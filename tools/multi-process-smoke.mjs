import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { io } from 'socket.io-client';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is required. Point it at an isolated local Redis-compatible test instance.');
const parsedRedisUrl = new URL(redisUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(parsedRedisUrl.hostname)) throw new Error('The multi-process smoke test refuses non-local Redis endpoints.');

const portA = boundedPort('SMOKE_SERVER_A_PORT', 18_081);
const portB = boundedPort('SMOKE_SERVER_B_PORT', 18_082);
if (portA === portB) throw new Error('Smoke-test server ports must be different.');
const namespace = `arcade:v1:smoke:${process.pid}:${randomUUID().slice(0, 8)}`;
const servers = [];
const sockets = [];
const redis = createClient({ url: redisUrl });
const startedAt = Date.now();

try {
  await redis.connect();
  servers.push(startServer('smoke-a', portA), startServer('smoke-b', portB));
  await Promise.all(servers.map(({ port }) => waitUntilReady(port)));
  const roomsResponse = await fetch(`http://127.0.0.1:${portA}/api/rooms`);
  const roomsPayload = await roomsResponse.json();
  assert(roomsResponse.ok && roomsPayload.ok, 'room directory was unavailable');
  assert(roomsPayload.rooms.length >= 2, `expected at least two discoverable rooms, got ${roomsPayload.rooms.length}`);

  const joinedRooms = new Map();
  for (let index = 0; index < 26; index += 1) {
    const placementResponse = await fetch(`http://127.0.0.1:${portA}/api/rooms/quick-join`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `198.51.100.${index + 1}` }, body: '{}'
    });
    const placement = await placementResponse.json();
    assert(placementResponse.ok && placement.ok, `placement ${index} failed: ${placement.reason ?? placementResponse.status}`);
    await joinSocket(index, placement);
    joinedRooms.set(placement.roomId, (joinedRooms.get(placement.roomId) ?? 0) + 1);
  }

  assert(joinedRooms.size === 2, `expected 26 users to span two rooms, got ${joinedRooms.size}`);
  assert([...joinedRooms.values()].every((population) => population <= 25), 'a room exceeded the configured 25-player limit');
  const serverKeys = await collectKeys(`${namespace}:servers:*`);
  const ownerKeys = await collectKeys(`${namespace}:room-owner:*`);
  assert(serverKeys.length === 2, `expected two server registrations, got ${serverKeys.length}`);
  assert(ownerKeys.length >= 2, `expected at least two room ownership leases, got ${ownerKeys.length}`);
  console.log(JSON.stringify({ ok: true, durationMs: Date.now() - startedAt, servers: 2, joinedPlayers: 26,
    roomPopulations: Object.fromEntries(joinedRooms), serverRegistrations: serverKeys.length, ownershipLeases: ownerKeys.length }, null, 2));
} finally {
  sockets.forEach((socket) => socket.disconnect());
  await Promise.all(servers.map(stopServer));
  if (redis.isOpen) {
    const keys = await collectKeys(`${namespace}:*`);
    if (keys.length) await redis.del(keys);
    await redis.quit();
  }
}

function startServer(id, port) {
  const logs = [];
  const child = spawn(process.execPath, ['dist/server/src/index.js'], { cwd: process.cwd(), windowsHide: true,
    env: { ...process.env, PORT: String(port), SERVER_ID: id, SERVER_REGION: 'smoke-local', REDIS_URL: redisUrl,
      REDIS_REQUIRED: '1', REDIS_KEY_PREFIX: namespace, TRUST_PROXY: '1', MAX_PLAYERS_PER_ROOM: '25',
      MAX_ROOMS_PER_SERVER: '10', MAX_PLAYERS_PER_SERVER: '250', PUBLIC_REALTIME_URL: `http://127.0.0.1:${port}` } });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { logs.push(String(chunk)); if (logs.length > 50) logs.shift(); });
  return { child, id, port, logs };
}

async function waitUntilReady(port) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try { const response = await fetch(`http://127.0.0.1:${port}/ready`); if (response.ok) return; } catch {}
    await delay(100);
  }
  const server = servers.find((candidate) => candidate.port === port);
  throw new Error(`server ${port} did not become ready\n${server?.logs.join('') ?? ''}`);
}

async function joinSocket(index, placement) {
  const socket = io(placement.realtimeUrl, { transports: ['websocket'], reconnection: false, timeout: 5_000 });
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`player ${index} join timed out`)), 7_500);
    const fail = (error) => { clearTimeout(timeout); reject(error instanceof Error ? error : new Error(String(error))); };
    socket.once('connect_error', fail);
    socket.once('room:error', (error) => fail(new Error(error?.message ?? 'room join failed')));
    socket.once('room:snapshot', () => { clearTimeout(timeout); resolve(); });
    socket.once('connect', () => socket.emit('room:join', { roomId: placement.roomId, reservationToken: placement.reservationToken,
      identity: { displayName: `Smoke${String(index).padStart(2, '0')}`, avatarId: 'neon-capsule' } }));
  });
}

async function stopServer(server) {
  if (server.child.exitCode !== null) return;
  server.child.kill('SIGTERM');
  await Promise.race([new Promise((resolve) => server.child.once('exit', resolve)), delay(8_000)]);
  if (server.child.exitCode === null) server.child.kill('SIGKILL');
}

async function collectKeys(pattern) {
  // This harness owns a unique, random namespace on a loopback-only Redis.
  // KEYS is intentionally safe here and avoids iterator shutdown ambiguity.
  return redis.keys(pattern);
}

function assert(condition, message) { if (!condition) throw new Error(message); }
function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function boundedPort(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1_024 || value > 65_535) throw new Error(`${name} must be a port from 1024 to 65535.`);
  return value;
}
