export class EnvironmentManager {
  constructor(scene, config, particles) {
    this.scene = scene; this.config = config; this.particles = particles; this.weatherEmitters = []; this.windows = []; this.createWindows(); this.createWeatherPools();
  }
  createWindows() {
    const THREE = window.THREE;
    for (const z of [-7, 0, 7]) {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(.12, 2.5, 3.5), new THREE.MeshStandardMaterial({ color: 0x17233d, metalness: .9, roughness: .14, emissive: 0x071628, emissiveIntensity: .3 })); frame.position.set(13.78, 2.6, z); this.scene.add(frame);
      const glass = new THREE.Mesh(new THREE.PlaneGeometry(3.22, 2.22), new THREE.MeshBasicMaterial({ color: 0x0b2844, transparent: true, opacity: .72, side: THREE.DoubleSide })); glass.position.set(13.7, 2.6, z); glass.rotation.y = -Math.PI / 2; this.scene.add(glass); this.windows.push({ frame, glass });
    }
  }
  createWeatherPools() {
    this.weatherEmitters.push(['rain', this.particles.create({ position: [13.45, 1.25, 0], color: 0x74cfff, count: 260, spread: [.2, 2.5, 15], velocity: [0, -2.8, .05], jitter: .14, size: .026, opacity: .65, maxDistance: 24 })]);
    this.weatherEmitters.push(['snow', this.particles.create({ position: [13.42, 1.25, 0], color: 0xffffff, count: 180, spread: [.25, 2.5, 15], velocity: [0, -.38, .08], jitter: .24, size: .055, opacity: .7, maxDistance: 24 })]);
    this.weatherEmitters.push(['dust', this.particles.create({ position: [13.4, 1.2, 0], color: 0xffc085, count: 100, spread: [.3, 2.3, 15], velocity: [0, .04, .05], jitter: .06, size: .04, opacity: .35, maxDistance: 24 })]);
    this.weatherEmitters.forEach(([, emitter]) => this.particles.setActive(emitter, false));
  }
  apply(state) {
    const THREE = window.THREE, theme = this.config.themes.find((candidate) => candidate.id === state.themeId), weather = this.config.weather.find((candidate) => candidate.id === state.weatherId);
    if (theme) { const color = new THREE.Color(theme.fog); this.scene.background = color.clone().multiplyScalar(.55); if (this.scene.fog) this.scene.fog.color.copy(color); }
    if (weather) this.windows.forEach(({ glass }) => glass.material.color.set(weather.color));
    this.weatherEmitters.forEach(([type, emitter]) => this.particles.setActive(emitter, weather?.particle === type));
  }
  flash() { this.windows.forEach(({ glass }) => { const original = glass.material.color.clone(); glass.material.color.set(0xdcecff); setTimeout(() => glass.material.color.copy(original), 120); }); }
  dispose() { this.windows.forEach(({ frame, glass }) => { this.scene.remove(frame, glass); frame.geometry.dispose(); frame.material.dispose(); glass.geometry.dispose(); glass.material.dispose(); }); }
}
