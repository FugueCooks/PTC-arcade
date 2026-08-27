import { io } from 'socket.io-client';
const URL = 'http://127.0.0.1:8099', CABINET = 'gamecube-cabinet-04';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ask = (s, ev, p = {}) => new Promise((r) => s.emit(ev, p, r));
const connect = (name) => new Promise((resolve, reject) => {
  const s = io(URL, { transports: ['websocket'] });
  s.on('connect_error', reject);
  s.on('player:state', (p) => { s.approved = p.p; });   // [x, y, z]
  s.on('connect', () => s.emit('room:join', { roomId: 'main', identity: { displayName: name, avatarId: 'neon-capsule' } }));
  s.on('room:snapshot', () => resolve(s));
  setTimeout(() => reject(new Error(`${name} never joined`)), 8000);
});
async function walk(s, tx, tz) {
  for (let i = 0; i < 250; i += 1) {
    const [x, , z] = s.approved;
    const dx = tx - x, dz = tz - z, d = Math.hypot(dx, dz);
    if (d < 0.4) return true;
    const k = Math.min(0.4, d) / d;
    s.emit('player:move', { p: [x + dx * k, z + dz * k], r: 0 });   // [x, z]
    await sleep(70);
  }
  return false;
}
const players = [];
for (const n of ['HOST', 'PLAYER_TWO', 'PLAYER_THREE', 'PLAYER_FOUR']) players.push(await connect(n));
await sleep(300);
const seen = [];
players[1].on('match:opened', (m) => seen.push(`opened(${m.seats.length})`));
players[1].on('match:changed', (m) => seen.push(`changed(${m.seats.length},${m.state})`));
players[1].on('match:closed', () => seen.push('closed'));

const arrived = await Promise.all(players.map((s, i) => walk(s, 7.6 - i * 0.05, 31)));
console.log('walked to cabinet :', `${arrived.filter(Boolean).length}/4`, players.map((s) => s.approved.map((n) => Math.round(n)).join(',')).join(' | '));
console.log('reserve           :', (await ask(players[0], 'cabinet:request-use', { cabinetId: CABINET })).ok);
console.log('activate          :', (await ask(players[0], 'cabinet:activate', { cabinetId: CABINET })).ok);
for (let i = 1; i < 4; i += 1) {
  const r = await ask(players[i], 'match:join', { cabinetId: CABINET });
  console.log(`join player ${i + 1}     :`, r.ok ? `seat ${r.seatIndex} (${r.match.seats.length} seated)` : `refused ${r.reason}`);
}
const far = await connect('PLAYER_FAR');
console.log('join from afar    :', (await ask(far, 'match:join', { cabinetId: CABINET })).reason ?? 'SEATED (BUG)');
console.log('start not ready   :', (await ask(players[0], 'match:start')).reason);
for (const s of players) await ask(s, 'match:ready', { ready: true });
console.log('start as non-host :', (await ask(players[2], 'match:start')).reason);
const started = await ask(players[0], 'match:start');
console.log('start as host     :', started.ok ? `${started.match.state}, ${started.match.seats.length} seats` : started.reason);
players[3].disconnect();
await sleep(600);
console.log('broadcasts        :', seen.join(' '));
for (const s of [...players, far]) s.disconnect();
process.exit(0);
