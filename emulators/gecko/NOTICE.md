# Gecko browser prototype

This directory hosts an experimental browser build of [Gecko](https://github.com/ioncodes/gecko), pinned to commit `39e82205a0da154f23fd36b95e64a8029d468618` and licensed under GPL-3.0.

The generated `pkg/` directory and upstream GPL license are produced by `.github/workflows/build-gecko-web.yml`. The local patch in `tools/gecko-web-disc.patch` exposes Gecko's existing GameCube HLE disc boot path to its web frontend and enables ISO, GCM, and RVZ file selection.

Game images and console system files are not included in Git or in the generated runtime. Users must supply files they are legally entitled to use.

This runtime is a test bench, not a production cabinet core. Gecko is experimental, the web build requires WebGPU, and large disc images can exceed browser or mobile-device memory limits.
