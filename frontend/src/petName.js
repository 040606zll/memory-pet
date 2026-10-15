const DEFAULT_NAME = '小忆';

/** 与后端名字字段保持一致，只接收明确的结构化昵称，不解析聊天或记忆正文。 */
export function validPetName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && Array.from(name).length <= 12 && !/[\u0000-\u001f\u007f-\u009f]/u.test(name) ? name : null;
}

/** 登录账号隔离昵称；旧全局键仅兼容独立预览，不分配给任意账号。 */
export function petNameKey(accountId) {
  return accountId ? `memory-pet-name:${encodeURIComponent(accountId)}` : 'memory-pet-name';
}

export function readPetName(key) {
  try { return validPetName(localStorage.getItem(key)) || DEFAULT_NAME; }
  catch { return DEFAULT_NAME; }
}

export function savePetName(key, name) {
  try { localStorage.setItem(key, name); }
  catch { /* 浏览器禁止存储时，本次会话仍保留昵称。 */ }
}
