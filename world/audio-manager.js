export class AudioManager {
  constructor(arcade, config) {
    this.arcade = arcade; this.config = config; this.context = null; this.master = null; this.ambience = null; this.music = null;
    this.sources = []; this.muted = false; this.currentTrackId = null; this.musicTimer = 0; this.beat = 0; this.pendingJukeboxState = null;
    this.toggle = document.querySelector('#audio-toggle');
    this.toggle.addEventListener('click', () => this.setMuted(!this.muted));
    const unlock = () => void this.unlock();
    window.addEventListener('pointerdown', unlock, { once: true }); window.addEventListener('keydown', unlock, { once: true });
  }

  async unlock() {
    if (!this.context) this.initialize();
    if (!this.context) return;
    if (this.context.state === 'suspended') await this.context.resume();
    if (this.pendingJukeboxState) { const state = this.pendingJukeboxState; this.pendingJukeboxState = null; this.setJukebox(state); }
  }

  initialize() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    this.context = new AudioContext(); this.master = this.context.createGain(); this.master.gain.value = .38; this.master.connect(this.context.destination);
    this.ambience = this.context.createGain(); this.ambience.gain.value = .7; this.ambience.connect(this.master);
    this.music = this.context.createGain(); this.music.gain.value = .24; this.music.connect(this.master);
    this.addHum('left-cabinets', [-10, 1.2, 0], 58, .045);
    this.addHum('right-cabinets', [10, 1.2, 0], 63, .04);
    this.addHum('air-conditioning', [0, 4.6, -11], 42, .035);
    this.addHum('jukebox-transformer', [6.3, 1, -10.5], 88, .028);
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

  setJukebox(state) {
    if (!this.context) { this.pendingJukeboxState = state; return; }
    if (!state.playing || !state.trackId) return this.stopMusic();
    if (state.trackId === this.currentTrackId && this.musicTimer) return;
    this.stopMusic(); this.currentTrackId = state.trackId; const track = this.config.tracks.find((candidate) => candidate.id === state.trackId);
    if (!track) return;
    if (track.url) this.playAudioAsset(track, state.startedAt); else this.playProceduralTrack(track, state.startedAt);
  }

  playAudioAsset(track, startedAt) {
    const audio = new Audio(track.url); audio.loop = true; audio.crossOrigin = 'anonymous';
    const source = this.context.createMediaElementSource(audio); source.connect(this.music); audio.currentTime = Math.max(0, (Date.now() - startedAt) / 1000); void audio.play().catch(() => {}); this.musicElement = audio;
  }

  playProceduralTrack(track, startedAt) {
    const beatMs = 60000 / track.tempo; this.beat = Math.floor(Math.max(0, Date.now() - startedAt) / beatMs);
    const pulse = () => { if (!this.context || this.muted) return; const note = track.pattern[this.beat % track.pattern.length]; this.playNote(track.root + note, .18, this.beat % 4 === 0 ? .09 : .055); this.beat += 1; };
    pulse(); this.musicTimer = setInterval(pulse, beatMs);
  }

  playNote(midi, duration, volume) {
    const now = this.context.currentTime, oscillator = this.context.createOscillator(), gain = this.context.createGain();
    oscillator.type = 'square'; oscillator.frequency.value = 440 * 2 ** ((midi - 69) / 12); gain.gain.setValueAtTime(0, now); gain.gain.linearRampToValueAtTime(volume, now + .012); gain.gain.exponentialRampToValueAtTime(.001, now + duration);
    oscillator.connect(gain).connect(this.music); oscillator.start(now); oscillator.stop(now + duration + .02);
  }

  stopMusic() { clearInterval(this.musicTimer); this.musicTimer = 0; this.currentTrackId = null; if (this.musicElement) { this.musicElement.pause(); this.musicElement.src = ''; this.musicElement = null; } }

  cue(kind = 'notice') {
    if (!this.context || this.muted) return;
    const notes = kind === 'busy' ? [72, 76, 79] : kind === 'jukebox' ? [67, 74] : [69, 76];
    notes.forEach((note, index) => setTimeout(() => this.playNote(note, .13, .06), index * 90));
  }

  click() { if (this.context && !this.muted) this.playNote(84, .055, .035); }

  update() {
    if (!this.context) return;
    const camera = this.arcade.getCamera(), listener = this.context.listener;
    listener.positionX.value = camera.position.x; listener.positionY.value = camera.position.y; listener.positionZ.value = camera.position.z;
  }

  setMuted(muted) { this.muted = muted; if (this.master) this.master.gain.setTargetAtTime(muted ? 0 : .38, this.context.currentTime, .05); this.toggle.textContent = muted ? 'AUDIO OFF' : 'AUDIO ON'; this.toggle.setAttribute('aria-pressed', String(!muted)); }
  dispose() { this.stopMusic(); this.sources.forEach(({ oscillator }) => oscillator.stop()); void this.context?.close(); }
}
