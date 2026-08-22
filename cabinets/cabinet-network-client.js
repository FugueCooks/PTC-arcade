export class CabinetNetworkClient {
  constructor(socket, timeoutMs = 3_500) { this.socket = socket; this.timeoutMs = timeoutMs; }
  requestUse(cabinetId) { return this.emitWithAck('cabinet:request-use', cabinetId); }
  activate(cabinetId) { return this.emitWithAck('cabinet:activate', cabinetId); }
  release(cabinetId) { return this.emitWithAck('cabinet:release', cabinetId); }
  emitWithAck(event, cabinetId) {
    if (!this.socket.connected) return Promise.resolve({ ok: false, reason: 'disconnected' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, reason: 'timeout' }), this.timeoutMs);
      this.socket.emit(event, { cabinetId }, (result) => { clearTimeout(timer); resolve(result); });
    });
  }
}

