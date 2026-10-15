import * as THREE from 'three';

/**
 * 毛绒材质：同一几何体用 InstancedMesh 画多层外壳（shell texturing），
 * 每层沿法线外推并按三维噪声裁剪，叠出蓬松的绒毛。第 0 层是不裁剪的实心底层。
 * 颜色分区（眼罩、灰斑）用对象空间椭球描述，所有外壳层共用，花纹不会错位。
 */
const NOISE = /* glsl */`
float furHash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float furNoise(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(furHash(i), furHash(i + vec3(1,0,0)), f.x), mix(furHash(i + vec3(0,1,0)), furHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(furHash(i + vec3(0,0,1)), furHash(i + vec3(1,0,1)), f.x), mix(furHash(i + vec3(0,1,1)), furHash(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;

export const MAX_PATCHES = 6;

export function createFurMaterial({ color = '#f3f0eb', length = 0.028, shells = 12, density = 120, gravity = 0.2, patches = [], sheen = 0.8, shellIndex = null, vertexColors = false } = {}) {
  const material = new THREE.MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.92, metalness: 0, sheen, sheenRoughness: 0.55, sheenColor: new THREE.Color('#ffffff'), vertexColors });
  const centers = [], radii = [], colors = [], angles = [];
  for (let i = 0; i < MAX_PATCHES; i++) {
    const patch = patches[i];
    centers.push(new THREE.Vector3(...(patch?.center || [0, 0, 0])));
    radii.push(new THREE.Vector3(...(patch?.radius || [1, 1, 1])));
    colors.push(new THREE.Color(patch?.color || '#000000'));
    angles.push(patch?.angle || 0);
  }
  const uniforms = {
    uFurColor: { value: new THREE.Color(color) },
    uFurLength: { value: length },
    uShells: { value: shells },
    uShellIndex: { value: shellIndex ?? 0 },
    uDensity: { value: density },
    uGravity: { value: gravity },
    uPatchCount: { value: Math.min(patches.length, MAX_PATCHES) },
    uPatchCenter: { value: centers },
    uPatchRadius: { value: radii },
    uPatchColor: { value: colors },
    uPatchAngle: { value: angles },
  };
  material.userData.furUniforms = uniforms;
  material.userData.shells = shells;
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uFurLength; uniform float uShells; uniform float uGravity; uniform float uShellIndex;
varying vec3 vFurPos; varying float vShell; varying float vFurAmount;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
#ifdef USE_INSTANCING
  float furShell = float(gl_InstanceID) / max(uShells - 1.0, 1.0);
#else
  float furShell = uShellIndex / max(uShells - 1.0, 1.0);
#endif
vFurPos = position; vShell = furShell;
// 顶点色 alpha 为毛长系数（嘴巴、鼻头处为 0）。
#ifdef USE_COLOR_ALPHA
  vFurAmount = color.a;
#else
  vFurAmount = 1.0;
#endif
// 用静止姿态的法线外推，蒙皮在之后统一变换，外壳随骨骼一起运动。
transformed += normalize(normal) * uFurLength * furShell * vFurAmount;
transformed.y -= uGravity * uFurLength * furShell * furShell;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uFurColor; uniform float uDensity; uniform int uPatchCount;
uniform vec3 uPatchCenter[${MAX_PATCHES}]; uniform vec3 uPatchRadius[${MAX_PATCHES}]; uniform vec3 uPatchColor[${MAX_PATCHES}]; uniform float uPatchAngle[${MAX_PATCHES}];
varying vec3 vFurPos; varying float vShell; varying float vFurAmount;
${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float furA = furNoise(vFurPos * uDensity);
float furB = furNoise(vFurPos * uDensity * 2.7 + 11.3);
float strand = furA * 0.6 + furB * 0.4;
if (vShell > 0.001 && (strand < 0.06 + vShell * 0.62 || vFurAmount < 0.15)) discard;
vec3 furBase = uFurColor;
for (int i = 0; i < ${MAX_PATCHES}; i++) {
  if (i >= uPatchCount) break;
  // 逐像素计算花色边界（可绕 z 轴倾斜），比顶点色清晰，边缘只带少量绒毛起伏。
  vec3 q = vFurPos - uPatchCenter[i];
  float ca = cos(uPatchAngle[i]), sa = sin(uPatchAngle[i]);
  q.xy = vec2(q.x * ca + q.y * sa, -q.x * sa + q.y * ca);
  float d = length(q / uPatchRadius[i]);
  furBase = mix(furBase, uPatchColor[i], 1.0 - smoothstep(0.9, 1.0, d));
}
// 底层更暗，模拟绒毛间的自遮挡；尖端略亮。
diffuseColor.rgb *= furBase * mix(0.8, 1.04, pow(vShell, 0.6));
// alpha 通道存的是毛长，不是透明度；画布透明背景下必须写回不透明。
diffuseColor.a = 1.0;`);
  };
  material.customProgramCacheKey = () => 'pet-fur-v1';
  return material;
}

/** 生成带毛绒外壳的部件；几何体应已烘焙缩放，网格自身不再非等比缩放。 */
export function furMesh(geometry, options = {}) {
  const material = createFurMaterial(options);
  const shells = material.userData.shells;
  const mesh = new THREE.InstancedMesh(geometry, material, shells);
  const identity = new THREE.Matrix4();
  for (let i = 0; i < shells; i++) mesh.setMatrixAt(i, identity);
  mesh.instanceMatrix.needsUpdate = true;
  // 外壳沿法线外推，包围球需放大，避免被视锥误裁。
  geometry.computeBoundingSphere();
  mesh.frustumCulled = false;
  mesh.userData.fur = true;
  return mesh;
}

/** 椭球几何：缩放烘焙进顶点，法线同步修正。 */
export function ellipsoid(rx, ry, rz, widthSegments = 40, heightSegments = 28) {
  return new THREE.SphereGeometry(1, widthSegments, heightSegments).scale(rx, ry, rz);
}
