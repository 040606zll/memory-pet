"""
用 Blender 脚本生成 3D 宠物狗（毛绒机器狗"小忆"）并导出 GLB。

运行：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python tools/blender/build_dog.py -- [--preview 输出目录]

产物：frontend/public/assets/pet3d/dog.glb
比例依据 tools/blender/reference/design.webp 实测（头宽 = 1 单位 ≈ 225px）：
  头高 ≈ 头宽，眼径 0.25，两眼距 0.44，眼在头高中线；鼻在眼下 0.21，嘴在眼下 0.31；
  眼罩上下各超出眼心 0.2、外侧 0.25，两眼之间在鼻梁处相连；耳长 0.55 垂到脸颊以下；
  头高 ≈ 躯干到颈部高度的 1.3 倍，腿短而粗，爪尖灰色。
坐标约定：脚本内用"前端坐标"（x 右、y 上、z 朝前），写入 Blender 时转换为 (x, -z, y)，
glTF 导出再转回 y 朝上，因此前端拿到的就是 x 右、y 上、z 朝前。
骨骼名与 frontend/src/pet3d/dogModel.js 的 GLB_BONE_MAP 对应。
"""
import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Matrix, Quaternion, Vector
from mathutils.bvhtree import BVHTree

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUTPUT = os.path.join(ROOT, 'frontend', 'public', 'assets', 'pet3d', 'dog.glb')
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
PREVIEW = args[args.index('--preview') + 1] if '--preview' in args else None


def V(x, y, z):
    """前端坐标 → Blender 坐标。"""
    return Vector((x, -z, y))


def F(v):
    """Blender 坐标 → 前端坐标。"""
    return (v.x, v.z, -v.y)


def srgb(hex_color):
    value = int(hex_color.lstrip('#'), 16)
    channels = [((value >> shift) & 255) / 255 for shift in (16, 8, 0)]
    return [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]


bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


# ---------- 形体：元球像黏土一样融合 ----------
def surface_factor(stiffness, threshold=0.6):
    # Blender 元球场 ≈ s·(1-(d/r)²)³，表面位于 d = r·sqrt(1-(t/s)^(1/3))。
    return math.sqrt(1 - (threshold / stiffness) ** (1 / 3))


def rotation(rot):
    """前端坐标下的欧拉角 (rx, ry, rz) → Blender 四元数。坐标映射是纯旋转，可逐轴转换。"""
    rx, ry, rz = rot
    return Quaternion(V(0, 1, 0), ry) @ Quaternion(V(1, 0, 0), rx) @ Quaternion(V(0, 0, 1), rz)


def family(name, parts, resolution=0.007):
    mb = bpy.data.metaballs.new(name)
    mb.resolution = resolution
    mb.render_resolution = resolution
    mb.threshold = 0.6
    for center, radii, stiffness, rot, negative in parts:
        biggest = max(radii)
        element = mb.elements.new(type='ELLIPSOID')
        element.co = V(*center)
        element.radius = biggest / surface_factor(stiffness)
        element.stiffness = stiffness
        element.use_negative = negative
        # 前端坐标的 (x, y, z) 半轴对应 Blender 的 (x, z, y)。
        element.size_x, element.size_y, element.size_z = radii[0] / biggest, radii[2] / biggest, radii[1] / biggest
        element.rotation = rotation(rot)
    obj = bpy.data.objects.new(name, mb)
    scene.collection.objects.link(obj)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
    bpy.data.objects.remove(obj)
    bpy.data.metaballs.remove(mb)
    result = bpy.data.objects.new(name + 'Mesh', mesh)
    scene.collection.objects.link(result)
    return result


def ell(center, radii, stiffness=3.0, rot=(0, 0, 0), negative=False):
    return (center, radii, stiffness, rot, negative)


# 关键位置（前端坐标）。
HEAD = (0, 1.15, 0.28)
EYE_X, EYE_Y = 0.22, 1.15
NOSE_Y, MOUTH_Y = EYE_Y - 0.21, EYE_Y - 0.28
MOUTH = (0, MOUTH_Y, 0.8)

