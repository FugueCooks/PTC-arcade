import bpy
import math
import os
import sys
from mathutils import Vector


def look_at(obj, point):
    obj.rotation_euler = (Vector(point) - obj.location).to_track_quat('-Z', 'Y').to_euler()


def render_frame(source_path, action_name, frame, output_path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source_path)
    armature = next(obj for obj in bpy.context.scene.objects if obj.type == 'ARMATURE')
    action = bpy.data.actions.get(action_name)
    if action:
        armature.animation_data_create()
        armature.animation_data.action = action
    bpy.context.scene.frame_set(frame)

    camera_data = bpy.data.cameras.new('PreviewCamera')
    camera = bpy.data.objects.new('PreviewCamera', camera_data)
    bpy.context.collection.objects.link(camera)
    camera.location = (5.2, -7.8, 3.4)
    look_at(camera, (0.25, 0, 1.1))
    bpy.context.scene.camera = camera

    light_data = bpy.data.lights.new('Key', 'AREA')
    light_data.energy = 1300
    light_data.shape = 'DISK'
    light_data.size = 5
    light = bpy.data.objects.new('Key', light_data)
    bpy.context.collection.objects.link(light)
    light.location = (3, -4, 6)
    look_at(light, (0, 0, 1))

    fill_data = bpy.data.lights.new('Fill', 'AREA')
    fill_data.energy = 700
    fill_data.size = 4
    fill = bpy.data.objects.new('Fill', fill_data)
    bpy.context.collection.objects.link(fill)
    fill.location = (-4, -2, 3)
    look_at(fill, (0, 0, 1))

    world = bpy.data.worlds.new('PreviewWorld')
    world.color = (0.015, 0.02, 0.04)
    bpy.context.scene.world = world
    bpy.context.scene.render.engine = 'BLENDER_EEVEE_NEXT'
    bpy.context.scene.render.resolution_x = 600
    bpy.context.scene.render.resolution_y = 600
    bpy.context.scene.render.resolution_percentage = 100
    bpy.context.scene.render.image_settings.file_format = 'PNG'
    bpy.context.scene.render.filepath = output_path
    bpy.ops.render.render(write_still=True)


def main():
    source_path, action_name, frame, output_path = sys.argv[sys.argv.index('--') + 1:]
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    render_frame(source_path, action_name, int(frame), output_path)


if __name__ == '__main__':
    main()
