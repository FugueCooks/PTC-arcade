"""Bake a compact, comic-book flight pose for Omni-Man without GLB actions."""

import sys

import bpy


def rotate(armature, name, x=0.0, y=0.0, z=0.0):
    bone = armature.pose.bones.get(name)
    if bone is None:
        raise RuntimeError(f'Required bone was not found: {name}')
    bone.rotation_mode = 'XYZ'
    bone.rotation_euler = (x, y, z)


def main():
    source_path, output_path = sys.argv[sys.argv.index('--') + 1:]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source_path)
    armature = next((obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE'), None)
    if armature is None:
        raise RuntimeError('Omni-Man armature could not be loaded.')

    # Begin from the bind pose used by the corrected idle instead of any
    # selected source animation. This keeps the arms naturally at his sides.
    armature.animation_data_clear()
    bpy.context.scene.frame_set(0)
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode='POSE')

    # A restrained one-knee-forward hovering stance: one thigh advances and
    # bends at the knee, while the other leg trails almost straight. No arm,
    # cape, or root rotations are authored here, avoiding the malformed old
    # flight pose and leaving heading controlled by the multiplayer renderer.
    rotate(armature, 'mixamorig:LeftUpLeg_055_78', x=0.72)
    rotate(armature, 'mixamorig:LeftLeg_056_79', x=-1.18)
    rotate(armature, 'mixamorig:LeftFoot_057_80', x=0.34)
    rotate(armature, 'mixamorig:LeftToeBase_058_81', x=0.12)
    rotate(armature, 'mixamorig:RightUpLeg_060_84', x=-0.08)
    rotate(armature, 'mixamorig:RightLeg_061_85', x=0.05)
    rotate(armature, 'mixamorig:RightFoot_062_86', x=0.04)
    bpy.ops.object.mode_set(mode='OBJECT')

    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    for obj in mesh_objects:
        if obj.name.startswith('Icosphere'):
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = bpy.data.meshes.new_from_object(evaluated, depsgraph=depsgraph)
        replacement = bpy.data.objects.new(obj.name, mesh)
        replacement.matrix_world = obj.matrix_world.copy()
        bpy.context.collection.objects.link(replacement)
        for material in obj.data.materials:
            mesh.materials.append(material)

    for original in mesh_objects:
        bpy.data.objects.remove(original, do_unlink=True)
    bpy.data.objects.remove(armature, do_unlink=True)

    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format='GLB',
        export_animations=False,
        export_yup=True,
    )


if __name__ == '__main__':
    main()
