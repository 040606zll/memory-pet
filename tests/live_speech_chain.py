"""真实账号 + MySQL + MemoryOS + LLM SSE + TTS + ASR；仅在上述独立验收服务运行。
生成专用测试账号，仅确认明确标注的无个人信息测试偏好。报告不含认证凭据。
"""
import array
import asyncio
import base64
from datetime import datetime
import json
import os
from pathlib import Path
import secrets
import sys
import time
import uuid
import httpx
from websockets.asyncio.client import connect

ROOT = Path(__file__).resolve().parents[1]
REPORT = Path(os.environ.get('PET_LIVE_REPORT', str(ROOT / 'docs/2026-10-15/流式语音/真实链路结果.json')))
BASE = os.environ.get('PET_LIVE_BASE_URL', 'http://127.0.0.1:18898').rstrip('/')
API_PREFIX = os.environ.get('PET_LIVE_API_PREFIX', '/api').rstrip('/')

async def main():
    evidence = {'started_at': datetime.now().isoformat(), 'result': 'running', 'steps': []}
    username = 'speech_qa_' + uuid.uuid4().hex[:12]
    password = secrets.token_urlsafe(24)
    try:
        async with httpx.AsyncClient(base_url=BASE, timeout=180, trust_env=False) as client:
            async def call(method, path, **kwargs):
                start = time.monotonic(); res = await client.request(method, API_PREFIX + path, **kwargs); body = res.json()
                evidence['steps'].append({'path': path, 'status': res.status_code, 'seconds': round(time.monotonic()-start, 3)})
                if not res.is_success or body.get('code') != 0:
                    raise AssertionError('接口失败：' + path + '；' + body.get('message', '未知错误'))
                return body['data']
            auth = await call('POST', '/auth/register', json={'username': username, 'password': password})
            client.headers['X-CSRF-Token'] = auth['csrf_token']
            auth_path = ROOT / '.runtime/speech-integration-auth.json'
            auth_path.write_text(json.dumps({'username': username, 'password': password})); auth_path.chmod(0o600)
            status = await call('GET', '/status')
            assert status['connected'] and status['speech']['configured'], status.get('memory_error')
            training = await call('POST', '/sessions', json={'mode': 'training', 'title': '流式语音自动验收训练'})

            async def chat(session_id, body, voice):
                started = time.monotonic(); counts = {}; deltas = []; pcm = []; timings = []; result = None; first = {}
                async with client.stream('POST', API_PREFIX + '/sessions/' + session_id + '/chat', json=body, headers={'Accept': 'text/event-stream', 'X-Voice-Enabled': str(voice).lower()}) as res:
                    assert res.status_code == 200
                    kind = ''
                    async for line in res.aiter_lines():
                        if line.startswith('event: '): kind = line[7:]
                        if not line.startswith('data: '): continue
                        data = json.loads(line[6:]); counts[kind] = counts.get(kind, 0) + 1; first.setdefault(kind, round(time.monotonic()-started, 3))
                        if kind == 'delta': deltas.append(data['text'])
                        elif kind == 'audio': pcm.append(base64.b64decode(data['pcm']))
                        elif kind == 'timing': timings.append(data)
                        elif kind in {'error', 'voice_error'}: raise AssertionError(data['message'])
                        elif kind == 'done': result = data
                assert result and ''.join(deltas).strip() == result['assistant_message']['content']
                if voice:
                    assert counts.get('audio', 0) > 1 and counts.get('timing', 0) > 1
                    assert first['audio'] < first['done']
                evidence['steps'].append({'path': '/sessions/{id}/chat', 'voice': voice, 'events': counts, 'first_seconds': first, 'pcm_bytes': sum(map(len, pcm))})
                return result, b''.join(pcm)

            trained, _ = await chat(training['id'], {'content': '这是无个人信息的流式语音联调测试偏好：我喜欢听秋天的雨声。请提取一条候选，等待我确认。', 'request_id': str(uuid.uuid4())}, False)
            candidate = trained['assistant_message']['candidates'][0]
            assert candidate['status'] == 'pending'
            confirmed = await call('POST', '/sessions/' + training['id'] + '/memories/confirm', json={'candidate_id': candidate['id']})
            assert confirmed['status'] == 'confirmed' and confirmed['memory_ids']
            session = await call('POST', '/sessions', json={'mode': 'chat', 'title': '独立会话语音召回验收'})
            body = {'content': '我喜欢听什么声音？请用一句话回答，不超过二十字。', 'request_id': str(uuid.uuid4())}
            answer, pcm = await chat(session['id'], body, True)
            assert '雨' in answer['assistant_message']['content'] and answer['assistant_message']['memories']
            replay, _ = await chat(session['id'], body, False)
            assert replay['assistant_message']['id'] == answer['assistant_message']['id']
            history = await call('GET', '/sessions/' + session['id'] + '/messages')
            assert history['total'] == 2
            evidence['reply'] = answer['assistant_message']['content']
            evidence['remote_memory_ids_present'] = bool(confirmed['memory_ids'])
            cookies = '; '.join(f'{k}={v}' for k, v in client.cookies.items())
            socket_url = BASE.replace('http://', 'ws://', 1).replace('https://', 'wss://', 1) + API_PREFIX + '/speech/asr'
            async with connect(socket_url, origin=BASE, additional_headers={'Cookie': cookies}, proxy=None) as ws:
                await ws.send(json.dumps({'csrf_token': auth['csrf_token']}))
                assert json.loads(await ws.recv())['type'] == 'ready'
                transcripts = []
                async def upload():
                    samples = array.array('h'); samples.frombytes(pcm)
                    values = array.array('h')
                    for i in range(int(len(samples) / 1.5)):
                        position = i * 1.5; left = int(position); fraction = position-left
                        values.append(round(samples[left] * (1-fraction) + samples[min(left+1,len(samples)-1)] * fraction))
                    raw = values.tobytes()
                    for offset in range(0, len(raw), 3200):
                        await ws.send(raw[offset:offset+3200]); await asyncio.sleep(.1)
                    await ws.send(json.dumps({'type': 'finish'}))
                sender = asyncio.create_task(upload())
                try:
                    while True:
                        data = json.loads(await asyncio.wait_for(ws.recv(), 30))
                        if data['type'] == 'transcript': transcripts.append(data)
                        elif data['type'] == 'finished': break
                        elif data['type'] == 'error': raise AssertionError(data['message'])
                    await sender
                finally: sender.cancel(); await asyncio.gather(sender, return_exceptions=True)
                assert any(item['final'] and item['text'] for item in transcripts)
                evidence['asr'] = {'interim_count': sum(not item['final'] for item in transcripts), 'final_text': ''.join(item['text'] for item in transcripts if item['final'])}
            evidence['result'] = 'passed'
    except Exception as error:
        evidence['result'] = 'failed'; evidence['failure_type'] = type(error).__name__
        # 只记录应用自身的断言，不记录带 URL/鉴权信息的网络异常。
        if isinstance(error, AssertionError): evidence['failure'] = str(error)
        raise
    finally:
        evidence['finished_at'] = datetime.now().isoformat(); REPORT.write_text(json.dumps(evidence, ensure_ascii=False, indent=2)); print('Live speech chain:', evidence['result'])

if __name__ == '__main__': asyncio.run(main())
