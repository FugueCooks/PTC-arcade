import { MatchPanel } from './matches/match-panel.js?v=arcade-rows-6';

(() => {
  const arcade = window.arcadeMultiplayer;
  if (!arcade || typeof window.createArcadeSocket !== 'function') {
    console.warn('Multiplayer client unavailable. Start the arcade with the Node launcher.');
    return;
  }

  const RESUME_TOKEN_KEY = 'roms-arcade-multiplayer-resume-token';
  const sendIntervalMs = 66;
  const interpolationDelayMs = 100;
  const remotePlayers = new Map();
  let socket;
  let avatarRenderer;
  let cabinetVisuals;
  let cabinetSessions;
  let presenceClient;
  let inspectionClient;
  let worldManager;
  let localPlayerId;
  let localAvatar;
  let lastSentAt = 0;
  let lastSentTransform;
  let lastAvatarFrameAt = 0;
  // Only animation stepping is budgeted, and only on low power hardware.
  // Throttling positions below the render rate is what makes avatars stutter.
  const avatarFrameIntervalMs = arcade.performanceProfile?.lowPower ? 1000 / 30 : 0;
  const localAvatarPosition = new THREE.Vector3();
  const remoteAvatarPosition = new THREE.Vector3();
  let started = false;
  let currentRoomId = 'main';
  let placementAbortController;
  const fullRoomAttempts = new Set();

  const angleLerp = (from, to, alpha) => {
    const difference = Math.atan2(Math.sin(to - from), Math.cos(to - from));
    return from + difference * alpha;
  };

  const asTransform = (state) => ({ position: { x: state.p[0], y: state.p[1], z: state.p[2] }, rotationY: state.r });

  const removeRemotePlayer = (id) => {
    const remote = remotePlayers.get(id);
    if (!remote) return;
    avatarRenderer.remove(remote.avatar);
    remotePlayers.delete(id);
    presenceClient?.remove(id);
    inspectionClient?.refresh();
  };

  const setRemoteDisconnected = (id, disconnected) => remotePlayers.get(id)?.avatar.setDisconnected(disconnected);

  const addSample = (state) => {
    presenceClient?.upsert(state);
    if (!localPlayerId || state.id === localPlayerId) return;
    let remote = remotePlayers.get(state.id);
    if (!remote) {
      remote = { avatar: avatarRenderer.create(state), samples: [] };
      remotePlayers.set(state.id, remote);
    }
    remote.avatar.applyIdentity(state);
    setRemoteDisconnected(state.id, false);
    remote.samples.push({ receivedAt: performance.now(), state });
    if (remote.samples.length > 8) remote.samples.shift();
  };

  const applyServerCorrection = (state) => {
    if (state.id !== localPlayerId) return;
    if (!localAvatar) localAvatar = avatarRenderer.create(state, { showNameplate: false });
    else localAvatar.applyIdentity(state);
    const local = arcade.getLocalTransform();
    const target = asTransform(state);
    const drift = Math.hypot(local.position.x - target.position.x, local.position.z - target.position.z);
    const rotationDrift = Math.abs(Math.atan2(Math.sin(target.rotationY - local.rotationY), Math.cos(target.rotationY - local.rotationY)));
    // A predicting client always runs about one round trip ahead of the echo it
    // gets back, so while the player is walking the server state is legitimately
    // stale by roughly speed x latency. Easing toward it on every packet drags
    // the camera backwards fifteen times a second, which reads as shaking. Mid
    // stride only a real desync is worth correcting.
    if (arcade.getLocalAnimationState?.() === 'walk') {
      if (drift > 1) arcade.applyAuthoritativeTransform(target, 0.28);
      return;
    }
    if (drift < 0.08 && rotationDrift < 0.05) return;
    arcade.applyAuthoritativeTransform(target, drift > 1 ? 0.28 : drift > 0.35 ? 0.08 : 0.025);
  };

  const interpolateRemotePlayers = (now) => {
    const renderTime = now - interpolationDelayMs;
    remotePlayers.forEach((remote) => {
      const samples = remote.samples;
      if (!samples.length) return;
      while (samples.length > 2 && samples[1].receivedAt <= renderTime) samples.shift();
      const first = samples[0];
      const second = samples[1] ?? first;
      const span = Math.max(1, second.receivedAt - first.receivedAt);
      const alpha = Math.max(0, Math.min(1, (renderTime - first.receivedAt) / span));
      const from = first.state;
      const to = second.state;
      const movedBetweenSamples = Math.hypot(to.p[0] - from.p[0], to.p[2] - from.p[2]) > 0.003;
      // An idle server state always wins. The position fallback also prevents a
      // stale final walk packet from looping forever if an idle packet is delayed.
      const animation = to.a === 'walk' && !movedBetweenSamples ? 'idle' : to.a;
      remoteAvatarPosition.set(
        from.p[0] + (to.p[0] - from.p[0]) * alpha,
        Math.max(0, from.p[1] + (to.p[1] - from.p[1]) * alpha - 1.65),
        from.p[2] + (to.p[2] - from.p[2]) * alpha
      );
      remote.avatar.setTransform(remoteAvatarPosition, angleLerp(from.r, to.r, alpha), animation);
    });
  };

  const hasMeaningfullyChanged = (next) => {
    if (!lastSentTransform) return true;
    const previous = lastSentTransform;
    return Math.hypot(next.position.x - previous.position.x, next.position.z - previous.position.z) > 0.01
      || Math.abs(next.rotationY - previous.rotationY) > 0.01
      || next.animation !== previous.animation;
  };

  const sendLocalTransform = (now) => {
    if (!socket?.connected || !localPlayerId || now - lastSentAt < sendIntervalMs) return;
    const transform = { ...arcade.getLocalTransform(), animation: arcade.getLocalAnimationState() };
    if (!hasMeaningfullyChanged(transform)) return;
    // Movement is transient state. Dropping a packet during congestion is much
    // better than replaying stale positions after the connection recovers.
    socket.volatile.emit('player:move', { p: [transform.position.x, transform.position.z], r: transform.rotationY });
    lastSentTransform = { position: { ...transform.position }, rotationY: transform.rotationY, animation: transform.animation };
    lastSentAt = now;
  };

  const frame = (now) => {
    if (!avatarRenderer || arcade.isEmulatorActive?.()) return;
    interpolateRemotePlayers(now);
    if (localAvatar) {
      const local = arcade.getLocalTransform();
      localAvatar.setHidden(arcade.isFirstPerson?.() === true);
      localAvatarPosition.set(local.position.x, 0, local.position.z);
      localAvatar.setTransform(localAvatarPosition, local.rotationY, arcade.getLocalAnimationState());
    }
    if (now - lastAvatarFrameAt >= avatarFrameIntervalMs - 1) {
      lastAvatarFrameAt = now;
      avatarRenderer.update(now);
    }
    sendLocalTransform(now);
  };

  const start = async (selection) => {
    if (started) return;
    started = true;
    try {
      const requestedRoomId = typeof selection.roomId === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(selection.roomId) ? selection.roomId : undefined;
      currentRoomId = requestedRoomId || 'main';
      const identity = { displayName: selection.displayName, avatarId: selection.avatarId };
      const { RoomPlacementClient } = await import('./rooms/room-placement-client.js?v=phase7-room-browser-1');
      const lastResumeToken = sessionStorage.getItem(RESUME_TOKEN_KEY) ?? sessionStorage.getItem(`${RESUME_TOKEN_KEY}:${currentRoomId}`) ?? undefined;
      placementAbortController = new AbortController();
      const placement = await new RoomPlacementClient().quickJoin(requestedRoomId, {
        signal: placementAbortController.signal,
        resumeToken: lastResumeToken,
        onWaiting: (detail) => window.dispatchEvent(new CustomEvent('arcade:placement-waiting', { detail }))
      });
      placementAbortController = undefined;
      window.dispatchEvent(new CustomEvent('arcade:placement-ready'));
      if (placement?.roomId) currentRoomId = placement.roomId;
      await window.prepareArcadeRealtime?.();
      const [{ AvatarRenderer }, { loadAvatarRegistry }, { CabinetNetworkClient }, { CabinetVisualState }, { CabinetSessionController }, { loadCabinetRegistry }, { ChatClient }, { PresenceClient }, { ReactionClient }, { InspectionClient }, { WorldManager }] = await Promise.all([
        import('./avatars/avatar-renderer.js?v=phase4-1'), import('./avatars/avatar-registry.js?v=triple-t-label-2'),
        import('./cabinets/cabinet-network-client.js?v=phase4-1'), import('./cabinets/cabinet-visual-state.js?v=phase4-1'),
        import('./cabinets/cabinet-session-controller.js?v=phase4-1'), import('./cabinets/cabinet-registry.js?v=murals-4'),
        import('./social/chat-client.js?v=phase5-1'), import('./social/presence-client.js?v=network-meter-1'),
        import('./social/reaction-client.js?v=phase5-2'), import('./social/inspection-client.js?v=phase5-1'),
        import('./world/world-manager.js?v=arcade-rows-6')
      ]);
      const avatarRegistry = await loadAvatarRegistry();
      avatarRenderer = new AvatarRenderer(arcade.scene, arcade.getCamera, avatarRegistry);
      const { installAvatarStressTest } = await import('./avatars/avatar-stress-test.js?v=triple-t-label-2');
      installAvatarStressTest(avatarRenderer, avatarRegistry, arcade.performanceProfile);
      // Render a local fallback immediately. The server snapshot will replace
      // its identity with the validated state once the room connection opens.
      localAvatar = avatarRenderer.create({ id: 'local-preview', n: identity.displayName, v: identity.avatarId }, { showNameplate: false });
      // Let Socket.IO negotiate polling/WebSocket order. Some ISP and mobile
      // routes perform substantially worse when WebSocket is forced first.
      let initialTicket = selection.realtimeTicket;
      const ticketProvider = initialTicket ? async () => {
        if (initialTicket) { const ticket = initialTicket; initialTicket = undefined; return ticket; }
        const response = await fetch('/api/auth/realtime-ticket', { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || typeof payload.ticket !== 'string') throw new Error(payload?.error?.message ?? 'Secure multiplayer admission failed.');
        return payload.ticket;
      } : undefined;
      socket = window.createArcadeSocket({ endpoint: placement?.realtimeUrl, reconnectionDelay: 500, reconnectionDelayMax: 3000,
        roomId: currentRoomId, ticket: selection.realtimeTicket, ticketProvider });
      new ChatClient(socket);
      presenceClient = new PresenceClient(socket, avatarRegistry);
      new ReactionClient(socket, (id) => id === localPlayerId ? localAvatar : remotePlayers.get(id)?.avatar);
      inspectionClient = new InspectionClient(arcade, avatarRenderer, presenceClient, (id) => remotePlayers.get(id));
      worldManager = await WorldManager.create(arcade, socket);
      cabinetVisuals = new CabinetVisualState(arcade);
      cabinetSessions = new CabinetSessionController(arcade, new CabinetNetworkClient(socket), cabinetVisuals, await loadCabinetRegistry());
      const joinRoom = () => socket.emit('room:join', {
        protocolVersion: 1,
        roomId: currentRoomId,
        resumeToken: sessionStorage.getItem(`${RESUME_TOKEN_KEY}:${currentRoomId}`) ?? undefined,
        reservationToken: placement?.reservationToken,
        ticket: typeof socket.admissionTicket === 'function' ? socket.admissionTicket() : selection.realtimeTicket,
        identity
      });
      socket.on('connect', joinRoom);
      socket.on('connect_error', (error) => window.dispatchEvent(new CustomEvent('arcade:connection-error', {
        detail: { message: error?.message ?? 'Secure multiplayer connection failed.' }
      })));
      // A cached Socket.IO transport can already be connected by the time the
      // dynamically imported social modules finish initializing.
      if (socket.connected) joinRoom();
      socket.on('room:resume', ({ resumeToken }) => {
        try { sessionStorage.setItem(`${RESUME_TOKEN_KEY}:${currentRoomId}`, resumeToken); sessionStorage.setItem(RESUME_TOKEN_KEY, resumeToken); } catch { /* Non-persistent browser session. */ }
      });
      socket.on('server:draining', ({ message }) => {
        worldManager?.announce({ text: message || 'This arcade server is restarting soon.' });
      });
      socket.on('room:error', ({ message, code }) => {
        if (code === 'room-full' && typeof socket.switchRoom === 'function') {
          fullRoomAttempts.add(currentRoomId);
          const roomIds = [...window.ARCADE_ROOM_REGISTRY.rooms.keys()];
          if (fullRoomAttempts.size >= roomIds.length) {
            started = false;
            cabinetSessions?.dispose();
            socket.disconnect();
            window.dispatchEvent(new CustomEvent('arcade:connection-error', { detail: { message: 'Every arcade instance is currently full. Please try again shortly.' } }));
            return;
          }
          const nextIndex = (roomIds.indexOf(currentRoomId) + 1) % roomIds.length;
          currentRoomId = roomIds[nextIndex];
          window.dispatchEvent(new CustomEvent('arcade:room-redirected', { detail: { roomId: currentRoomId } }));
          socket.switchRoom(currentRoomId);
          return;
        }
        started = false;
        cabinetSessions?.dispose();
        socket.disconnect();
        window.dispatchEvent(new CustomEvent('arcade:connection-error', { detail: { message } }));
      });
      socket.on('room:snapshot', ({ roomId, selfId, players }) => {
        fullRoomAttempts.clear();
        localPlayerId = selfId;
        // The panel marks which seat is yours, so it needs this before it can
        // render a match usefully.
        if (window.ARCADE_MATCH_PANEL) window.ARCADE_MATCH_PANEL.playerId = selfId;
        presenceClient.snapshot(roomId, selfId, players);
        const self = players.find((player) => player.id === selfId);
        if (self) applyServerCorrection(self);
        players.forEach(addSample);
      });
      socket.on('player:state', applyServerCorrection);
      socket.on('player:joined', addSample);
      socket.on('player:moved', addSample);
      socket.on('player:reconnected', addSample);
      socket.on('player:status', (payload) => {
        presenceClient.status(payload);
        const remote = remotePlayers.get(payload.id);
        if (remote?.samples.length) {
          const latest = remote.samples[remote.samples.length - 1].state;
          remote.samples.push({ receivedAt: performance.now(), state: { ...latest, s: payload.status, a: payload.status === 'away' ? 'idle' : latest.a } });
        }
        inspectionClient.refresh();
      });
      socket.on('player:disconnected', ({ id }) => { setRemoteDisconnected(id, true); presenceClient.disconnected(id); });
      socket.on('player:left', ({ id }) => removeRemotePlayer(id));
      // Seats at a cabinet. Built here because this is where the socket is;
      // arcade.js shows and hides it as cabinets open.
      window.ARCADE_MATCH_PANEL = new MatchPanel({
        root: document.querySelector('#match-panel'), socket, playerId: localPlayerId ?? null
      });
      socket.on('cabinet:snapshot', (snapshot) => cabinetVisuals.applySnapshot(snapshot));
      socket.on('cabinet:state-changed', (state) => cabinetVisuals.apply(state));
      socket.on('cabinet:delta', (delta) => cabinetVisuals.applyDelta(delta));
      socket.on('cabinet:forced-release', ({ cabinetId, reason }) => cabinetSessions.forceRelease(cabinetId, reason));
      socket.on('disconnect', () => {
        cabinetSessions?.serverDisconnected();
        localPlayerId = undefined;
        if (localAvatar) { avatarRenderer.remove(localAvatar); localAvatar = undefined; }
        remotePlayers.forEach((_, id) => removeRemotePlayer(id));
      });
      let lastActivityAt = 0;
      const activity = () => { const now = performance.now(); if (socket.connected && now - lastActivityAt > 3000) { socket.emit('presence:activity'); lastActivityAt = now; } };
      ['keydown', 'pointerdown'].forEach((name) => window.addEventListener(name, activity, { passive: true }));
    } catch (error) {
      started = false;
      placementAbortController = undefined;
      if (error?.name === 'AbortError') {
        window.dispatchEvent(new CustomEvent('arcade:placement-canceled'));
        return;
      }
      window.dispatchEvent(new CustomEvent('arcade:connection-error', { detail: { message: 'Avatar renderer could not start. Please refresh and try again.' } }));
      console.error('Avatar renderer failed to start.', error);
    }
  };

  window.addEventListener('arcade:identity-selected', ({ detail }) => void start(detail));
  window.addEventListener('arcade:placement-cancel', () => placementAbortController?.abort());
  if (window.arcadeAvatarIdentity) void start(window.arcadeAvatarIdentity);
  // Runs inside the scene's own frame, immediately before the draw call, so an
  // avatar is never a frame behind the camera that is following it.
  if (typeof arcade.onBeforeRender === 'function') arcade.onBeforeRender(frame);
  else { const loop = (now) => { requestAnimationFrame(loop); frame(now); }; requestAnimationFrame(loop); }
})();
