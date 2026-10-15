"""服务端百炼双向流：PCM 音频和字级时间戳，密钥不下发浏览器。"""
import asyncio
import base64
from dataclasses import dataclass
import json
import uuid
from urllib.parse import urlsplit

from websockets.asyncio.client import connect
from websockets.exceptions import WebSocketException

from .errors import ServiceError


@dataclass(frozen=True)
class SpeechConfig:
    api_key: str = ''
    url: str = 'wss://dashscope.aliyuncs.com/api-ws/v1/inference'
    tts_model: str = 'qwen-audio-3.0-tts-flash'
    voice: str = 'longjielidou_v3.6'
    asr_model: str = 'fun-asr-realtime'

    @classmethod
    def from_settings(cls, values):
        result = cls(**{field: values['PET_' + env] for field, env in {
            'api_key': 'SPEECH_API_KEY', 'url': 'SPEECH_URL', 'tts_model': 'TTS_MODEL',
            'voice': 'TTS_VOICE', 'asr_model': 'ASR_MODEL',
        }.items() if 'PET_' + env in values})
        url = urlsplit(result.url)
        if url.scheme != 'wss' or not url.hostname or url.username or url.password or url.query or url.fragment:
            raise ServiceError('语音服务地址必须是完整的 WSS 地址', 500)
        return result

    def ready(self):
        if not self.api_key:
            raise ServiceError('管理员尚未配置语音服务，请使用文字输入', 503)

    def public(self):
        return {'configured': bool(self.api_key), 'voice': self.voice}


class Speech:
    def __init__(self, config):
        self.config = config

    def connection(self):
        self.config.ready()
        return connect(self.config.url, additional_headers={'Authorization': 'Bearer ' + self.config.api_key},
                       proxy=None, open_timeout=10, close_timeout=2, max_size=2**20, max_queue=8)

    @staticmethod
    async def command(ws, task_id, action, payload):
        await ws.send(json.dumps({'header': {'action': action, 'task_id': task_id, 'streaming': 'duplex'}, 'payload': payload}))

    @staticmethod
    async def event(ws):
        raw = await asyncio.wait_for(ws.recv(), 30)
        if isinstance(raw, bytes):
            return raw
        event = json.loads(raw)
        if event.get('header', {}).get('event') == 'task-failed':
            # 供应商 error_message 可能含输入、内部路径或凭据，仅展示固定错误。
            raise ServiceError('语音服务拒绝请求，请检查模型权限、额度和音色配置', 502)
        return event

    async def start(self, ws, task, parameters):
        task_id = uuid.uuid4().hex
        await self.command(ws, task_id, 'run-task', {
            'task_group': 'audio', 'task': task,
            'function': 'SpeechSynthesizer' if task == 'tts' else 'recognition',
            'model': self.config.tts_model if task == 'tts' else self.config.asr_model,
            'parameters': parameters, 'input': {},
        })
        event = await self.event(ws)
        if not isinstance(event, dict) or event.get('header', {}).get('event') != 'task-started':
            raise ServiceError('语音服务没有确认任务启动，请重试', 502)
        return task_id

    async def synthesize(self, texts, emit):
        async with self.connection() as ws:
            task_id = await self.start(ws, 'tts', {'text_type': 'PlainText', 'voice': self.config.voice,
                'format': 'pcm', 'sample_rate': 24000, 'word_timestamp_enabled': True})
            async def send_text():
                async for text in texts:
                    await self.command(ws, task_id, 'continue-task', {'input': {'text': text}})
                await self.command(ws, task_id, 'finish-task', {'input': {}})
            sender = asyncio.create_task(send_text())
            audio_received = False
            tail = b''
            try:
                while True:
                    # 发送失败会立即传播，避免接收循环空等超时。
                    receiver = asyncio.create_task(self.event(ws))
                    try:
                        done, _ = await asyncio.wait({sender, receiver}, return_when=asyncio.FIRST_COMPLETED)
                        if sender in done:
                            sender.result()
                        event = await receiver
                    finally:
                        if not receiver.done():
                            receiver.cancel()
                            await asyncio.gather(receiver, return_exceptions=True)
                    if isinstance(event, bytes):
                        pcm = tail + event
                        boundary = len(pcm) - len(pcm) % 2
                        tail = pcm[boundary:]
                        if boundary:
                            audio_received = True
                            await emit('audio', {'pcm': base64.b64encode(pcm[:boundary]).decode(), 'sample_rate': 24000})
                    elif event.get('header', {}).get('event') == 'task-finished':
                        await sender
                        if not audio_received or tail:
                            raise ServiceError('语音服务未返回完整音频，请使用文字或重试', 502)
                        return
                    elif event.get('header', {}).get('event') == 'result-generated':
                        output = event.get('payload', {}).get('output', {})
                        if output.get('sentence', {}).get('words'):
                            await emit('timing', output)
            finally:
                sender.cancel()
                await asyncio.gather(sender, return_exceptions=True)

    async def recognize(self, browser):
        async with self.connection() as ws:
            task_id = await self.start(ws, 'asr', {'format': 'pcm', 'sample_rate': 16000})
            await browser.send_json({'type': 'ready'})
            async def send_audio():
                total = 0
                while True:
                    message = await browser.receive()
                    if message['type'] == 'websocket.disconnect':
                        return
                    audio = message.get('bytes')
                    if audio is not None:
                        total += len(audio)
                        if len(audio) > 32768 or len(audio) % 2 or total > 16000 * 2 * 60:
                            raise ServiceError('录音超过限制，请分段输入', 422)
                        await ws.send(audio)
                    elif json.loads(message.get('text') or '{}').get('type') == 'finish':
                        await self.command(ws, task_id, 'finish-task', {'input': {}})
                        return
                    else:
                        raise ServiceError('录音消息格式无效', 422)
            async def receive_text():
                while True:
                    event = await self.event(ws)
                    if not isinstance(event, dict):
                        raise ServiceError('语音识别响应格式无效', 502)
                    kind = event.get('header', {}).get('event')
                    if kind == 'task-finished':
                        await browser.send_json({'type': 'finished'})
                        return
                    if kind == 'result-generated':
                        sentence = event.get('payload', {}).get('output', {}).get('sentence', {})
                        if not sentence.get('heartbeat'):
                            await browser.send_json({'type': 'transcript', 'sentence_id': sentence.get('sentence_id', sentence.get('begin_time', 0)),
                                'text': sentence.get('text', ''), 'final': bool(sentence.get('sentence_end'))})
            sender, receiver = asyncio.create_task(send_audio()), asyncio.create_task(receive_text())
            try:
                done, _ = await asyncio.wait({sender, receiver}, return_when=asyncio.FIRST_COMPLETED)
                for task in done:
                    task.result()
                if sender in done and browser.client_state.name == 'DISCONNECTED':
                    return
                await receiver
            finally:
                for task in (sender, receiver):
                    task.cancel()
                await asyncio.gather(sender, receiver, return_exceptions=True)


SPEECH_ERRORS = (TimeoutError, OSError, WebSocketException, ValueError, TypeError, KeyError)
