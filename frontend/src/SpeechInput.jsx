import { useEffect, useRef, useState } from 'react';
import { Microphone, Stop } from '@phosphor-icons/react';
import { openAsrSocket } from './api.js';

export function SpeechInput({ disabled, value, onChange, onError, onActive, openSocket = openAsrSocket, getMedia }) {
  const [state, setState] = useState('idle');
  const active = useRef(null);
  const mounted = useRef(true);
  function cleanup() {
    const current = active.current;
    active.current = null;
    if (current) {
      clearTimeout(current.timeout);
      current.stream?.getTracks().forEach(track => track.stop());
      current.node?.disconnect(); current.source?.disconnect();
      current.context?.close().catch(() => {});
      current.socket?.close();
    }
    if (mounted.current) { setState('idle'); onActive?.(false); }
  }
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; cleanup(); }; }, []);
  function stop() {
    const current = active.current;
    if (!current || !current.node) { cleanup(); return; }
    setState('finishing');
    current.stream.getTracks().forEach(track => track.stop());
    // 先传输 worklet 的尾包，再通知上游结束。
    current.stopping = true;
    current.node.port.postMessage('flush');
    current.timeout && clearTimeout(current.timeout);
    current.timeout = setTimeout(() => { onError('语音识别结束超时，请重试。'); cleanup(); }, 12000);
  }
  async function start() {
    if (active.current || disabled) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) { onError('语音输入需要 HTTPS 和支持麦克风的浏览器。'); return; }
    const current = { sentences: new Map(), prefix: value, stopping: false };
    active.current = current; setState('connecting'); onActive?.(true);
    try {
      current.context = new (window.AudioContext || window.webkitAudioContext)();
      await current.context.resume();
      if (active.current !== current) return;
      const stream = await (getMedia || navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices))({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      if (active.current !== current) { stream.getTracks().forEach(track => track.stop()); return; }
      current.stream = stream;
      await current.context.audioWorklet.addModule(new URL('./pcm-capture.worklet.js', import.meta.url));
      if (active.current !== current) return;
      const socket = openSocket(); current.socket = socket;
      current.timeout = setTimeout(() => { onError('语音连接超时，请重试。'); cleanup(); }, 15000);
      socket.onmessage = event => {
        if (active.current !== current) return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === 'ready') {
            clearTimeout(current.timeout);
            current.source = current.context.createMediaStreamSource(stream);
            current.node = new AudioWorkletNode(current.context, 'pcm-capture');
            current.node.port.onmessage = event => {
              if (active.current !== current || socket.readyState !== WebSocket.OPEN) return;
              if (socket.bufferedAmount > 128000) { onError('网络较慢，录音已停止，请重试。'); cleanup(); return; }
              if (event.data.byteLength) socket.send(event.data);
              if (current.stopping && event.data.finished) { current.node.disconnect(); current.source.disconnect(); socket.send(JSON.stringify({ type: 'finish' })); current.stopping = false; }
            };
            current.source.connect(current.node); current.node.connect(current.context.destination);
            setState('recording');
            current.timeout = setTimeout(stop, 55000);
          } else if (data.type === 'transcript') {
            current.sentences.set(data.sentence_id, data.text);
            const text = [...current.sentences.entries()].sort((a, b) => a[0] - b[0]).map(([, text]) => text).join('');
            onChange((current.prefix + text).slice(0, 4096));
          } else if (data.type === 'finished') { cleanup(); }
          else if (data.type === 'error') { onError(data.message); cleanup(); }
        } catch { onError('语音识别响应异常，请重试。'); cleanup(); }
      };
      socket.onerror = () => { if (active.current === current) { onError('语音连接失败，请重试或使用文字输入。'); cleanup(); } };
      socket.onclose = () => { if (active.current === current) { onError('语音连接中断，已保留识别文字。'); cleanup(); } };
    } catch (error) {
      if (active.current === current) { onError(({ NotAllowedError: '麦克风权限未开启，请在浏览器中允许访问。', NotFoundError: '未检测到麦克风，请连接设备后重试。', NotReadableError: '麦克风被占用或无法读取，请关闭其他录音程序后重试。' })[error.name] || '无法启动语音输入，请检查麦克风后重试。'); cleanup(); }
    }
  }
  return <button type="button" className={`voice-input ${state !== 'idle' ? 'recording' : ''}`} disabled={disabled && state === 'idle' || state === 'finishing'} aria-label={state === 'idle' ? '开始语音输入' : state === 'finishing' ? '正在完成识别' : '停止语音输入'} onClick={state === 'idle' ? start : stop}>{state === 'idle' ? <Microphone weight="bold" /> : <Stop weight="fill" />}<span>{({ idle: '语音', connecting: '连接中', recording: '停止', finishing: '识别中' })[state]}</span></button>;
}
