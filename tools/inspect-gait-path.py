"""Print evaluated hip, knee, and ankle positions across a GLB animation."""

import json
import sys

import bpy


def vector(value):
    return [round(component, 4) for component in value]


def main():
    source_path, action_prefix, frames = sys.argv[sys.argv.index("--") + 1:]
    frame_numbers = [int(value) for value in frames.split(",")]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source_path)

    armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    action = next(action for action in bpy.data.actions if action.name.startswith(action_prefix))
    armature.animation_data_create()
    armature.animation_data.action = action

    suffixes = ["_073", "_074", "_075", "_082", "_083", "_084"]
    bone_names = [next(name for name in armature.pose.bones.keys() if name.endswith(suffix)) for suffix in suffixes]
    output = []
    for frame in frame_numbers:
        bpy.context.scene.frame_set(frame)
        output.append({
            "frame": frame,
            "bones": {
                name: {
                    "head": vector(armature.matrix_world @ armature.pose.bones[name].head),
                    "tail": vector(armature.matrix_world @ armature.pose.bones[name].tail),
                }
                for name in bone_names
            },
        })
    print(json.dumps(output))


if __name__ == "__main__":
    main()
