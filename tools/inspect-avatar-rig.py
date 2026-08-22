import bpy
import json
import sys


def main():
    source_path = sys.argv[sys.argv.index("--") + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source_path)

    armatures = []
    for obj in bpy.context.scene.objects:
        if obj.type != "ARMATURE":
            continue
        armatures.append(
            {
                "name": obj.name,
                "bones": [
                    {
                        "name": bone.name,
                        "parent": bone.parent.name if bone.parent else None,
                        "head": [round(value, 4) for value in bone.head_local],
                        "tail": [round(value, 4) for value in bone.tail_local],
                    }
                    for bone in obj.data.bones
                ],
            }
        )

    print(json.dumps({"armatures": armatures}, ensure_ascii=False))


if __name__ == "__main__":
    main()
