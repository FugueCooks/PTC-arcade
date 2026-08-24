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

async function loadFile(file, start, span) {
  status.textContent = `Loading ${file.name}…`;
  progress.hidden = false;
  progress.value = start;
  const bytes = new Uint8Array(await file.arrayBuffer());
  progress.value = start + span;
  return bytes;
}

async function initialize() {
  if (!navigator.gpu) throw new Error('WebGPU is unavailable in this browser. Try a current desktop Chrome or Edge build.');
  runtime = await import('./pkg/gecko_web.js');
  await runtime.default();
  runtimeReady = true;
  status.textContent = 'Runtime ready. Select an RVZ, ISO, or GCM image.';
  updateStartState();
  parent.postMessage({ type: 'arcade:emulator-ready', core: 'gamecube-gecko' }, location.origin);
}

startButton.addEventListener('click', async () => {
  const disc = discInput.files?.[0];
  if (!disc || !runtimeReady) return;
  startButton.disabled = true;
  try {
    const discBytes = await loadFile(disc, 0, .9);
    const dspFile = dspInput.files?.[0];
    const dspBytes = dspFile ? await loadFile(dspFile, .9, .1) : undefined;
    status.textContent = 'Starting GameCube…';
    document.querySelector('#setup').hidden = true;
    runtime.start_emulator(discBytes, disc.name, dspBytes);
    progress.value = 1;
  } catch (error) {
    console.error(error);
    status.textContent = error instanceof Error ? error.message : 'The emulator could not start.';
    startButton.disabled = false;
    progress.hidden = true;
    parent.postMessage({ type: 'arcade:emulator-error', core: 'gamecube-gecko' }, location.origin);
  }
});

initialize().catch(error => {
  console.error(error);
  status.textContent = error instanceof Error ? error.message : 'The GameCube runtime could not initialize.';
  parent.postMessage({ type: 'arcade:emulator-error', core: 'gamecube-gecko' }, location.origin);
});
