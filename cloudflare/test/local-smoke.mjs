import assert from 'node:assert/strict';

const endpoint = process.env.REALTIME_TEST_URL ?? 'ws://127.0.0.1:8791/realtime?room=main';

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
first.close(); second.close();
console.log('Cloudflare local smoke test passed: join, visibility, movement, chat sanitation, and acknowledgements.');
process.exit(0);
