import { loadAvatarRegistry } from './avatars/avatar-registry.js?v=avatar-loader-1';

const PREFERENCE_KEY = 'roms-arcade-avatar-preferences';
const namePattern = /^[A-Za-z0-9 ._-]{2,18}$/;
const screen = document.querySelector('#avatar-screen');
const form = document.querySelector('#avatar-form');
const nameInput = document.querySelector('#display-name');
const roomSelect = document.querySelector('#room-select');
const cards = document.querySelector('#avatar-cards');
const status = document.querySelector('#avatar-status');
const confirmButton = document.querySelector('#avatar-confirm');
let selectedAvatarId = 'neon-capsule';

const readPreferences = () => {
  try {
    const value = JSON.parse(localStorage.getItem(PREFERENCE_KEY) ?? 'null');
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
};

const savePreferences = (identity) => {
  try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify(identity)); } catch { /* Private browsing may disable storage. */ }
};

const selectAvatar = (id) => {
  selectedAvatarId = id;
  cards.querySelectorAll('[data-avatar-id]').forEach((card) => card.classList.toggle('selected', card.dataset.avatarId === id));
};

const showStatus = (message, error = false) => {
  status.textContent = message;
  status.dataset.error = String(error);
};

async function boot() {
  confirmButton.disabled = true;
  confirmButton.textContent = 'ENTER ARCADE';
  delete confirmButton.dataset.retry;
  showStatus('Loading avatar choices…');
  try {
    const avatars = await loadAvatarRegistry();
    const rooms = window.ARCADE_ROOM_REGISTRY?.rooms;
    if (!(rooms instanceof Map) || rooms.size === 0) throw new Error('Arcade instances could not be loaded.');
    const saved = readPreferences();
    if (typeof saved.displayName === 'string') nameInput.value = saved.displayName.slice(0, 18);
    if (avatars.has(saved.avatarId)) selectedAvatarId = saved.avatarId;
    roomSelect.replaceChildren(...[...rooms.values()].map((room) => {
      const option = document.createElement('option');
      option.value = room.id;
      option.textContent = `${room.name} · ${room.capacity} MAX`;
      return option;
    }));
    roomSelect.value = rooms.has(saved.roomId) ? saved.roomId : 'main';
    cards.replaceChildren(...[...avatars.values()].map((avatar) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'avatar-card';
      card.dataset.avatarId = avatar.id;
      card.textContent = avatar.name;
      card.addEventListener('click', () => selectAvatar(avatar.id));
      return card;
    }));
    selectAvatar(selectedAvatarId);
    confirmButton.disabled = false;
    showStatus('Choose your player, then enter the arcade.');
  } catch (error) {
    confirmButton.disabled = false;
    confirmButton.textContent = 'RETRY';
    confirmButton.dataset.retry = 'true';
    showStatus(error instanceof Error ? error.message : 'Avatar choices could not be loaded.', true);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (confirmButton.dataset.retry === 'true') {
    void boot();
    return;
  }
  const displayName = nameInput.value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!namePattern.test(displayName)) {
    showStatus('Use 2–18 letters, numbers, spaces, dots, dashes, or underscores.', true);
    nameInput.focus();
    return;
  }
  const selection = { displayName, avatarId: selectedAvatarId, roomId: roomSelect.value };
  savePreferences(selection);
  window.arcadeAvatarIdentity = selection;
  window.dispatchEvent(new CustomEvent('arcade:identity-selected', { detail: selection }));
  screen.hidden = true;
  document.querySelector('#enter').click();
});

window.addEventListener('arcade:connection-error', ({ detail }) => {
  screen.hidden = false;
  showStatus(detail?.message ?? 'Could not connect to the arcade.', true);
});

window.addEventListener('arcade:placement-waiting', () => {
  screen.hidden = false;
  confirmButton.disabled = true;
  showStatus('Arcade rooms are busy. Finding an available instance…');
});
window.addEventListener('arcade:placement-ready', () => {
  screen.hidden = true;
  confirmButton.disabled = false;
});

void boot();
