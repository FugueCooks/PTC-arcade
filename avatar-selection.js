import { loadAvatarRegistry } from './avatars/avatar-registry.js?v=tung-sahur-1';
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
const walletPanel = document.querySelector('#wallet-panel');
const walletSelect = document.querySelector('#wallet-select');
const walletConnect = document.querySelector('#wallet-connect');
const walletSignout = document.querySelector('#wallet-signout');
const walletChange = document.querySelector('#wallet-change');
const walletCopy = document.querySelector('#wallet-copy');
const walletAddress = document.querySelector('#wallet-address');
const identityMode = document.querySelector('#identity-mode');
const profileFields = document.querySelector('#wallet-profile-fields');
const placementClient = new RoomPlacementClient();
let selectedAvatarId = 'neon-capsule';
let staticRooms;
let accountSession;
let avatarRegistry;
let walletClient;

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

const isWalletSession = () => accountSession?.identity?.type === 'registered' && accountSession.identity.walletAuthenticated === true;

const showIdentityMode = () => {
  const authenticated = isWalletSession();
  walletPanel.dataset.authenticated = String(authenticated);
  identityMode.textContent = authenticated ? 'WALLET ACCOUNT' : 'GUEST MODE';
  profileFields.hidden = !authenticated;
  walletSignout.hidden = !authenticated;
  walletChange.hidden = !authenticated;
  walletCopy.hidden = !authenticated;
  walletConnect.hidden = authenticated;
  walletSelect.hidden = authenticated;
  confirmButton.textContent = authenticated ? 'ENTER ARCADE' : 'PLAY AS GUEST';
  if (authenticated) {
    const address = accountSession.identity.walletAddress ?? '';
    walletAddress.textContent = address ? `${address.slice(0, 4)}…${address.slice(-4)} · AUTHENTICATED` : 'AUTHENTICATED';
    walletAddress.hidden = false;
    nameInput.value = accountSession.identity.displayName;
    selectedAvatarId = avatarRegistry?.has(accountSession.identity.avatarId) ? accountSession.identity.avatarId : 'neon-capsule';
    selectAvatar(selectedAvatarId);
  } else {
    walletAddress.hidden = true;
    nameInput.value = '';
    if (!avatarRegistry?.has(selectedAvatarId)) selectedAvatarId = 'neon-capsule';
    selectAvatar(selectedAvatarId);
  }
};

async function initializeWallets() {
  try {
    const { PtcWalletClient } = await import('./wallet/wallet-standard-bundle.js?v=phase9-1');
    walletClient = new PtcWalletClient({ appName: 'PTC Arcade', appUri: location.origin,
      network: window.ARCADE_RUNTIME?.solanaNetwork ?? 'mainnet-beta' });
    walletClient.onAccountChange((address) => {
      if (!isWalletSession()) return;
      if (address && address === accountSession.identity.walletAddress) return;
      walletAddress.textContent = address
        ? 'CONNECTED WALLET CHANGED · AUTHENTICATE TO SWITCH ACCOUNT'
        : 'WALLET DISCONNECTED · SIGNED-IN SESSION REMAINS ACTIVE';
      walletChange.hidden = false;
      showStatus('Your wallet connection changed. Your signed-in account has not changed.', true);
    });
    const render = () => {
      const wallets = walletClient.wallets();
      walletSelect.replaceChildren(...(wallets.length ? wallets.map((wallet) => roomOption(wallet.name, wallet.name))
        : [roomOption('', 'NO COMPATIBLE WALLET FOUND', true)]));
      walletConnect.disabled = wallets.length === 0;
    };
    render();
    setTimeout(render, 500);
  } catch {
    walletSelect.replaceChildren(roomOption('', 'WALLET SUPPORT UNAVAILABLE', true));
    walletConnect.disabled = true;
  }
}

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
    selectedAvatarId = typeof saved.avatarId === 'string' && avatars.has(saved.avatarId) ? saved.avatarId : 'neon-capsule';
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
      accountSession = session?.identity?.type === 'registered' && session.identity.walletAuthenticated !== true
        ? undefined : session;
    } catch { accountSession = undefined; }
    showIdentityMode();
    await initializeWallets();
    confirmButton.disabled = false;
    showStatus(isWalletSession() ? 'Wallet authenticated. Choose your name and avatar.' : 'Choose an avatar and enter instantly as a temporary guest.');
    void refreshRooms(false);
  } catch (error) {
    confirmButton.disabled = false;
    confirmButton.textContent = 'RETRY';
    confirmButton.dataset.retry = 'true';
    showStatus(error instanceof Error ? error.message : 'Avatar choices could not be loaded.', true);
  }
}

walletConnect.addEventListener('click', async () => {
  if (!walletClient || !walletSelect.value) return;
  walletConnect.disabled = true;
  showStatus('Connect your wallet, then approve the free sign-in message. No transaction will be sent.');
  try {
    const connected = await walletClient.connect(walletSelect.value);
    const challenge = await requestJson('/api/auth/wallet/challenge', { method: 'POST', body: JSON.stringify({ walletAddress: connected.address }) });
    showStatus('SIGNATURE PENDING // This is free and does not spend SOL.');
    const output = await walletClient.signIn(challenge.input);
    accountSession = await requestJson('/api/auth/wallet/verify', { method: 'POST',
      body: JSON.stringify({ challengeId: challenge.challengeId, output }) });
    showIdentityMode();
    showStatus(accountSession.created ? 'Wallet verified. Finish your persistent arcade profile.' : 'Wallet verified. Your persistent profile is restored.');
  } catch (error) {
    showStatus(error instanceof Error ? error.message : 'Wallet authentication was canceled or rejected.', true);
  } finally { walletConnect.disabled = false; }
});

walletSignout.addEventListener('click', async () => {
  walletSignout.disabled = true;
  try { await requestJson('/api/auth/logout', { method: 'POST', body: '{}' }); } catch { /* Sign-out remains local if the server is unavailable. */ }
  await walletClient?.disconnect();
  accountSession = undefined;
  showIdentityMode();
  walletSignout.disabled = false;
  showStatus('Signed out. You may enter as a temporary guest.');
});

walletCopy.addEventListener('click', async () => {
  const address = accountSession?.identity?.walletAddress;
  if (!address) return;
  try { await navigator.clipboard.writeText(address); showStatus('Wallet address copied.'); }
  catch { showStatus('Could not copy the wallet address.', true); }
});

walletChange.addEventListener('click', () => {
  walletSelect.hidden = false;
  walletConnect.hidden = false;
  walletConnect.textContent = 'AUTHENTICATE NEW WALLET';
  showStatus('Choose a wallet and sign a new challenge. Your current account remains active until verification succeeds.');
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (confirmButton.dataset.retry === 'true') {
    void boot();
    return;
  }
  let displayName = isWalletSession() ? nameInput.value.normalize('NFKC').trim().replace(/\s+/g, ' ') : '';
  if (isWalletSession() && !namePattern.test(displayName)) {
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
    if (isWalletSession()) {
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
  const selection = { displayName, avatarId: selectedAvatarId, roomId: customRoomId || roomSelect.value, realtimeTicket };
  savePreferences(selection, isWalletSession());
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
