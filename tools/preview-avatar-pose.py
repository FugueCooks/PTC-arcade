"""Render a quick auto-framed workbench preview of an avatar action pose."""

import bpy
import os
import sys
from mathutils import Vector


def main():
    source_path, action_prefix, frame, output_path = sys.argv[sys.argv.index("--") + 1:]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source_path)
    armature = next((obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"), None)
    if armature and action_prefix != '-':
        action = next(action for action in bpy.data.actions if action.name.startswith(action_prefix))
        armature.animation_data_create()
        armature.animation_data.action = action
        bpy.context.scene.frame_set(int(frame))

    depsgraph = bpy.context.evaluated_depsgraph_get()
    points = []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        points.extend(evaluated.matrix_world @ vertex.co for vertex in mesh.vertices)
        evaluated.to_mesh_clear()
    lower = Vector([min(point[axis] for point in points) for axis in range(3)])
    upper = Vector([max(point[axis] for point in points) for axis in range(3)])
    center, radius = (lower + upper) / 2, max((upper - lower).length / 2, 1)

    camera_data = bpy.data.cameras.new("PreviewCamera")
    camera = bpy.data.objects.new("PreviewCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = center + Vector((radius * 1.55, -radius * 2.35, radius * 1.2))
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = camera

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.studio_light = "paint.sl"
    scene.display.shading.background_type = "WORLD"
    scene.display.shading.background_color = (0.04, 0.05, 0.08)
    scene.render.resolution_x = 500
    scene.render.resolution_y = 500
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = output_path
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
