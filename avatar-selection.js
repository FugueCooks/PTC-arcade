import { loadAvatarRegistry } from './avatars/avatar-registry.js?v=triple-t-label-2';
import { RoomPlacementClient } from './rooms/room-placement-client.js?v=phase7-room-browser-1';

const PREFERENCE_KEY = 'roms-arcade-avatar-preferences';
const namePattern = /^[A-Za-z0-9 ._-]{2,18}$/;
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
const accountPanel = document.querySelector('#account-panel');
const accountSignedOut = document.querySelector('#account-signed-out');
const accountSignedIn = document.querySelector('#account-signed-in');
const accountWho = document.querySelector('#account-who');
const accountUsername = document.querySelector('#account-username');
const accountPassword = document.querySelector('#account-password');
const accountSubmit = document.querySelector('#account-submit');
const accountSignout = document.querySelector('#account-signout');
const tabSignIn = document.querySelector('#account-tab-signin');
const tabRegister = document.querySelector('#account-tab-register');
const identityMode = document.querySelector('#identity-mode');
const profileFields = document.querySelector('#account-profile-fields');
const placementClient = new RoomPlacementClient();
let selectedAvatarId = 'vled';
let staticRooms;
let accountSession;
let avatarRegistry;
let accountMode = 'signin';

const readPreferences = () => {
  try {
    const value = JSON.parse(localStorage.getItem(PREFERENCE_KEY) ?? 'null');
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
};

const savePreferences = (selection, persistent) => {
  const value = persistent ? selection : { roomId: selection.roomId, avatarId: selection.avatarId };
  try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify(value)); } catch { /* Private browsing may disable storage. */ }
};

// Keep the stable avatar ID and asset filenames for reconnect compatibility,
// but never expose the model's former display name in the player picker.
const avatarDisplayName = (avatar) => avatar.id === 'tung-sahur' ? 'Triple T' : avatar.name;

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
  if (!response.ok) { const error = new Error(payload?.error?.message ?? 'Arcade request failed.'); error.status = response.status; throw error; }
  return payload;
};

// A real account rather than the throwaway identity a guest is handed. The
// wallet flow used to add a second condition here, because a registered row
// could exist without the wallet having proved anything; a username and
// password leave nothing half-proved, so the type is the whole answer.
const isRegisteredSession = () => accountSession?.identity?.type === 'registered';

const showAccountState = () => {
  const registered = isRegisteredSession();
  accountPanel.dataset.authenticated = String(registered);
  identityMode.textContent = registered ? 'ARCADE ACCOUNT' : 'GUEST MODE';
  accountSignedOut.hidden = registered;
  accountSignedIn.hidden = !registered;
  profileFields.hidden = !registered;
  confirmButton.textContent = registered ? 'ENTER ARCADE' : 'PLAY AS GUEST';
  if (registered) {
    accountWho.textContent = `SIGNED IN AS ${accountSession.identity.displayName.toUpperCase()}`;
    nameInput.value = accountSession.identity.displayName;
    selectedAvatarId = avatarRegistry?.has(accountSession.identity.avatarId) ? accountSession.identity.avatarId : 'vled';
  } else {
    nameInput.value = '';
    if (!avatarRegistry?.has(selectedAvatarId)) selectedAvatarId = 'vled';
  }
  selectAvatar(selectedAvatarId);
};

/** Sign in and register share one form; the mode decides where it posts. */
const setAccountMode = (mode) => {
  accountMode = mode;
  const registering = mode === 'register';
  tabSignIn.classList.toggle('is-active', !registering);
  tabRegister.classList.toggle('is-active', registering);
  tabSignIn.setAttribute('aria-selected', String(!registering));
  tabRegister.setAttribute('aria-selected', String(registering));
  accountSubmit.textContent = registering ? 'CREATE ACCOUNT' : 'SIGN IN';
  accountPassword.autocomplete = registering ? 'new-password' : 'current-password';
  showStatus(registering
    ? 'Pick a username and a password of at least 8 characters.'
    : 'Sign in to pick up where you left off.');
};

