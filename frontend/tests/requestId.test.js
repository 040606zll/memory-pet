import { afterEach, expect, it, vi } from 'vitest';
import { newRequestId } from '../src/requestId.js';

afterEach(() => vi.unstubAllGlobals());

it('安全上下文优先使用原生编号', () => {
  const randomUUID = vi.fn(() => 'existing-id');
  vi.stubGlobal('crypto', { randomUUID });
  expect(newRequestId()).toBe('existing-id');
  expect(randomUUID).toHaveBeenCalledOnce();
});

it('HTTP 随机字节按 UUID v4 编码并为不同消息生成独立编号', () => {
  const crypto = globalThis.crypto;
  vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
  const ids = Array.from({ length: 100 }, newRequestId);
  expect(new Set(ids).size).toBe(100);
  for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

it.each([undefined, {}])('缺少随机数能力时提供中文错误', crypto => {
  vi.stubGlobal('crypto', crypto);
  expect(newRequestId).toThrow('浏览器不支持生成消息编号，请更换浏览器后重试。');
});
