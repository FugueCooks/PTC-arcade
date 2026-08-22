"""Render evenly spaced diagnostic frames from a local video with Blender's VSE."""

import os
import sys

import bpy


def main():
    video_path, output_dir, sample_count = sys.argv[sys.argv.index("--") + 1:]
    sample_count = int(sample_count)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    editor = scene.sequence_editor_create()
    strip = editor.sequences.new_movie("movement-recording", video_path, channel=1, frame_start=1)
    duration = max(strip.frame_final_duration, 1)

    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.use_file_extension = True
    scene.render.film_transparent = False
    os.makedirs(output_dir, exist_ok=True)

    for index in range(sample_count):
        frame = 1 + round((duration - 1) * index / max(sample_count - 1, 1))
        scene.frame_set(frame)
        scene.render.filepath = os.path.join(output_dir, f"sample-{index + 1:02d}.png")
        bpy.ops.render.render(write_still=True)

    print(f"Rendered {sample_count} frames from {duration} source frames.")


if __name__ == "__main__":
    main()