body_parts = [
    ell((0, 0.5, -0.1), (0.32, 0.28, 0.38), 3.0),          # 躯干
    ell((0, 0.43, 0.02), (0.26, 0.2, 0.26), 3.0),          # 肚子
    ell((0, 0.55, 0.18), (0.3, 0.3, 0.24), 3.0),           # 胸
    ell((0, 0.74, 0.24), (0.23, 0.2, 0.2), 3.0),           # 脖子
    ell(HEAD, (0.5, 0.47, 0.45), 4.0),                     # 头：宽≈高，正面较平
    ell((0, 1.3, 0.28), (0.44, 0.32, 0.4), 4.0),           # 头顶饱满
    ell((-0.2, 0.98, 0.48), (0.23, 0.18, 0.2), 4.0),       # 脸颊
    ell((0.2, 0.98, 0.48), (0.23, 0.18, 0.2), 4.0),
    ell((0, 0.93, 0.6), (0.22, 0.16, 0.2), 5.0),           # 口鼻：短而宽，只略微前凸
    ell((0, 0.8, 0.56), (0.15, 0.09, 0.15), 6.0),          # 下巴
    ell(MOUTH, (0.1, 0.045, 0.09), 6.0, (0.1, 0, 0), True),  # 嘴：负元球挖出张开的笑嘴
    ell((0, 0.62, -0.42), (0.09, 0.09, 0.09), 3.5),        # 尾巴：短，向上卷
    ell((0, 0.7, -0.49), (0.085, 0.085, 0.085), 3.5),
    ell((0, 0.79, -0.52), (0.078, 0.078, 0.078), 3.5),
    ell((0, 0.88, -0.5), (0.07, 0.07, 0.07), 3.5),
    ell((0, 0.94, -0.44), (0.06, 0.06, 0.06), 3.5),
]
# 腿粗短，刚度高避免互相粘连；爪子圆润，前端三个趾头。
for side in (-1, 1):
    body_parts += [
        ell((side * 0.18, 0.4, 0.24), (0.125, 0.16, 0.125), 7.0),
        ell((side * 0.18, 0.2, 0.27), (0.11, 0.14, 0.11), 8.0),
        ell((side * 0.18, 0.08, 0.32), (0.13, 0.08, 0.15), 8.0),
        ell((side * 0.22, 0.43, -0.3), (0.16, 0.19, 0.18), 6.0),
        ell((side * 0.22, 0.2, -0.27), (0.11, 0.14, 0.11), 8.0),
        ell((side * 0.22, 0.08, -0.21), (0.13, 0.08, 0.15), 8.0),
    ]
    for dx in (-0.06, 0.0, 0.06):
        body_parts += [ell((side * 0.18 + dx, 0.065, 0.43), (0.045, 0.05, 0.05), 8.0),
                       ell((side * 0.22 + dx, 0.065, -0.1), (0.045, 0.05, 0.05), 8.0)]
# 耳朵：大而软的垂耳，从头顶两侧挂下来，下端更宽更圆。
ear_parts = []
for side in (-1, 1):
    ear_parts += [
        ell((side * 0.46, 1.32, 0.24), (0.07, 0.14, 0.13), 4.0, (0, 0, side * 0.35)),
        ell((side * 0.56, 1.1, 0.26), (0.08, 0.2, 0.17), 4.0, (0, 0, side * 0.2)),
        ell((side * 0.6, 0.9, 0.28), (0.085, 0.16, 0.18), 4.0, (0, 0, side * 0.08)),
    ]

body = family('Body', body_parts)
ears = family('Ears', ear_parts)
# 合并前记下耳朵表面，重建网格后据此给耳朵单独上色。
ear_bvh = BVHTree.FromObject(ears, bpy.context.evaluated_depsgraph_get())
bpy.ops.object.select_all(action='DESELECT')
body.select_set(True)
ears.select_set(True)
bpy.context.view_layer.objects.active = body
bpy.ops.object.join()

