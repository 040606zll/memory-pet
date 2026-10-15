import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });
Object.defineProperty(window, 'matchMedia', { value: vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })), writable: true });
HTMLDialogElement.prototype.showModal = function () { this.open = true; };
HTMLDialogElement.prototype.close = function () { this.open = false; };
Element.prototype.scrollTo = function () {};
HTMLCanvasElement.prototype.getContext = vi.fn(() => ({ clearRect() {}, drawImage() {} }));
