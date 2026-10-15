"""多账号 FastAPI：身份来自登录会话，记忆连接逐请求按账号解析。"""
import asyncio
import hmac
from contextlib import asynccontextmanager

import httpx
from fastapi import Depends, FastAPI, Query, Request, WebSocket, WebSocketDisconnect
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.common.response import response
from .access import AccessPolicy
from .accounts import Accounts
from .auth import Auth, COOKIE_NAME, SESSION_AGE, public_user
from .config import Connection
from .connections import AccountConnections
from .database import DatabaseConfig, run_db
from .errors import ServiceError
from .providers import Providers
from .schemas import ACTIONS, AccountBody, CandidateBody, ChatBody, ConfirmBody, Mode, ModeBody, RetryConnectionBody, SessionBody, Surface
from .service import PetService
from .settings import load_settings
from .store import Store
from .speech import Speech, SpeechConfig, SPEECH_ERRORS
from .streaming import chat_events


class AccessMiddleware(BaseHTTPMiddleware):
    def __init__(self, app, policy):
        super().__init__(app)
        self.policy = policy

    async def dispatch(self, request, call_next):
        message = self.policy.rejection(request.headers)
        if message:
            return JSONResponse(response(message=message, code=403), status_code=403)
        # 在框架解析正文前校验，确保不同 FastAPI 版本均拒绝非 JSON 登录请求。
        if (request.method == 'POST' and request.url.path in {'/api/auth/login', '/api/auth/register'}
                and request.headers.get('content-type', '').split(';', 1)[0].strip().lower() != 'application/json'):
            return JSONResponse(response(message='登录请求格式无效，请从登录页面重试', code=415), status_code=415)
        result = await call_next(request)
        # 登录和业务结果含账号私有数据，同源代理与浏览器均不得缓存。
        if request.url.path.startswith('/api/'):
            result.headers['Cache-Control'] = 'no-store'
        return result


async def disconnect_aware(request, coroutine):
    task = asyncio.create_task(coroutine)
    try:
        while not task.done():
            await asyncio.wait({task}, timeout=0.2)
            if not task.done() and await request.is_disconnected():
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise ServiceError("请求已取消", 499)
        return task.result()
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


