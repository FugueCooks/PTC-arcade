"""Export Omni-Man's bind-rest pose as static geometry for renderer-safe idling."""

import sys

import bpy


def main():
    source_path, output_path = sys.argv[sys.argv.index('--') + 1:]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source_path)
    armature = next((obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE'), None)
    if armature is None:
        raise RuntimeError('Omni-Man armature could not be loaded.')

    # The source GLB has a pose clip selected at import time.  It bends the
    # arms into a stylised stance, which is not suitable for a neutral idle.
    # Clear it before evaluating meshes so we bake the model's actual bind
    # pose: shoulders relaxed, elbows straight, and hands alongside the hips.
    armature.animation_data_clear()
    bpy.context.scene.frame_set(0)
    bpy.context.view_layer.objects.active = armature
    armature.select_set(True)

    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh_objects = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    baked = []
    for obj in mesh_objects:
        # The source includes a detached Icosphere helper which is not part of
        # Omni-Man's body and would otherwise appear as a loose ball at his feet.
        if obj.name.startswith('Icosphere'):
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = bpy.data.meshes.new_from_object(evaluated, depsgraph=depsgraph)
        replacement = bpy.data.objects.new(obj.name, mesh)
        replacement.matrix_world = obj.matrix_world.copy()
        bpy.context.collection.objects.link(replacement)
        for material in obj.data.materials:
            mesh.materials.append(material)
        baked.append((obj, replacement))

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
