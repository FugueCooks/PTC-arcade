"""Create a restrained, full-stride walk loop for the Omni-Man Mixamo rig."""

import math
import sys

import bpy


FPS = 24
FRAMES = (1, 7, 13, 19, 25)


def pose(armature, names, frame, values):
    """Apply local Euler offsets over the imported neutral pose and keyframe them."""
    for name, offset in zip(names, values):
        bone = armature.pose.bones.get(name)
        if bone is None:
            raise RuntimeError(f"Required bone was not found: {name}")
        bone.rotation_mode = 'XYZ'
        base = bone.get('walk_base_rotation')
        if base is None:
            base = tuple(bone.rotation_euler)
            bone['walk_base_rotation'] = base
        bone.rotation_euler = tuple(base[index] + offset[index] for index in range(3))
        bone.keyframe_insert(data_path='rotation_euler', frame=frame)


def axis_pose(armature, name, frame, value, axis=0):
    bone = armature.pose.bones.get(name)
    if bone is None:
        raise RuntimeError(f"Required bone was not found: {name}")
    bone.rotation_mode = 'XYZ'
    base = bone.get('walk_base_rotation')
    if base is None:
        base = tuple(bone.rotation_euler)
        bone['walk_base_rotation'] = base
    rotation = list(base)
    rotation[axis] += value
    bone.rotation_euler = rotation
    bone.keyframe_insert(data_path='rotation_euler', frame=frame)


def add_natural_walk(armature):
    if armature.animation_data is None:
        armature.animation_data_create()
    action = bpy.data.actions.new('OmniManNaturalWalk')
    armature.animation_data.action = action

    hips = 'mixamorig:Hips_01_12'
    left_leg = ('mixamorig:LeftUpLeg_055_78', 'mixamorig:LeftLeg_056_79', 'mixamorig:LeftFoot_057_80', 'mixamorig:LeftToeBase_058_81')
    right_leg = ('mixamorig:RightUpLeg_060_84', 'mixamorig:RightLeg_061_85', 'mixamorig:RightFoot_062_86', 'mixamorig:RightToeBase_063_87')
    left_arm = 'mixamorig:LeftArm_09_21'
    right_arm = 'mixamorig:RightArm_032_50'
    spine = 'mixamorig:Spine_02_13'

    # Contact, down, passing, up, contact. The stride uses opposing thigh
    # arcs, a bent swing knee, ankle roll, and small counter-swinging arms.
    left_cycle = (
        (-0.34, 0.08, 0.13, -0.04),
        (-0.17, 0.04, 0.04, 0.00),
        (0.07, 0.42, -0.17, 0.16),
        (0.28, 0.56, -0.25, 0.23),
        (-0.34, 0.08, 0.13, -0.04),
    )
    right_cycle = (
        (0.28, 0.56, -0.25, 0.23),
        (-0.34, 0.08, 0.13, -0.04),
        (-0.17, 0.04, 0.04, 0.00),
        (0.07, 0.42, -0.17, 0.16),
        (0.28, 0.56, -0.25, 0.23),
    )
    arm_cycle = (-0.20, -0.10, 0.07, 0.18, -0.20)
    right_arm_cycle = (0.18, 0.07, -0.10, -0.20, 0.18)
    hip_sway = (0.018, -0.009, -0.017, 0.008, 0.018)
    hip_bob = (0.0, -0.018, 0.002, -0.012, 0.0)

    for index, frame in enumerate(FRAMES):
        axis_pose(armature, left_leg[0], frame, left_cycle[index][0])
        axis_pose(armature, left_leg[1], frame, left_cycle[index][1])
        axis_pose(armature, left_leg[2], frame, left_cycle[index][2])
        axis_pose(armature, left_leg[3], frame, left_cycle[index][3])
        axis_pose(armature, right_leg[0], frame, right_cycle[index][0])
        axis_pose(armature, right_leg[1], frame, right_cycle[index][1])
        axis_pose(armature, right_leg[2], frame, right_cycle[index][2])
        axis_pose(armature, right_leg[3], frame, right_cycle[index][3])
        # Arms point along their local X axis, so local Z gives a clean
        # front/back shoulder swing without flaring them sideways.
        axis_pose(armature, left_arm, frame, arm_cycle[index], axis=2)
        axis_pose(armature, right_arm, frame, right_arm_cycle[index], axis=2)
        axis_pose(armature, spine, frame, -hip_sway[index] * 0.45)

        hip_bone = armature.pose.bones.get(hips)
        hip_bone.rotation_mode = 'XYZ'
        base_rotation = hip_bone.get('walk_base_rotation')
        if base_rotation is None:
            base_rotation = tuple(hip_bone.rotation_euler)
            hip_bone['walk_base_rotation'] = base_rotation
        hip_bone.rotation_euler = (base_rotation[0], base_rotation[1], base_rotation[2] + hip_sway[index])
        hip_bone.keyframe_insert(data_path='rotation_euler', frame=frame)
        base_location = hip_bone.get('walk_base_location')
        if base_location is None:
            base_location = tuple(hip_bone.location)
            hip_bone['walk_base_location'] = base_location
        hip_bone.location = (base_location[0], base_location[1], base_location[2] + hip_bob[index])
        hip_bone.keyframe_insert(data_path='location', frame=frame)

    for curve in action.fcurves:
        for point in curve.keyframe_points:
            point.interpolation = 'BEZIER'
    action.frame_range = (FRAMES[0], FRAMES[-1])
    return action


def main():
    source_path, output_path = sys.argv[sys.argv.index('--') + 1:]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source_path)
    armature = next((obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE'), None)
    if armature is None:
        raise RuntimeError('No armature found in Omni-Man source file.')
    # The supplied clip is a correctly posed idle, so retain it as the base
    # for both states. Its bind pose alone has the arms flared outward.
    armature.animation_data_create()
    source_idle = armature.animation_data.action
    if source_idle is None:
        raise RuntimeError('Omni-Man source file does not contain its expected idle pose.')
    source_idle.name = 'OmniManIdle'
    add_natural_walk(armature)
    bpy.context.scene.render.fps = FPS
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
