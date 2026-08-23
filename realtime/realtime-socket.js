(() => {
  const runtime = window.ARCADE_RUNTIME ?? {};

  class NativeRealtimeSocket {
    constructor(endpoint, options = {}) {
      this.endpoint = endpoint;
      this.options = options;
      this.connected = false;
      this.listeners = new Map();
      this.pending = new Map();
      this.sequence = 0;
      this.closedByClient = false;
      this.reconnectAttempt = 0;
      this.volatile = { emit: (event, payload) => this.emit(event, payload) };
      this.connect();
    }

    on(event, listener) {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    off(event, listener) {
      this.listeners.get(event)?.delete(listener);
      return this;
    }

    emit(event, payload, acknowledge) {
      return this.send(event, payload, acknowledge, false, 0);
    }

    timeout(timeoutMs) {
      return { emit: (event, payload, acknowledge) => this.send(event, payload, acknowledge, true, timeoutMs) };
    }

    disconnect() {
      this.closedByClient = true;
      clearTimeout(this.reconnectTimer);
      this.socket?.close(1000, 'client disconnect');
      this.rejectPending(new Error('disconnected'));
    }

    switchRoom(roomId) {
      this.options.roomId = roomId;
      this.closedByClient = false;
      this.socket?.close(1000, 'switch room');
    }

    connect() {
      if (this.closedByClient) return;
      const url = new URL(this.endpoint, window.location.href);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      if (typeof this.options.roomId === 'string') url.searchParams.set('room', this.options.roomId);
      this.socket = new WebSocket(url);
      this.socket.addEventListener('open', () => {
        this.connected = true;
        this.reconnectAttempt = 0;
        this.dispatch('connect');
      });
      this.socket.addEventListener('message', ({ data }) => this.receive(data));
      this.socket.addEventListener('close', () => {
        const wasConnected = this.connected;
        this.connected = false;
        this.rejectPending(new Error('disconnected'));
        if (wasConnected) this.dispatch('disconnect');
        if (!this.closedByClient) this.scheduleReconnect();
      });
      this.socket.addEventListener('error', () => this.socket?.close());
    }

    send(event, payload, acknowledge, timeoutStyle, timeoutMs) {
      if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) {
        if (typeof acknowledge === 'function') {
          queueMicrotask(() => timeoutStyle ? acknowledge(new Error('disconnected')) : acknowledge({ ok: false, reason: 'disconnected' }));
        }
        return this;
      }
      const requestId = typeof acknowledge === 'function' ? `${Date.now().toString(36)}-${++this.sequence}` : undefined;
      if (requestId) {
        const timer = timeoutMs > 0 ? setTimeout(() => {
          const pending = this.pending.get(requestId);
          if (!pending) return;
          this.pending.delete(requestId);
          timeoutStyle ? pending.callback(new Error('timeout')) : pending.callback({ ok: false, reason: 'timeout' });
        }, timeoutMs) : undefined;
        this.pending.set(requestId, { callback: acknowledge, timeoutStyle, timer });
      }
      this.socket.send(JSON.stringify({ e: event, d: payload, q: requestId }));
      return this;
    }

    receive(raw) {
      let message;
      try { message = JSON.parse(raw); } catch { return; }
      if (!message || typeof message !== 'object') return;
      if (typeof message.q === 'string' && !message.e) {
        const pending = this.pending.get(message.q);
        if (!pending) return;
        this.pending.delete(message.q);
        clearTimeout(pending.timer);
        pending.timeoutStyle ? pending.callback(null, message.d) : pending.callback(message.d);
        return;
      }
      if (typeof message.e === 'string') this.dispatch(message.e, message.d);
    }

    dispatch(event, payload) {
      this.listeners.get(event)?.forEach((listener) => listener(payload));
    }

    rejectPending(error) {
      for (const { callback, timeoutStyle, timer } of this.pending.values()) {
        clearTimeout(timer);
        timeoutStyle ? callback(error) : callback({ ok: false, reason: 'disconnected' });
      }
      this.pending.clear();
    }

    scheduleReconnect() {
      const minimum = this.options.reconnectionDelay ?? 500;
      const maximum = this.options.reconnectionDelayMax ?? 3_000;
      const delay = Math.min(maximum, minimum * 2 ** Math.min(this.reconnectAttempt++, 4));
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), delay + Math.random() * 200);
    }
  }

  window.createArcadeSocket = (options = {}) => {
    const endpoint = typeof options.endpoint === 'string' && options.endpoint.trim()
      ? options.endpoint.trim()
      : (typeof runtime.realtimeUrl === 'string' ? runtime.realtimeUrl.trim() : '');
    if (endpoint) return new NativeRealtimeSocket(endpoint, options);
    if (typeof window.io === 'function') return window.io(options.socketIoEndpoint, options);
    throw new Error('No realtime transport is configured.');
  };

  let socketIoLoad;
  window.prepareArcadeRealtime = () => {
    const endpoint = typeof runtime.realtimeUrl === 'string' ? runtime.realtimeUrl.trim() : '';
    if (endpoint || typeof window.io === 'function') return Promise.resolve();
    if (socketIoLoad) return socketIoLoad;
    socketIoLoad = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = '/socket.io/socket.io.js';
      script.async = true;
      script.addEventListener('load', resolve, { once: true });
      script.addEventListener('error', () => reject(new Error('Unable to load the fallback realtime client.')), { once: true });
      document.head.append(script);
    });
    return socketIoLoad;
  };
})();
