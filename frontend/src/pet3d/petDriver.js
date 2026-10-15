import { api, post } from '../api.js';
import { API_BASE_URL } from '../config.js';

// 驱动通道：'mock' 为本地模拟（服务端未实现时使用）；'http' 走预留的 /pet/* 接口。
export const PET_DRIVER_MODE = 'mock';
import { FOODS, COMMANDS, interactionEvent, normalizeCommands } from './protocol.js';

/**
 * 宠物驱动：页面只与 PetDriver 交互，具体通道由 transport 决定。
 * - mock：本地模拟服务端反应，状态值存浏览器，供服务端实现前联调。
 * - http：预留的真实接口，见 docs/2026-10-15/3D宠物/API接口文档.md。
 */
export class PetDriver {
  constructor(transport) {
    this.transport = transport;
    this.listeners = new Set();
    this.disconnect = null;
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  dispatch(input) {
    const commands = normalizeCommands(input);
    if (commands.length) this.listeners.forEach(listener => listener(commands));
    return commands;
  }
  connect() { this.disconnect = this.transport.connect?.(commands => this.dispatch(commands)) || null; }
  /** 上报交互；服务端（或 mock）可返回一组指令让宠物继续反应。 */
  async report(kind, detail = {}, stats) {
    try {
      const reply = await this.transport.sendEvent(interactionEvent(kind, detail), stats);
      return this.dispatch(reply);
    } catch { return []; }
  }
  loadState() { return this.transport.loadState().catch(() => null); }
  saveState(stats) { return this.transport.saveState(stats).catch(() => null); }
  dispose() { this.disconnect?.(); this.listeners.clear(); }
}

const pick = (list, random) => list[Math.floor(random() * list.length) % list.length];

/** 本地模拟：按交互类型给出服务端风格的指令和状态变化，不发任何网络请求。 */
export class MockPetTransport {
  constructor({ storageKey = 'memory-pet:pet3d', random = Math.random, storage = globalThis.localStorage } = {}) {
    this.storageKey = storageKey; this.random = random; this.storage = storage;
  }
  async loadState() {
    try { const value = JSON.parse(this.storage?.getItem(this.storageKey) || 'null'); return value?.stats ? value : null; }
    catch { return null; }
  }
  async saveState(stats) {
    try { this.storage?.setItem(this.storageKey, JSON.stringify({ stats, saved_at: new Date().toISOString() })); } catch { /* 隐私模式无存储时忽略 */ }
    return { stats };
  }
  async sendEvent(event, stats = {}) {
    const say = text => ({ type: 'say', text, duration_ms: 3200 });
    const random = this.random;
    switch (event.kind) {
      case 'pet_head':
      case 'stroke':
        return [{ type: 'emotion', name: 'love', intensity: 0.9, duration_ms: 5000 }, say(pick(['好舒服呀～', '再摸摸嘛', '最喜欢你了！'], random))];
      case 'poke':
        return [{ type: 'emotion', name: 'surprised', intensity: 0.8, duration_ms: 2000 }, say(pick(['哎呀！', '嘿，好痒！', '你戳我干嘛～'], random))];
      case 'tickle':
        return [{ type: 'emotion', name: 'excited', intensity: 1, duration_ms: 4000 }, say('哈哈哈好痒！')];
      case 'feed': {
        const food = FOODS[event.detail?.item];
        if (!food) return [];
        if ((stats.hunger ?? 50) > 92) return [{ type: 'action', name: 'shake_head', trigger: 'server' }, say('我已经吃饱啦～')];
        return [{ type: 'emotion', name: 'happy', intensity: 0.9, duration_ms: 6000 }, say(`${food.label}真好吃！`)];
      }
      case 'throw_ball':
        return [{ type: 'emotion', name: 'excited', intensity: 1, duration_ms: 6000 }];
      case 'fetch_done':
        return [{ type: 'action', name: 'wag_tail', trigger: 'server' }, say('我捡回来啦！再扔一次？')];
      case 'command':
        return COMMANDS[event.detail?.name] ? [say(pick(['看我的！', '好嘞！', '没问题～'], random))] : [];
      case 'sleep':
        return [say('晚安…')];
      case 'wake':
        return [{ type: 'emotion', name: 'happy', duration_ms: 3000 }, say('早呀！')];
      default:
        return [];
    }
  }
  connect() { return () => {}; }
}

/** 预留的服务端通道：REST 上报 + SSE 下发。服务端就绪后把 PET_DRIVER_MODE 改为 'http'。 */
export class HttpPetTransport {
  async loadState() { return api('/pet/state'); }
  async saveState(stats) { return api('/pet/state', { method: 'PUT', body: JSON.stringify({ stats }) }); }
  async sendEvent(event, stats) {
    const result = await post('/pet/interactions', { ...event, stats });
    return result?.commands || [];
  }
  connect(onCommands) {
    if (typeof EventSource === 'undefined') return () => {};
    const source = new EventSource(`${API_BASE_URL.replace(/\/+$/, '')}/pet/events`, { withCredentials: true });
    source.onmessage = message => { try { onCommands(JSON.parse(message.data)); } catch { /* 忽略无法解析的推送 */ } };
    return () => source.close();
  }
}

export function createPetDriver({ userId = 'anonymous', mode = PET_DRIVER_MODE } = {}) {
  const transport = mode === 'http' ? new HttpPetTransport() : new MockPetTransport({ storageKey: `memory-pet:pet3d:${userId}` });
  return new PetDriver(transport);
}
