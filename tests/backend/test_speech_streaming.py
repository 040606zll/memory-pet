"""真实协议/调度的可重复验证，供应商连接替身不访问网络或业务数据库。"""
import asyncio
import base64
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from starlette.websockets import WebSocketState

from pet.config import Connection
from pet.errors import ServiceError
from pet.providers import Providers
from pet.schemas import ChatBody
from pet.service import PetService
from pet.speech import Speech, SpeechConfig
from pet.streaming import chat_events


def run(coro):
    return asyncio.run(coro)


def event(kind, output=None):
    return json.dumps({'header': {'event': kind}, 'payload': {'output': output or {}}})


class Wire:
    def __init__(self, messages):
        self.messages = asyncio.Queue()
        for message in messages:
            self.messages.put_nowait(message)
        self.sent, self.closed = [], False

    async def __aenter__(self): return self
    async def __aexit__(self, *args): self.closed = True
    async def recv(self): return await self.messages.get()
    async def send(self, data): self.sent.append(data)


def provider(monkeypatch, messages):
    wire = Wire(messages)
    connect = Mock(return_value=wire)
    monkeypatch.setattr('pet.speech.connect', connect)
    return Speech(SpeechConfig(api_key='private-test-key')), wire, connect


@pytest.mark.parametrize('url', ['http://invalid', 'wss://a@b/path', 'wss://host/path?secret=a', 'wss://host/#fragment', 'wss:///path'])
def test_config_rejects_unsafe_urls(url):
    with pytest.raises(ServiceError): SpeechConfig.from_settings({'PET_SPEECH_URL': url})


def test_config_public_and_server_only_credentials(monkeypatch):
    config = SpeechConfig.from_settings({'PET_SPEECH_API_KEY': 'private-test-key', 'PET_TTS_VOICE': 'voice', 'PET_ASR_MODEL': 'asr'})
    assert config.public() == {'configured': True, 'voice': 'voice'}
    assert config.asr_model == 'asr'
    with pytest.raises(ServiceError): SpeechConfig().ready()
    speech, _, connect = provider(monkeypatch, [])
    speech.connection()
    assert connect.call_args.kwargs['additional_headers'] == {'Authorization': 'Bearer private-test-key'}
    assert connect.call_args.kwargs['proxy'] is None


def test_tts_duplex_pcm_timing_and_cleanup(monkeypatch):
    output = {'sentence': {'index': 0, 'words': [{'text': '你', 'begin_time': 0}]}}
    speech, wire, _ = provider(monkeypatch, [event('task-started'), event('result-generated', output), b'\x00\x01', event('result-generated'), event('task-finished')])
    async def scenario():
        sent = []
        async def texts():
            yield '你好'; yield '。'
        async def emit(kind, data): sent.append((kind, data))
        await speech.synthesize(texts(), emit)
        assert sent == [('timing', output), ('audio', {'pcm': base64.b64encode(b'\x00\x01').decode(), 'sample_rate': 24000})]
    run(scenario())
    frames = [json.loads(frame) for frame in wire.sent]
    assert [frame['header']['action'] for frame in frames] == ['run-task', 'continue-task', 'continue-task', 'finish-task']
    assert frames[0]['payload']['parameters']['voice'] == 'longjielidou_v3.6'
    assert frames[0]['payload']['parameters']['word_timestamp_enabled']
    assert wire.closed


@pytest.mark.parametrize('first', [event('task-failed'), event('unknown'), b'bad', '{invalid'])
def test_task_rejected_or_malformed_is_not_success(monkeypatch, first):
    speech, wire, _ = provider(monkeypatch, [first])
    async def scenario():
        with pytest.raises((ServiceError, ValueError)):
            await speech.start(wire, 'tts', {})
    run(scenario())


def test_tts_cancellation_releases_websocket(monkeypatch):
    speech, wire, _ = provider(monkeypatch, [event('task-started')])
    async def scenario():
        async def texts():
            await asyncio.Future()
            yield ''
        task = asyncio.create_task(speech.synthesize(texts(), AsyncMock()))
        await asyncio.sleep(.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError): await task
        assert wire.closed
    run(scenario())


class Browser:
    client_state = WebSocketState.CONNECTED
    def __init__(self, messages):
        self.messages, self.events = messages, []
    async def receive(self):
        await asyncio.sleep(0)
        message = self.messages.pop(0)
        if message['type'] == 'websocket.disconnect': self.client_state = WebSocketState.DISCONNECTED
        return message
    async def send_json(self, data): self.events.append(data)


