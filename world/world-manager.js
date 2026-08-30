import { EnvironmentManager } from './environment-manager.js?v=preload-1';
import { LightingManager } from './lighting-manager.js';
import { ObjectInteractionManager } from './object-interaction-manager.js';
import { ParticleManager } from './particle-manager.js';

export class WorldManager {
  static async create(arcade, socket) {
    const response = await fetch('assets/world/config.json?v=npcs-removed-1'); if (!response.ok) throw new Error('World configuration could not load.');
    const config = await response.json(); return new WorldManager(arcade, socket, config);
  }
  constructor(arcade, socket, config) {
    this.arcade = arcade; this.socket = socket; this.config = config; this.state = null; this.lastFrameAt = performance.now(); this.nextFrameAt = 0; this.updateIntervalMs = arcade.performanceProfile?.lowPower ? 50 : 33; this.disposed = false; this.suspended = false; this.announcementTimer = 0;
    this.particles = new ParticleManager(arcade.scene, arcade.getCamera); this.environment = new EnvironmentManager(arcade.scene, config, this.particles);
    this.lighting = new LightingManager(arcade.scene, config);
    this.interactions = new ObjectInteractionManager(arcade, config.objects, (object) => this.interact(object));
    this.dust = this.particles.create({ position: [0, .1, 0], color: 0xbba7dc, count: 90, spread: [24, 4.2, 26], velocity: [0, .025, 0], jitter: .025, size: .025, opacity: .18, maxDistance: 30 });
    socket.on('world:snapshot', (state) => { this.apply(state); this.announce({ text: 'Welcome to the PTC Arcade.' }); });
    socket.on('world:state-changed', (state) => this.apply(state)); socket.on('world:announcement', (announcement) => this.announce(announcement)); socket.on('world:event', (event) => this.event(event));
    this.onEmulatorModeChanged = (event) => { this.suspended = Boolean(event.detail?.active); this.lastFrameAt = performance.now(); };
    window.addEventListener('arcade:emulator-mode-changed', this.onEmulatorModeChanged);
    this.frame = (now) => this.update(now); requestAnimationFrame(this.frame);
  }
  apply(state) { if (this.state && state.revision < this.state.revision) return; this.state = state; this.environment.apply(state); this.lighting.apply(state); const theme = this.config.themes.find((candidate) => candidate.id === state.themeId); document.querySelector('#world-status').textContent = `${theme?.name ?? state.themeId} · ${state.activityLevel}`.toUpperCase(); }
  interact(object) { const messages = { 'prize-counter': 'PRIZE COUNTER // SHOP COMING LATER' }; this.announce({ text: messages[object.type] ?? `${object.name} // READY` }); }
  announce(announcement) { const element = document.querySelector('#world-announcement'); element.textContent = announcement.text; element.classList.add('visible'); clearTimeout(this.announcementTimer); this.announcementTimer = setTimeout(() => element.classList.remove('visible'), 4200); }
  event(event) { this.lighting.event(event); if (event.type === 'power-flicker' && this.state?.weatherId === 'thunder') this.environment.flash(); if (event.type === 'neon-surge') this.particles.burst([0, 2.2, 0], 0xff3cac); if (event.type === 'fireworks') this.particles.burst([12.8, 3, 0], 0xffd34a); }
  update(now) { if (this.disposed) return; requestAnimationFrame(this.frame); if (this.suspended || now < this.nextFrameAt) return; this.nextFrameAt = now + this.updateIntervalMs; const delta = Math.min(.05, (now - this.lastFrameAt) / 1000); this.lastFrameAt = now; this.interactions.update(now); this.lighting.update(now, delta); this.particles.update(delta); }
  dispose() { this.disposed = true; window.removeEventListener('arcade:emulator-mode-changed', this.onEmulatorModeChanged); clearTimeout(this.announcementTimer); this.lighting.dispose(); this.environment.dispose(); this.interactions.dispose(); this.particles.dispose(); }
}
