export class AudioManager {
  constructor(arcade, config) {
    this.arcade = arcade; this.config = config; this.context = null; this.master = null; this.effects = null;
    this.muted = false;
    this.toggle = document.querySelector('#audio-toggle');
    this.toggle.addEventListener('click', () => this.setMuted(!this.muted));
    const unlock = () => void this.unlock();
    window.addEventListener('pointerdown', unlock, { once: true }); window.addEventListener('keydown', unlock, { once: true });
  }

  async unlock() {
    if (!this.context) this.initialize();
    if (!this.context) return;
    if (this.context.state === 'suspended') await this.context.resume();
  }

  /**
   * There is no background bed any more.
   *
   * The arcade used to run three panned sine oscillators and a band-passed
   * noise loop from the moment audio unlocked, and nothing ever stopped them.
   * Only the interaction sounds are left, and they are silent until something
   * is clicked or announced.
   */
  initialize() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    this.context = new AudioContext(); this.master = this.context.createGain(); this.master.gain.value = .38; this.master.connect(this.context.destination);
    this.effects = this.context.createGain(); this.effects.gain.value = .24; this.effects.connect(this.master);
  }

  /**
   * How busy the room is used to set the volume of the crowd loop. It has no
   * sound to reach now, and it is kept as a no-op because the world state that
   * calls it is authoritative and unrelated to audio.
   */
  setActivity() {}

  playNote(midi, duration, volume) {
    const now = this.context.currentTime, oscillator = this.context.createOscillator(), gain = this.context.createGain();
    oscillator.type = 'square'; oscillator.frequency.value = 440 * 2 ** ((midi - 69) / 12); gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(volume, now + .012); gain.gain.exponentialRampToValueAtTime(.001, now + duration);
    oscillator.connect(gain).connect(this.effects); oscillator.start(now); oscillator.stop(now + duration + .02);
  }

  cue(kind = 'notice') {
    if (!this.context || this.muted) return;
    const notes = kind === 'busy' ? [72, 76, 79] : [69, 76];
    notes.forEach((note, index) => setTimeout(() => this.playNote(note, .13, .06), index * 90));
  }

  click() { if (this.context && !this.muted) this.playNote(84, .055, .035); }

  update() {
    if (!this.context) return;
    const camera = this.arcade.getCamera(), listener = this.context.listener;
    listener.positionX.value = camera.position.x; listener.positionY.value = camera.position.y; listener.positionZ.value = camera.position.z;
  }

  setMuted(muted) { this.muted = muted; if (this.master) this.master.gain.setTargetAtTime(muted ? 0 : .38, this.context.currentTime, .05); this.toggle.textContent = muted ? 'AUDIO OFF' : 'AUDIO ON'; this.toggle.setAttribute('aria-pressed', String(!muted)); }
  dispose() { void this.context?.close(); }
}
