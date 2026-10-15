import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { EyeTexture, pawTagTexture, radialTexture } from './eyeTexture.js';
import { createFurMaterial } from './furMaterial.js';
import { EyeRig } from './eyeRig.js';

/**
 * 统一骨架接口（rig）：动画层只操作这些节点。
 *   root, hips, chest, neck, head, jaw, tongue, earL, earR, tail[3],
 *   legs.{fl,fr,bl,br} = [upper, lower], mouthItem（叼东西的挂点）, eyes = { left, right }
 * 模型由 tools/blender/build_dog.py 在 Blender 中生成并导出为 GLB，修改造型后重新运行脚本即可。
 */
export const DOG_MODEL_URL = '/assets/pet3d/puppy.glb';

/**
 * 当前模型：Tripo 生成、由 tools/blender/rig_tripo_dog.py 减面并绑定骨架的贴图模型。
 * 花色、嘴巴、舌头都烘焙在 PBR 贴图里，保留 GLB 自带材质，不叠毛绒外壳。
 */
export const PUPPY_BONE_MAP = {
  hips: 'hips', chest: 'chest', neck: 'neck', head: 'head', jaw: 'jaw', tongue: 'Tongue', earL: 'earL', earR: 'earR',
  tail: ['tail0', 'tail1', 'tail2'],
  legs: { fl: ['flUpper', 'flLower'], fr: ['frUpper', 'frLower'], bl: ['blUpper', 'blLower'], br: ['brUpper', 'brLower'] },
  body: 'DogBody', eyes: { left: 'Eye_L', right: 'Eye_R' }, tag: null,
  mouth: [0, 0.83, 0.68], fur: false,
};

/** 旧模型（tools/blender/build_dog.py 生成的 dog.glb）的骨骼/节点名，保留以便回退。 */
export const GLB_BONE_MAP = {
  hips: 'hips', chest: 'chest', neck: 'neck', head: 'head', jaw: 'jaw', tongue: 'Tongue', earL: 'earL', earR: 'earR',
  tail: ['tail0', 'tail1', 'tail2'],
  legs: { fl: ['flUpper', 'flLower'], fr: ['frUpper', 'frLower'], bl: ['blUpper', 'blLower'], br: ['brUpper', 'brLower'] },
  body: 'DogBody', eyes: { left: 'Eye_L', right: 'Eye_R' }, tag: 'Tag',
  mouth: [0, 0.87, 0.82], fur: true,
};

/**
 * 面部花色在着色器里逐像素绘制：以眼睛实际位置为准放眼罩，嘴巴、口鼻奶油色同理。
 * 坐标为模型静止姿态坐标（x 右、y 上、z 前）。
 */
function facePatches(find, map) {
  const position = name => { const node = find(name); return node ? node.getWorldPosition(new THREE.Vector3()) : null; };
  const left = position(map.eyes.left) || new THREE.Vector3(-0.22, 1.15, 0.72);
  const right = position(map.eyes.right) || new THREE.Vector3(0.22, 1.15, 0.72);
  const mask = '#2b2e34';
  // 按设计图实测：眼罩上下各超出眼心约 0.2、外侧约 0.25，在鼻梁处相连，鼻子贴在眼罩下沿。
  return [
    // 口鼻部位偏奶油色，让脸部有层次（放最前，后面的花色覆盖它）。
    { center: [0, left.y - 0.28, left.z + 0.05], radius: [0.25, 0.18, 0.2], color: '#f2e8da' },
    { center: [left.x - 0.03, left.y - 0.01, left.z - 0.1], radius: [0.25, 0.2, 0.3], color: mask, angle: 0.18 },
    { center: [right.x + 0.03, right.y - 0.01, right.z - 0.1], radius: [0.25, 0.2, 0.3], color: mask, angle: -0.18 },
    // 两眼之间的鼻梁处相连，上缘留出一个小 V 形缺口。
    { center: [0, left.y - 0.08, left.z], radius: [0.13, 0.085, 0.2], color: mask },
    // 张开的笑嘴：深色口腔。
    { center: map.mouth, radius: [0.105, 0.042, 0.14], color: '#5b1f2c' },
  ];
}

const REST_KEYS = ['hips', 'chest', 'neck', 'head', 'jaw', 'tongue', 'earL', 'earR'];

/**
 * 记录每个节点的静止姿态，以及它在模型根坐标系下的朝向。
 * 骨骼在 GLB 里各有自己的轴向；动画按"模型坐标轴"给出旋转，pose() 用这些朝向换算到骨骼本地。
 */
export function captureRest(rig) {
  rig.root.updateMatrixWorld(true);
  const rootInverse = rig.root.getWorldQuaternion(new THREE.Quaternion()).invert();
  const nodes = [...REST_KEYS.map(key => rig[key]), ...rig.tail, ...Object.values(rig.legs).flat()];
  for (const node of nodes) {
    if (!node) continue;
    node.userData.restPosition = node.position.clone();
    node.userData.restQuaternion = node.quaternion.clone();
    node.userData.axis = rootInverse.clone().multiply(node.getWorldQuaternion(new THREE.Quaternion()));
    node.userData.parentAxis = node.parent ? rootInverse.clone().multiply(node.parent.getWorldQuaternion(new THREE.Quaternion())) : new THREE.Quaternion();
  }
}

