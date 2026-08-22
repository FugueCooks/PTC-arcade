"""Render a side-on diagnostic frame for a GLB avatar animation."""

import os
import sys

import bpy
from mathutils import Vector


def get_bounds():
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
    return lower, upper


def main():
    arguments = sys.argv[sys.argv.index("--") + 1:]
    source_path, action_prefix, frame, output_path = arguments[:4]
    view = arguments[4] if len(arguments) > 4 else "side"
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source_path)

    armature = next((obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"), None)
    if armature and action_prefix.lower() != "none":
        action = next(action for action in bpy.data.actions if action.name.startswith(action_prefix))
        armature.animation_data_create()
        armature.animation_data.action = action
        bpy.context.scene.frame_set(int(frame))

    lower, upper = get_bounds()
    center = (lower + upper) / 2
    radius = max((upper - lower).length / 2, 1)

    camera_data = bpy.data.cameras.new("SidePreviewCamera")
    camera = bpy.data.objects.new("SidePreviewCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    # Character models use Z-up. A frontal reference view therefore looks
    # along the horizontal Y axis rather than down from above.
    camera.location = center + (Vector((0, -radius * 3.0, 0)) if view == "front" else Vector((radius * 3.0, 0, 0)))
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera_data.type = "ORTHO"
    camera_data.ortho_scale = radius * 2.35
    bpy.context.scene.camera = camera

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.studio_light = "paint.sl"
    scene.display.shading.background_type = "WORLD"
    scene.display.shading.background_color = (0.04, 0.05, 0.08)
    scene.render.resolution_x = 700
    scene.render.resolution_y = 700
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = output_path
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
