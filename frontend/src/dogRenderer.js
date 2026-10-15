import { DOG, deform } from './dogMotion.js';

const vertex = `#version 300 es
in vec2 aPosition;
in vec2 aOriginal;
uniform vec2 uResolution;
uniform vec2 uOffset;
uniform float uScale;
out vec2 vOriginal;
void main() {
  vec2 p=(aPosition-vec2(112.0,128.0))*uScale+uOffset;
  gl_Position=vec4(p.x/uResolution.x*2.0-1.0,1.0-p.y/uResolution.y*2.0,0.0,1.0);
  vOriginal=aOriginal;
}`;
const fragment = `#version 300 es
precision highp float;
uniform sampler2D uDog;
uniform sampler2D uOriginal;
uniform float uBlink;
in vec2 vOriginal;
out vec4 outColor;
void main() {
  vec2 size=vec2(706.0,500.0);
  vec4 color=texture(uDog,vOriginal/size);
  // 将原来的LED眼部纹理连续压缩，闭眼时周边仍使用同一脸部纹理。
  vec2 eye=vec2(231.0,201.0);
  vec2 d=vOriginal-eye;
  if(uBlink>0.0001 && length(d)<21.0 && color.a>.99) {
    float openness=max(.065,1.0-uBlink);
    vec2 samplePoint=eye+vec2(d.x,d.y/openness);
    vec3 face=texture(uOriginal,vec2(207.0,201.0+d.y*.3)/size).rgb;
    float visible=1.0-smoothstep(18.0,21.0,length(samplePoint-eye));
    vec3 squeezed=mix(face,texture(uOriginal,samplePoint/size).rgb,visible);
    float edge=(1.0-smoothstep(18.0,21.0,length(d)))*smoothstep(0.0,.06,uBlink);
    color.rgb=mix(color.rgb,squeezed,edge);
  }
  outColor=color;
}`;

/** 网格仅上传一次索引与原始UV；每帧更新共用顶点，无分层图像换帧和接缝。 */
export function createDogMesh(step = 6) {
  const { x, y, width, height } = DOG.crop;
  const columns = Math.ceil(width / step), rows = Math.ceil(height / step);
  const original = [], indices = [];
  for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) original.push(x + col * width / columns, y + row * height / rows);
  for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    const a = row * (columns + 1) + col, b = a + 1, c = a + columns + 1, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { original: new Float32Array(original), positions: new Float32Array(original), indices: new Uint16Array(indices) };
}

export function drawingSize(canvas, dpr = window.devicePixelRatio || 1) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  const ratio = Math.min(Math.max(dpr, 1), 2);
  return { width: Math.max(1, Math.round(rect.width * ratio)), height: Math.max(1, Math.round(rect.height * ratio)) };
}

export class DogRenderer {
  constructor(canvas, image, { diagnose = false, maskImage } = {}) {
    if (!maskImage) throw new Error('机器狗透明轮廓尚未加载。');
    this.canvas = canvas; this.diagnose = diagnose; this.mesh = createDogMesh();
    this.stats = { frames: 0, blankFrames: 0, resizes: 0 };
    const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('当前浏览器无法打开机器狗动画，请开启硬件加速后重试。');
    this.gl = gl; this.resources = { buffers: [], textures: [], shaders: [] };
    const compile = (type, source) => {
      const shader = gl.createShader(type); this.resources.shaders.push(shader);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) { this.dispose(); throw new Error('机器狗动画着色器加载失败。'); }
      return shader;
    };
    const program = gl.createProgram(); this.program = program;
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex)); gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) { this.dispose(); throw new Error('机器狗动画渲染器加载失败。'); }
    gl.useProgram(program);
    const buffer = (name, data, usage) => {
      const value = gl.createBuffer(); this.resources.buffers.push(value); gl.bindBuffer(gl.ARRAY_BUFFER, value);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      const location = gl.getAttribLocation(program, name); gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
      return value;
    };
    buffer('aOriginal', this.mesh.original, gl.STATIC_DRAW);
    this.positionBuffer = buffer('aPosition', this.mesh.positions, gl.DYNAMIC_DRAW);
    const index = gl.createBuffer(); this.resources.buffers.push(index); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.mesh.indices, gl.STATIC_DRAW);
    const mask = document.createElement('canvas'); mask.width = 706; mask.height = 500;
    const context = mask.getContext('2d');
    const from = DOG.maskBounds, to = DOG.subjectBounds;
    // 只使用生成抠图的alpha；所有RGB仍来自原型，不使用生成的近似角色。
    // 限定有效主体框，外围低透明度散点不会被带入房间。
    context.drawImage(maskImage, from.x, from.y, from.width, from.height, to.x, to.y, to.width, to.height);
    context.globalCompositeOperation = 'source-in'; context.drawImage(image, 0, 0);
    const texture = (name, source, slot) => {
      const value = gl.createTexture(); this.resources.textures.push(value); gl.activeTexture(gl.TEXTURE0 + slot); gl.bindTexture(gl.TEXTURE_2D, value);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source); gl.uniform1i(gl.getUniformLocation(program, name), slot);
    };
    texture('uDog', mask, 0); texture('uOriginal', image, 1);
    this.uniforms = Object.fromEntries(['uResolution','uOffset','uScale','uBlink'].map(name => [name, gl.getUniformLocation(program, name)]));
  }
  draw(pose) {
    const { gl, canvas, mesh } = this;
    const size = drawingSize(canvas);
    // 隐藏布局保留上一帧；尺寸通知不能把画布设置成零或重复清空。
    if (!size) return false;
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width; canvas.height = size.height; this.stats.resizes++;
    }
    gl.viewport(0, 0, size.width, size.height); gl.useProgram(this.program);
    const scale = Math.min(size.width / DOG.crop.width, size.height / DOG.crop.height);
    const offset = [(size.width - DOG.crop.width * scale) / 2, size.height - DOG.crop.height * scale];
    gl.uniform2f(this.uniforms.uResolution, size.width, size.height); gl.uniform2f(this.uniforms.uOffset, ...offset); gl.uniform1f(this.uniforms.uScale, scale); gl.uniform1f(this.uniforms.uBlink, pose.blink);
    for (let i = 0; i < mesh.original.length; i += 2) {
      const point = deform(mesh.original[i], mesh.original[i + 1], pose); mesh.positions[i] = point[0]; mesh.positions[i + 1] = point[1];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer); gl.bufferSubData(gl.ARRAY_BUFFER, 0, mesh.positions);
    // 清理与完整绘制在同一次帧回调内完成，交互期间不改canvas身份或可见性。
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawElements(gl.TRIANGLES, mesh.indices.length, gl.UNSIGNED_SHORT, 0);
    this.stats.frames++;
    if (this.diagnose) {
      const point = deform(253, 241, pose), pixel = new Uint8Array(4);
      const px = Math.round((point[0] - DOG.crop.x) * scale + offset[0]);
      const py = size.height - 1 - Math.round((point[1] - DOG.crop.y) * scale + offset[1]);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      if (pixel[3] === 0) this.stats.blankFrames++;
    }
    return true;
  }
  dispose() {
    const { gl, resources } = this;
    resources.buffers.forEach(value => gl.deleteBuffer(value)); resources.textures.forEach(value => gl.deleteTexture(value)); resources.shaders.forEach(value => gl.deleteShader(value)); gl.deleteProgram(this.program);
  }
}