# 体素重建：耳朵与头部融为一个流形，再平滑、减面到前端友好的面数。
body.data.remesh_voxel_size = 0.011
bpy.ops.object.voxel_remesh()
smooth = body.modifiers.new('Smooth', 'SMOOTH')
smooth.factor = 0.6
smooth.iterations = 6
bpy.ops.object.modifier_apply(modifier='Smooth')
decimate = body.modifiers.new('Decimate', 'DECIMATE')
decimate.ratio = 0.16
bpy.ops.object.modifier_apply(modifier='Decimate')
bpy.ops.object.shade_smooth()
body.name = 'DogBody'
body.data.name = 'DogBody'
print('body vertices', len(body.data.vertices), 'faces', len(body.data.polygons))


# ---------- 花色：按位置绘制顶点色；alpha 为毛长（0 = 无绒毛，如嘴巴） ----------
COL = {k: srgb(v) for k, v in {
    'white': '#f6f3ef', 'cream': '#eee7dc', 'grey': '#8f9399', 'dark': '#4a4d55',
}.items()}


def blend(a, b, t):
    t = max(0.0, min(1.0, t))
    return [a[i] + (b[i] - a[i]) * t for i in range(3)]


def blob(p, c, r):
    return math.sqrt(sum(((p[i] - c[i]) / r[i]) ** 2 for i in range(3)))


def soft(d, edge=0.2):
    return max(0.0, min(1.0, (1 - d) / edge))


def color_at(p):
    x, y, z = p
    color, fur = COL['white'], 1.0
    # 胸口偏奶油色。
    color = blend(color, COL['cream'], soft(blob(p, (0, 0.6, 0.42), (0.26, 0.22, 0.2)), 0.6) * 0.7)
    # 背部与臀部灰斑、后腿外侧灰色。
    spot = max(soft(blob(p, (0.28, 0.66, -0.24), (0.2, 0.17, 0.24)), 0.35), soft(blob(p, (-0.27, 0.7, -0.33), (0.15, 0.13, 0.17)), 0.35))
    color = blend(color, COL['grey'], spot)
    for side in (-1, 1):
        color = blend(color, COL['grey'], soft(blob(p, (side * 0.33, 0.46, -0.34), (0.12, 0.16, 0.16)), 0.4))
    # 爪子趾尖。
    if y < 0.17:
        toe = max((z - 0.41) / 0.05, (z - (-0.13)) / 0.05 if z < 0 else 0)
        color = blend(color, COL['grey'], toe)
    # 尾巴灰色、尾尖白。
    if z < -0.38 and y > 0.55:
        color = blend(COL['grey'], COL['white'], (y - 0.9) / 0.06)
    # 耳朵：离原耳朵表面越近越灰，耳尖更深；耳根的灰色稍微漫到头顶。
    _, _, _, ear_distance = ear_bvh.find_nearest(V(x, y, z))
    if ear_distance is not None and ear_distance < 0.05:
        color = blend(color, blend(COL['grey'], COL['dark'], (0.95 - y) / 0.14), 1 - ear_distance / 0.05)
    # 眼罩、嘴巴的颜色由前端着色器逐像素绘制（边缘更干净）；这里只缩短这些区域的绒毛。
    for side in (-1, 1):
        fur *= 1 - 0.6 * soft(blob(p, (side * (EYE_X + 0.02), EYE_Y, 0.62), (0.22, 0.17, 0.28)), 0.3)
    fur *= 1 - soft(blob(p, MOUTH, (0.11, 0.055, 0.12)), 0.25)
    # 脸正面短绒（像毛绒玩具的脸），花色边缘不会被长毛遮成锯齿。
    if y > 0.78 and z > 0.4:
        fur *= 0.1 + 0.9 * max(0.0, min(1.0, (0.58 - z) / 0.16))
    return color, fur


mesh = body.data
attr = mesh.color_attributes.new('Col', 'FLOAT_COLOR', 'POINT')
colors = [color_at(F(vertex.co)) for vertex in mesh.vertices]

