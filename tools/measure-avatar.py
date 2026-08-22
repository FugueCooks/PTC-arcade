import bpy
from mathutils import Vector
import sys


def main():
    source_path = sys.argv[sys.argv.index("--") + 1]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source_path)
    bpy.context.view_layer.update()

    corners = []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        object_corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
        corners.extend(object_corners)
        object_minimum = Vector(min(value[index] for value in object_corners) for index in range(3))
        object_maximum = Vector(max(value[index] for value in object_corners) for index in range(3))
        print("OBJECT", obj.name, "MESH", obj.data.name, "PARENT", obj.parent.name if obj.parent else None, "MODIFIERS", [modifier.type for modifier in obj.modifiers], "MATERIALS", [slot.material.name if slot.material else None for slot in obj.material_slots], "MIN", tuple(round(value, 5) for value in object_minimum), "MAX", tuple(round(value, 5) for value in object_maximum), "SIZE", tuple(round(object_maximum[index] - object_minimum[index], 5) for index in range(3)))
    minimum = Vector(min(value[index] for value in corners) for index in range(3))
    maximum = Vector(max(value[index] for value in corners) for index in range(3))
    print("MIN", tuple(round(value, 5) for value in minimum))
    print("MAX", tuple(round(value, 5) for value in maximum))
    print("SIZE", tuple(round(maximum[index] - minimum[index], 5) for index in range(3)))


if __name__ == "__main__":
    main()