def test_asr_interim_revisions_final_and_pcm(monkeypatch):
    partial = {'sentence': {'sentence_id': 1, 'text': '你好', 'sentence_end': False}}
    final = {'sentence': {'sentence_id': 1, 'text': '你好。', 'sentence_end': True}}
    speech, wire, _ = provider(monkeypatch, [event('task-started'), event('result-generated', {'sentence': {'heartbeat': True}}), event('result-generated', partial), event('result-generated', final), event('task-finished')])
    browser = Browser([{'type': 'websocket.receive', 'bytes': b'\0\0'}, {'type': 'websocket.receive', 'text': '{"type":"finish"}'}])
    run(speech.recognize(browser))
    assert browser.events == [{'type': 'ready'}, {'type': 'transcript', 'sentence_id': 1, 'text': '你好', 'final': False}, {'type': 'transcript', 'sentence_id': 1, 'text': '你好。', 'final': True}, {'type': 'finished'}]
    assert wire.closed


@pytest.mark.parametrize('message', [ {'type': 'websocket.receive', 'bytes': b'\0'}, {'type': 'websocket.receive', 'bytes': b'\0'*32770}, {'type': 'websocket.receive', 'text': '{}'}])
def test_asr_invalid_audio_or_commands_release_connection(monkeypatch, message):
    speech, wire, _ = provider(monkeypatch, [event('task-started')])
    with pytest.raises(ServiceError): run(speech.recognize(Browser([message])))
    assert wire.closed


def test_asr_disconnect_does_not_wait_for_provider(monkeypatch):
    speech, wire, _ = provider(monkeypatch, [event('task-started')])
    run(speech.recognize(Browser([{'type': 'websocket.disconnect'}])))
    assert wire.closed


def test_asr_rejects_binary_response(monkeypatch):
    speech, wire, _ = provider(monkeypatch, [event('task-started'), b'invalid'])
    with pytest.raises(ServiceError): run(speech.recognize(Browser([{'type': 'websocket.receive', 'text': '{"type":"finish"}'}])))


@pytest.mark.parametrize('voice,fail', [(False, False), (True, False), (True, True)])
def test_sse_real_orchestration_voice_failure_continues_text(voice, fail):
    async def scenario():
        async def chat(*args, on_delta):
            await on_delta('你'); await on_delta('好'); return {'assistant_message': {'content': '你好'}}
        async def synthesize(texts, emit):
            if fail: raise ServiceError('private key upstream', 502)
            assert ''.join([text async for text in texts]) == '你好'
            await emit('audio', {'pcm': 'AAA='})
        service = SimpleNamespace(chat=chat)
        speech = SimpleNamespace(synthesize=synthesize)
        frames = [frame async for frame in chat_events(service, speech, None, 'session', None, voice)]
        assert frames[0].startswith('event: delta') and frames[-1].startswith('event: done')
        assert any('event: voice_error' in frame for frame in frames) == fail
        assert all('private key' not in frame for frame in frames)
    run(scenario())


@pytest.mark.parametrize('error', [ServiceError('可重试错误', 502), RuntimeError('private key')])
def test_sse_error_is_terminal_and_safe(error):
    async def scenario():
        async def chat(*args, **kwargs): raise error
        frames = [frame async for frame in chat_events(SimpleNamespace(chat=chat), None, None, 's', None)]
        assert len(frames) == 1 and frames[0].startswith('event: error')
        assert 'private key' not in frames[0]
    run(scenario())


def test_sse_disconnect_cancels_model_and_audio():
    async def scenario():
        stopped = asyncio.Event()
        async def chat(*args, on_delta):
            try:
                await on_delta('你好'); await asyncio.Future()
            finally: stopped.set()
        stream = chat_events(SimpleNamespace(chat=chat), SimpleNamespace(synthesize=AsyncMock()), None, 's', None, True)
        assert 'event: delta' in await anext(stream)
        await stream.aclose()
        assert stopped.is_set()
    run(scenario())


CONFIG = Connection('http://memory.test', 'memory-key', 'user-id', 'https://model.test/v1', 'private-test-key', 'test-model')


