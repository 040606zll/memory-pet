import { beforeEach, expect, it, vi } from 'vitest';
import { DogRenderer, drawingSize } from '../src/dogRenderer.js';

const zero = { head: 0, headY: 0, body: 0, paw: 0, tail: 0, ear: 0, blink: 0 };
let canvas, gl, rect;
beforeEach(() => {
  rect = { width: 500, height: 544 };
  const methods = ['createShader','shaderSource','compileShader','getShaderParameter','createProgram','attachShader','linkProgram','getProgramParameter','useProgram','createBuffer','bindBuffer','bufferData','getAttribLocation','enableVertexAttribArray','vertexAttribPointer','createTexture','activeTexture','bindTexture','texParameteri','texImage2D','uniform1i','getUniformLocation','viewport','uniform2f','uniform1f','bufferSubData','clearColor','clear','drawElements','readPixels','deleteBuffer','deleteTexture','deleteShader','deleteProgram'];
  gl = Object.fromEntries(methods.map(name => [name, vi.fn(() => ({}))]));
  gl.getShaderParameter.mockReturnValue(true); gl.getProgramParameter.mockReturnValue(true);
  gl.readPixels.mockImplementation((x,y,w,h,format,type,pixel) => { pixel[3] = 255; });
  const maskContext = Object.fromEntries(['beginPath','lineTo','moveTo','closePath','clip','drawImage'].map(name => [name, vi.fn()]));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(type => type === 'webgl2' ? gl : maskContext);
  canvas = document.createElement('canvas'); canvas.getBoundingClientRect = () => rect;
});
it('连续动作绘制和相同尺寸通知不重复清空绘图缓冲区', () => {
  const renderer = new DogRenderer(canvas, new Image(), { diagnose: true, maskImage: new Image() });
  for (let frame = 0; frame < 120; frame++) renderer.draw({ ...zero, head: .03 * Math.sin(frame / 20) });
  expect(renderer.stats).toEqual({ frames: 120, blankFrames: 0, resizes: 1 });
  expect(gl.drawElements).toHaveBeenCalledTimes(120);
  expect(gl.texImage2D).toHaveBeenCalledTimes(2);
  expect(gl.clear).toHaveBeenCalledTimes(120);
  expect(gl.readPixels).toHaveBeenCalledTimes(120);
  rect = { width: 501, height: 544 }; renderer.draw(zero);
  expect(renderer.stats.resizes).toBe(2);
});
it('隐藏或零尺寸布局保留上一帧，恢复相同尺寸不重新设置画布', () => {
  const renderer = new DogRenderer(canvas, new Image(), { maskImage: new Image() }); renderer.draw(zero);
  rect = { width: 0, height: 0 };
  expect(renderer.draw(zero)).toBe(false); expect(canvas.width).toBe(500); expect(canvas.height).toBe(544);
  expect(gl.clear).toHaveBeenCalledTimes(1);
  rect = { width: 500, height: 544 }; renderer.draw(zero);
  expect(renderer.stats.resizes).toBe(1);
});
it('真实空白像素计入诊断，资源在卸载时释放', () => {
  gl.readPixels.mockImplementation(() => {});
  const renderer = new DogRenderer(canvas, new Image(), { diagnose: true, maskImage: new Image() }); renderer.draw(zero);
  expect(renderer.stats.blankFrames).toBe(1);
  renderer.dispose(); expect(gl.deleteBuffer).toHaveBeenCalledTimes(3); expect(gl.deleteTexture).toHaveBeenCalledTimes(2); expect(gl.deleteProgram).toHaveBeenCalledTimes(1);
});
it('像素密度上限为2，尺寸取整避免亚像素抖动引起反复重建', () => {
  rect = { width: 500.1, height: 544.1 };
  expect(drawingSize(canvas, 3)).toEqual({ width: 1000, height: 1088 });
});
it('GPU不可用或资源编译失败时明确报错', () => {
  expect(() => new DogRenderer(canvas, new Image())).toThrow('透明轮廓');
  gl.getShaderParameter.mockReturnValue(false);
  expect(() => new DogRenderer(canvas, new Image(), { maskImage: new Image() })).toThrow('着色器');
  gl.getShaderParameter.mockReturnValue(true); gl.getProgramParameter.mockReturnValue(false);
  expect(() => new DogRenderer(canvas, new Image(), { maskImage: new Image() })).toThrow('渲染器');
  canvas.getContext = () => null;
  expect(() => new DogRenderer(canvas, new Image(), { maskImage: new Image() })).toThrow('硬件加速');
});
it('系统未提供像素倍率时以标准像素尺寸绘制', () => {
  vi.stubGlobal('devicePixelRatio', 0);
  try { expect(drawingSize(canvas)).toEqual({ width: 500, height: 544 }); }
  finally { vi.unstubAllGlobals(); }
});
