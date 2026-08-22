const messages = {
  occupied: 'THIS CABINET IS CURRENTLY IN USE.',
  'too-far': 'MOVE CLOSER TO THE CABINET.',
  'already-using': 'EXIT YOUR CURRENT CABINET FIRST.',
  disabled: 'THIS CABINET IS OUT OF ORDER.',
  'unknown-cabinet': 'THIS CABINET IS UNAVAILABLE.',
  'invalid-request': 'INVALID CABINET REQUEST.',
  'rate-limited': 'PLEASE WAIT A MOMENT.',
  disconnected: 'MULTIPLAYER SERVER DISCONNECTED.',
  timeout: 'THE CABINET SERVER DID NOT RESPOND.'
};

export class CabinetSessionController {
  constructor(arcade, network, visuals, registry) {
    this.arcade = arcade; this.network = network; this.visuals = visuals;
    this.registry = registry;
    this.activeCabinetId = null; this.requestPending = false;
    this.onInteract = ({ detail }) => void this.request(detail?.cabinetId);
    this.onEnded = ({ detail }) => void this.release(detail?.cabinetId);
    window.addEventListener('arcade:cabinet-interact', this.onInteract);
    window.addEventListener('arcade:cabinet-session-ended', this.onEnded);
  }
  async request(cabinetId) {
    if (this.requestPending || typeof cabinetId !== 'string' || !this.registry.has(cabinetId)) return;
    if (!this.visuals.ready) return this.arcade.showCabinetMessage?.('SYNCING CABINET STATUS...');
    this.requestPending = true;
    const result = await this.network.requestUse(cabinetId);
    this.requestPending = false;
    if (!result.ok) return this.arcade.showCabinetMessage?.(messages[result.reason] ?? 'CABINET REQUEST DENIED.');
    if (!this.arcade.beginCabinetSession?.(cabinetId, result.alignment)) {
      await this.network.release(cabinetId);
      return this.arcade.showCabinetMessage?.('CABINET COULD NOT OPEN.');
    }
    this.activeCabinetId = cabinetId;
    const activation = await this.network.activate(cabinetId);
    if (!activation.ok) {
      this.arcade.forceCloseCabinetSession?.(cabinetId);
      this.activeCabinetId = null;
      this.arcade.showCabinetMessage?.('CABINET RESERVATION EXPIRED.');
    }
  }
  async release(cabinetId) {
    if (!cabinetId || cabinetId !== this.activeCabinetId) return;
    this.activeCabinetId = null;
    await this.network.release(cabinetId);
  }
  forceRelease(cabinetId, reason) {
    if (cabinetId !== this.activeCabinetId) return;
    this.activeCabinetId = null;
    this.arcade.forceCloseCabinetSession?.(cabinetId);
    this.arcade.showCabinetMessage?.(reason === 'activation-timeout' ? 'CABINET RESERVATION EXPIRED.' : 'CABINET SESSION ENDED.');
  }
  serverDisconnected() {
    if (this.activeCabinetId) {
      this.arcade.forceCloseCabinetSession?.(this.activeCabinetId);
      this.activeCabinetId = null;
    }
    this.visuals.reset();
  }
  dispose() {
    window.removeEventListener('arcade:cabinet-interact', this.onInteract);
    window.removeEventListener('arcade:cabinet-session-ended', this.onEnded);
  }
}
