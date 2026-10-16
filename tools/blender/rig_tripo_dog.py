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

# ---------- 真实眼球：按原模型眼睛表面拟合球体，挖掉画在脸上的眼睛，换成可转动的眼球 ----------
# 原模型的眼睛是画在脸部网格上的一颗近似球形的凸起（正面到外侧都有，外侧露出浅色眼白）。
# ① 按贴图颜色给每个面分类（黑瞳孔 / 青色虹膜 / 浅色眼白），从眼心种子连通出整颗眼睛的面片；
# ② 用这些顶点最小二乘拟合球体：眼球表面与原眼睛表面重合，凸出程度与原模型一致；
# ③ 在球面上按实测的瞳孔、虹膜球冠程序化绘制贴图（无接缝、无画死的高光，任何角度边缘都平滑）；
# ④ 删除这些面片，眼眶边缘按角度平滑后收进眼球表面之下，皮肤像眼睑一样包住眼球，不留缝。
import numpy as np

EYE_GUESS = (0.127, 0.627, 0.33)   # 原始尺寸前端坐标下的大致眼心（只用来找种子面）
EYE_SEARCH = 0.13                  # 只在这个范围内找眼睛面片
BALL_TEXTURE = 1024
TUCK = 0.004                       # 眼眶边缘压到眼球表面以下的深度（原始尺寸）
BAKE_DIR = os.path.join(ROOT, 'tools', 'blender', 'build')


def attach(obj, bone):
    obj.parent = armature
    obj.parent_type = 'BONE'
    obj.parent_bone = bone
    obj.matrix_parent_inverse = (armature.matrix_world @ arm_data.bones[bone].matrix_local @ Matrix.Translation((0, arm_data.bones[bone].length, 0))).inverted()


def smooth(edge0, edge1, x):
    t = np.clip((x - edge0) / (edge1 - edge0), 0, 1)
    return t * t * (3 - 2 * t)


def texture_sampler():
    source = next(i for i in bpy.data.images if 'basecolor' in i.name)
    small = source.copy()
    small.scale(2048, 2048)
    pixels = np.empty(2048 * 2048 * 4, np.float32)
    small.pixels.foreach_get(pixels)
    bpy.data.images.remove(small)
    pixels = pixels.reshape(2048, 2048, 4)[:, :, :3]

    def color(face, uv_layer):
        u = sum(l[uv_layer].uv.x for l in face.loops) / len(face.loops)
        v = sum(l[uv_layer].uv.y for l in face.loops) / len(face.loops)
        return pixels[int(v * 2048) % 2048, int(u * 2048) % 2048]
    color.pixels = pixels
    return color


def dense_caps(faces, uv_layer, pixels, center, radius, steps=8):
    """在每个面片内按重心坐标密集取样贴图颜色，按样本面积累计瞳孔与虹膜（含瞳孔）的球冠。"""
    acc = {'pupil': [Vector(), 0.0], 'iris': [Vector(), 0.0]}
    size = pixels.shape[0]
    for f in faces:
        loops = list(f.loops)
        if len(loops) != 3:
            continue
        (a, b, c) = (l.vert.co for l in loops)
        (ua, ub, uc) = (l[uv_layer].uv for l in loops)
        area = f.calc_area() / (steps * (steps + 1) / 2)
        for i in range(steps):
            for j in range(steps - i):
                p, q = (i + 1 / 3) / steps, (j + 1 / 3) / steps
                r = 1 - p - q
                uv = ua * r + ub * p + uc * q
                kind = classify(pixels[int(uv.y * size) % size, int(uv.x * size) % size])
                if kind in ('pupil', 'iris'):
                    d = ((a * r + b * p + c * q) - center).normalized()
                    for key in (('pupil', 'iris') if kind == 'pupil' else ('iris',)):
                        acc[key][0] += d * area
                        acc[key][1] += area
    caps = {}
    for key, (direction, total) in acc.items():
        solid = total / radius ** 2
        caps[key] = (direction.normalized(), math.acos(max(-1.0, 1 - solid / (2 * math.pi))))
    return caps['pupil'], caps['iris']


def classify(c):
    r, g, b = c
    top = max(c)
    if top < 0.12:
        return 'pupil'
    if top < 0.2:
        return 'edge'  # 瞳孔与眼眶交界处的深色描边，不参与瞳孔大小计算
    if b - r > 0.05 and b > 0.3:
        return 'iris' if r < 0.45 else 'sclera'
    return None


