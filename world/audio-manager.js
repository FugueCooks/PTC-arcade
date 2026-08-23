export class AudioManager {
  constructor(arcade, config) {
    this.arcade = arcade; this.config = config; this.context = null; this.master = null; this.ambience = null; this.effects = null;
    this.sources = []; this.muted = false;
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

  initialize() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    this.context = new AudioContext(); this.master = this.context.createGain(); this.master.gain.value = .38; this.master.connect(this.context.destination);
    this.ambience = this.context.createGain(); this.ambience.gain.value = .7; this.ambience.connect(this.master);
    this.effects = this.context.createGain(); this.effects.gain.value = .24; this.effects.connect(this.master);
    this.addHum('left-cabinets', [-10, 1.2, 0], 58, .045);
    this.addHum('right-cabinets', [10, 1.2, 0], 63, .04);
    this.addHum('air-conditioning', [0, 4.6, -11], 42, .035);
    this.noise = this.createNoiseBuffer(2);
    this.crowdGain = this.context.createGain(); this.crowdGain.gain.value = .012;
    const crowd = this.context.createBufferSource(); crowd.buffer = this.noise; crowd.loop = true;
    const filter = this.context.createBiquadFilter(); filter.type = 'bandpass'; filter.frequency.value = 620; filter.Q.value = .55;
    crowd.connect(filter).connect(this.crowdGain).connect(this.ambience); crowd.start();
  }

  addHum(id, position, frequency, volume) {
    const oscillator = this.context.createOscillator(); oscillator.type = 'sine'; oscillator.frequency.value = frequency;
    const gain = this.context.createGain(); gain.gain.value = volume; const panner = this.context.createPanner();
    panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse'; panner.refDistance = 2; panner.maxDistance = 18; panner.rolloffFactor = 1.5;
    panner.positionX.value = position[0]; panner.positionY.value = position[1]; panner.positionZ.value = position[2];
    oscillator.connect(gain).connect(panner).connect(this.ambience); oscillator.start(); this.sources.push({ id, oscillator, gain, panner });
  }

  createNoiseBuffer(seconds) {
    const buffer = this.context.createBuffer(1, this.context.sampleRate * seconds, this.context.sampleRate); const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  setActivity(level) {
    if (!this.context) return;
    const target = level === 'busy' ? .055 : level === 'active' ? .03 : .012;
    this.crowdGain.gain.setTargetAtTime(target, this.context.currentTime, .8);
    this.ambience.gain.setTargetAtTime(level === 'quiet' ? .52 : level === 'busy' ? .86 : .7, this.context.currentTime, .8);
  }

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
  dispose() { this.sources.forEach(({ oscillator }) => oscillator.stop()); void this.context?.close(); }
}
