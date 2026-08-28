"""Generates the Chao Garden's props as one low-poly GLB.

Run headless:
  blender --background --python tools/make-chao-props.py

Objects exported: Palm, RockA, RockB, RockC, CliffColumn. Everything is
flat-shaded and low-poly on purpose — the Dreamcast garden this recreates was
low-poly, and props that match it read as belonging to it.
"""
import bpy
import bmesh
import math
import random

random.seed(7)

def clear():
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    for block in (bpy.data.meshes, bpy.data.materials):
        for item in list(block):
            block.remove(item)

def material(name, color, rough=0.85):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes['Principled BSDF']
    bsdf.inputs['Base Color'].default_value = (*color, 1)
    bsdf.inputs['Roughness'].default_value = rough
    return mat

def flat(obj):
    for poly in obj.data.polygons:
        poly.use_smooth = False

clear()
trunk_mat = material('PalmTrunk', (0.34, 0.2, 0.09))
frond_mat = material('PalmFrond', (0.13, 0.5, 0.16))
rock_mat = material('GardenRock', (0.62, 0.58, 0.5), rough=0.95)

# ---- Palm: a curved, tapered trunk of stacked segments, ringed like the
# reference's, with a fan of bent fronds.
segments = []
x_drift = 0.0
for i in range(7):
    t = i / 6
    radius = 0.11 * (1 - t * 0.45)
    bpy.ops.mesh.primitive_cylinder_add(vertices=7, radius=radius, depth=0.28,
        location=(x_drift, 0, 0.14 + i * 0.26))
    x_drift += 0.035 + i * 0.008
    seg = bpy.context.object
    seg.rotation_euler[1] = 0.09
    seg.data.materials.append(trunk_mat)
    flat(seg)
    segments.append(seg)

fronds = []
top = (x_drift, 0, 1.98)
for i in range(7):
    angle = i / 7 * math.tau
    mesh = bpy.data.meshes.new('frond')
    bm = bmesh.new()
    length, width = 1.05, 0.3
    steps = 5
    verts = []
    for s in range(steps + 1):
        u = s / steps
        drop = 0.55 * u * u          # the frond bends down along its length
        taper = width * (1 - u * 0.85) / 2
        x = u * length
        verts.append((bm.verts.new((x, -taper, -drop)), bm.verts.new((x, taper, -drop))))
    for s in range(steps):
        a, b = verts[s]
        c, d = verts[s + 1]
        bm.faces.new((a, b, d, c))
    bm.to_mesh(mesh)
    bm.free()
    frond = bpy.data.objects.new('frond', mesh)
    bpy.context.collection.objects.link(frond)
    frond.location = top
    frond.rotation_euler[2] = angle
    frond.rotation_euler[1] = -0.28
    frond.data.materials.append(frond_mat)
    flat(frond)
    fronds.append(frond)

bpy.ops.object.select_all(action='DESELECT')
for obj in segments + fronds:
    obj.select_set(True)
bpy.context.view_layer.objects.active = segments[0]
bpy.ops.object.join()
palm = bpy.context.object
palm.name = 'Palm'

# ---- Rocks: displaced icospheres, squashed irregular boulders.
for n, (sx, sy, sz) in enumerate([(1, 0.8, 0.7), (0.7, 1.1, 0.6), (1.2, 0.9, 0.5)]):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.5, location=(0, 0, 0.32))
    rock = bpy.context.object
    rock.name = f'Rock{chr(65 + n)}'
    for v in rock.data.vertices:
        v.co.x *= sx * (1 + random.uniform(-0.22, 0.22))
        v.co.y *= sy * (1 + random.uniform(-0.22, 0.22))
        v.co.z *= sz * (1 + random.uniform(-0.18, 0.18))
    rock.data.materials.append(rock_mat)
    flat(rock)

# ---- CliffColumn: a clustered stack of squared columns, the reference's
# blocky waterfall stone.
columns = []
for i, (cx, cy, height, side) in enumerate([
        (0, 0, 3.2, 0.55), (0.62, 0.18, 2.4, 0.45), (-0.55, -0.12, 2.7, 0.48),
        (0.2, -0.55, 1.9, 0.4), (-0.25, 0.5, 2.1, 0.42)]):
    bpy.ops.mesh.primitive_cylinder_add(vertices=6, radius=side, depth=height,
        location=(cx, cy, height / 2))
    col = bpy.context.object
    col.rotation_euler[2] = i * 0.4
    for v in col.data.vertices:
        v.co.x *= 1 + random.uniform(-0.08, 0.08)
        v.co.y *= 1 + random.uniform(-0.08, 0.08)
    col.data.materials.append(rock_mat)
    flat(col)
    columns.append(col)
bpy.ops.object.select_all(action='DESELECT')
for obj in columns:
    obj.select_set(True)
bpy.context.view_layer.objects.active = columns[0]
bpy.ops.object.join()
cliff = bpy.context.object
cliff.name = 'CliffColumn'

bpy.ops.export_scene.gltf(filepath='assets/models/chao-garden-props.glb', export_format='GLB')
print('EXPORTED chao-garden-props.glb')
