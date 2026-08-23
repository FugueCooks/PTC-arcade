import assert from 'node:assert/strict';

const endpointUrl = new URL(process.env.REALTIME_TEST_URL ?? 'ws://127.0.0.1:8791/realtime');
endpointUrl.searchParams.set('room', `smoke-${Date.now().toString(36)}`);
const endpoint = endpointUrl.href;

class Client {
  constructor(name) {
    this.name = name;
    this.events = [];
    this.waiters = [];
    this.sequence = 0;
  }

  async connect() {
    this.socket = new WebSocket(endpoint);
    this.socket.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      this.events.push(message);
      this.waiters.splice(0).forEach((wake) => wake());
    });
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
  }

  send(event, data, acknowledge = false) {
    const requestId = acknowledge ? `smoke-${this.name}-${++this.sequence}` : undefined;
    this.socket.send(JSON.stringify({ e: event, d: data, q: requestId }));
    return requestId;
  }

  async waitFor(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = this.events.find(predicate);
      if (match) return match;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${this.name}`)), Math.max(1, deadline - Date.now()));
        this.waiters.push(() => { clearTimeout(timer); resolve(); });
      });
    }
    throw new Error(`Timed out waiting for ${this.name}`);
  }

  close() { this.socket.close(); }
}

const first = new Client('first');
const second = new Client('second');
await Promise.all([first.connect(), second.connect()]);
first.send('room:join', { roomId: 'main', identity: { displayName: 'Cloud One', avatarId: 'neon-capsule' } });
const firstSnapshot = (await first.waitFor((message) => message.e === 'room:snapshot')).d;
assert.equal(firstSnapshot.players.length, 1);

second.send('room:join', { roomId: 'main', identity: { displayName: 'Cloud Two', avatarId: 'extreme-gundam' } });
const secondSnapshot = (await second.waitFor((message) => message.e === 'room:snapshot')).d;
assert.equal(secondSnapshot.players.length, 2);
assert.equal((await first.waitFor((message) => message.e === 'player:joined')).d.n, 'Cloud Two');

await new Promise((resolve) => setTimeout(resolve, 70));
first.send('player:move', { p: [0.1, 11], r: Math.PI });
assert.equal((await second.waitFor((message) => message.e === 'player:moved')).d.p[0], 0.1);

const chatRequest = first.send('chat:send', { text: 'Hello <edge>!' }, true);
assert.equal((await first.waitFor((message) => message.q === chatRequest)).d.ok, true);
assert.equal((await second.waitFor((message) => message.e === 'chat:message' && message.d.kind === 'chat')).d.text, 'Hello edge!');

const pingRequest = second.send('social:ping', {}, true);
assert.equal(typeof (await second.waitFor((message) => message.q === pingRequest)).d.serverAt, 'number');

async function moveTo(client, from, to, steps = 48) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  for (let index = 1; index <= steps; index += 1) {
    const alpha = index / steps;
    client.send('player:move', { p: [from[0] + (to[0] - from[0]) * alpha, from[1] + (to[1] - from[1]) * alpha], r: Math.PI / 2 });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

await Promise.all([moveTo(first, [0.1, 11], [-8.2, -10]), moveTo(second, [-2.2, 11], [-8.2, -10])]);
for (const client of [first, second]) {
  const state = client.events.findLast((message) => message.e === 'player:state')?.d;
  assert.ok(state && Math.hypot(state.p[0] + 8.2, state.p[2] + 10) < 0.2, `${client.name} did not reach the cabinet: ${JSON.stringify(state?.p)}`);
}
const firstClaim = first.send('cabinet:request-use', { cabinetId: 'pixel-rally' }, true);
const secondClaim = second.send('cabinet:request-use', { cabinetId: 'pixel-rally' }, true);
const [firstResult, secondResult] = await Promise.all([
  first.waitFor((message) => message.q === firstClaim), second.waitFor((message) => message.q === secondClaim)
]);
assert.equal([firstResult.d.ok, secondResult.d.ok].filter(Boolean).length, 1, 'only one player may win a cabinet race');
assert.equal([firstResult.d.reason, secondResult.d.reason].includes('occupied'), true,
  `losing request was not rejected as occupied: ${JSON.stringify([firstResult.d, secondResult.d])}`);

first.close(); second.close();
console.log('Cloudflare smoke test passed: two-player join, movement, chat sanitation, acknowledgements, and atomic cabinet ownership.');
process.exit(0);
