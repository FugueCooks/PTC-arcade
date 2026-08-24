import { loadAvatarRegistry } from './avatars/avatar-registry.js?v=avatar-loader-1';
import { RoomPlacementClient } from './rooms/room-placement-client.js?v=phase7-room-browser-1';

const PREFERENCE_KEY = 'roms-arcade-avatar-preferences';
const namePattern = /^[A-Za-z0-9_.-]{2,18}$/;
const screen = document.querySelector('#avatar-screen');
const form = document.querySelector('#avatar-form');
const nameInput = document.querySelector('#display-name');
const roomSelect = document.querySelector('#room-select');
const roomIdInput = document.querySelector('#room-id');
const roomRefresh = document.querySelector('#room-refresh');
const roomHelp = document.querySelector('#room-help');
const cards = document.querySelector('#avatar-cards');
const status = document.querySelector('#avatar-status');
const confirmButton = document.querySelector('#avatar-confirm');
const cancelButton = document.querySelector('#placement-cancel');
const authModePanel = document.querySelector('#auth-mode');
const authFields = document.querySelector('#auth-fields');
const passwordInput = document.querySelector('#account-password');
const signedInPanel = document.querySelector('#signed-in-panel');
const signedInLabel = document.querySelector('#signed-in-label');
const signOutButton = document.querySelector('#sign-out');
const placementClient = new RoomPlacementClient();
let selectedAvatarId = 'neon-capsule';
let staticRooms;
let authMode = 'guest';
let accountSession;

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

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, { credentials: 'same-origin', ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) } });
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(payload?.error?.message ?? 'Account request failed.'); error.status = response.status; throw error; }
  return payload;
};

const setAuthMode = (mode) => {
  authMode = mode;
  authModePanel.querySelectorAll('[data-auth-mode]').forEach((button) => button.classList.toggle('selected', button.dataset.authMode === mode));
  authFields.hidden = mode === 'guest' || Boolean(accountSession);
  passwordInput.disabled = mode === 'guest' || Boolean(accountSession);
  passwordInput.required = !passwordInput.disabled;
  passwordInput.autocomplete = mode === 'register' ? 'new-password' : 'current-password';
  confirmButton.textContent = mode === 'register' ? 'CREATE ACCOUNT & ENTER' : mode === 'login' ? 'SIGN IN & ENTER' : 'ENTER AS GUEST';
};

const showSignedIn = (session) => {
  accountSession = session;
  signedInPanel.hidden = !session;
  authModePanel.hidden = Boolean(session);
  authFields.hidden = true;
  passwordInput.disabled = Boolean(session);
  if (session) {
    signedInLabel.textContent = `${session.identity.type === 'guest' ? 'GUEST' : 'SIGNED IN'} // ${session.identity.displayName}`;
    nameInput.value = session.identity.displayName;
    selectedAvatarId = session.identity.avatarId;
    confirmButton.textContent = 'ENTER ARCADE';
  }
};

const roomOption = (value, label, disabled = false) => {
  const option = document.createElement('option');
  option.value = value;
  option.textContent = label;
  option.disabled = disabled;
  return option;
};

const showStaticRooms = (preferredRoomId = '') => {
  roomSelect.replaceChildren(
    roomOption('', 'QUICK JOIN · BEST AVAILABLE'),
    ...[...staticRooms.values()].map((room) => roomOption(room.id, `${room.name} · 0/${room.capacity}`))
  );
  roomSelect.value = staticRooms.has(preferredRoomId) ? preferredRoomId : '';
};

async function refreshRooms(announce = true) {
  const selected = roomSelect.value;
  roomRefresh.disabled = true;
  if (announce) roomHelp.textContent = 'Refreshing live room population…';
  try {
    const rooms = await placementClient.rooms();
    if (!Array.isArray(rooms) || rooms.length === 0) throw new Error('No rooms available.');
    roomSelect.replaceChildren(
      roomOption('', 'QUICK JOIN · BEST AVAILABLE'),
      ...rooms.map((room) => roomOption(
        room.id,
        `${room.name} · ${room.population}/${room.capacity}${room.status === 'full' ? ' · FULL' : ''}`,
        room.status === 'full'
      ))
    );
    if ([...roomSelect.options].some((option) => option.value === selected && !option.disabled)) roomSelect.value = selected;
    roomHelp.textContent = `${rooms.length} live room${rooms.length === 1 ? '' : 's'} found. Quick Join chooses a healthy room automatically.`;
  } catch {
    showStaticRooms(selected);
    roomHelp.textContent = 'Live population is unavailable; automatic placement remains enabled.';
  } finally {
    roomRefresh.disabled = false;
  }
}