def test_langchain_real_stream_handles_escaped_chinese_and_outputs_metadata():
    reply = '你好，"朋友"！\n今天一起玩🐶。'
    raw = json.dumps({'reply': reply, 'actions': ['wave'], 'pet_name': '小旺', 'candidates': ['用户喜欢茶']}, ensure_ascii=True)
    frames = []
    for piece in raw:
        frames.append('data: ' + json.dumps({'id': 'id', 'object': 'chat.completion.chunk', 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': piece}, 'finish_reason': None}]}) + '\n\n')
    frames.append('data: ' + json.dumps({'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]}) + '\n\ndata: [DONE]\n\n')
    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, headers={'Content-Type': 'text/event-stream'}, content=''.join(frames)))) as client:
            deltas = []
            async def emit(text): deltas.append(text)
            output = await Providers(client).reply(CONFIG, 'training', '你好', [], [], on_delta=emit)
            assert output.reply == reply and output.pet_name == '小旺'
            assert ''.join(deltas) == reply and len(deltas) > 1
    run(scenario())


def test_idempotent_replay_emits_text_and_uses_latest_candidates():
    store = Mock(); store.session.return_value = {'surface': 'pet', 'mode': 'chat'}
    previous = {'assistant_message': {'content': '你好', 'candidates': []}}
    store.begin_operation.return_value = previous; store.candidates_by_ids.return_value = {}
    async def scenario():
        emit = AsyncMock()
        assert await PetService(store, Mock()).chat(CONFIG, 's', ChatBody(content='你好', request_id='retry'), on_delta=emit) == previous
        emit.assert_awaited_once_with('你好')
    run(scenario())


@pytest.fixture
def api_app(monkeypatch):
    from pet.main import create_app
    from pet.store import Store
    monkeypatch.setattr(Store, 'initialize', Mock())
    app = create_app(connection=CONFIG)
    app.state.accounts.authenticate = Mock(return_value={'id': 'account', 'csrf_token': 'csrf'})
    app.state.store.session = Mock(return_value={'surface': 'pet', 'mode': 'chat'})
    for route in app.routes:
        if getattr(route, 'path', '') == '/api/sessions/{session_id}/chat':
            authorized = next(dep.call for dep in route.dependant.dependencies if dep.name == 'c')
            app.dependency_overrides[authorized] = lambda: CONFIG
    return app


def test_stream_endpoint_auth_scope_and_sse(api_app):
    from fastapi.testclient import TestClient
    with TestClient(api_app) as client:
        async def chat(*args, on_delta):
            await on_delta('你好'); return {'assistant_message': {'content': '你好'}}
        api_app.state.service.chat = chat
        result = client.post('/api/sessions/session/chat', json={'content': '你好', 'request_id': 'sse'}, headers={'Accept': 'text/event-stream'})
        assert result.status_code == 200
        assert result.headers['content-type'].startswith('text/event-stream')
        assert result.headers['x-accel-buffering'] == 'no'
        assert 'event: delta' in result.text and 'event: done' in result.text
        assert not api_app.state.stream_accounts
        api_app.state.stream_accounts.add(CONFIG.scope)
        assert client.post('/api/sessions/session/chat', json={'content': '你好', 'request_id': 'sse'}, headers={'Accept': 'text/event-stream'}).status_code == 429


@pytest.mark.parametrize('headers', [{}, {'Origin': 'https://evil.example'}, {'Origin': 'http://localhost'}])
def test_asr_endpoint_requires_allowed_origin_cookie_and_csrf(api_app, headers):
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect
    with TestClient(api_app) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect('/api/speech/asr', headers=headers) as ws:
                ws.send_json({'csrf_token': 'wrong'})
                if headers.get('Origin') == 'http://localhost': assert ws.receive_json()['type'] == 'error'
                ws.receive_json()


def test_asr_endpoint_real_lifecycle_busy_and_sanitized_failure(api_app):
    from fastapi.testclient import TestClient
    async def recognize(ws): await ws.send_json({'type': 'ready'})
    api_app.state.speech.recognize = recognize
    with TestClient(api_app) as client:
        with client.websocket_connect('/api/speech/asr', headers={'Origin': 'http://localhost'}) as ws:
            ws.send_json({'csrf_token': 'csrf'})
            assert ws.receive_json() == {'type': 'ready'}
        assert not api_app.state.voice_accounts
        api_app.state.voice_accounts.add('account')
        with client.websocket_connect('/api/speech/asr', headers={'Origin': 'http://localhost'}) as ws:
            ws.send_json({'csrf_token': 'csrf'})
            assert ws.receive_json()['type'] == 'error'
        assert 'account' in api_app.state.voice_accounts
        api_app.state.voice_accounts.clear()
        api_app.state.speech.recognize = AsyncMock(side_effect=OSError('private-key'))
        with client.websocket_connect('/api/speech/asr', headers={'Origin': 'http://localhost'}) as ws:
            ws.send_json({'csrf_token': 'csrf'})
            assert 'private-key' not in ws.receive_json()['message']
        assert not api_app.state.voice_accounts


def test_sse_heartbeat_empty_reply_and_post_audio_failure_deltas(monkeypatch):
    from pet import streaming
    original = streaming.asyncio.wait_for
    first = True
    async def instant_timeout(awaitable, timeout):
        nonlocal first
        if first:
            first = False
            awaitable.close()
            raise TimeoutError
        return await original(awaitable, timeout)
    monkeypatch.setattr(streaming.asyncio, 'wait_for', instant_timeout)
    async def scenario():
        async def chat(*args, **kwargs): return {'ok': True}
        frames = [frame async for frame in chat_events(SimpleNamespace(chat=chat), Mock(), None, 's', None, True)]
        assert frames == [': keepalive\n\n', 'event: done\ndata: {"ok": true}\n\n']
        broken = asyncio.Event()
        async def more(*args, on_delta):
            await on_delta('你'); await broken.wait(); await asyncio.sleep(.01)
            await on_delta('好'); return {'ok': True}
        async def audio(*args):
            broken.set(); raise OSError('secret')
        frames = [frame async for frame in chat_events(SimpleNamespace(chat=more), SimpleNamespace(synthesize=audio), None, 's', None, True)]
        assert sum(frame.startswith('event: delta') for frame in frames) == 2
    run(scenario())


@pytest.mark.parametrize('chunks', [[None], ['x' * 32001], [json.dumps({'reply': '长'*8001}, ensure_ascii=False)]])
def test_stream_model_rejects_invalid_chunks_and_output_bounds(monkeypatch, chunks):
    from langchain_core.messages import AIMessageChunk
    from pet.model_agent import run_model_agent
    class Agent:
        async def astream(self, *args, **kwargs):
            for content in chunks:
                yield (None if content is None else AIMessageChunk(content=content)), {}
    monkeypatch.setattr('pet.model_agent.create_agent', lambda **kwargs: Agent())
    async def scenario():
        async with httpx.AsyncClient() as client:
            with pytest.raises(ValueError):
                await run_model_agent(client, CONFIG, [], on_delta=AsyncMock())
    run(scenario())


def test_stream_malformed_json_is_rejected_after_partial_parser_failure(monkeypatch):
    from langchain_core.messages import AIMessageChunk
    class Agent:
        async def astream(self, *args, **kwargs):
            yield AIMessageChunk(content='{"reply":"\\uZZZZ"}'), {}
    monkeypatch.setattr('pet.model_agent.create_agent', lambda **kwargs: Agent())
    async def scenario():
        async with httpx.AsyncClient() as client:
            with pytest.raises(ServiceError):
                await Providers(client).reply(CONFIG, 'chat', '你好', [], [], on_delta=AsyncMock())
    run(scenario())


def test_tts_empty_audio_is_failure_for_text_fallback(monkeypatch):
    speech, wire, _ = provider(monkeypatch, [event('task-started'), event('task-finished')])
    async def texts(): yield '你好'
    with pytest.raises(ServiceError, match='音频'):
        run(speech.synthesize(texts(), AsyncMock()))


@pytest.mark.parametrize('packets,valid', [([b'\x00', b'\x01'], True), ([b'', b'\x00'], False)])
def test_tts_handles_pcm_sample_boundaries(monkeypatch, packets, valid):
    speech, wire, _ = provider(monkeypatch, [event('task-started'), *packets, event('task-finished')])
    async def texts(): yield '你好'
    async def scenario():
        emit = AsyncMock()
        if valid:
            await speech.synthesize(texts(), emit)
            emit.assert_awaited_once_with('audio', {'pcm': 'AAE=', 'sample_rate': 24000})
        else:
            with pytest.raises(ServiceError): await speech.synthesize(texts(), emit)
    run(scenario())


def test_tts_ignores_unknown_events_and_waits_for_delayed_text_sender(monkeypatch):
    speech, wire, _ = provider(monkeypatch, [event('task-started'), event('unknown'), b'\x00\x01'])
    async def texts():
        await asyncio.sleep(.01)
        yield '你好'
        wire.messages.put_nowait(event('task-finished'))
    run(speech.synthesize(texts(), AsyncMock()))


def test_asr_ignores_unknown_events_while_upload_continues(monkeypatch):
    speech, wire, _ = provider(monkeypatch, [event('task-started'), event('unknown'), event('task-finished')])
    class SlowBrowser(Browser):
        async def receive(self): await asyncio.Future()
    run(speech.recognize(SlowBrowser([])))


def test_concurrent_sse_requests_reserve_one_account_slot_after_scope_check(api_app):
    import threading
    barrier = threading.Barrier(2)
    api_app.state.store.session.side_effect = lambda *args: barrier.wait(timeout=3)
    async def scenario():
        async with api_app.router.lifespan_context(api_app):
            entered, release = asyncio.Event(), asyncio.Event()
            calls = []
            async def chat(*args, on_delta):
                calls.append(1); entered.set(); await release.wait(); return {'ok': True}
            api_app.state.service.chat = chat
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=api_app), base_url='http://testserver') as client:
                async def request():
                    return await client.post('/api/sessions/s/chat', json={'content': '你好', 'request_id': 'same'}, headers={'Accept': 'text/event-stream'})
                tasks = [asyncio.create_task(request()), asyncio.create_task(request())]
                try:
                    await asyncio.wait_for(entered.wait(), 3)
                    done, _ = await asyncio.wait(tasks, timeout=.1, return_when=asyncio.FIRST_COMPLETED)
                    assert len(calls) == 1
                    assert len(done) == 1 and next(iter(done)).result().status_code == 429
                finally:
                    release.set()
                    await asyncio.gather(*tasks)
    run(scenario())


@pytest.mark.parametrize('fenced,mismatch', [(True, False), (False, True)])
def test_stream_legacy_fence_fallback_and_final_consistency(monkeypatch, fenced, mismatch):
    async def model(client, c, messages, on_delta):
        if mismatch: await on_delta('不一致的旧正文')
        text = json.dumps({'reply': '你好', 'actions': [], 'candidates': []})
        return '```json\n' + text + '\n```' if fenced else text
    monkeypatch.setattr('pet.providers.run_model_agent', model)
    async def scenario():
        emit = AsyncMock()
        async with httpx.AsyncClient() as client:
            if mismatch:
                with pytest.raises(ServiceError, match='不一致'): await Providers(client).reply(CONFIG, 'chat', '你好', [], [], on_delta=emit)
            else:
                await Providers(client).reply(CONFIG, 'chat', '你好', [], [], on_delta=emit)
                emit.assert_awaited_once_with('你好')
    run(scenario())


def test_asr_rejects_an_expired_cookie_before_accepting_the_connection(api_app):
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect
    api_app.state.accounts.authenticate.side_effect=ServiceError('登录失效',401)
    with TestClient(api_app) as client:
        with pytest.raises(WebSocketDisconnect) as failure:
            with client.websocket_connect('/api/speech/asr',headers={'Origin':'http://localhost'}): pass
        assert failure.value.code == 1008
    assert not api_app.state.voice_accounts


@pytest.mark.parametrize('stage',['before_csrf','during_recording','upstream_error_after_disconnect'])
def test_asr_browser_disconnect_never_leaks_an_account_slot_or_sends_to_a_closed_socket(api_app, stage):
    from fastapi.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect
    import threading
    completed=threading.Event()
    async def recognize(ws):
        await ws.send_json({'type':'ready'})
        try:
            if stage == 'upstream_error_after_disconnect':
                await ws.receive()
                raise OSError('connection failed after browser disconnected')
            await ws.receive_text()
        finally: completed.set()
    api_app.state.speech.recognize=recognize
    with TestClient(api_app) as client:
        with client.websocket_connect('/api/speech/asr',headers={'Origin':'http://localhost'}) as ws:
            if stage != 'before_csrf':
                ws.send_json({'csrf_token':'csrf'}); assert ws.receive_json() == {'type':'ready'}
            ws.close()
        if stage != 'before_csrf': assert completed.wait(2)
    assert not api_app.state.voice_accounts