def fit_sphere(points):
    p = np.array(points)
    a = np.c_[2 * p, np.ones(len(p))]
    b = (p ** 2).sum(1)
    sol, *_ = np.linalg.lstsq(a, b, rcond=None)
    center = sol[:3]
    radius = math.sqrt(sol[3] + center @ center)
    residual = np.abs(np.linalg.norm(p - center, axis=1) - radius)
    return Vector(center), radius, float(residual.mean()), float(residual.max())


def cap(faces, center, radius):
    """面片集合 → 球冠（中心方向，角半径），按面积加权、用立体角换算半径。"""
    total, direction = 0.0, Vector()
    for f in faces:
        area = f.calc_area()
        direction += (f.calc_center_median() - center).normalized() * area
        total += area
    solid = total / radius ** 2
    return direction.normalized(), math.acos(max(-1.0, 1 - solid / (2 * math.pi)))


def eye_region(bm, uv_layer, color, side):
    guess = V(side * EYE_GUESS[0], EYE_GUESS[1], EYE_GUESS[2])
    near = [f for f in bm.faces if (f.calc_center_median() - guess).length < EYE_SEARCH * SCALE and f.normal.y < 0.3]
    kind = {f: classify(color(f, uv_layer)) for f in near}
    seed = min((f for f in near if kind[f]), key=lambda f: (f.calc_center_median() - guess).length)
    region, todo = {seed}, [seed]
    while todo:
        f = todo.pop()
        for e in f.edges:
            for g in e.link_faces:
                if g not in region and g in kind and kind[g]:
                    region.add(g)
                    todo.append(g)
    # 补洞：眼睛里画死的白色高光等不是眼睛颜色的小块，从外圈连不进来的都算眼睛。
    outside = {f for f in near if f not in region and (f.calc_center_median() - guess).length > (EYE_SEARCH - 0.015) * SCALE}
    todo = list(outside)
    while todo:
        f = todo.pop()
        for e in f.edges:
            for g in e.link_faces:
                if g in kind and g not in region and g not in outside:
                    outside.add(g)
                    todo.append(g)
    holes = [f for f in near if f not in region and f not in outside]
    for f in holes:
        kind[f] = 'pupil'
    region.update(holes)
    rim = {g for f in region for v in f.verts for g in v.link_faces if g not in region}
    lid = np.median(np.array([color(f, uv_layer) for f in rim]), 0)
    # 靠近眼眶的两圈面片带有描边和阴影，不用来量瞳孔/虹膜。
    border = {f for f in region if any(g not in region for v in f.verts for g in v.link_faces)}
    border |= {f for f in region if any(g in border for v in f.verts for g in v.link_faces)}
    interior = {f: kind[f] for f in region if f not in border}
    return region, kind, interior, lid


class Opening:
    """眼眶开口：以眼轴为极轴，每个方位角上开口的张角，经过强平滑得到圆润的轮廓。"""

    def __init__(self, center, axis, faces, bins=72, window=20):
        self.center, self.axis = center, axis
        self.u = axis.orthogonal().normalized()
        self.w = axis.cross(self.u).normalized()
        raw = np.full(bins, np.nan)
        for f in faces:
            az, spread = self.polar(f.calc_center_median())
            i = int((az + math.pi) / (2 * math.pi) * bins) % bins
            raw[i] = spread if np.isnan(raw[i]) else max(raw[i], spread)
        known = np.nonzero(~np.isnan(raw))[0]
        idx = np.arange(bins)
        raw = np.interp(idx, known, raw[known], period=bins)
        k = max(1, int(window / (360 / bins)))
        kernel = np.exp(-0.5 * (np.arange(-2 * k, 2 * k + 1) / k) ** 2)
        padded = np.concatenate([raw[-2 * k:], raw, raw[:2 * k]])
        self.table = np.convolve(padded, kernel / kernel.sum(), 'valid')
        self.bins = bins

    def polar(self, co):
        d = (co - self.center).normalized()
        return math.atan2(d.dot(self.w), d.dot(self.u)), math.acos(max(-1.0, min(1.0, d.dot(self.axis))))

    def spread(self, az):
        x = (az + math.pi) / (2 * math.pi) * self.bins - 0.5
        return float(np.interp(x, np.arange(self.bins), self.table, period=self.bins))

    def point(self, az, spread, radius):
        return self.center + (self.axis * math.cos(spread) + (self.u * math.cos(az) + self.w * math.sin(az)) * math.sin(spread)) * radius


