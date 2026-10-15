import { expect, it, vi } from 'vitest';
import { readPetName } from '../src/petName.js';

it('浏览器阻止本地存储读取时仍能使用默认宠物名字', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('禁用存储', 'SecurityError'); });
  expect(readPetName('memory-pet-name:alice')).toBe('小忆');
});