const submitAccount = async () => {
  const username = accountUsername.value.trim();
  const password = accountPassword.value;
  // Checked here so an obvious slip does not cost a round trip, and checked
  // again on the server, which is the copy that actually decides.
  if (!/^[A-Za-z0-9_.-]{2,18}$/.test(username)) {
    showStatus('Usernames are 2-18 characters: letters, numbers, dots, dashes or underscores.', true);
    accountUsername.focus();
    return;
  }
  if (!password || (accountMode === 'register' && password.length < 8)) {
    showStatus(accountMode === 'register' ? 'Passwords need at least 8 characters.' : 'Enter your password.', true);
    accountPassword.focus();
    return;
  }
  accountSubmit.disabled = true;
  showStatus(accountMode === 'register' ? 'Creating your account…' : 'Signing in…');
  try {
    const endpoint = accountMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    // The two schemas disagree on purpose: registration needs the avatar the
    // player picked, and sign-in is strict and refuses any field it did not
    // ask for -- sending one body for both fails whichever end is not being
    // used at the time.
    const body = accountMode === 'register'
      ? { username, password, avatarId: selectedAvatarId }
      : { username, password };
    accountSession = await requestJson(endpoint, { method: 'POST', body: JSON.stringify(body) });
    // Nothing keeps the password once it has been sent.
    accountPassword.value = '';
    showAccountState();
    showStatus(accountMode === 'register' ? 'Account created. Choose your avatar and enter.' : 'Signed in. Choose your avatar and enter.');
  } catch (error) {
    // The server answers a bad username and a bad password identically, so
    // that probing cannot learn which usernames exist. Passing its wording
    // through keeps that property instead of guessing at a friendlier one.
    showStatus(error instanceof Error ? error.message : 'That did not work. Please try again.', true);
    accountPassword.focus();
  } finally {
    accountSubmit.disabled = false;
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
  confirmButton.textContent = 'PLAY AS GUEST';
  delete confirmButton.dataset.retry;
  showStatus('Loading avatar choices…');
  try {
    const avatars = await loadAvatarRegistry();
    avatarRegistry = avatars;
    staticRooms = window.ARCADE_ROOM_REGISTRY?.rooms;
    if (!(staticRooms instanceof Map) || staticRooms.size === 0) throw new Error('Arcade instances could not be loaded.');
    const saved = readPreferences();
    selectedAvatarId = typeof saved.avatarId === 'string' && avatars.has(saved.avatarId) ? saved.avatarId : 'vled';
    showStaticRooms(typeof saved.roomId === 'string' ? saved.roomId : '');
    if (typeof saved.roomId === 'string' && saved.roomId && !staticRooms.has(saved.roomId)) roomIdInput.value = saved.roomId.slice(0, 96);
    cards.replaceChildren(...[...avatars.values()].map((avatar) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'avatar-card';
      card.dataset.avatarId = avatar.id;
      card.textContent = avatarDisplayName(avatar);
      card.addEventListener('click', () => selectAvatar(avatar.id));
      return card;
    }));
    try {
      const session = await requestJson('/api/auth/session', { method: 'GET' });
      accountSession = session;
    } catch { accountSession = undefined; }
    showAccountState();
    confirmButton.disabled = false;
    showStatus(isRegisteredSession() ? 'Signed in. Choose your name and avatar.' : 'Choose an avatar and enter instantly as a temporary guest.');
    void refreshRooms(false);
  } catch (error) {
    confirmButton.disabled = false;
    confirmButton.textContent = 'RETRY';
    confirmButton.dataset.retry = 'true';
    showStatus(error instanceof Error ? error.message : 'Avatar choices could not be loaded.', true);
  }
}

tabSignIn.addEventListener('click', () => setAccountMode('signin'));
tabRegister.addEventListener('click', () => setAccountMode('register'));
accountSubmit.addEventListener('click', () => { void submitAccount(); });

for (const field of [accountUsername, accountPassword]) {
  field.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    // These fields sit inside the avatar form, where Enter means "play as
    // guest". Pressing it in a password box should sign in instead.
    event.preventDefault();
    void submitAccount();
  });
}

accountSignout.addEventListener('click', async () => {
  accountSignout.disabled = true;
  try { await requestJson('/api/auth/logout', { method: 'POST', body: '{}' }); }
  catch { /* Signing out stays local when the server cannot be reached. */ }
  accountSession = undefined;
  showAccountState();
  accountSignout.disabled = false;
  showStatus('Signed out. You can play as a guest or sign in again.');
});
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (confirmButton.dataset.retry === 'true') {
    void boot();
    return;
  }
  let displayName = isRegisteredSession() ? nameInput.value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
  if (isRegisteredSession() && !namePattern.test(displayName)) {
    showStatus('Use 2–18 letters, numbers, spaces, dots, dashes, or underscores.', true);
    nameInput.focus();
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
    if (isRegisteredSession()) {
      const profile = await requestJson('/api/account/profile', { method: 'PUT', body: JSON.stringify({ displayName, avatarId: selectedAvatarId }) });
      accountSession = { ...accountSession, identity: profile.identity };
    } else {
      if (accountSession) {
        try { await requestJson('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* A fresh guest request remains authoritative. */ }
        accountSession = undefined;
      }
      try { accountSession = await requestJson('/api/auth/guest', { method: 'POST', body: JSON.stringify({ avatarId: selectedAvatarId }) }); }
      catch (error) { if (!(error.status === 404 || error.status === 503)) throw error; }
    }
    if (accountSession) {
      displayName = accountSession.identity.displayName; selectedAvatarId = accountSession.identity.avatarId;
    } else {
      displayName = `GUEST_${crypto.getRandomValues(new Uint32Array(1))[0].toString(16).toUpperCase().slice(-6).padStart(6, '0')}`;
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
  const selection = { displayName, avatarId: selectedAvatarId, roomId: customRoomId || roomSelect.value,
    walletAuthenticated: isRegisteredSession(), realtimeTicket };
  savePreferences(selection, isRegisteredSession());
  window.arcadeAvatarIdentity = selection;
  window.dispatchEvent(new CustomEvent('arcade:identity-selected', { detail: selection }));
  screen.hidden = true;
  document.querySelector('#enter').click();
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
