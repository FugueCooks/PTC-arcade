import { io } from 'socket.io-client';

const target = (process.env.LOAD_TEST_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const users = bounded('LOAD_TEST_USERS', 10, 1, 10_000);
const durationMs = bounded('LOAD_TEST_DURATION_SECONDS', 30, 1, 3_600) * 1_000;
const rampMs = bounded('LOAD_TEST_RAMP_SECONDS', 5, 0, 600) * 1_000;
const movementMs = bounded('LOAD_TEST_MOVEMENT_INTERVAL_MS', 200, 50, 60_000);
const chatMs = optionalInterval('LOAD_TEST_CHAT_INTERVAL_MS', 5_000);
const cabinetMs = optionalInterval('LOAD_TEST_CABINET_INTERVAL_MS', 7_500);
const reconnectMs = optionalInterval('LOAD_TEST_RECONNECT_INTERVAL_MS', 15_000);
const forwardedIps = process.env.LOAD_TEST_FORWARDED_IPS === '1';
const sockets = []; const latencies = [];
let joined = 0; let errors = 0; let sent = 0; let chats = 0; let cabinetRequests = 0; let reconnects = 0;
const started = Date.now();

for (let index = 0; index < users; index += 1) setTimeout(() => void connectUser(index), Math.floor(index * rampMs / Math.max(1, users - 1)));
await new Promise((resolve) => setTimeout(resolve, rampMs + durationMs));
for (const entry of sockets) { entry.timers.forEach(clearInterval); entry.socket.disconnect(); }
latencies.sort((a, b) => a - b);
console.log(JSON.stringify({ target, requestedUsers: users, joined, errors, movementPacketsSent: sent,
  chatMessagesSent: chats, cabinetRequestsSent: cabinetRequests, reconnectCycles: reconnects,
  elapsedSeconds: Number(((Date.now() - started) / 1_000).toFixed(1)), latencyMs: { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99) } }, null, 2));
if (errors || joined !== users) process.exitCode = 1;

async function connectUser(index) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    // Development-only proxy simulation: each synthetic user receives a stable
    // documentation-range address so per-IP admission limits remain testable.
    // The target server must explicitly enable TRUST_PROXY for this to apply.
    if (forwardedIps) headers['X-Forwarded-For'] = `198.51.100.${1 + (index % 250)}`;
    const response = await fetch(`${target}/api/rooms/quick-join`, { method: 'POST', headers, body: '{}' });
    const placement = await response.json();
    if (!response.ok || !placement.ok) throw new Error(placement.reason || 'placement-failed');
    const socket = io(placement.realtimeUrl || target, { transports: ['websocket'], reconnection: false, timeout: 10_000 });
    let state; let resumeToken; let reconnecting = false; let chatSequence = 0; let hasJoined = false;
    socket.on('connect', () => socket.emit('room:join', { roomId: placement.roomId, reservationToken: placement.reservationToken, resumeToken,
      identity: { displayName: `Load${String(index).padStart(5, '0')}`.slice(0, 18), avatarId: 'neon-capsule' } }));
    socket.on('room:snapshot', () => { if (!hasJoined) { hasJoined = true; joined += 1; } });
    socket.on('room:resume', (payload) => { resumeToken = payload.resumeToken; if (reconnecting) { reconnects += 1; reconnecting = false; } });
    socket.on('player:state', (next) => { state = next; });
    socket.on('room:error', () => { errors += 1; });
    socket.on('connect_error', () => { errors += 1; });
    const timers = [setInterval(() => {
      if (!state) return;
      const sentAt = Date.now(); socket.emit('social:ping', { sentAt }, () => latencies.push(Date.now() - sentAt));
      socket.volatile.emit('player:move', { p: [state.p[0], state.p[2]], r: state.r }); sent += 1;
    }, movementMs)];
    if (chatMs) timers.push(setInterval(() => {
      if (!state || !socket.connected) return;
      socket.emit('chat:send', { text: `load-${index}-${chatSequence++}` }, () => {}); chats += 1;
    }, chatMs));
    if (cabinetMs) timers.push(setInterval(() => {
      if (!state || !socket.connected) return;
      socket.emit('cabinet:request-use', { cabinetId: 'crash-bandicoot' }, () => {}); cabinetRequests += 1;
    }, cabinetMs));
    if (reconnectMs) timers.push(setInterval(() => {
      if (!resumeToken || reconnecting || !socket.connected) return;
      reconnecting = true; socket.disconnect(); setTimeout(() => socket.connect(), 250);
    }, reconnectMs));
    sockets.push({ socket, timers });
  } catch { errors += 1; }
}

function percentile(value) { return latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * value))] : null; }
function bounded(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  return value;
}
function optionalInterval(name, minimum) {
  const value = Number(process.env[name] ?? 0);
  if (!Number.isFinite(value) || value < 0 || value > 3_600_000 || (value > 0 && value < minimum)) {
    throw new Error(`${name} must be 0 (disabled) or between ${minimum} and 3600000.`);
  }
  return value;
}
