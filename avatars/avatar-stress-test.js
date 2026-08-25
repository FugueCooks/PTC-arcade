export function installAvatarStressTest(renderer, registry, performanceProfile) {
  if (!['localhost', '127.0.0.1'].includes(location.hostname)) return;
  const count = Math.min(100, Math.max(0, Number(new URLSearchParams(location.search).get('avatarStress')) || 0));
  if (!count) return;
  const requestedAvatarId = new URLSearchParams(location.search).get('avatarStressId');
  const requestedState = new URLSearchParams(location.search).get('avatarStressState');
  const nearCamera = new URLSearchParams(location.search).get('avatarStressNear') === '1';
  const avatarId = requestedAvatarId && registry.has(requestedAvatarId)
    ? requestedAvatarId
    : registry.keys().next().value;
  const started = performance.now();
  for (let index = 0; index < count; index += 1) {
    const avatar = renderer.create({ id: `stress-${index}`, n: `BOT ${index + 1}`, v: avatarId }, { showNameplate: true });
    const position = nearCamera
      ? { x: -1.1 + (index % 3) * 1.1, y: 0, z: 7 + Math.floor(index / 3) * 1.5 }
      : { x: -9 + (index % 10) * 2, y: 0, z: -5 + Math.floor(index / 10) * 2 };
    avatar.setTransform(position, Math.PI, requestedState === 'idle' || requestedState === 'walk'
      ? requestedState
      : index % 3 ? 'idle' : 'walk');
  }
  const report = { avatarId, avatarCount: count, nameplateCount: count, setupMs: Number((performance.now() - started).toFixed(3)) };
  const refresh = () => Object.assign(report, renderer.getStats?.(), performanceProfile?.getStats?.(), { sampledAt: Date.now() });
  refresh();
  const timer = setInterval(refresh, 1_000);
  report.stop = () => clearInterval(timer);
  window.ARCADE_STRESS = report;
  console.info('Avatar stress mode', window.ARCADE_STRESS);
}