# ---------- 环境光遮蔽：半球采样射线，烘焙到顶点色，让耳根、腿间、嘴角有体积感 ----------
body_bvh = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())
golden = math.pi * (3 - math.sqrt(5))
SAMPLES = 32
directions = []
for i in range(SAMPLES):
    # 余弦加权的半球方向（z 向上），之后按顶点法线旋转。
    u = (i + 0.5) / SAMPLES
    radius, height = math.sqrt(u), math.sqrt(1 - u)
    directions.append(Vector((radius * math.cos(i * golden), radius * math.sin(i * golden), height)))
occlusion = []
for vertex in mesh.vertices:
    normal = vertex.normal
    frame = normal.to_track_quat('Z', 'Y')
    origin = vertex.co + normal * 0.004
    blocked = 0.0
    for direction in directions:
        hit, _, _, distance = body_bvh.ray_cast(origin, frame @ direction, 0.5)
        if hit is not None:
            blocked += 1 - distance / 0.5
    occlusion.append(blocked / SAMPLES)
for vertex, (rgb, fur), occ in zip(mesh.vertices, colors, occlusion):
    shade = 1 - 0.7 * occ
    attr.data[vertex.index].color = (rgb[0] * shade, rgb[1] * shade, rgb[2] * shade, fur)
mesh.color_attributes.active_color = attr
mesh.attributes.default_color_name = 'Col'
print('ao mean', round(sum(occlusion) / len(occlusion), 3))


def material(name, color=(1, 1, 1), roughness=0.6, metallic=0.0, use_vertex_color=False, emission=None):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    if use_vertex_color:
        node = mat.node_tree.nodes.new('ShaderNodeVertexColor')
        node.layer_name = 'Col'
        mat.node_tree.links.new(node.outputs['Color'], bsdf.inputs['Base Color'])
    if emission:
        bsdf.inputs['Emission Color'].default_value = (*emission, 1)
        bsdf.inputs['Emission Strength'].default_value = 2.0
    return mat


body.data.materials.append(material('Fur', roughness=0.95, use_vertex_color=True))


# ---------- 骨架 ----------
BONES = [
    ('hips', None, (0, 0.5, -0.1), (0, 0.55, 0.16)),
    ('chest', 'hips', (0, 0.55, 0.16), (0, 0.72, 0.26)),
    ('neck', 'chest', (0, 0.72, 0.26), (0, 0.92, 0.3)),
    ('head', 'neck', (0, 0.92, 0.3), (0, 1.55, 0.32)),
    ('jaw', 'head', (0, 0.9, 0.5), (0, 0.84, 0.74)),
    ('earL', 'head', (-0.44, 1.4, 0.24), (-0.62, 0.78, 0.28)),
    ('earR', 'head', (0.44, 1.4, 0.24), (0.62, 0.78, 0.28)),
    ('tail0', 'hips', (0, 0.57, -0.38), (0, 0.72, -0.48)),
    ('tail1', 'tail0', (0, 0.72, -0.48), (0, 0.86, -0.5)),
    ('tail2', 'tail1', (0, 0.86, -0.5), (0, 0.96, -0.43)),
]
for key, side in (('fl', -1), ('fr', 1)):
    BONES += [(f'{key}Upper', 'chest', (side * 0.18, 0.52, 0.22), (side * 0.18, 0.3, 0.25)),
              (f'{key}Lower', f'{key}Upper', (side * 0.18, 0.3, 0.25), (side * 0.18, 0.03, 0.3))]
for key, side in (('bl', -1), ('br', 1)):
    BONES += [(f'{key}Upper', 'hips', (side * 0.22, 0.5, -0.3), (side * 0.22, 0.3, -0.28)),
              (f'{key}Lower', f'{key}Upper', (side * 0.22, 0.3, -0.28), (side * 0.22, 0.03, -0.24))]