def ball_texture(name, center, radius, pupil, iris, sclera, iris_color, opening):
    # 方位投影 ρ = 0.5·sqrt(θ/π)，θ 为与正前方（Blender -Y）的夹角；方向用 Blender 坐标。
    n = BALL_TEXTURE
    ys, xs = np.mgrid[0:n, 0:n]
    du, dv = (xs + 0.5) / n - 0.5, (ys + 0.5) / n - 0.5
    theta = math.pi * np.minimum(1, (2 * np.hypot(du, dv)) ** 2)
    phi = np.arctan2(dv, du)
    d = np.stack([np.sin(theta) * np.cos(phi), -np.cos(theta), np.sin(theta) * np.sin(phi)], -1)
    (pupil_dir, pupil_angle), (iris_dir, iris_angle) = pupil, iris
    to_pupil = np.arccos(np.clip(d @ np.array(pupil_dir), -1, 1))
    to_iris = np.arccos(np.clip(d @ np.array(iris_dir), -1, 1))
    aa = 0.008
    # 眼白：向后（埋进头里的部分）逐渐变暗。
    ball = sclera * (1 - 0.3 * smooth(1.5, 2.4, theta))[..., None]
    t = np.clip(to_iris / iris_angle, 0, 1)
    ring = iris_color * (0.82 + 0.28 * smooth(0.55, 0.92, t))[..., None]
    limbus = smooth(0.88, 1.0, t)[..., None]
    ring = ring * (1 - limbus) + iris_color * 0.45 * limbus
    inside = (1 - smooth(iris_angle - aa, iris_angle + aa, to_iris))[..., None]
    ball = ball * (1 - inside) + ring * inside
    tp = np.clip(to_pupil / pupil_angle, 0, 1)[..., None]
    dark = np.array([0.035, 0.05, 0.075]) * (1 - tp) + np.array([0.004, 0.006, 0.01]) * tp
    inside = (1 - smooth(pupil_angle - aa, pupil_angle + aa * 1.5, to_pupil))[..., None]
    ball = ball * (1 - inside) + dark * inside
    # 眼眶边缘的接触阴影：贴近开口轮廓的一圈变暗，像原模型的细描边。
    axis, u, w = (np.array(opening.axis), np.array(opening.u), np.array(opening.w))
    az = np.arctan2(d @ w, d @ u)
    spread = np.arccos(np.clip(d @ axis, -1, 1))
    x = (az + math.pi) / (2 * math.pi) * opening.bins - 0.5
    limit = np.interp(x.ravel(), np.arange(opening.bins), opening.table, period=opening.bins).reshape(x.shape)
    shade = smooth(limit - math.radians(8), limit - math.radians(1), spread)
    line = smooth(limit - math.radians(2.2), limit - math.radians(0.8), spread)
    ball = ball * (1 - 0.45 * shade)[..., None] * (1 - 0.6 * line)[..., None]
    image = bpy.data.images.new(name + '_ball', n, n)
    image.pixels.foreach_set(np.concatenate([ball, np.ones((n, n, 1))], -1).astype(np.float32).ravel())
    os.makedirs(BAKE_DIR, exist_ok=True)
    image.filepath_raw = os.path.join(BAKE_DIR, f'{name}.png')
    image.file_format = 'PNG'
    image.save()
    return image


def ball_object(name, center, radius, image, lid, axis, opening):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=72, v_segments=48, radius=radius)
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
    mat.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.25
    me.materials.append(mat)
    obj = bpy.data.objects.new(name, me)
    scene.collection.objects.link(obj)
    obj.location = center
    obj['lid_color'] = '#%02x%02x%02x' % tuple(int(max(0, min(1, c)) * 255) for c in lid)
    obj['radius'] = radius
    # 眼睛朝向（glTF 坐标：x 右、y 上、z 前），前端据此放反光点。
    obj['axis'] = [axis.x, axis.z, -axis.y]
    # 眼眶开口：以 opening.axis 为极轴的最大张角（度），前端眼睑只覆盖这个范围。
    obj['opening_axis'] = [opening.axis.x, opening.axis.z, -opening.axis.y]
    obj['opening'] = math.degrees(float(opening.table.max()))
    attach(obj, 'head')
    return obj