def create_app(*, database=None, connection=None, transport=None):
    @asynccontextmanager
    async def lifespan(app):
        try:
            await run_db(app.state.store.initialize)
            async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=10), transport=transport, trust_env=False, follow_redirects=False) as client:
                app.state.providers = Providers(client)
                app.state.service = PetService(app.state.store, app.state.providers)
                yield
        finally:
            await run_db(app.state.store.close)

    settings = load_settings()
    app = FastAPI(title="MemoryPet 账号与记忆服务", lifespan=lifespan)
    app.add_middleware(AccessMiddleware, policy=AccessPolicy.from_settings(settings))
    app.state.store = Store(database if database is not None else DatabaseConfig.from_settings(settings))
    app.state.speech = Speech(SpeechConfig.from_settings(settings))
    app.state.voice_accounts = set()
    app.state.stream_accounts = set()
    app.state.accounts = Accounts(app.state.store)
    app.state.auth = Auth(app.state.accounts)
    # 此处只存服务端配置，不存当前用户或全局登录状态。
    app.state.connection = connection or Connection.environment(settings)

    @app.exception_handler(ServiceError)
    async def service_error(request, exc):
        return JSONResponse(response(message=exc.message, code=exc.status), status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, exc):
        message = "账号需为三到三十二位字母、数字或下划线，密码需为八到一百二十八位" if request.url.path.startswith('/api/auth/') else "请求参数无效，请检查必填项、文本长度和模式"
        return JSONResponse(response(message=message, code=422), status_code=422)

    @app.exception_handler(Exception)
    async def unexpected_error(request, exc):
        return JSONResponse(response(message="服务处理失败，请稍后重试", code=500), status_code=500)

    async def account(request: Request):
        current = await run_db(app.state.accounts.authenticate, request.cookies.get(COOKIE_NAME))
        if request.method not in {"GET", "HEAD", "OPTIONS"}:
            supplied = request.headers.get("X-CSRF-Token", "")
            if not supplied or not hmac.compare_digest(supplied.encode(), current["csrf_token"].encode()):
                raise ServiceError("页面安全验证已失效，请刷新页面后重试", 403)
        return current

    async def sign_in(body, request, register=False):
        current = await app.state.auth.credentials(body.username, body.password, request.client.host if request.client else "unknown", register=register)
        token, csrf = await run_db(app.state.accounts.new_session, current["id"], request.cookies.get(COOKIE_NAME))
        result = JSONResponse(response({"user": public_user(current), "csrf_token": csrf}))
        result.set_cookie(COOKIE_NAME, token, max_age=SESSION_AGE, httponly=True, secure=request.url.scheme == "https", samesite="strict", path="/")
        return result

    @app.post("/api/auth/register")
    async def register(body: AccountBody, request: Request):
        return await sign_in(body, request, register=True)

    @app.post("/api/auth/login")
    async def login(body: AccountBody, request: Request):
        return await sign_in(body, request)

    @app.get("/api/auth/me")
    async def me(current=Depends(account)):
        return response({"user": public_user(current), "csrf_token": current["csrf_token"]})

    @app.post("/api/auth/logout")
    async def logout(request: Request, current=Depends(account)):
        await run_db(app.state.accounts.logout, request.cookies[COOKIE_NAME])
        result = JSONResponse(response())
        result.delete_cookie(COOKIE_NAME, path="/", httponly=True, samesite="strict")
        return result

    async def resolve(current):
        # 缺少模型配置时不创建远端用户；同账号并发初始化共享锁，不阻塞其他账号。
        app.state.connection.model_ready()
        async with app.state.service.lock(f"connection:{current['id']}"):
            return await AccountConnections(app.state.accounts, app.state.providers).resolve(app.state.connection, current["id"])

    async def connection_status(current, *, strict=False):
        c, memory_error = app.state.connection, None
        try:
            c = await resolve(current)
            memory_validated = True
        except ServiceError as exc:
            if strict:
                raise
            memory_validated, memory_error = False, exc.message
        llm_validated = bool(c.llm_url and c.llm_key and c.model)
        return response({"memoryos": {"configured": bool(c.memory_key), "user_id": c.user_id if memory_validated else None}, "llm": {"configured": llm_validated}, "speech": app.state.speech.config.public(), "actions": ACTIONS, "connected": memory_validated and llm_validated, "memory_validated": memory_validated, "llm_validated": llm_validated, "memory_error": memory_error or (None if llm_validated else "管理员尚未配置完整的大模型服务")})

    @app.get("/api/status")
    async def status(current=Depends(account)):
        return await connection_status(current)

    @app.post("/api/connection")
    async def connect(body: RetryConnectionBody, request: Request, current=Depends(account)):
        return await disconnect_aware(request, connection_status(current, strict=True))

    @app.post("/api/disconnect")
    async def disconnect(current=Depends(account)):
        raise ServiceError("记忆服务由账号统一管理，如需切换账号请退出登录", 409)

    async def authorized_connection(current=Depends(account)):
        c = await resolve(current)
        c.ready()
        return c

    @app.post("/api/sessions")
    async def session_create(body: SessionBody, c=Depends(authorized_connection)):
        title = "记忆对话" if body.surface == "memory" and "title" not in body.model_fields_set else body.title
        return response(await run_db(app.state.store.create_session, c.scope, body.mode, title, body.surface))

    @app.get("/api/sessions")
    async def sessions(page: int = Query(1, ge=1), limit: int = Query(20, ge=1, le=100), mode: Mode | None = None, surface: Surface = "pet", c=Depends(authorized_connection)):
        return response(await run_db(app.state.store.sessions, c.scope, page, limit, mode, surface))

    @app.patch("/api/sessions/{session_id}")
    async def mode(session_id: str, body: ModeBody, c=Depends(authorized_connection)):
        async with app.state.service.lock(f"session:{session_id}"):
            return response(await run_db(app.state.store.mode, session_id, c.scope, body.mode))

    @app.get("/api/sessions/{session_id}/messages")
    async def messages(session_id: str, page: int = Query(1, ge=1), limit: int = Query(100, ge=1, le=200), c=Depends(authorized_connection)):
        return response(await run_db(app.state.store.messages, session_id, c.scope, page, limit))

    @app.post("/api/sessions/{session_id}/chat")
    async def chat(session_id: str, body: ChatBody, request: Request, c=Depends(authorized_connection)):
        if 'text/event-stream' in request.headers.get('accept', ''):
            owner = c.local_account_id or c.scope
            # 在响应头发送前校验归属；校验完成后同步占位，避免并发检查间的竞态。
            await run_db(app.state.store.session, session_id, c.scope)
            if owner in app.state.stream_accounts or len(app.state.stream_accounts) >= 16:
                raise ServiceError('当前对话正在处理中，请稍后再试', 429)
            app.state.stream_accounts.add(owner)
            async def stream():
                try:
                    async for event in chat_events(app.state.service, app.state.speech, c, session_id, body,
                                                  voice=request.headers.get('x-voice-enabled') == 'true'):
                        yield event
                finally:
                    app.state.stream_accounts.discard(owner)
            return StreamingResponse(stream(), media_type='text/event-stream',
                                     headers={'X-Accel-Buffering': 'no', 'Cache-Control': 'no-store'})
        return response(await disconnect_aware(request, app.state.service.chat(c, session_id, body)))

    @app.websocket('/api/speech/asr')
    async def asr(websocket: WebSocket):
        policy = AccessPolicy.from_settings(settings)
        if not websocket.headers.get('origin') or policy.rejection(websocket.headers):
            await websocket.close(code=1008)
            return
        owner = None
        accepted = False
        try:
            current = await run_db(app.state.accounts.authenticate, websocket.cookies.get(COOKIE_NAME))
            await websocket.accept()
            accepted = True
            async with asyncio.timeout(10):
                first = await websocket.receive_json()
            supplied = first.get('csrf_token', '')
            if not isinstance(supplied, str) or not supplied or not hmac.compare_digest(supplied.encode('utf-8', errors='replace'), current['csrf_token'].encode()):
                raise ServiceError('页面安全验证已失效，请刷新页面后重试', 403)
            if current['id'] in app.state.voice_accounts or len(app.state.voice_accounts) >= 8:
                raise ServiceError('语音服务繁忙，请稍后再试', 429)
            owner = current['id']
            app.state.voice_accounts.add(owner)
            async with asyncio.timeout(75):
                await app.state.speech.recognize(websocket)
        except WebSocketDisconnect:
            pass
        except (ServiceError, *SPEECH_ERRORS, AttributeError):
            if accepted and websocket.client_state.name != 'DISCONNECTED':
                await websocket.send_json({'type': 'error', 'message': '语音识别暂不可用，请重试或使用文字输入。'})
        finally:
            if owner:
                app.state.voice_accounts.discard(owner)
            if websocket.client_state.name != 'DISCONNECTED':
                await websocket.close(code=1000 if accepted else 1008)

    @app.patch("/api/sessions/{session_id}/candidates/{candidate_id}")
    async def edit_candidate(session_id: str, candidate_id: str, body: CandidateBody, c=Depends(authorized_connection)):
        return response(await app.state.service.edit_candidate(c, session_id, candidate_id, body))

    @app.post("/api/sessions/{session_id}/memories/confirm")
    async def confirm(session_id: str, body: ConfirmBody, request: Request, c=Depends(authorized_connection)):
        return response(await disconnect_aware(request, app.state.service.confirm(c, session_id, body.candidate_id)))

    @app.get("/api/sessions/{session_id}/memories")
    async def memories(session_id: str, request: Request, page: int = Query(1, ge=1), limit: int = Query(20, ge=1, le=100), q: str | None = Query(None, max_length=200), c=Depends(authorized_connection)):
        await run_db(app.state.store.session, session_id, c.scope)
        return response(await disconnect_aware(request, app.state.providers.memories(c, page, limit, q)))

    @app.get("/api/health")
    async def health():
        return response({"status": "ok"})

    return app


app = create_app()