arm_data = bpy.data.armatures.new('DogRig')
armature = bpy.data.objects.new('DogRig', arm_data)
scene.collection.objects.link(armature)
bpy.context.view_layer.objects.active = armature
bpy.ops.object.mode_set(mode='EDIT')
for name, parent, head, tail in BONES:
    bone = arm_data.edit_bones.new(name)
    bone.head = V(*head)
    bone.tail = V(*tail)
    bone.roll = 0
    if parent:
        bone.parent = arm_data.edit_bones[parent]
        bone.use_connect = False
bpy.ops.object.mode_set(mode='OBJECT')

bpy.ops.object.select_all(action='DESELECT')
body.select_set(True)
armature.select_set(True)
bpy.context.view_layer.objects.active = armature
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
missing = [v.index for v in body.data.vertices if not v.groups]
print('vertices without weights', len(missing))


# ---------- 刚体部件：贴在体表并挂到骨骼上 ----------
bvh = BVHTree.FromObject(body, bpy.context.evaluated_depsgraph_get())


def surface(origin, direction):
    hit, normal, _, _ = bvh.ray_cast(V(*origin), V(*direction).normalized())
    return hit, normal


def attach(obj, bone):
    obj.parent = armature
    obj.parent_type = 'BONE'
    obj.parent_bone = bone
    # 父级为骨骼时保持世界位置不变。
    obj.matrix_parent_inverse = (armature.matrix_world @ armature.data.bones[bone].matrix_local @ Matrix.Translation((0, armature.data.bones[bone].length, 0))).inverted()


def sphere(name, center, radii, mat, segments=32, rings=20):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=segments, v_segments=rings, radius=1.0)
    for v in bm.verts:
        v.co = Vector((v.co.x * radii[0], v.co.y * radii[2], v.co.z * radii[1]))
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    me.materials.append(mat)
    obj = bpy.data.objects.new(name, me)
    obj.location = V(*center)
    scene.collection.objects.link(obj)
    return obj


def eye(name, side):
    """发光眼：扁球冠，UV 正面投影，前端会替换成表情画布。"""
    hit, normal = surface((side * EYE_X, EYE_Y, 1.5), (0, 0, -1))
    radius, depth, cap = 0.14, 0.5, 1.0
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=40, v_segments=20, radius=radius)
    # 只保留朝前的球冠（Blender -Y 为前）。
    for v in [v for v in bm.verts if v.co.y > -radius * math.cos(cap)]:
        bm.verts.remove(v)
    uv_layer = bm.loops.layers.uv.new('UVMap')
    span = radius * math.sin(cap)
    for face in bm.faces:
        for loop in face.loops:
            co = loop.vert.co
            loop[uv_layer].uv = (co.x / span * 0.5 + 0.5, co.z / span * 0.5 + 0.5)
    for v in bm.verts:
        v.co.y = (v.co.y + radius * math.cos(cap)) * depth
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = True
    me.materials.append(material(name, (0.2, 0.9, 1.0), roughness=0.1, emission=(0.2, 0.9, 1.0)))
    obj = bpy.data.objects.new(name, me)
    scene.collection.objects.link(obj)
    # 朝向：沿脸部表面法线，略向前收拢，两眼都看向主人。
    outward = (Vector((0, -1, 0)) * 0.7 + normal * 0.3).normalized()
    obj.rotation_mode = 'QUATERNION'
    obj.rotation_quaternion = Vector((0, -1, 0)).rotation_difference(outward)
    obj.location = hit + Vector((0, -0.025, 0))
    attach(obj, 'head')
    return obj


eye('Eye_L', -1)
eye('Eye_R', 1)

nose_hit, _ = surface((0, NOSE_Y, 1.5), (0, 0, -1))
nose = sphere('Nose', (0, 0, 0), (0.078, 0.055, 0.05), material('Nose', srgb('#1b1d21'), roughness=0.2))
nose.location = nose_hit + Vector((0, 0.012, 0))
nose.rotation_euler = Euler((math.radians(-12), 0, 0))
attach(nose, 'head')

