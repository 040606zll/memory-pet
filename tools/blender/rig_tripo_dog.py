"""
把 Tripo 生成的机器狗模型（tools/blender/source/puppy_tripo.glb，单网格、无骨架、PBR 贴图）
整理成前端可驱动的 GLB：减面、压缩贴图、绑定与 dogModel.js GLB_BONE_MAP 同名的骨架、加表情眼罩片。

运行：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python tools/blender/rig_tripo_dog.py -- [--preview 输出目录] [--faces 80000]

产物：frontend/public/assets/pet3d/puppy.glb
坐标约定同 build_dog.py：脚本内用"前端坐标"（x 右、y 上、z 朝前），V() 转成 Blender 坐标。
骨骼位置以原始模型（高 0.897）实测，乘 SCALE 放大到与旧模型同高（约 1.66），相机和动作幅度无需改动。
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SOURCE = os.path.join(ROOT, 'tools', 'blender', 'source', 'puppy_tripo.glb')
OUTPUT = os.path.join(ROOT, 'frontend', 'public', 'assets', 'pet3d', 'puppy.glb')
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
PREVIEW = args[args.index('--preview') + 1] if '--preview' in args else None
TARGET_FACES = int(args[args.index('--faces') + 1]) if '--faces' in args else 80000
SCALE = 1.85
TEXTURE_SIZE = {'basecolor': 2048, 'normal': 2048, 'rm': 1024}


def V(x, y, z):
    """前端坐标（原始模型尺寸）→ 放大后的 Blender 坐标。"""
    return Vector((x, -z, y)) * SCALE


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
bpy.ops.import_scene.gltf(filepath=SOURCE)
body = next(o for o in scene.objects if o.type == 'MESH')
body.name = body.data.name = 'DogBody'
bpy.context.view_layer.objects.active = body
body.select_set(True)
body.scale = (SCALE,) * 3
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

# ---------- 减面：约 200 万三角形 → TARGET_FACES ----------
faces_before = len(body.data.polygons)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=0.0001)
bpy.ops.object.mode_set(mode='OBJECT')
decimate = body.modifiers.new('decimate', 'DECIMATE')
decimate.ratio = min(1.0, TARGET_FACES / faces_before)
bpy.ops.object.modifier_apply(modifier=decimate.name)
for poly in body.data.polygons:
    poly.use_smooth = True
print('faces', faces_before, '->', len(body.data.polygons))

# ---------- 实测四只脚掌中心（离地 0.06 以内的顶点按象限聚类） ----------
paws = {}
for v in body.data.vertices:
    co = v.co / SCALE
    x, y, z = co.x, co.z, -co.y
    if y > 0.06:
        continue
    key = ('f' if z > 0 else 'b') + ('l' if x < 0 else 'r')
    paws.setdefault(key, []).append((x, z))
PAW = {k: (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts)) for k, pts in paws.items()}
print('paws', {k: tuple(round(c, 3) for c in v) for k, v in PAW.items()})

# ---------- 骨架（原始尺寸前端坐标，按 640px 正交视图实测） ----------
BONES = [
    ('hips', None, (0, 0.26, -0.2), (0, 0.28, 0.0)),
    ('chest', 'hips', (0, 0.28, 0.0), (0, 0.33, 0.14)),
    ('neck', 'chest', (0, 0.33, 0.12), (0, 0.44, 0.12)),
    ('head', 'neck', (0, 0.44, 0.12), (0, 0.86, 0.12)),
    ('jaw', 'head', (0, 0.5, 0.26), (0, 0.45, 0.37)),
    ('earL', 'head', (-0.215, 0.8, 0.05), (-0.37, 0.48, 0.05)),
    ('earR', 'head', (0.215, 0.8, 0.05), (0.37, 0.48, 0.05)),
    ('tail0', 'hips', (0, 0.31, -0.28), (0, 0.38, -0.36)),
    ('tail1', 'tail0', (0, 0.38, -0.36), (0, 0.44, -0.4)),
    ('tail2', 'tail1', (0, 0.44, -0.4), (0, 0.52, -0.43)),
]
for key, parent, top in (('fl', 'chest', 0.3), ('fr', 'chest', 0.3), ('bl', 'hips', 0.27), ('br', 'hips', 0.27)):
    x, z = PAW[key]
    BONES += [(f'{key}Upper', parent, (x, top, z), (x, 0.15, z)),
              (f'{key}Lower', f'{key}Upper', (x, 0.15, z), (x, 0.02, z))]
NO_DEFORM = {'jaw'}  # 嘴巴和舌头烘焙在贴图里，下巴不变形，只作为叼东西的挂点。

arm_data = bpy.data.armatures.new('DogRig')
armature = bpy.data.objects.new('DogRig', arm_data)
scene.collection.objects.link(armature)
bpy.ops.object.select_all(action='DESELECT')
bpy.context.view_layer.objects.active = armature
bpy.ops.object.mode_set(mode='EDIT')
for name, parent, head, tail in BONES:
    bone = arm_data.edit_bones.new(name)
    bone.head, bone.tail, bone.roll = V(*head), V(*tail), 0
    bone.use_deform = name not in NO_DEFORM
    if parent:
        bone.parent = arm_data.edit_bones[parent]
        bone.use_connect = False
bpy.ops.object.mode_set(mode='OBJECT')

body.select_set(True)
armature.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
missing = [v for v in body.data.vertices if not v.groups]
print('vertices without weights', len(missing))
# 热扩散失败的顶点（通常是贴着的耳朵/脚掌缝隙）按最近骨段补权重。
if missing:
    segments = [(b.name, b.head_local, b.tail_local) for b in arm_data.bones if b.use_deform]

    def distance(p, a, b):
        ab = b - a
        t = max(0.0, min(1.0, (p - a).dot(ab) / ab.length_squared))
        return (p - (a + ab * t)).length
    for v in missing:
        name = min(segments, key=lambda s: distance(v.co, s[1], s[2]))[0]
        body.vertex_groups[name].add([v.index], 1.0, 'REPLACE')

# ---------- 真实眼球：挖掉烘焙在脸上的眼睛，换成可转动的球体 ----------
# 原模型的眼睛是画在脸部网格上的凸起，眼睑和看向只能"贴图"，看起来像贴纸。
# 这里：① 从原始 8K 贴图按正面投影烘焙眼睛图；② 用它生成眼球球体贴图（等距方位投影，
# 前极在眼心），去掉画死的高光（前端用固定反光点 + 真实光泽代替），眼睛轮廓外补成浅色眼白，
# 眼球转动时边缘不会露出眼罩色；③ 删除脸上眼睛区域的面片，球体正好填进眼窝。
# 实测（原始尺寸前端坐标）：眼心 (±0.127, 0.627)，眼睛轮廓半径 0.06~0.076，眼球最前端 z≈0.371。
import numpy as np

EYE = (0.127, 0.627)
BAKE_HALF = 0.085          # 烘焙图覆盖眼心 ±0.085
EYEBALL_RADIUS = 0.078     # 眼球半径：在眼罩表面处的截面略大于眼睛轮廓，不留缝
BAKE_SIZE = 1024
BALL_TEXTURE = 1024
BAKE_DIR = os.path.join(ROOT, 'tools', 'blender', 'build')


def attach(obj, bone):
    obj.parent = armature
    obj.parent_type = 'BONE'
    obj.parent_bone = bone
    obj.matrix_parent_inverse = (armature.matrix_world @ arm_data.bones[bone].matrix_local @ Matrix.Translation((0, arm_data.bones[bone].length, 0))).inverted()


def eye_faces(src, cx, cz, radius):
    return [f for f in src.faces
            if math.hypot(f.calc_center_median().x - cx, f.calc_center_median().z - cz) < radius
            and f.normal.y < -0.2 and f.calc_center_median().y < -0.27 * SCALE]


def bake_front(name, side):
    """把眼睛区域按正面投影烘焙成方形图：像素 (u, v) ↔ 正面坐标 眼心 ± BAKE_HALF。"""
    cx, cz, half = side * EYE[0] * SCALE, EYE[1] * SCALE, BAKE_HALF * SCALE
    src = bmesh.new()
    src.from_mesh(body.data)
    src.normal_update()
    bm = bmesh.new()
    uv_layer = bm.loops.layers.uv.new('UVMap')
    verts = {}
    for f in eye_faces(src, cx, cz, half * 1.1):
        new = []
        for v in f.verts:
            if v.index not in verts:
                verts[v.index] = bm.verts.new(v.co + v.normal * 0.0015 * SCALE)
            new.append(verts[v.index])
        face = bm.faces.new(new)
        for loop in face.loops:
            co = loop.vert.co
            loop[uv_layer].uv = ((co.x - cx) / half * 0.5 + 0.5, (co.z - cz) / half * 0.5 + 0.5)
    src.free()
    me = bpy.data.meshes.new(name + '_bake')
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(name + '_bake', me)
    scene.collection.objects.link(obj)
    image = bpy.data.images.new(name + '_front', BAKE_SIZE, BAKE_SIZE)
    mat = bpy.data.materials.new(name + '_bake')
    mat.use_nodes = True
    tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
    tex.image = image
    mat.node_tree.nodes.active = tex
    me.materials.append(mat)
    bpy.ops.object.select_all(action='DESELECT')
    body.select_set(True)
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.bake(type='DIFFUSE', pass_filter={'COLOR'}, use_selected_to_active=True,
                        cage_extrusion=0.01 * SCALE, max_ray_distance=0.03 * SCALE, margin=16)
    pixels = np.empty(BAKE_SIZE * BAKE_SIZE * 4, np.float32)
    image.pixels.foreach_get(pixels)
    bpy.data.objects.remove(obj)
    return pixels.reshape(BAKE_SIZE, BAKE_SIZE, 4)[:, :, :3]  # 行 0 在底部（Blender 约定）


def flood(seed, allowed, steps=4000):
    """在 allowed 区域内从 seed 4 邻域扩张到收敛。"""
    reach = seed & allowed
    for _ in range(steps):
        grown = reach.copy()
        grown[1:] |= reach[:-1]; grown[:-1] |= reach[1:]
        grown[:, 1:] |= reach[:, :-1]; grown[:, :-1] |= reach[:, 1:]
        grown &= allowed
        if (grown == reach).all():
            break
        reach = grown
    return reach


def eye_regions(front):
    """返回 (眼睛区域, 瞳孔内画死的高光, 瞳孔颜色, 眼白颜色)。"""
    r, g, b = front[..., 0], front[..., 1], front[..., 2]
    top = front.max(-1)
    dark = top < 0.15
    cyan = (b - r > 0.06) & (top > 0.2)
    n = front.shape[0]
    border = np.zeros_like(dark)
    border[0, :] = border[-1, :] = border[:, 0] = border[:, -1] = True
    # 高光：被瞳孔黑色完全包围的非黑像素（从边缘出发、不穿过黑色到不了）。
    outside = flood(border, ~dark)
    highlight = ~dark & ~outside
    center = np.zeros_like(dark)
    center[n // 2 - 4:n // 2 + 4, n // 2 - 4:n // 2 + 4] = True
    # 限制在眼心 0.074 以内，避免顺着眼罩上的深色绒毛扩散出去。
    ys, xs = np.mgrid[0:n, 0:n]
    inside = np.hypot((xs + 0.5) / n - 0.5, (ys + 0.5) / n - 0.5) * 2 * BAKE_HALF < 0.074
    eye = flood(center, (dark | cyan | highlight) & inside)
    # 补洞：眼睛区域内部被包围的小块也算眼睛。
    eye |= ~flood(border, ~eye)
    # 高光的抗锯齿边也一起抹掉：向外扩 3 像素，只在眼睛内。
    highlight = flood(highlight, eye, steps=3)
    pupil = front[dark & eye].mean(0) if (dark & eye).any() else np.array([0.01, 0.01, 0.015])
    pale = cyan & eye & (top > 0.85)
    sclera = np.median(front[pale], 0) if pale.sum() > 50 else np.array([0.8, 0.97, 0.99])
    return eye, highlight, pupil, sclera


def sample(image, u, v):
    n = image.shape[0]
    x = np.clip((u * n).astype(int), 0, n - 1)
    y = np.clip((v * n).astype(int), 0, n - 1)
    return image[y, x]


def eyeball(name, side):
    front = bake_front(name, side)
    eye, highlight, pupil_color, sclera = eye_regions(front)
    cleaned = front.copy()
    cleaned[highlight] = pupil_color
    # 眼睛轮廓外的像素换成眼白色，并向内羽化 2 像素避免硬边。
    soft = eye.astype(np.float32)
    for _ in range(2):
        soft = (soft + np.roll(soft, 1, 0) + np.roll(soft, -1, 0) + np.roll(soft, 1, 1) + np.roll(soft, -1, 1)) / 5
    cleaned = cleaned * soft[..., None] + sclera * (1 - soft[..., None])

    # 球体贴图：方位投影，ρ = 0.5·sqrt(θ/π)（θ 为与正前方的夹角），前极在中心，
    # 正面眼睛区域占贴图大半，背面压缩。
    n = BALL_TEXTURE
    ys, xs = np.mgrid[0:n, 0:n]
    du, dv = (xs + 0.5) / n - 0.5, (ys + 0.5) / n - 0.5
    rho = np.hypot(du, dv)
    theta = math.pi * (2 * rho) ** 2
    phi = np.arctan2(dv, du)
    lateral = np.sin(np.minimum(theta, math.pi / 2)) * EYEBALL_RADIUS
    # 前半球按正面投影取烘焙图；后半球（埋在头里看不到）一律眼白。
    su = lateral * np.cos(phi) / BAKE_HALF * 0.5 + 0.5
    sv = lateral * np.sin(phi) / BAKE_HALF * 0.5 + 0.5
    ball = sample(cleaned, su, sv)
    ball[theta > math.pi / 2] = sclera
    rgba = np.concatenate([ball, np.ones((n, n, 1), np.float32)], -1)
    image = bpy.data.images.new(name + '_ball', n, n)
    image.pixels.foreach_set(rgba.astype(np.float32).ravel())
    os.makedirs(BAKE_DIR, exist_ok=True)
    image.filepath_raw = os.path.join(BAKE_DIR, f'{name}.png')
    image.file_format = 'PNG'
    image.save()

    # 球体网格：两极朝上下，UV 用同一投影（前极 = 眼心）。
    radius = EYEBALL_RADIUS * SCALE
    cx, cz = side * EYE[0] * SCALE, EYE[1] * SCALE
    hit, _, _, _ = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get()).ray_cast(Vector((cx, -5, cz)), Vector((0, 1, 0)))
    center = Vector((cx, hit.y + radius, cz))
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=64, v_segments=40, radius=radius)
    uv_layer = bm.loops.layers.uv.new('UVMap')
    for face in bm.faces:
        face.smooth = True
        for loop in face.loops:
            d = loop.vert.co.normalized()
            th = math.acos(max(-1.0, min(1.0, -d.y)))
            ph = math.atan2(d.z, d.x)
            rr = 0.5 * math.sqrt(th / math.pi)
            loop[uv_layer].uv = (0.5 + rr * math.cos(ph), 0.5 + rr * math.sin(ph))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    tex = mat.node_tree.nodes.new('ShaderNodeTexImage')
    tex.image = image
    mat.node_tree.links.new(tex.outputs['Color'], mat.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
    me.materials.append(mat)
    obj = bpy.data.objects.new(name, me)
    scene.collection.objects.link(obj)
    obj.location = center
    # 眼罩颜色给前端做眼睑：取眼睛轮廓外一圈的低饱和像素。
    ring = flood(eye, np.ones_like(eye), steps=24) & ~eye
    ring &= (front.max(-1) - front.min(-1) < 0.08) & (front.max(-1) > 0.15) & (front.max(-1) < 0.6)
    lid = np.median(front[ring], 0) if ring.sum() > 30 else np.array([0.37, 0.34, 0.36])
    obj['lid_color'] = '#%02x%02x%02x' % tuple(int(c * 255) for c in lid)
    obj['radius'] = radius
    attach(obj, 'head')
    print(name, 'center', tuple(round(c / SCALE, 3) for c in F_(center)), 'highlight px', int(highlight.sum()), 'lid', obj['lid_color'], 'sclera', np.round(sclera, 2))
    return eye, cx, cz


def F_(v):
    return Vector((v.x, v.z, -v.y))


scene.render.engine = 'CYCLES'
scene.cycles.samples = 1
scene.cycles.device = 'CPU'
sockets = [eyeball('Eye_L', -1), eyeball('Eye_R', 1)]

# 在脸上挖出眼窝：删掉正面投影落在眼睛轮廓内（外扩 2%）的面片。
bm = bmesh.new()
bm.from_mesh(body.data)
bm.normal_update()
doomed = []
for eye_mask, cx, cz in sockets:
    n = eye_mask.shape[0]
    grown = flood(eye_mask, np.ones_like(eye_mask), steps=int(n * 0.02))
    for f in eye_faces(bm, cx, cz, BAKE_HALF * SCALE):
        c = f.calc_center_median()
        u = (c.x - cx) / (BAKE_HALF * SCALE) * 0.5 + 0.5
        v = (c.z - cz) / (BAKE_HALF * SCALE) * 0.5 + 0.5
        if grown[min(n - 1, int(v * n)), min(n - 1, int(u * n))]:
            doomed.append(f)
bmesh.ops.delete(bm, geom=list(set(doomed)), context='FACES')
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
bm.to_mesh(body.data)


def socket_rim(name, cx, cz, lid_color):
    """眼窝边缘：减面后的三角形让边缘呈锯齿，沿边缘做一圈平滑的细管（眼罩色）盖住，像眼睑的边。"""
    # 找到眼窝的边界边并按角度排序成环。
    boundary = [e for e in bm.edges if e.is_boundary
                and math.hypot((e.verts[0].co.x + e.verts[1].co.x) / 2 - cx, (e.verts[0].co.z + e.verts[1].co.z) / 2 - cz) < BAKE_HALF * SCALE * 1.3]
    points = sorted({v.index: v.co.copy() for e in boundary for v in e.verts}.values(), key=lambda co: math.atan2(co.z - cz, co.x - cx))
    if len(points) < 12:
        return
    # 按角度重采样 96 个点（同一角度取离眼心最远的边界点），再沿环平滑。
    count = 96
    ring = []
    for i in range(count):
        a = -math.pi + (i + 0.5) / count * 2 * math.pi
        near = [p for p in points if abs((math.atan2(p.z - cz, p.x - cx) - a + math.pi) % (2 * math.pi) - math.pi) < math.pi / count * 2.5]
        if near:
            ring.append(max(near, key=lambda p: math.hypot(p.x - cx, p.z - cz)))
        else:
            ring.append(None)
    for i in range(count):
        if ring[i] is None:
            j = next(k for k in range(1, count) if ring[(i - k) % count] is not None)
            ring[i] = ring[(i - j) % count].copy()
    for _ in range(6):
        ring = [(ring[i - 1] + ring[i] * 2 + ring[(i + 1) % count]) / 4 for i in range(count)]
    tube = 0.0055 * SCALE
    rim = bmesh.new()
    sides = 10
    loops = []
    for i, p in enumerate(ring):
        tangent = (ring[(i + 1) % count] - ring[i - 1]).normalized()
        outward = Vector((p.x - cx, 0, p.z - cz)).normalized()
        normal = tangent.cross(outward).normalized()
        if normal.y > 0:
            normal = -normal
        binormal = tangent.cross(normal).normalized()
        loops.append([rim.verts.new(p + (normal * math.cos(t) + binormal * math.sin(t)) * tube)
                      for t in (k / sides * 2 * math.pi for k in range(sides))])
    for i in range(count):
        a, b = loops[i], loops[(i + 1) % count]
        for k in range(sides):
            face = rim.faces.new((a[k], a[(k + 1) % sides], b[(k + 1) % sides], b[k]))
            face.smooth = True
    bmesh.ops.recalc_face_normals(rim, faces=rim.faces)
    me = bpy.data.meshes.new(name)
    rim.to_mesh(me)
    rim.free()
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*[c ** 2.2 for c in lid_color], 1)
    bsdf.inputs['Roughness'].default_value = 0.75
    me.materials.append(mat)
    obj = bpy.data.objects.new(name, me)
    scene.collection.objects.link(obj)
    attach(obj, 'head')


for (eye_mask, cx, cz), name in zip(sockets, ('Eye_L', 'Eye_R')):
    lid_hex = bpy.data.objects[name]['lid_color']
    socket_rim(name + '_rim', cx, cz, [int(lid_hex[i:i + 2], 16) / 255 for i in (1, 3, 5)])
bm.free()
print('socket faces removed', len(set(doomed)))

# ---------- 贴图压缩（在眼片烘焙之后，眼片取原始 8K 贴图） ----------
for image in bpy.data.images:
    key = next((k for k in TEXTURE_SIZE if k in image.name), None)
    if key and max(image.size) > TEXTURE_SIZE[key]:
        print('texture', image.name, tuple(image.size), '->', TEXTURE_SIZE[key])
        image.scale(TEXTURE_SIZE[key], TEXTURE_SIZE[key])


# 舌头已烘焙在贴图里，留空节点保持 rig 接口完整。
tongue = bpy.data.objects.new('Tongue', None)
scene.collection.objects.link(tongue)
tongue.location = V(0, 0.45, 0.36)
attach(tongue, 'jaw')

# ---------- 预览渲染（可选）：静止 + 一个测试姿态 ----------
if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x, scene.render.resolution_y = 640, 640
    world = bpy.data.worlds.new('World')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.82, 0.9, 0.98, 1)
    scene.world = world
    sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
    sun.data.energy = 3.0
    sun.rotation_euler = (math.radians(50), math.radians(-20), math.radians(-35))
    scene.collection.objects.link(sun)
    camera = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
    camera.data.lens = 60
    scene.collection.objects.link(camera)
    scene.camera = camera
    pose_bones = armature.pose.bones

    def shots(prefix):
        for label, angle in (('front', 0.0), ('three_quarter', -0.7), ('side', -1.57)):
            target = Vector((0, 0, 0.85))
            camera.location = target + Vector((math.sin(angle) * 5, -math.cos(angle) * 5, 0.9))
            camera.rotation_euler = (target - camera.location).to_track_quat('-Z', 'Y').to_euler()
            scene.render.filepath = os.path.join(PREVIEW, f'{prefix}_{label}.png')
            bpy.ops.render.render(write_still=True)
    shots('rest')
    for name, angles in {'head': (0, 0, 0.4), 'earL': (0.6, 0, 0), 'earR': (-0.5, 0, 0), 'tail0': (0, 0, 0.7),
                         'flUpper': (0.7, 0, 0), 'brUpper': (-0.6, 0, 0), 'flLower': (-0.6, 0, 0)}.items():
        pose_bones[name].rotation_mode = 'XYZ'
        pose_bones[name].rotation_euler = angles
    shots('posed')
    for bone in pose_bones:
        bone.rotation_euler = (0, 0, 0)
    bpy.data.objects.remove(sun)
    bpy.data.objects.remove(camera)

# ---------- 导出 GLB ----------
os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.gltf(filepath=OUTPUT, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
                          export_skins=True, export_animations=False, export_materials='EXPORT', export_normals=True,
                          export_image_format='WEBP', export_image_quality=85, export_extras=True)
print('exported', OUTPUT, os.path.getsize(OUTPUT), 'bytes')
