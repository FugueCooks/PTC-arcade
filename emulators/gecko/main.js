const status = document.querySelector('#status');
const startButton = document.querySelector('#start');
const discInput = document.querySelector('#disc');
const dspInput = document.querySelector('#dsp');
const progress = document.querySelector('#progress');

let runtime;
let runtimeReady = false;
let lastProgressUpdate = 0;
const CACHE_DIRECTORY = 'ptc-arcade-gamecube-v1';
const CACHE_HEADROOM_BYTES = 64 * 1024 * 1024;

function updateStartState() {
  startButton.disabled = !runtimeReady || !discInput.files?.[0];
}

function selected(input, output) {
  document.querySelector(output).textContent = input.files?.[0]?.name || 'No file selected';
  updateStartState();
}

discInput.addEventListener('change', () => selected(discInput, '#disc-name'));
dspInput.addEventListener('change', () => selected(dspInput, '#dsp-name'));

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  return `${(bytes / 1048576).toFixed(bytes >= 104857600 ? 0 : 1)} MB`;
}

function cacheSupported() {
  return typeof navigator.storage?.getDirectory === 'function';
}

function cacheFileName(name, totalBytes) {
  const safeName = String(name || 'game.rvz').replace(/[^A-Za-z0-9._-]/g, '-').slice(-96);
  return `${totalBytes}-${safeName}`;
}

async function gameCacheDirectory() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(CACHE_DIRECTORY, { create: true });
}

async function getCachedGame(name, totalBytes) {
  if (!cacheSupported() || !Number.isSafeInteger(totalBytes) || totalBytes <= 0) return null;
  const entryName = cacheFileName(name, totalBytes);
  try {
    const directory = await gameCacheDirectory();
    const handle = await directory.getFileHandle(entryName);
    const file = await handle.getFile();
    if (file.size === totalBytes) return file;
    await directory.removeEntry(entryName);
  } catch (error) {
    if (error?.name !== 'NotFoundError') console.warn('Could not inspect the GameCube cache.', error);
  }
  return null;
}

async function prepareCacheWrite(name, totalBytes) {
  if (!cacheSupported() || !Number.isSafeInteger(totalBytes) || totalBytes <= 0) return null;
  try {
    await navigator.storage.persist?.();
    const estimate = await navigator.storage.estimate?.();
    if (Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage)
      && estimate.quota - estimate.usage < totalBytes + CACHE_HEADROOM_BYTES) return null;
    const directory = await gameCacheDirectory();
    const entryName = cacheFileName(name, totalBytes);
    const handle = await directory.getFileHandle(entryName, { create: true });
    const writable = await handle.createWritable({ keepExistingData: false });
    return { directory, entryName, handle, writable };
  } catch (error) {
    console.warn('GameCube caching is unavailable for this download.', error);
    return null;
  }
}

function enterHostedMode(name, totalBytes) {
  document.body.classList.add('hosted-game');
  document.querySelector('#setup h1').textContent = 'PREPARING GAMECUBE';
  document.querySelector('.note').textContent = cacheSupported()
    ? `First launch downloads ${formatBytes(totalBytes)}. Future launches use this device's local copy.`
    : `Downloading ${formatBytes(totalBytes)} for this browser session. Keep this window open.`;
  for (const element of document.querySelectorAll('.picker, output, #start')) element.hidden = true;
  parent.postMessage({ type: 'arcade:gamecube-source-loading' }, location.origin);
  status.textContent = `Starting download for ${name}…`;
}

async function streamIntoDiscBuffer(stream, totalBytes, name) {
  if (!runtime?.DiscBuffer) throw new Error('This Gecko runtime does not support chunked disc loading.');
  status.textContent = `Loading ${name}…`;
  progress.hidden = false;
  progress.value = 0;
  // Reserving the final size avoids Vec's geometric growth temporarily needing
  // both its old and new allocations inside WebAssembly's finite address space.
  const buffer = new runtime.DiscBuffer(totalBytes || 0);
  const reader = stream.getReader();
  let loaded = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    try {
      buffer.append(value);
    } catch (error) {
      throw new Error(`Gecko ran out of WebAssembly memory after ${loaded.toLocaleString()} of ${totalBytes.toLocaleString()} bytes while loading ${name}.`, { cause: error });
    }
    loaded += value.byteLength;
    const now = performance.now();
    if (totalBytes > 0) progress.value = Math.min(1, loaded / totalBytes);
    if (now - lastProgressUpdate >= 120 || (totalBytes > 0 && loaded >= totalBytes)) {
      const percent = totalBytes > 0 ? Math.min(100, Math.floor(loaded / totalBytes * 100)) : null;
      status.textContent = percent === null
        ? `Downloading ${name} · ${formatBytes(loaded)}`
        : `Downloading ${name} · ${percent}% · ${formatBytes(loaded)} / ${formatBytes(totalBytes)}`;
      parent.postMessage({ type: 'arcade:gamecube-load-progress', loaded, total: totalBytes, percent }, location.origin);
      lastProgressUpdate = now;
    }
  }
  return buffer;
}

async function loadFile(file) {
  return streamIntoDiscBuffer(file.stream(), file.size, file.name);
}

async function loadRemoteFile(url, name, expectedBytes = 0) {
  const requestedBytes = Number(expectedBytes) || 0;
  const cached = await getCachedGame(name, requestedBytes);
  if (cached) {
    status.textContent = `Loading ${name} from this device…`;
    return streamIntoDiscBuffer(cached.stream(), cached.size, name);
  }
  status.textContent = `Downloading ${name}…`;
  progress.hidden = false;
  const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`Game download failed (${response.status}).`);
  if (!response.body) throw new Error('This browser cannot stream the GameCube image.');
  const totalBytes = Number(response.headers.get('content-length')) || Number(expectedBytes) || 0;
  const cacheTarget = await prepareCacheWrite(name, totalBytes);
  if (!cacheTarget) return streamIntoDiscBuffer(response.body, totalBytes, name);

  const [runtimeStream, cacheStream] = response.body.tee();
  const cacheWrite = cacheStream.pipeTo(cacheTarget.writable).then(async () => {
    const file = await cacheTarget.handle.getFile();
    if (file.size !== totalBytes) throw new Error('Cached GameCube image was incomplete.');
    return file;
  }).catch(async error => {
    try { await cacheTarget.directory.removeEntry(cacheTarget.entryName); } catch { /* No partial file. */ }
    console.warn('The GameCube image could not be cached locally.', error);
    return null;
  });
  const [discBuffer] = await Promise.all([
    streamIntoDiscBuffer(runtimeStream, totalBytes, name),
    cacheWrite,
  ]);
  return discBuffer;
}

function startRuntime(discBuffer, filename, dspBytes) {
  status.textContent = 'Starting GameCube…';
  document.querySelector('#setup').hidden = true;
  discBuffer.start(filename, dspBytes);
  progress.value = 1;
  parent.postMessage({ type: 'arcade:gamecube-source-accepted' }, location.origin);
}

async function startRemote({ url, name = 'game.rvz', size = 0 }) {
  if (!runtimeReady || typeof url !== 'string') return;
  try {
    startButton.disabled = true;
    enterHostedMode(name, Number(size) || 0);
    startRuntime(await loadRemoteFile(url, name, size), name);
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
