"""
眼睛对照渲染：同一组相机下分别渲染 Tripo 原始模型与处理后的 puppy.glb，检查眼球与眼眶是否贴合。

运行：
  /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup --python tools/blender/compare_eyes.py -- 输出目录

输出：<输出目录>/<视角>_original.png 与 <视角>_ours.png。
"""
import math
import os
import sys

import bpy
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = sys.argv[sys.argv.index('--') + 1]
SCALE = 1.85
# 头部注视点（Blender 坐标，已放大）：两眼中间略靠前。
TARGET = Vector((0, -0.62, 1.16))
VIEWS = {
    'front': (0, 0),
    'three_quarter': (-38, 4),
    'side': (-72, 2),
    'low': (-25, -22),
    'high': (-20, 28),
    'right_side': (68, 2),
}


def setup():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = 'BLENDER_EEVEE'
    scene.render.resolution_x = scene.render.resolution_y = 720
    world = bpy.data.worlds.new('World')
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (0.8, 0.86, 0.92, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.9
    for rot, energy in (((50, -20, -35), 3.0), ((60, 10, 140), 1.2)):
        sun = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
        sun.data.energy = energy
        sun.rotation_euler = tuple(math.radians(a) for a in rot)
        scene.collection.objects.link(sun)
    camera = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
    camera.data.lens = 85
    scene.collection.objects.link(camera)
    scene.camera = camera
    return scene, camera


def shoot(scene, camera, suffix):
    os.makedirs(OUT, exist_ok=True)
    for name, (yaw, pitch) in VIEWS.items():
        y, p = math.radians(yaw), math.radians(pitch)
        direction = Vector((math.sin(y) * math.cos(p), -math.cos(y) * math.cos(p), math.sin(p)))
        camera.location = TARGET + direction * 2.6
        camera.rotation_euler = (TARGET - camera.location).to_track_quat('-Z', 'Y').to_euler()
        scene.render.filepath = os.path.join(OUT, f'{name}_{suffix}.png')
        bpy.ops.render.render(write_still=True)


scene, camera = setup()
bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT, 'tools', 'blender', 'source', 'puppy_tripo.glb'))
for obj in scene.objects:
    if obj.type == 'MESH':
        obj.scale = (SCALE,) * 3
shoot(scene, camera, 'original')

scene, camera = setup()
bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT, 'frontend', 'public', 'assets', 'pet3d', 'puppy.glb'))
shoot(scene, camera, 'ours')

# 左右拼接：左原始、右处理后，便于逐视角对比。
import numpy as np
for name in VIEWS:
    halves = []
    for suffix in ('original', 'ours'):
        image = bpy.data.images.load(os.path.join(OUT, f'{name}_{suffix}.png'))
        w, h = image.size
        pixels = np.empty(w * h * 4, np.float32)
        image.pixels.foreach_get(pixels)
        halves.append(pixels.reshape(h, w, 4))
    joined = np.concatenate(halves, 1)
    out = bpy.data.images.new(f'{name}_compare', joined.shape[1], joined.shape[0])
    out.pixels.foreach_set(joined.ravel())
    out.filepath_raw = os.path.join(OUT, f'{name}_compare.png')
    out.file_format = 'PNG'
    out.save()
