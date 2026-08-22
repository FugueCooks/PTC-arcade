const statusLabels = { idle: 'Idle', walking: 'Walking', playing: 'Playing Cabinet', loading: 'Loading', away: 'Away', disconnected: 'Disconnected' };

export class PresenceClient {
  constructor(socket, registry) {
    this.socket = socket;
    this.registry = registry;
    this.players = new Map();
    this.selfId = undefined;
    this.list = document.querySelector('#player-list');
    this.population = document.querySelector('#room-population');
    this.roomLabel = document.querySelector('#room-label');
    this.stats = document.querySelector('#network-stats');
    this.dot = document.querySelector('#connection-dot');
    const toggle = document.querySelector('#player-list-toggle');
    toggle.addEventListener('click', () => { this.list.hidden = !this.list.hidden; toggle.setAttribute('aria-expanded', String(!this.list.hidden)); });
    socket.on('connect', () => this.connection(true));
    socket.on('disconnect', () => this.connection(false));
    this.pingTimer = setInterval(() => this.ping(), 5000);
  }

  snapshot(roomId, selfId, players) {
    this.roomLabel.textContent = roomId === 'main' ? 'MAIN ARCADE' : roomId.toUpperCase();
    this.selfId = selfId;
    this.players.clear();
    players.forEach((player) => this.players.set(player.id, player));
    this.render();
  }

  upsert(player) { this.players.set(player.id, { ...this.players.get(player.id), ...player }); this.render(); }
  status({ id, status }) { const player = this.players.get(id); if (player) { player.s = status; this.render(); } }
  disconnected(id) { this.status({ id, status: 'disconnected' }); }
  remove(id) { this.players.delete(id); this.render(); }
  get(id) { return this.players.get(id); }

  render() {
    this.population.textContent = String([...this.players.values()].filter((player) => player.s !== 'disconnected').length);
    this.list.replaceChildren(...[...this.players.values()].sort((a, b) => a.n.localeCompare(b.n)).map((player) => {
      const row = document.createElement('div'); row.className = 'player-row'; row.dataset.playerId = player.id;
      const image = document.createElement('img'); image.alt = ''; image.src = this.registry.get(player.v)?.thumbnailUrl ?? 'assets/avatars/neon-capsule.svg';
      const identity = document.createElement('div');
      const name = document.createElement('strong'); name.textContent = player.n;
      const status = document.createElement('small'); status.textContent = statusLabels[player.s] ?? 'Idle';
      identity.append(name, status);
      const local = document.createElement('span'); local.className = 'local-tag'; local.textContent = player.id === this.selfId ? 'YOU' : '';
      row.append(image, identity, local); return row;
    }));
  }

  connection(online) { this.dot.className = online ? 'online' : ''; this.stats.textContent = online ? 'ONLINE' : 'RECONNECTING'; }
  ping() {
    if (!this.socket.connected) return;
    const started = performance.now();
    this.socket.timeout(2500).emit('social:ping', {}, (error) => {
      if (error) return this.connection(false);
      const ping = Math.round(performance.now() - started);
      this.dot.className = ping > 220 ? 'poor' : 'online';
      this.stats.textContent = `${ping} MS · ${ping < 100 ? 'EXCELLENT' : ping < 220 ? 'GOOD' : 'WEAK'}`;
    });
  }
}

export const socialStatusLabel = (status) => statusLabels[status] ?? 'Idle';
