"""SSE 编排，文本生成与合成并行，断连取消所有上游任务。"""
import asyncio
import json

from .errors import ServiceError
from .speech import SPEECH_ERRORS


async def chat_events(service, speech, connection, session_id, body, voice=False):
    events, texts = asyncio.Queue(maxsize=32), asyncio.Queue()
    voice_failed = False

    async def emit(kind, data):
        await events.put((kind, data))

    async def deltas(text):
        await emit('delta', {'text': text})
        if voice and not voice_failed:
            texts.put_nowait(text)

    async def text_source():
        while True:
            text = await texts.get()
            if text is None:
                return
            yield text

    async def audio():
        nonlocal voice_failed
        try:
            # 等待第一个字后再占用供应商任务，避免模型首字慢导致 TTS 空闲超时。
            first = await texts.get()
            if first is None:
                return
            async def source():
                yield first
                async for text in text_source():
                    yield text
            await speech.synthesize(source(), emit)
        except (ServiceError, *SPEECH_ERRORS):
            voice_failed = True
            await emit('voice_error', {'message': '语音播放暂不可用，已继续显示文字。'})

    async def produce():
        audio_task = asyncio.create_task(audio()) if voice else None
        try:
            async with asyncio.timeout(180):
                result = await service.chat(connection, session_id, body, on_delta=deltas)
                texts.put_nowait(None)
                if audio_task:
                    await audio_task
                await emit('done', result)
        except ServiceError as error:
            await emit('error', {'message': error.message, 'status': error.status})
        except Exception:
            await emit('error', {'message': '对话流中断，请重试这条消息。', 'status': 502})
        finally:
            if audio_task:
                audio_task.cancel()
                await asyncio.gather(audio_task, return_exceptions=True)

    producer = asyncio.create_task(produce())
    try:
        while True:
            try:
                kind, data = await asyncio.wait_for(events.get(), 10)
            except TimeoutError:
                yield ': keepalive\n\n'
                continue
            yield 'event: ' + kind + '\ndata: ' + json.dumps(data, ensure_ascii=False) + '\n\n'
            if kind in {'done', 'error'}:
                return
    finally:
        producer.cancel()
        await asyncio.gather(producer, return_exceptions=True)