async function boot() {
  confirmButton.disabled = true;
  confirmButton.textContent = 'ENTER AS GUEST';
  delete confirmButton.dataset.retry;
  showStatus('Loading avatar choices…');
  try {
    const avatars = await loadAvatarRegistry();
    staticRooms = window.ARCADE_ROOM_REGISTRY?.rooms;
    if (!(staticRooms instanceof Map) || staticRooms.size === 0) throw new Error('Arcade instances could not be loaded.');
    const saved = readPreferences();
    if (typeof saved.displayName === 'string') nameInput.value = saved.displayName.slice(0, 18);
    if (avatars.has(saved.avatarId)) selectedAvatarId = saved.avatarId;
    showStaticRooms(typeof saved.roomId === 'string' ? saved.roomId : '');
    if (typeof saved.roomId === 'string' && saved.roomId && !staticRooms.has(saved.roomId)) roomIdInput.value = saved.roomId.slice(0, 96);
    cards.replaceChildren(...[...avatars.values()].map((avatar) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'avatar-card';
      card.dataset.avatarId = avatar.id;
      card.textContent = avatar.name;
      card.addEventListener('click', () => selectAvatar(avatar.id));
      return card;
    }));
    try {
      const session = await requestJson('/api/auth/session', { method: 'GET' });
      showSignedIn(session);
      if (avatars.has(session.identity.avatarId)) selectedAvatarId = session.identity.avatarId;
    } catch { showSignedIn(undefined); setAuthMode('guest'); }
    selectAvatar(selectedAvatarId);
    confirmButton.disabled = false;
    showStatus('Choose your player, then enter the arcade.');
    void refreshRooms(false);
  } catch (error) {
    confirmButton.disabled = false;
    confirmButton.textContent = 'RETRY';
    confirmButton.dataset.retry = 'true';
    showStatus(error instanceof Error ? error.message : 'Avatar choices could not be loaded.', true);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (confirmButton.dataset.retry === 'true') {
    void boot();
    return;
  }
  let displayName = nameInput.value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!accountSession && !namePattern.test(displayName)) {
    showStatus('Use 2–18 letters, numbers, dots, dashes, or underscores.', true);
    nameInput.focus();
    return;
  }
  if (!accountSession && authMode === 'register' && passwordInput.value.length < 8) {
    showStatus('Choose a password with at least 8 characters.', true);
    passwordInput.focus();
    return;
  }
  if (!accountSession && authMode === 'login' && !passwordInput.value) {
    showStatus('Enter your password.', true);
    passwordInput.focus();
    return;
  }
  const customRoomId = roomIdInput.value.trim();
  if (customRoomId && !/^[A-Za-z0-9_-]{1,96}$/.test(customRoomId)) {
    showStatus('Room IDs may contain only letters, numbers, dashes, and underscores.', true);
    roomIdInput.focus();
    return;
  }
  confirmButton.disabled = true;
  try {
    if (accountSession?.identity?.type === 'registered') {
      const profile = await requestJson('/api/account/profile', { method: 'PUT', body: JSON.stringify({ displayName, avatarId: selectedAvatarId }) });
      showSignedIn({ ...accountSession, identity: profile.identity });
    } else if (!accountSession) {
      const endpoint = authMode === 'register' ? '/api/auth/register' : authMode === 'login' ? '/api/auth/login' : '/api/auth/guest';
      const body = authMode === 'login' ? { username: displayName, password: passwordInput.value }
        : authMode === 'register' ? { username: displayName, password: passwordInput.value, avatarId: selectedAvatarId }
          : { displayName, avatarId: selectedAvatarId };
      try {
        const session = await requestJson(endpoint, { method: 'POST', body: JSON.stringify(body) });
        showSignedIn(session); displayName = session.identity.displayName; selectedAvatarId = session.identity.avatarId;
        passwordInput.value = '';
      } catch (error) {
        // Guest-only deployments remain usable until PostgreSQL is provisioned.
        if (!(authMode === 'guest' && (error.status === 404 || error.status === 503))) throw error;
      }
    } else {
      displayName = accountSession.identity.displayName; selectedAvatarId = accountSession.identity.avatarId;
    }
  } catch (error) {
    confirmButton.disabled = false;
    showStatus(error instanceof Error ? error.message : 'Account request failed.', true);
    return;
  }
  let realtimeTicket;
  if (typeof window.ARCADE_RUNTIME?.realtimeUrl === 'string' && window.ARCADE_RUNTIME.realtimeUrl) {
    try {
      const admission = await requestJson('/api/auth/realtime-ticket', { method: 'POST', body: '{}' });
      realtimeTicket = admission.ticket;
    } catch (error) {
      confirmButton.disabled = false;
      showStatus(error instanceof Error ? error.message : 'Secure multiplayer admission failed.', true);
      return;
    }
  }
  const selection = { displayName, avatarId: selectedAvatarId, roomId: customRoomId || roomSelect.value, realtimeTicket };
  savePreferences(selection);
  window.arcadeAvatarIdentity = selection;
  window.dispatchEvent(new CustomEvent('arcade:identity-selected', { detail: selection }));
  screen.hidden = true;
  document.querySelector('#enter').click();
});

authModePanel.addEventListener('click', (event) => {
  const mode = event.target.closest('[data-auth-mode]')?.dataset.authMode;
  if (mode) { event.preventDefault(); setAuthMode(mode); }
});
signOutButton.addEventListener('click', async () => {
  try { await requestJson('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* Local state is cleared either way. */ }
  showSignedIn(undefined); setAuthMode('guest'); showStatus('Signed out. Continue as a guest or sign in again.');
});
window.addEventListener('arcade:connection-error', ({ detail }) => {
  screen.hidden = false;
  cancelButton.hidden = true;
  confirmButton.disabled = false;
  showStatus(detail?.message ?? 'Could not connect to the arcade.', true);
});

window.addEventListener('arcade:placement-waiting', ({ detail }) => {
  screen.hidden = false;
  confirmButton.disabled = true;
  cancelButton.hidden = false;
  const seconds = Math.max(1, Math.ceil((detail?.delay ?? 1_500) / 1_000));
  showStatus(`Arcade rooms are busy. Retrying in ${seconds} second${seconds === 1 ? '' : 's'}…`);
});
window.addEventListener('arcade:placement-ready', () => {
  screen.hidden = true;
  cancelButton.hidden = true;
  confirmButton.disabled = false;
});
window.addEventListener('arcade:placement-canceled', () => {
  screen.hidden = false;
  cancelButton.hidden = true;
  confirmButton.disabled = false;
  showStatus('Room search canceled. Choose a room or try Quick Join again.');
});

roomRefresh.addEventListener('click', () => void refreshRooms());
cancelButton.addEventListener('click', () => window.dispatchEvent(new CustomEvent('arcade:placement-cancel')));

void boot();
