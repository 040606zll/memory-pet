"""仅本机语音浏览器验收：真实模型/ASR/TTS，内存会话，不验证 MySQL/MemoryOS。
运行 python tests/speech_browser_server.py 后访问 http://127.0.0.1:18899/。
固定 QA 身份只存在于此测试进程；不修改产品认证或读取真实聊天。
"""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import replace
from pathlib import Path
import sys
from unittest.mock import Mock
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import httpx
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import FileResponse, StreamingResponse
import uvicorn
from app.common.response import response
from pet.config import Connection
from pet.providers import Providers
from pet.schemas import ChatBody
from pet.service import PetService
from pet.settings import load_settings
from pet.speech import Speech, SpeechConfig
from pet.streaming import chat_events

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / 'frontend/dist/client'
settings = load_settings()
connection = replace(Connection.environment(settings), user_id='speech-qa-no-remote-user', memory_key='speech-qa-no-remote-key')
speech = Speech(SpeechConfig.from_settings(settings))
store = Mock()
store.begin_operation.return_value = None
store.history.return_value = []
store.session.return_value = {'surface': 'pet', 'mode': 'chat'}

@asynccontextmanager
async def lifespan(app):
    async with httpx.AsyncClient(timeout=90, trust_env=False) as client:
        providers = Providers(client)
        async def recall(*args): return []
        providers.recall = recall
        app.state.service = PetService(store, providers)
        yield
app = FastAPI(lifespan=lifespan)

@app.get('/pet-api/auth/me')
async def me():
    return response({'user': {'id': 'voice_qa', 'username': 'voice_qa_test_only'}, 'csrf_token': 'local-speech-qa'})

@app.get('/pet-api/status')
async def status():
    return response({'connected': True, 'llm': {'configured': True}, 'memoryos': {'configured': True}, 'speech': speech.config.public()})

@app.post('/pet-api/sessions')
async def create(request: Request):
    body = await request.json(); store.session.return_value['mode'] = body['mode']
    return response({'id': 'voice-qa', 'mode': body['mode']})

@app.get('/pet-api/sessions/{session_id}/memories')
async def memories(session_id: str): return response({'items': [], 'total': 0})

@app.post('/pet-api/sessions/{session_id}/chat')
async def chat(session_id: str, body: ChatBody, request: Request):
    return StreamingResponse(chat_events(app.state.service, speech, connection, session_id, body, voice=request.headers.get('x-voice-enabled') == 'true'), media_type='text/event-stream')

@app.websocket('/pet-api/speech/asr')
async def asr(ws: WebSocket):
    await ws.accept()
    try:
        async with asyncio.timeout(75):
            if (await ws.receive_json()).get('csrf_token') != 'local-speech-qa': return
            await speech.recognize(ws)
    finally: await ws.close()

@app.get('/fixture.pcm')
async def fixture():
    return FileResponse(ROOT / '.runtime/live-speech.pcm', headers={'Access-Control-Allow-Origin': 'http://127.0.0.1:8796'})

@app.get('/{path:path}')
async def asset(path: str):
    target = (DIST / path).resolve()
    if target.is_relative_to(DIST.resolve()) and target.is_file(): return FileResponse(target)
    return FileResponse(DIST / 'index.html')

if __name__ == '__main__': uvicorn.run(app, host='127.0.0.1', port=18899, access_log=False)
