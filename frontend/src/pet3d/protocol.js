/**
 * 3D 宠物驱动协议：服务端（或本地 mock）下发指令，前端上报交互事件。
 * 字段约定见 docs/2026-10-15/3D宠物/API接口文档.md，修改时两边同步。
 */

/** 动作目录：label 用于页面状态，posture 为动作期间的姿态，duration 为默认毫秒数。 */
export const PET_ACTIONS = {
  idle: { label: '正在陪着你', posture: null, duration: 0 },
  // 与聊天接口 assistant_message.actions 同名，旧动作直接映射。
  blink: { label: '眨眨眼', posture: null, duration: 900 },
  wave: { label: '向你挥手', posture: 'sit', duration: 2400 },
  nod: { label: '点点头', posture: null, duration: 1600 },
  shake_head: { label: '摇摇头', posture: null, duration: 1600 },
  stretch: { label: '正在伸懒腰', posture: null, duration: 3000 },
  happy: { label: '开心地蹦跳', posture: null, duration: 2200 },
  sleep: { label: '正在打盹', posture: 'sleep', duration: 9000 },
  wag_tail: { label: '开心地摇尾巴', posture: null, duration: 2600 },
  // 3D 版新增动作。
  sit: { label: '乖乖坐下', posture: 'sit', duration: 4000 },
  lie_down: { label: '趴下休息', posture: 'lie', duration: 5000 },
  shake_paw: { label: '和你握手', posture: 'sit', duration: 2600 },
  roll_over: { label: '打个滚', posture: 'lie', duration: 2600 },
  spin: { label: '转圈圈', posture: null, duration: 1800 },
  beg: { label: '作揖讨好', posture: 'sit', duration: 2800 },
  bark: { label: '汪汪叫', posture: null, duration: 1400 },
  pet_head: { label: '被摸得好舒服', posture: null, duration: 2200 },
  poke: { label: '被戳了一下', posture: null, duration: 1100 },
  tickle: { label: '笑得打滚', posture: null, duration: 1800 },
  eat: { label: '正在吃东西', posture: null, duration: 4200 },
  drink: { label: '正在喝牛奶', posture: null, duration: 3600 },
  fetch: { label: '去捡球', posture: null, duration: 0, internal: true },
  walk: { label: '跑过去啦', posture: null, duration: 0, internal: true },
  sniff: { label: '东闻闻西闻闻', posture: null, duration: 2200 },
  look_around: { label: '好奇地张望', posture: null, duration: 2400 },
  scratch: { label: '挠挠痒', posture: 'sit', duration: 2200 },
  yawn: { label: '打了个哈欠', posture: null, duration: 2000 },
  wake_up: { label: '醒过来啦', posture: null, duration: 1600 },
};

export const POSTURES = ['stand', 'sit', 'lie', 'sleep'];
export const EMOTIONS = ['neutral', 'happy', 'excited', 'love', 'sad', 'sleepy', 'curious', 'surprised', 'angry'];
export const FOODS = {
  bone: { label: '骨头', action: 'eat', hunger: 22, mood: 6 },
  jerky: { label: '肉干', action: 'eat', hunger: 14, mood: 10 },
  milk: { label: '牛奶', action: 'drink', hunger: 10, mood: 6, energy: 6 },
};
export const COMMANDS = {
  sit: '坐下', shake_paw: '握手', lie_down: '趴下', roll_over: '打滚', spin: '转圈', beg: '作揖', bark: '叫一声', wave: '挥挥手',
};
export const INTERACTIONS = ['pet_head', 'stroke', 'poke', 'tickle', 'feed', 'throw_ball', 'fetch_done', 'command', 'sleep', 'wake'];

const clampDuration = value => Math.max(300, Math.min(20000, Number(value) || 0));
const finite = value => typeof value === 'number' && Number.isFinite(value);

/** 校验并规范化一条下发指令；无法识别的返回 null，页面忽略而不报错。 */
export function normalizeCommand(raw) {
  if (!raw || typeof raw !== 'object') return null;
  // 兼容聊天接口的旧格式 {name, trigger, duration_ms}。
  const type = raw.type || (raw.name ? 'action' : '');
  switch (type) {
    case 'action': {
      const spec = PET_ACTIONS[raw.name];
      if (!spec || raw.name === 'idle') return null;
      // 无固定时长的内部动作由页面流程驱动；服务端要求捡球时改用 spawn ball。
      if (spec.internal) return raw.name === 'fetch' ? { type: 'spawn', item: 'ball' } : null;
      const trigger = ['explicit', 'emotion', 'idle', 'server'].includes(raw.trigger) ? raw.trigger : 'emotion';
      const duration_ms = raw.duration_ms ? clampDuration(raw.duration_ms) : spec.duration;
      return { type, name: raw.name, trigger, duration_ms, params: raw.params && typeof raw.params === 'object' ? raw.params : {} };
    }
    case 'emotion':
      return EMOTIONS.includes(raw.name) ? { type, name: raw.name, intensity: finite(raw.intensity) ? Math.max(0, Math.min(1, raw.intensity)) : 0.7, duration_ms: clampDuration(raw.duration_ms || 6000) } : null;
    case 'posture':
      return POSTURES.includes(raw.name) ? { type, name: raw.name } : null;
    case 'lookAt': {
      const target = raw.target === 'user' || raw.target === 'item' ? raw.target
        : raw.target && ['x', 'y', 'z'].every(key => finite(raw.target[key])) ? { x: raw.target.x, y: raw.target.y, z: raw.target.z } : null;
      return target ? { type, target, duration_ms: clampDuration(raw.duration_ms || 2500) } : null;
    }
    case 'say':
      return typeof raw.text === 'string' && raw.text.trim() ? { type, text: raw.text.trim().slice(0, 80), duration_ms: clampDuration(raw.duration_ms || 4000) } : null;
    case 'stats': {
      const stats = {};
      for (const key of ['hunger', 'mood', 'energy', 'affection']) if (finite(raw[key])) stats[key] = Math.max(0, Math.min(100, raw[key]));
      return Object.keys(stats).length ? { type, ...stats } : null;
    }
    case 'spawn':
      return FOODS[raw.item] || raw.item === 'ball' ? { type, item: raw.item } : null;
    default:
      return null;
  }
}

/** 规范化一批指令，支持单条、数组或 {commands:[...]}。 */
export function normalizeCommands(input) {
  const list = Array.isArray(input) ? input : Array.isArray(input?.commands) ? input.commands : input ? [input] : [];
  return list.map(normalizeCommand).filter(Boolean);
}

/** 构造上报给服务端的交互事件。 */
export function interactionEvent(kind, detail = {}, now = Date.now()) {
  return { type: 'interaction', kind, detail, at: new Date(now).toISOString() };
}
