const status = document.querySelector('#status');
const startButton = document.querySelector('#start');
const discInput = document.querySelector('#disc');
const dspInput = document.querySelector('#dsp');
const progress = document.querySelector('#progress');

let runtime;
let runtimeReady = false;

function updateStartState() {
  startButton.disabled = !runtimeReady || !discInput.files?.[0];
}

function selected(input, output) {
  document.querySelector(output).textContent = input.files?.[0]?.name || 'No file selected';
  updateStartState();
}

discInput.addEventListener('change', () => selected(discInput, '#disc-name'));
dspInput.addEventListener('change', () => selected(dspInput, '#dsp-name'));

async function streamIntoDiscBuffer(stream, totalBytes, name) {
  if (!runtime?.DiscBuffer) throw new Error('This Gecko runtime does not support chunked disc loading.');
  status.textContent = `Loading ${name}…`;
  progress.hidden = false;
  progress.value = 0;
  const buffer = new runtime.DiscBuffer(totalBytes || 0);
  const reader = stream.getReader();
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer.append(value);
    loaded += value.byteLength;
    if (totalBytes > 0) progress.value = Math.min(1, loaded / totalBytes);
  }
  return buffer;
}

async function loadFile(file) {
  return streamIntoDiscBuffer(file.stream(), file.size, file.name);
}

async function loadRemoteFile(url, name) {
  status.textContent = `Downloading ${name}…`;
  progress.hidden = false;
  const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`Game download failed (${response.status}).`);
  if (!response.body) throw new Error('This browser cannot stream the GameCube image.');
  const totalBytes = Number(response.headers.get('content-length')) || 0;
  return streamIntoDiscBuffer(response.body, totalBytes, name);
}

function startRuntime(discBuffer, filename, dspBytes) {
  status.textContent = 'Starting GameCube…';
  document.querySelector('#setup').hidden = true;
  discBuffer.start(filename, dspBytes);
  progress.value = 1;
  parent.postMessage({ type: 'arcade:gamecube-source-accepted' }, location.origin);
}

async function startRemote({ url, name = 'game.rvz' }) {
  if (!runtimeReady || typeof url !== 'string') return;
  try {
    startButton.disabled = true;
    startRuntime(await loadRemoteFile(url, name), name);
  } catch (error) {
    console.error(error);
    status.textContent = error instanceof Error ? error.message : 'The GameCube image could not load.';
    progress.hidden = true;
    parent.postMessage({ type: 'arcade:emulator-error', core: 'gamecube-gecko' }, location.origin);
  }
}

async function startLocal(file) {
  if (!runtimeReady || !(file instanceof File)) return;
  try {
    startButton.disabled = true;
    startRuntime(await loadFile(file), file.name);
  } catch (error) {
    console.error(error);
    status.textContent = error instanceof Error ? error.message : 'The GameCube image could not load.';
    progress.hidden = true;
    parent.postMessage({ type: 'arcade:emulator-error', core: 'gamecube-gecko' }, location.origin);
  }
}

async function initialize() {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable in this browser. Try a current desktop Chrome or Edge build.');
  runtime = await import('./pkg/web.js');
  await runtime.default();
  runtimeReady = true;
  status.textContent = 'Runtime ready. Select an RVZ, ISO, or GCM image.';
  updateStartState();
  parent.postMessage({ type: 'arcade:emulator-ready', core: 'gamecube-gecko' }, location.origin);
  const localGame = new URLSearchParams(location.search).get('game');
  if (localGame && ['127.0.0.1', 'localhost'].includes(location.hostname)) {
    const url = new URL(localGame, location.href);
    if (url.origin === location.origin) void startRemote({ url: url.href, name: url.pathname.split('/').pop() || 'game.rvz' });
  }
}

startButton.addEventListener('click', async () => {
  const disc = discInput.files?.[0];
  if (!disc || !runtimeReady) return;
  startButton.disabled = true;
  try {
    const discBuffer = await loadFile(disc);
    const dspFile = dspInput.files?.[0];
    const dspBytes = dspFile ? new Uint8Array(await dspFile.arrayBuffer()) : undefined;
    startRuntime(discBuffer, disc.name, dspBytes);
  } catch (error) {
    console.error(error);
    status.textContent = error instanceof Error ? error.message : 'The emulator could not start.';
    startButton.disabled = false;
    progress.hidden = true;
    parent.postMessage({ type: 'arcade:emulator-error', core: 'gamecube-gecko' }, location.origin);
  }
});

addEventListener('message', event => {
  if (event.origin !== location.origin || event.source !== parent) return;
  if (event.data?.type === 'arcade:gamecube-load-remote') void startRemote(event.data);
  if (event.data?.type === 'arcade:gamecube-load-file') void startLocal(event.data.file);
});

initialize().catch(error => {
  console.error(error);
  status.textContent = error instanceof Error ? error.message : 'The GameCube runtime could not initialize.';
  parent.postMessage({ type: 'arcade:emulator-error', core: 'gamecube-gecko' }, location.origin);
});
