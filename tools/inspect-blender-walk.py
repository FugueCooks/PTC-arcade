"""Inspect the imported GLB walk action on the six locomotion bones."""

import json
import sys

import bpy


def main():
    source_path = sys.argv[sys.argv.index("--") + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source_path)

    armature = next(obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE")
    actions = list(bpy.data.actions)
    matching_actions = [item for item in actions if "Walk" in item.name]
    if not matching_actions:
        print(json.dumps({"actions": [item.name for item in actions]}))
        return
    action = matching_actions[0]
    suffixes = ("_073", "_074", "_075", "_082", "_083", "_084")
    names = [next(name for name in armature.pose.bones.keys() if name.endswith(suffix)) for suffix in suffixes]

    output = {}
    for name in names:
        prefix = f'pose.bones["{name}"].rotation_quaternion'
        output[name] = [
            {"index": curve.array_index, "points": [[round(point.co[0], 5), round(point.co[1], 7)] for point in curve.keyframe_points]}
            for curve in action.fcurves
            if curve.data_path == prefix
        ]
    print(json.dumps(output, ensure_ascii=False))


if __name__ == "__main__":
    main()
