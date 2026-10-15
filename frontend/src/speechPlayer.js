import { diffChars } from 'diff';

// 合成器的时间戳针对规范化读法（100 → 一百）；位置映射保留页面原文。
function originalBoundaries(original, normalized) {
  const boundaries = [0];
  let source = 0, target = 0;
  for (const part of diffChars(original, normalized)) {
    if (part.removed) { source += part.value.length; continue; }
    for (const char of part.value) {
      if (!part.added) source += char.length;
      target += char.length; boundaries[target] = source;
    }
  }
  return boundaries;
}

/** PCM 连续调度；文字进度使用音频设备时钟，网络停顿不推进字幕。 */
export class SpeechPlayer {
  constructor(onText, AudioContextClass = window.AudioContext || window.webkitAudioContext) {
    if (!AudioContextClass) throw new Error('当前浏览器不支持语音播放，请关闭语音后重试。');
    this.context = new AudioContextClass();
    this.onText = onText;
    this.text = ''; this.words = new Map(); this.segments = []; this.sources = new Set();
    this.sentences = new Map(); this.sentenceCursor = 0;
    this.samples = 0; this.end = 0; this.stopped = false; this.visible = 0;
    this.timer = setInterval(() => this.tick(), 30);
  }
  async unlock() {
    await this.context.resume();
    if (this.context.state !== 'running') throw new Error('浏览器未允许播放声音，请重新点击发送。');
  }
  appendText(text) { this.text += text; }
  timing(output) {
    const sentenceId = output.sentence?.index;
    if (!this.sentences.has(sentenceId) && typeof output.original_text === 'string' && typeof output.normalized_text === 'string') {
      const start = this.text.indexOf(output.original_text, this.sentenceCursor);
      if (start >= 0) {
        this.sentences.set(sentenceId, { start, text: output.normalized_text, boundaries: originalBoundaries(output.original_text, output.normalized_text) });
        this.sentenceCursor = start + output.original_text.length;
      }
    }
    const sentence = this.sentences.get(sentenceId);
    let cursor = 0;
    for (const word of output.sentence?.words || []) {
      if (typeof word.text === 'string' && Number.isFinite(word.begin_time)) {
        let sourceEnd;
        if (sentence) {
          const index = sentence.text.indexOf(word.text, cursor);
          if (index >= 0) {
            cursor = index + word.text.length;
            sourceEnd = sentence.start + sentence.boundaries[cursor];
          }
        }
        this.words.set(`${output.sentence.index}:${word.begin_index}:${word.begin_time}`, { ...word, sourceEnd });
      }
    }
    this.tick();
  }
  push({ pcm, sample_rate }) {
    if (this.stopped) return;
    if (sample_rate !== 24000) throw new Error('语音采样率无效。');
    const raw = atob(pcm);
    if (!raw.length || raw.length % 2) throw new Error('语音数据不完整，请重试。');
    const buffer = this.context.createBuffer(1, raw.length / 2, sample_rate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < channel.length; i++) {
      const v = raw.charCodeAt(i * 2) | (raw.charCodeAt(i * 2 + 1) << 8);
      channel[i] = (v >= 32768 ? v - 65536 : v) / 32768;
    }
    const start = Math.max(this.end, this.context.currentTime + 0.04);
    this.segments.push({ start, end: start + buffer.duration, offset: this.samples / sample_rate });
    this.samples += channel.length;
    this.end = start + buffer.duration;
    const source = this.context.createBufferSource();
    source.buffer = buffer; source.connect(this.context.destination);
    source.onended = () => { this.sources.delete(source); source.disconnect(); };
    this.sources.add(source); source.start(start);
  }
  playedMs() {
    let played = 0;
    for (const segment of this.segments) {
      if (this.context.currentTime < segment.start) break;
      played = segment.offset + Math.min(this.context.currentTime, segment.end) - segment.start;
    }
    return played * 1000;
  }
  tick() {
    if (this.stopped || !this.segments.length || this.context.currentTime < this.segments[0].start) return;
    const ms = this.playedMs();
    let cursor = 0, visible = 0;
    for (const word of [...this.words.values()].sort((a, b) => a.begin_time - b.begin_time)) {
      if (Number.isFinite(word.sourceEnd)) cursor = word.sourceEnd;
      else {
        const index = this.text.indexOf(word.text, cursor);
        if (index < 0) continue;
        cursor = index + word.text.length;
      }
      if (word.begin_time <= ms) visible = cursor;
    }
    if (visible > this.visible) { this.visible = visible; this.onText(this.text.slice(0, visible)); }
  }
  async finish(signal) {
    if (!this.samples) throw new Error('语音服务没有返回音频，请重试或关闭语音。');
    while (!this.stopped && this.context.currentTime < this.end) {
      if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    if (this.stopped || signal?.aborted) throw new DOMException('已取消', 'AbortError');
    this.onText(this.text);
  }
  stop() {
    if (this.stopped) return;
    this.stopped = true; clearInterval(this.timer);
    for (const source of this.sources) { source.stop(); source.disconnect(); }
    this.sources.clear();
    this.context.close().catch(() => {});
  }
}
