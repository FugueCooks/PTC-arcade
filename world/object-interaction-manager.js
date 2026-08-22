export class ObjectInteractionManager {
  constructor(arcade, objects, onInteract) {
    this.arcade = arcade; this.objects = []; this.onInteract = onInteract; this.near = null; this.prompt = document.querySelector('#world-prompt'); this.lastCheck = 0;
    objects.forEach((definition) => this.add(definition)); this.onKey = (event) => { if (event.code === 'KeyE' && !event.repeat && this.near && !isTyping()) this.onInteract(this.near.definition); };
    window.addEventListener('keydown', this.onKey);
  }
  add(definition) { const visual = this.createVisual(definition); this.objects.push({ definition, visual }); }
  createVisual(definition) {
    if (definition.type === 'prize-counter') return null;
    const THREE = window.THREE, group = new THREE.Group(); group.position.set(...definition.position);
    const colors = { jukebox: 0xff3cac, vending: 0x36f9f6, kiosk: 0xffcc4a }, color = colors[definition.type] ?? 0x934dff;
    const body = new THREE.Mesh(new THREE.BoxGeometry(definition.type === 'jukebox' ? 1.35 : 1.05, definition.type === 'jukebox' ? 2.15 : 1.85, .75), new THREE.MeshStandardMaterial({ color: 0x101423, emissive: color, emissiveIntensity: .18, metalness: .75, roughness: .2 })); body.position.y = definition.type === 'jukebox' ? 1.08 : .93; group.add(body);
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(.76, .72), new THREE.MeshBasicMaterial({ color })); screen.position.set(0, 1.25, .381); group.add(screen);
    const trim = new THREE.Mesh(new THREE.TorusGeometry(.46, .045, 10, 32, Math.PI), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 2 })); trim.position.set(0, 1.56, .4); group.add(trim);
    this.arcade.scene.add(group); return group;
  }
  update(now) {
    if (now - this.lastCheck < 100) return; this.lastCheck = now; const player = this.arcade.getLocalTransform().position; let nearest = null, nearestDistance = Infinity;
    this.objects.forEach((object) => { const [x,,z] = object.definition.position, distance = Math.hypot(player.x - x, player.z - z); if (distance <= object.definition.interactionDistance && distance < nearestDistance) { nearest = object; nearestDistance = distance; } });
    this.near = nearest; this.prompt.classList.toggle('visible', Boolean(nearest)); if (nearest) this.prompt.querySelector('span').textContent = nearest.definition.name;
  }
  dispose() { window.removeEventListener('keydown', this.onKey); this.objects.forEach(({ visual }) => { if (!visual) return; this.arcade.scene.remove(visual); visual.traverse((object) => { if (object.isMesh) { object.geometry.dispose(); object.material.dispose(); } }); }); }
}
function isTyping() { const tag = document.activeElement?.tagName; return tag === 'INPUT' || tag === 'TEXTAREA'; }
