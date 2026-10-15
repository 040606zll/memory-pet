import { expect, it, vi } from 'vitest';
import { api } from '../src/api.js';
import { previewMessages } from '../src/preview.js';
it('HTTP失败只显示中文语义错误，响应解析失败给出清晰提示', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => { throw Error('unexpected'); } })));
  await expect(api('/status')).rejects.toThrow('服务返回了无法识别的响应');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({ code: 500 }) })));
  await expect(api('/status')).rejects.toThrow('请求失败，请稍后重试。');
});
it('原型训练和正式消息独立生成、记忆仅用于明确预览', () => {
  expect(previewMessages('training').at(-1).candidates).toHaveLength(2);
  expect(previewMessages('chat').at(-1).memories[0].content).toBe('喜欢听雨声');
  expect(previewMessages('chat').every(m => !m.candidates)).toBe(true);
});
