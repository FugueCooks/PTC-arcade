"""Append a no-jet, tucked-knee flying pose to the Omni-Man avatar GLB."""

import sys

import bpy


def offset_rotation(armature, name, offsets, frame):
    bone = armature.pose.bones.get(name)
    if bone is None:
        raise RuntimeError(f'Required bone was not found: {name}')
    bone.rotation_mode = 'XYZ'
    base = tuple(bone.rotation_euler)
    bone.rotation_euler = tuple(base[index] + offsets[index] for index in range(3))
    bone.keyframe_insert(data_path='rotation_euler', frame=frame)


def create_flight_stance(armature):
    action = bpy.data.actions.new('OmniManFlightStance')
    armature.animation_data.action = action

    # The supplied idle provides the hands-at-sides base. These controlled
    # local offsets tuck the left knee while extending the opposite leg,
    # giving a clear comic-book flying silhouette without procedural effects.
    pose_offsets = {
        'mixamorig:Hips_01_12': (0.08, 0.0, 0.0),
        'mixamorig:Spine_02_13': (-0.12, 0.0, 0.0),
        # Rotate from the shoulder rather than using a visual effect: the
        # original relaxed pose holds the arms slightly away from the torso.
        # These offsets bring both arms down into the compact flight silhouette.
        'mixamorig:LeftArm_09_21': (0.0, 0.0, -0.78),
        'mixamorig:RightArm_032_50': (0.0, 0.0, 0.78),
        'mixamorig:LeftUpLeg_055_78': (-0.72, 0.0, 0.0),
        'mixamorig:LeftLeg_056_79': (1.26, 0.0, 0.0),
        'mixamorig:LeftFoot_057_80': (-0.48, 0.0, 0.0),
        'mixamorig:LeftToeBase_058_81': (-0.12, 0.0, 0.0),
        'mixamorig:RightUpLeg_060_84': (0.20, 0.0, 0.0),
        'mixamorig:RightLeg_061_85': (0.08, 0.0, 0.0),
        'mixamorig:RightFoot_062_86': (0.10, 0.0, 0.0),
    }
    for frame in (1, 25):
        for name, offsets in pose_offsets.items():
            offset_rotation(armature, name, offsets, frame)
    action.frame_range = (1, 25)
    return action


def create_hover_idle(armature):
    """Keep Omni-Man's supplied neutral pose, but lower the T-pose arms."""
    action = bpy.data.actions.new('OmniManHoverIdle')
    armature.animation_data.action = action
    for frame in (1, 25):
        offset_rotation(armature, 'mixamorig:LeftArm_09_21', (0.0, 0.0, -0.78), frame)
        offset_rotation(armature, 'mixamorig:RightArm_032_50', (0.0, 0.0, 0.78), frame)
        # Counter-rotate at the elbows so the full arm chain follows the torso
        # rather than folding behind it when the shoulders are lowered.
        offset_rotation(armature, 'mixamorig:LeftForeArm_010_22', (0.0, 0.0, 0.78), frame)
        offset_rotation(armature, 'mixamorig:RightForeArm_033_51', (0.0, 0.0, -0.78), frame)
    action.frame_range = (1, 25)
    return action


def main():
    source_path, output_path = sys.argv[sys.argv.index('--') + 1:]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source_path)
    armature = next((obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE'), None)
    if armature is None or armature.animation_data is None or armature.animation_data.action is None:
        raise RuntimeError('Omni-Man source idle pose could not be loaded.')
    source_action = armature.animation_data.action
    create_hover_idle(armature)
    # Start the flight pose from the supplied source pose, not the arm-adjusted
    # hover action, so its shoulder offsets are applied exactly once.
    armature.animation_data.action = source_action
    bpy.context.scene.frame_set(1)
    create_flight_stance(armature)
    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format='GLB',
        export_animations=True,
        export_force_sampling=True,
        export_frame_range=True,
        export_yup=True,
    )


if __name__ == '__main__':
    main()
