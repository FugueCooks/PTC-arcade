"""Bake a stable arms-at-sides rest pose for the Omni-Man GLB."""

import sys

import bpy


def offset_bone(armature, name, offset):
    bone = armature.pose.bones.get(name)
    if bone is None:
        raise RuntimeError(f'Required bone was not found: {name}')
    bone.rotation_mode = 'XYZ'
    base = tuple(bone.rotation_euler)
    bone.rotation_euler = tuple(base[index] + offset[index] for index in range(3))


def main():
    source_path, output_path = sys.argv[sys.argv.index('--') + 1:]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source_path)
    armature = next((obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE'), None)
    if armature is None:
        raise RuntimeError('Omni-Man armature could not be loaded.')

    # The source clip contains the intended hand and elbow orientation. Use it
    # as the base pose, then lower the arm chains before baking that exact pose.
    bpy.context.scene.frame_set(1)
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)
    bpy.ops.object.mode_set(mode='POSE')

    # The source asset is a partial T-pose. Apply the matching shoulder and
    # elbow changes, then bake them into the skeleton's rest position. This
    # avoids crossfading an authored action with incompatible joint transforms.
    offset_bone(armature, 'mixamorig:LeftArm_09_21', (0.0, 0.0, -0.78))
    offset_bone(armature, 'mixamorig:RightArm_032_50', (0.0, 0.0, 0.78))
    offset_bone(armature, 'mixamorig:LeftForeArm_010_22', (0.0, 0.0, 0.78))
    offset_bone(armature, 'mixamorig:RightForeArm_033_51', (0.0, 0.0, -0.78))
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode='OBJECT')

    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format='GLB',
        export_animations=False,
        export_yup=True,
    )


if __name__ == '__main__':
    main()