def tuck_socket(bm, opening, radius):
    """眼眶边缘放到平滑轮廓上、略低于眼球表面，附近两圈顶点平滑过渡。"""
    edge = [v for v in bm.verts if v.is_boundary and (v.co - opening.center).length < radius * 1.6]
    inner = radius - TUCK * SCALE
    for v in edge:
        az, _ = opening.polar(v.co)
        v.co = opening.point(az, opening.spread(az), inner)
    ring = {x for v in edge for e in v.link_edges for x in e.verts if not x.is_boundary}
    ring2 = ring | {x for v in ring for e in v.link_edges for x in e.verts if not x.is_boundary}
    for _ in range(4):
        bmesh.ops.smooth_vert(bm, verts=list(ring2), factor=0.5, use_axis_x=True, use_axis_y=True, use_axis_z=True)
    return len(edge)


color = texture_sampler()
bm = bmesh.new()
bm.from_mesh(body.data)
bm.normal_update()
uv_layer = bm.loops.layers.uv.active
eyes = []
for name, side in (('Eye_L', -1), ('Eye_R', 1)):
    region, kind, interior, lid = eye_region(bm, uv_layer, color, side)
    points = list({v.index: v.co.copy() for f in region for v in f.verts}.values())
    center, radius, mean_err, max_err = fit_sphere(points)
    pupil, iris = dense_caps(region, uv_layer, color.pixels, center, radius)
    iris = (iris[0], max(iris[1], pupil[1] + math.radians(4)))
    whole = cap(region, center, radius)
    opening = Opening(center, whole[0], region)
    sclera_faces = [color(f, uv_layer) for f in region if kind[f] == 'sclera']
    sclera = np.median(np.array(sclera_faces), 0) if sclera_faces else np.array([0.75, 0.96, 0.98])
    iris_faces = [color(f, uv_layer) for f in region if kind[f] == 'iris']
    iris_color = np.median(np.array(iris_faces), 0) if iris_faces else np.array([0.12, 0.88, 0.94])
    eyes.append((name, region, center, radius, opening, pupil, iris, sclera, iris_color, lid))
    print(name, 'faces', len(region), 'center', tuple(round(c / SCALE, 3) for c in (center.x, center.z, -center.y)),
          'radius', round(radius / SCALE, 4), 'fit err mean/max', round(mean_err / SCALE, 4), round(max_err / SCALE, 4),
          'pupil', round(math.degrees(pupil[1]), 1), 'iris', round(math.degrees(iris[1]), 1), 'eye', round(math.degrees(whole[1]), 1))

# 开口内的面片全部删除（包括颜色没认出来造成的缺口），开口外的保留。
doomed = set()
for name, region, center, radius, opening, *_ in eyes:
    for f in bm.faces:
        c = f.calc_center_median()
        if (c - center).length < radius * 1.5:
            az, spread = opening.polar(c)
            # 多删 2.5°：开口外紧贴的一圈皮肤带着原眼睛边缘的颜色，删掉后由收边拉过来的眼罩皮肤盖住。
            if spread < opening.spread(az) + math.radians(2.5):
                doomed.add(f)
bmesh.ops.delete(bm, geom=list(doomed), context='FACES')
bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
for name, region, center, radius, opening, *_ in eyes:
    print(name, 'socket edge verts', tuck_socket(bm, opening, radius), 'opening deg', round(math.degrees(opening.table.min()), 1), '-', round(math.degrees(opening.table.max()), 1))
bm.to_mesh(body.data)
bm.free()

# 眼眶附近的皮肤完全跟随 head 骨（眼球也挂在 head 骨上），外圈逐渐过渡回原权重，
# 否则低头/转头时皮肤与眼球相对错动，出现遮挡或缝隙。
head_group = body.vertex_groups['head']
for v in body.data.vertices:
    near = min((v.co - e[2]).length / e[3] for e in eyes)
    if near > 2.4:
        continue
    k = 1.0 if near < 1.6 else 1 - (near - 1.6) / 0.8
    for g in v.groups:
        if g.group != head_group.index:
            g.weight *= 1 - k
    current = next((g.weight for g in v.groups if g.group == head_group.index), 0.0)
    head_group.add([v.index], current + (1 - current) * k, 'REPLACE')

for name, region, center, radius, opening, pupil, iris, sclera, iris_color, lid in eyes:
    image = ball_texture(name, center, radius, pupil, iris, sclera, iris_color, opening)
    ball_object(name, center, radius, image, lid, pupil[0], opening)


# ---------- 贴图压缩（在眼睛取色之后） ----------
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
