export class JukeboxClient {
  constructor(socket, tracks, audio) {
    this.socket = socket; this.tracks = tracks; this.audio = audio; this.state = null; this.panel = document.querySelector('#jukebox-panel'); this.list = document.querySelector('#jukebox-tracks');
    this.list.replaceChildren(...tracks.map((track) => { const row = document.createElement('div'); row.className = 'jukebox-track'; row.dataset.trackId = track.id; const name = document.createElement('span'); name.textContent = `${track.name} // ${track.tempo} BPM`; const button = document.createElement('button'); button.type = 'button'; button.textContent = 'PLAY'; button.addEventListener('click', () => this.set(track.id, true)); row.append(name, button); return row; }));
    document.querySelector('#jukebox-stop').addEventListener('click', () => this.set(this.state?.trackId, false)); document.querySelector('#jukebox-close').addEventListener('click', () => this.close());
  }
  open() { document.exitPointerLock?.(); this.panel.hidden = false; }
  close() { this.panel.hidden = true; this.arcadeCanvas()?.requestPointerLock?.(); }
  arcadeCanvas() { return window.arcadeMultiplayer?.getCanvas?.(); }
  set(trackId, playing) { this.audio.click(); this.socket.emit('world:jukebox-set', { trackId, playing }, (result) => { if (!result?.ok) this.showError(result?.reason); }); }
  apply(state) { this.state = state; this.audio.setJukebox(state); this.list.querySelectorAll('.jukebox-track').forEach((row) => row.classList.toggle('playing', state.playing && row.dataset.trackId === state.trackId)); }
  showError(reason) { const status = document.querySelector('#world-announcement'); status.textContent = reason === 'rate-limited' ? 'JUKEBOX // PLEASE WAIT' : 'JUKEBOX // TRACK UNAVAILABLE'; status.classList.add('visible'); setTimeout(() => status.classList.remove('visible'), 1800); }
}
