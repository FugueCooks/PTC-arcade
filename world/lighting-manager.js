export class LightingManager {
  constructor(scene, config) {
    this.scene = scene; this.config = config; this.lights = []; this.emissives = []; this.accentLights = []; this.targetMultiplier = 1; this.currentMultiplier = 1; this.eventUntil = 0; this.eventType = null;
    scene.traverse((object) => {
      if (object.isLight && object.intensity > 0) this.lights.push({ light: object, base: object.intensity });
      if (object.isMesh) (Array.isArray(object.material) ? object.material : [object.material]).forEach((material) => { if (material?.emissive && material.emissiveIntensity > .4) this.emissives.push({ material, base: material.emissiveIntensity }); });
    });
    const THREE = window.THREE;
    [[-6, 3.5, -5], [0, 3.3, 7], [6, 3.5, -5]].forEach((position) => { const light = new THREE.PointLight(0x36f9f6, 1.4, 9, 2); light.position.set(...position); scene.add(light); this.accentLights.push(light); this.lights.push({ light, base: 1.4 }); });
  }
  apply(state) { const theme = this.config.themes.find((candidate) => candidate.id === state.themeId) ?? this.config.themes[0]; const activity = state.activityLevel === 'busy' ? 1.28 : state.activityLevel === 'active' ? 1 : .72; this.targetMultiplier = activity * theme.brightness; this.accentLights.forEach((light, index) => light.color.set(theme.neon[index % theme.neon.length])); }
  event(event) { this.eventType = event.type; this.eventUntil = performance.now() + event.durationMs; }
  update(now, delta) {
    this.currentMultiplier += (this.targetMultiplier - this.currentMultiplier) * Math.min(1, delta * 1.6);
    let eventFactor = 1;
    if (now < this.eventUntil) eventFactor = this.eventType === 'power-flicker' ? (Math.random() > .72 ? .18 : 1) : this.eventType === 'neon-surge' ? 1.55 : 1;
    this.lights.forEach(({ light, base }, index) => { const flicker = index % 5 === 0 ? .96 + Math.sin(now * .0027 + index) * .04 : 1; light.intensity = base * this.currentMultiplier * eventFactor * flicker; });
    this.emissives.forEach(({ material, base }, index) => { material.emissiveIntensity = base * Math.min(1.45, this.currentMultiplier) * eventFactor * (.97 + Math.sin(now * .003 + index) * .03); });
  }
  dispose() { this.accentLights.forEach((light) => this.scene.remove(light)); this.accentLights.length = 0; }
}