# 舌头：小而扁，含在嘴里，舌尖略微探出。
tongue = sphere('Tongue', (0, 0, 0), (0.045, 0.013, 0.055), material('Tongue', srgb('#ff8a9a'), roughness=0.35))
tongue.location = V(0, MOUTH_Y - 0.018, MOUTH[2] - 0.035)
tongue.rotation_euler = Euler((math.radians(30), 0, 0))
attach(tongue, 'jaw')

collar_mat = material('Collar', srgb('#3a3f48'), roughness=0.4, metallic=0.3)
# 项圈半径按实际脖子粗细测量，避免陷进绒毛或悬空。
COLLAR_Y = 0.66
# 从脖子中心向外发射射线，第一次碰到的就是脖子表面（不会被垂下的耳朵干扰）。
neck_center = V(0, COLLAR_Y, 0.2)
neck_radius = max(
    (bvh.ray_cast(neck_center, V(math.cos(a), 0, math.sin(a)), 1.0)[0] - neck_center).length
    # 只取前方与两侧（向后的射线会穿过躯干打到背部）。
    for a in (i * math.pi / 8 for i in range(-1, 10))
    if bvh.ray_cast(neck_center, V(math.cos(a), 0, math.sin(a)), 1.0)[0] is not None
) + 0.004
print('neck radius', round(neck_radius, 3))
bpy.ops.mesh.primitive_torus_add(major_radius=neck_radius, minor_radius=0.03, major_segments=72, minor_segments=16, location=V(0, COLLAR_Y, 0.2))
collar = bpy.context.active_object
collar.name = 'Collar'
collar.rotation_euler = Euler((math.radians(-17), 0, 0))
collar.data.materials.append(collar_mat)
bpy.ops.object.shade_smooth()
attach(collar, 'neck')

# 吊牌贴在项圈下方的胸口绒毛表面。
tag_y = COLLAR_Y - neck_radius * math.sin(math.radians(17)) - 0.05
tag_hit, _ = surface((0, tag_y, 1.2), (0, 0, -1))
bpy.ops.mesh.primitive_cylinder_add(radius=0.065, depth=0.022, vertices=40, location=tag_hit + Vector((0, -0.03, 0)))
tag = bpy.context.active_object
tag.name = 'Tag'
tag.rotation_euler = Euler((math.radians(90 - 12), 0, 0))
tag.data.materials.append(material('Tag', srgb('#2e343c'), roughness=0.3, metallic=0.5, emission=(0.25, 0.9, 1.0)))
attach(tag, 'neck')


# ---------- 预览渲染（可选） ----------
if PREVIEW:
    os.makedirs(PREVIEW, exist_ok=True)
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x, scene.render.resolution_y = 640, 720
    world = bpy.data.worlds.new('World')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.82, 0.9, 0.98, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 1.0
    scene.world = world
    sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
    sun.data.energy = 3.0
    sun.rotation_euler = Euler((math.radians(50), math.radians(-20), math.radians(-35)))
    scene.collection.objects.link(sun)
    camera = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
    camera.data.lens = 60
    scene.collection.objects.link(camera)
    scene.camera = camera
    for label, angle in (('front', 0.0), ('three_quarter', -0.6), ('side', -1.57)):
        distance, target = 4.6, V(0, 0.75, 0)
        camera.location = target + Vector((math.sin(angle) * distance, -math.cos(angle) * distance, 0.75))
        camera.rotation_euler = (target - camera.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(PREVIEW, f'{label}.png')
        bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(sun)
    bpy.data.objects.remove(camera)


# ---------- 导出 GLB ----------
os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
bpy.ops.object.select_all(action='SELECT')
options = dict(filepath=OUTPUT, export_format='GLB', use_selection=True, export_yup=True, export_apply=False,
               export_skins=True, export_animations=False, export_materials='EXPORT', export_normals=True)
try:
    bpy.ops.export_scene.gltf(**options, export_vertex_color='ACTIVE', export_all_vertex_colors=False)
except TypeError:
    bpy.ops.export_scene.gltf(**options)
print('exported', OUTPUT, os.path.getsize(OUTPUT), 'bytes')
