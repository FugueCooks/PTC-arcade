"""Generates the Chao Garden's props as one low-poly GLB.

Run headless:
  blender --background --python tools/make-chao-props.py

Objects exported: Palm, RockA, RockB, RockC, CliffColumn. Low-poly and
flat-shaded on purpose — the Dreamcast garden was low-poly — but shaped, not
schematic: the trunk shows its rings, the fronds crease and droop in two
layers, the rock reads warm rather than foam-grey.
"""
import bpy
import bmesh
import math
import random

random.seed(11)

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
trunk_mat = material('PalmTrunk', (0.3, 0.17, 0.07))
ring_mat = material('PalmRing', (0.42, 0.26, 0.11))
frond_mat = material('PalmFrond', (0.08, 0.42, 0.11))
frond_lite = material('PalmFrondLight', (0.16, 0.55, 0.16))
coco_mat = material('Coconut', (0.28, 0.19, 0.09))
rock_mat = material('GardenRock', (0.52, 0.47, 0.38), rough=0.95)

# ---- Palm: a curving trunk whose segments alternate radius, so the rings the
# reference draws are geometry here, under a two-layer creased crown.
parts = []
x_drift, z_at = 0.0, 0.0
for i in range(8):
    t = i / 7
    bulge = 0.115 if i % 2 == 0 else 0.09
    radius = bulge * (1 - t * 0.4)
    depth = 0.26
    bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=radius, depth=depth,
        location=(x_drift, 0, z_at + depth / 2))
    seg = bpy.context.object
    seg.rotation_euler[1] = 0.1
    seg.data.materials.append(trunk_mat if i % 2 else ring_mat)
    flat(seg)
    parts.append(seg)
    z_at += depth * 0.94
    x_drift += 0.04 + i * 0.009

def frond(length, width, droop, lift, angle, mat):
    """A creased frond: two half-planes meeting at a spine, drooping along it."""
    mesh = bpy.data.meshes.new('frond')
    bm = bmesh.new()
    steps = 5
    rows = []
    for s in range(steps + 1):
        u = s / steps
        drop = droop * u * u
        taper = width * (1 - u * 0.8) / 2
        x = u * length
        crease = 0.16 * taper / (width / 2)
        rows.append((
            bm.verts.new((x, -taper, -drop - crease)),
            bm.verts.new((x, 0, -drop + 0.05 * (1 - u))),
            bm.verts.new((x, taper, -drop - crease))))
    for s in range(steps):
        a1, b1, c1 = rows[s]
        a2, b2, c2 = rows[s + 1]
        bm.faces.new((a1, b1, b2, a2))
        bm.faces.new((b1, c1, c2, b2))
    bm.to_mesh(mesh)
    bm.free()
    leaf = bpy.data.objects.new('frond', mesh)
    bpy.context.collection.objects.link(leaf)
    leaf.location = (x_drift, 0, z_at)
    leaf.rotation_euler[2] = angle
    leaf.rotation_euler[1] = -lift
    leaf.data.materials.append(mat)
    flat(leaf)
    return leaf

for i in range(7):
    parts.append(frond(1.15, 0.34, 0.62, 0.18, i / 7 * math.tau, frond_mat))
for i in range(5):
    parts.append(frond(0.8, 0.26, 0.35, 0.55, (i + 0.5) / 5 * math.tau, frond_lite))
for i in range(3):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.085,
        location=(x_drift + 0.11 * math.cos(i * 2.1), 0.11 * math.sin(i * 2.1), z_at - 0.08))
    nut = bpy.context.object
    nut.data.materials.append(coco_mat)
    flat(nut)
    parts.append(nut)

bpy.ops.object.select_all(action='DESELECT')
for obj in parts:
    obj.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.join()
palm = bpy.context.object
palm.name = 'Palm'

# ---- Rocks: displaced icospheres, warm-grey, sunk-looking boulders.
for n, (sx, sy, sz) in enumerate([(1, 0.8, 0.62), (0.72, 1.1, 0.55), (1.25, 0.9, 0.48)]):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.5, location=(0, 0, 0.24))
    rock = bpy.context.object
    rock.name = f'Rock{chr(65 + n)}'
    for v in rock.data.vertices:
        v.co.x *= sx * (1 + random.uniform(-0.24, 0.24))
        v.co.y *= sy * (1 + random.uniform(-0.24, 0.24))
        v.co.z *= sz * (1 + random.uniform(-0.2, 0.2))
    rock.data.materials.append(rock_mat)
    flat(rock)

# ---- CliffColumn: clustered squared columns for the waterfall stone.
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
