export class NPCManager {
  constructor(scene, paths, getCamera) {
    this.scene = scene; this.getCamera = getCamera; this.interactionHandler = null; this.npcs = paths.map((path) => this.create(path));
  }
  create(path) {
    const THREE = window.THREE, root = new THREE.Group(), color = new THREE.Color(path.color);
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(.24, .72, 4, 10), new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: .16, metalness: .4, roughness: .35 })); body.position.y = .75;
    const head = new THREE.Mesh(new THREE.SphereGeometry(.19, 14, 14), new THREE.MeshStandardMaterial({ color: 0xddd9ee, roughness: .4 })); head.position.y = 1.45;
    const badge = new THREE.Mesh(new THREE.BoxGeometry(.11, .11, .03), new THREE.MeshBasicMaterial({ color: 0xfff3c4 })); badge.position.set(0, 1, .25);
    root.add(body, head, badge); root.position.set(...path.points[0]); root.userData.npcId = path.id; this.scene.add(root);
    return { path, root, body, targetIndex: 1, idleUntil: 0, phase: Math.random() * Math.PI * 2 };
  }
  update(now, delta) {
    const camera = this.getCamera();
    this.npcs.forEach((npc) => {
      const distance = npc.root.position.distanceTo(camera.position); npc.root.visible = distance < 34; if (!npc.root.visible || distance > 24 || now < npc.idleUntil) return;
      const target = npc.path.points[npc.targetIndex], dx = target[0] - npc.root.position.x, dz = target[2] - npc.root.position.z, remaining = Math.hypot(dx, dz);
      if (remaining < .16) { npc.targetIndex = (npc.targetIndex + 1) % npc.path.points.length; npc.idleUntil = now + 800 + Math.random() * 1400; return; }
      const step = Math.min(remaining, npc.path.speed * delta); npc.root.position.x += dx / remaining * step; npc.root.position.z += dz / remaining * step; npc.root.rotation.y = Math.atan2(dx, dz);
      npc.phase += delta * 7; npc.body.position.y = .75 + Math.abs(Math.sin(npc.phase)) * .035; npc.root.rotation.z = Math.sin(npc.phase * .5) * .018;
    });
  }
  setInteractionHandler(handler) { this.interactionHandler = handler; }
  interact(npcId, playerId = null) { const npc = this.npcs.find((candidate) => candidate.path.id === npcId); if (!npc) return false; this.interactionHandler?.({ npcId, playerId, npc }); return true; }
  dispose() { this.npcs.forEach(({ root }) => { this.scene.remove(root); root.traverse((object) => { if (object.isMesh) { object.geometry.dispose(); object.material.dispose(); } }); }); this.npcs.length = 0; }
}
