export class ParticleManager {
  constructor(scene, getCamera) { this.scene = scene; this.getCamera = getCamera; this.emitters = []; }
  create(options) {
    const THREE = window.THREE, count = options.count ?? 80, positions = new Float32Array(count * 3), velocities = new Float32Array(count * 3);
    for (let i = 0; i < count; i += 1) this.resetParticle(positions, velocities, i, options);
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({ color: options.color ?? 0xffffff, size: options.size ?? .035, transparent: true, opacity: options.opacity ?? .55, depthWrite: false, blending: options.additive ? THREE.AdditiveBlending : THREE.NormalBlending });
    const points = new THREE.Points(geometry, material); points.position.set(...(options.position ?? [0, 0, 0])); this.scene.add(points);
    const emitter = { options, points, positions, velocities, count, active: true }; this.emitters.push(emitter); return emitter;
  }
  resetParticle(positions, velocities, i, options) { const p = i * 3, spread = options.spread ?? [1, 1, 1]; positions[p] = (Math.random() - .5) * spread[0]; positions[p + 1] = Math.random() * spread[1]; positions[p + 2] = (Math.random() - .5) * spread[2]; const velocity = options.velocity ?? [0, -.5, 0]; velocities[p] = velocity[0] + (Math.random() - .5) * (options.jitter ?? .1); velocities[p + 1] = velocity[1] + (Math.random() - .5) * (options.jitter ?? .1); velocities[p + 2] = velocity[2] + (Math.random() - .5) * (options.jitter ?? .1); }
  update(delta) {
    const camera = this.getCamera();
    this.emitters.forEach((emitter) => {
      const visible = emitter.active && emitter.points.position.distanceTo(camera.position) <= (emitter.options.maxDistance ?? 32); emitter.points.visible = visible; if (!visible) return;
      for (let i = 0; i < emitter.count; i += 1) { const p = i * 3; emitter.positions[p] += emitter.velocities[p] * delta; emitter.positions[p + 1] += emitter.velocities[p + 1] * delta; emitter.positions[p + 2] += emitter.velocities[p + 2] * delta; const height = emitter.options.spread?.[1] ?? 1; if (emitter.positions[p + 1] < 0 || emitter.positions[p + 1] > height) this.resetParticle(emitter.positions, emitter.velocities, i, emitter.options); }
      emitter.points.geometry.attributes.position.needsUpdate = true;
    });
  }
  setActive(emitter, active) { if (emitter) emitter.active = active; }
  burst(position, color = 0x36f9f6) { const emitter = this.create({ position, color, count: 28, spread: [.4, .3, .4], velocity: [0, .9, 0], jitter: .8, size: .055, additive: true, maxDistance: 20 }); setTimeout(() => { emitter.active = false; emitter.points.visible = false; }, 1200); }
  dispose() { this.emitters.forEach(({ points }) => { this.scene.remove(points); points.geometry.dispose(); points.material.dispose(); }); this.emitters.length = 0; }
}
