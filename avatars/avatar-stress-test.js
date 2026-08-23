export function installAvatarStressTest(renderer, registry) {
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) return;
  const count = Math.min(100, Math.max(0, Number(new URLSearchParams(location.search).get('avatarStress')) || 0));
  if (!count) return;
  const avatarId = registry.keys().next().value;
  const started = performance.now();
  for (let index = 0; index < count; index += 1) {
    const avatar = renderer.create({ id: `stress-${index}`, n: `BOT ${index + 1}`, v: avatarId }, { showNameplate: true });
    avatar.setTransform({ x: -9 + (index % 10) * 2, y: 0, z: -5 + Math.floor(index / 10) * 2 }, Math.PI, index % 3 ? 'idle' : 'walk');
  }
  window.ARCADE_STRESS = Object.freeze({ avatarCount: count, setupMs: performance.now() - started });
  console.info('Avatar stress mode', window.ARCADE_STRESS);
}
