// 保留跨帧采样累积，任意设备采样率转换为 16kHz 单声道 PCM16。
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super(); this.phase = 0; this.sum = 0; this.count = 0; this.chunk = [];
    this.active = true;
    this.port.onmessage = () => { this.active = false; this.flush(); this.port.postMessage({ finished: true }); };
  }
  flush() {
    if (!this.chunk.length) return;
    const pcm = new Int16Array(this.chunk); this.chunk = [];
    this.port.postMessage(pcm.buffer, [pcm.buffer]);
  }
  process(inputs) {
    if (!this.active) return true;
    const input = inputs[0]?.[0];
    if (input) for (const sample of input) {
      this.sum += sample; this.count++; this.phase += 16000;
      if (this.phase >= sampleRate) {
        const value = Math.max(-1, Math.min(1, this.sum / this.count));
        this.chunk.push(Math.round(value * (value < 0 ? 32768 : 32767)));
        this.phase -= sampleRate; this.sum = 0; this.count = 0;
        if (this.chunk.length >= 1600) this.flush();
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