/** 加载 GLB 并组装 rig：身体换成多层毛绒外壳，眼睛换成表情画布，吊牌加发光爪印。 */
export async function loadDogModel({ url = DOG_MODEL_URL, map = PUPPY_BONE_MAP, shells = 12 } = {}) {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = new THREE.Group(); root.name = 'dog';
  root.add(gltf.scene);
  const find = name => gltf.scene.getObjectByName(name);
  const replaced = [];

  const body = find(map.body);
  if (!body?.isSkinnedMesh) throw new Error('宠物模型缺少蒙皮身体');
  if (!map.fur) {
    body.name = 'dog-body';
    body.frustumCulled = false;
    body.castShadow = body.receiveShadow = true;
  }
  const patches = map.fur ? facePatches(find, map) : [];
  for (let shell = 0; map.fur && shell < shells; shell++) {
    const material = createFurMaterial({ shells, shellIndex: shell, length: 0.024, density: 140, gravity: 0.1, vertexColors: true, sheen: 0.35, patches });
    let mesh = body;
    if (shell === 0) { replaced.push(body.material); body.material = material; }
    else { mesh = new THREE.SkinnedMesh(body.geometry, material); mesh.bind(body.skeleton, body.bindMatrix); body.parent.add(mesh); }
    mesh.name = shell === 0 ? 'dog-body' : 'dog-fur';
    mesh.frustumCulled = false;
    // 实心底层投射阴影，各层接收阴影（耳朵投在脸上、身体投在腿上）。
    mesh.castShadow = shell === 0;
    mesh.receiveShadow = true;
  }

  const eyes = {};
  for (const [key, side] of [['left', -1], ['right', 1]]) {
    const node = find(map.eyes[key]);
    if (!map.fur) {
      // 贴图模型：眼球是独立球体，配三维眼睑和固定反光点（见 eyeRig.js）。
      const ball = node?.isMesh ? node : null;
      if (!ball) throw new Error('宠物模型缺少眼球');
      replaced.push(ball.material);
      eyes[key] = new EyeRig(ball, side);
      continue;
    }
    const eye = new EyeTexture(side);
    node?.traverse(child => {
      if (!child.isMesh) return;
      replaced.push(child.material);
      child.material = new THREE.MeshBasicMaterial({ map: eye.texture, toneMapped: false, transparent: true });
      // 透明角膜：带环境反射的光泽，眼睛显得湿润有神。
      const cornea = new THREE.Mesh(child.geometry, new THREE.MeshPhysicalMaterial({ color: '#06121a', transparent: true, opacity: 0.28, roughness: 0.06, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 1.4, depthWrite: false }));
      cornea.scale.set(1.03, 1.03, 1.25);
      child.add(cornea);
    });
    if (node) {
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: radialTexture('rgba(90,235,255,0.42)', 'rgba(90,235,255,0)'), depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }));
      halo.scale.setScalar(0.3); node.add(halo);
    }
    eyes[key] = eye;
  }

  // 吊牌：正面贴发光爪印，朝向模型正前方。
  root.updateMatrixWorld(true);
  const tag = map.tag ? find(map.tag) : null;
  if (tag) {
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.058, 40), new THREE.MeshBasicMaterial({ map: pawTagTexture(), toneMapped: false }));
    const center = tag.getWorldPosition(new THREE.Vector3());
    tag.add(face);
    face.position.copy(tag.worldToLocal(center.add(new THREE.Vector3(0, 0, 0.014))));
    face.quaternion.copy(tag.getWorldQuaternion(new THREE.Quaternion()).invert()).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2, 0, 0)));
  }

  const jaw = find(map.jaw) || new THREE.Group();
  const mouthItem = new THREE.Group();
  jaw.add(mouthItem);
  mouthItem.position.copy(jaw.worldToLocal(new THREE.Vector3(...map.mouth)));

  const rig = {
    root, hips: find(map.hips), chest: find(map.chest), neck: find(map.neck), head: find(map.head), jaw, tongue: find(map.tongue),
    earL: find(map.earL), earR: find(map.earR), tail: map.tail.map(find),
    legs: Object.fromEntries(Object.entries(map.legs).map(([key, names]) => [key, names.map(find)])), mouthItem, eyes, tag,
  };
  captureRest(rig);
  return {
    object: root, rig,
    dispose: () => {
      const seen = new Set();
      root.traverse(child => {
        if (child.geometry && !seen.has(child.geometry)) { seen.add(child.geometry); child.geometry.dispose(); }
        const materials = Array.isArray(child.material) ? child.material : child.material ? [child.material] : [];
        materials.forEach(material => { material.map?.dispose(); material.dispose(); });
      });
      replaced.forEach(material => material?.dispose());
      eyes.left.dispose(); eyes.right.dispose();
    },
  };
}
