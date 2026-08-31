// Prepare a downloaded cabinet GLB for the arcade.
//
// Sketchfab models arrive as full PBR sets — baseColor, normal, occlusion,
// metallicRoughness — and on these the textures are effectively the whole file.
// The NES console model is 16,781 vertices and 104 MB; the mesh is 405 KB of
// that. Meshopt alone therefore does almost nothing to them, which is why this
// step exists and why running gltfpack on its own left a 103 MB file.
//
// What it drops is chosen for where these stand. The Temple of Time's back room
// is lit by the two global lights and nothing else, and the temple's own
// materials are flattened to MeshBasicMaterial on load, so normal, occlusion and
// roughness maps have almost nothing there to act on. baseColor and emissive are
// what read; the rest is weight carried into every clone and every Docker layer.
//
//   node tools/slim-cabinet-models.mjs <sourceDir> <outDir> [maxTextureEdge]
//
// Then meshopt-compress the results:
//   .conversion-tools/meshoptimizer-v1.2/gltfpack.exe -i <in> -o <out> -cc
import fs from 'fs';
import path from 'path';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { prune, dedup, resample, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';

const [sourceDir, outDir, maxEdgeArg] = process.argv.slice(2);
if (!sourceDir || !outDir) {
  console.error('usage: node tools/slim-cabinet-models.mjs <sourceDir> <outDir> [maxTextureEdge]');
  process.exit(1);
}
const maxEdge = Number(maxEdgeArg ?? 2048);

// Source name to the name it takes in the arcade. Source names come from
// Sketchfab with spaces and parentheses in them; everything the arcade serves
// is lowercase kebab.
const JOBS = [
  ['gameboy_advance_-_zelda_concept (1).glb', 'zelda-gba-cabinet.glb'],
  ['gamecube.glb', 'zelda-gamecube-cabinet.glb'],
  ['nintendo_3ds_majoras_mask. (1).glb', 'zelda-ds-cabinet.glb'],
  ['nes_console_and_controller.glb', 'zelda-nes-cabinet.glb'],
  ['nintendo_64.glb', 'zelda-n64-cabinet.glb'],
  ['super_mario_bros_arcade.glb', 'mario-smb-arcade.glb'],
  ['arcade_machine_lowpoly.glb', 'mario-bros-arcade.glb'],
  ['super_mario_3_acrade.glb', 'mario-smb3-arcade.glb'],
];

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
fs.mkdirSync(outDir, { recursive: true });

let missing = 0;
for (const [inName, outName] of JOBS) {
  const inPath = path.join(sourceDir, inName);
  if (!fs.existsSync(inPath)) {
    console.log(`  skip  ${outName.padEnd(30)} source not present: ${inName}`);
    missing++;
    continue;
  }
  const before = fs.statSync(inPath).size;
  const doc = await io.read(inPath);

  let dropped = 0;
  for (const material of doc.getRoot().listMaterials()) {
    for (const slot of ['NormalTexture', 'OcclusionTexture', 'MetallicRoughnessTexture']) {
      if (material[`get${slot}`]()) { material[`set${slot}`](null); dropped++ }
    }
    // glTF's default metallicFactor is 1.0, and a model that carries a
    // metallicRoughness texture is usually relying on it to bring that down to
    // zero across most of the mesh. Drop the texture and leave the factor and
    // the whole thing renders fully metallic — which, with no environment map
    // in the scene to reflect, is solid black. This is what turned the Game Boy
    // and NES cabinets into black slabs on the temple floor the first time.
    material.setMetallicFactor(0);
    material.setRoughnessFactor(0.85);
  }

  await doc.transform(
    resample(),
    dedup(),
    // prune first so the dropped maps are gone before anything re-encodes them
    prune(),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [maxEdge, maxEdge], quality: 90 }),
    prune(),
  );

  const outPath = path.join(outDir, outName);
  await io.write(outPath, doc);
  const after = fs.statSync(outPath).size;
  console.log(`  ok    ${outName.padEnd(30)} ${(before / 1e6).toFixed(1)}MB -> ${(after / 1e6).toFixed(1)}MB`
    + `   ${dropped} maps dropped, ${doc.getRoot().listTextures().length} textures kept`);
}
if (missing) console.log(`\n${missing} source model(s) not present yet.`);
