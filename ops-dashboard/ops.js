/**
 * Operations dashboard client (Milestone 11.26).
 *
 * Every request goes through `api`, which carries the CSRF token on writes and
 * treats a 401 as "the session is gone" rather than retrying. The dashboard
 * performs no authorization: the server decides, and this file only renders
 * what came back.
 */
const BASE = '/api/v1/operations';

let csrfToken = null;
let currentView = 'overview';

const element = (id) => document.getElementById(id);
const view = () => element('view');

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  // Only state-changing requests carry the CSRF token, matching the server.
  if (method !== 'GET' && csrfToken) headers['x-arcade-ops-csrf'] = csrfToken;

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body)
  });

  if (response.status === 401) {
    signedOut('Session expired. Sign in again.');
    throw new Error('unauthorized');
  }
  const payload = await response.json().catch(() => ({ ok: false, error: 'bad-response' }));
  if (!response.ok && !payload.data) throw new Error(payload.error ?? `request failed (${response.status})`);
  return payload;
}

function signedOut(message) {
  csrfToken = null;
  element('console').hidden = true;
  element('who').hidden = true;
  element('login-panel').hidden = false;
  if (message) showLoginError(message);
}

function showLoginError(message) {
  const target = element('login-error');
  target.textContent = message;
  target.hidden = false;
}

/** Text only: never innerHTML, so a value from the server cannot inject markup. */
function table(columns, rows) {
  const host = document.createElement('table');
  const head = host.createTHead().insertRow();
  for (const column of columns) {
    const cell = document.createElement('th');
    cell.textContent = column.label;
    head.append(cell);
  }
  const body = host.createTBody();
  if (rows.length === 0) {
    const empty = body.insertRow().insertCell();
    empty.colSpan = columns.length;
    empty.textContent = 'NOTHING TO SHOW';
    empty.className = 'muted';
    return host;
  }
  for (const row of rows) {
    const line = body.insertRow();
    for (const column of columns) {
      const cell = line.insertCell();
      const value = column.value(row);
      cell.textContent = value === null || value === undefined ? '—' : String(value);
    }
  }
  return host;
}

function statBlock(entries) {
  const host = document.createElement('div');
  host.className = 'stats';
  for (const [label, value] of entries) {
    const card = document.createElement('div');
    card.className = 'stat';
    const number = document.createElement('strong');
    number.textContent = String(value);
    const caption = document.createElement('span');
    caption.textContent = label;
    card.append(number, caption);
    host.append(card);
  }
  return host;
}

function heading(text) {
  const host = document.createElement('h2');
  host.textContent = text;
  return host;
}

const VIEWS = {
  async overview() {
    const { data } = await api('/overview');
    const host = document.createDocumentFragment();
    host.append(statBlock([
      ['ONLINE PLAYERS', data.totals.onlinePlayers],
      ['ACTIVE ROOMS', data.totals.activeRooms],
      ['ACTIVE CABINETS', data.totals.activeCabinets],
      ['GAME SESSIONS', data.totals.activeGameSessions],
      ['PENDING VERIFICATIONS', data.totals.pendingCompetitiveVerifications],
      ['EVENT LOOP (ms)', data.server.eventLoopDelayMs.toFixed(2)],
      ['MEMORY (MB)', Math.round(data.server.memoryRssBytes / 1048576)],
      ['PLUGINS FAILED', data.plugins.failed]
    ]));

    host.append(heading('HEALTH'));
    host.append(table(
      [
        { label: 'DEPENDENCY', value: (row) => row.name },
        { label: 'REQUIRED', value: (row) => (row.required ? 'yes' : 'no') },
        { label: 'READY', value: (row) => (row.ready ? 'yes' : 'no') },
        { label: 'DETAIL', value: (row) => row.detail }
      ],
      data.dependencies
    ));

    host.append(heading('REGISTRY'));
    host.append(statBlock([
      ['CABINET DEFINITIONS', data.registry.cabinetDefinitions],
      ['ZONES', data.registry.zones],
      ['GAME DEFINITIONS', data.registry.gameDefinitions],
      ['EMULATOR ADAPTERS', data.emulatorAdapters.length]
    ]));

    const version = document.createElement('p');
    version.className = 'muted';
    version.textContent = `deployment ${data.deploymentVersion} · server ${data.server.serverId} · ${data.server.region} · ${data.server.draining ? 'DRAINING' : 'serving'}`;
    host.append(version);
    return host;
  },

  async servers() {
    const { data } = await api('/servers');
    return table([
      { label: 'SERVER', value: (row) => row.serverId },
      { label: 'REGION', value: (row) => row.region },
      { label: 'VERSION', value: (row) => row.version },
      { label: 'UPTIME (s)', value: (row) => row.uptimeSeconds },
      { label: 'ROOMS', value: (row) => row.roomCount },
      { label: 'PLAYERS', value: (row) => row.playerCount },
      { label: 'CAPACITY', value: (row) => `${row.capacity.maxPlayers}p / ${row.capacity.maxRooms}r` },
      { label: 'READY', value: (row) => (row.ready ? 'yes' : row.readinessReasons.join(', ')) },
      { label: 'DRAINING', value: (row) => (row.draining ? 'yes' : 'no') }
    ], data);
  },

  async rooms() {
    const { data } = await api('/rooms');
    return table([
      { label: 'ROOM', value: (row) => row.roomId },
      { label: 'POPULATION', value: (row) => row.population },
      { label: 'OWNER', value: (row) => row.owningServerId },
      { label: 'STATUS', value: (row) => row.status },
      { label: 'ACTIVE CABINETS', value: (row) => row.activeCabinetCount },
      { label: 'CREATED', value: (row) => (row.createdAt ? new Date(row.createdAt).toISOString() : null) }
    ], data);
  },

  async cabinets() {
    const { data } = await api('/cabinets');
    return table([
      { label: 'CABINET', value: (row) => row.cabinetId },
      { label: 'ZONE', value: (row) => row.zoneId },
      { label: 'GAME', value: (row) => row.gameId },
      { label: 'STATE', value: (row) => row.state },
      { label: 'OCCUPANT', value: (row) => row.occupantPublicId },
      { label: 'ENABLED', value: (row) => (row.enabled ? 'yes' : 'no') },
      { label: 'MAINTENANCE', value: (row) => (row.maintenance ? 'yes' : 'no') },
      { label: 'FAILURES', value: (row) => row.failureCount }
    ], data);
  },

  async plugins() {
    const { data } = await api('/overview');
    const host = document.createDocumentFragment();
    host.append(statBlock([
      ['TOTAL', data.plugins.total],
      ['STARTED', data.plugins.started],
      ['FAILED', data.plugins.failed],
      ['DISABLED', data.plugins.disabled]
    ]));
    host.append(heading('FAILURES'));
    host.append(table([
      { label: 'PLUGIN', value: (row) => row.pluginId },
      { label: 'ERROR', value: (row) => row.error }
    ], data.plugins.failures));
    return host;
  },

  async replays() {
    const { data } = await api('/overview');
    const host = document.createDocumentFragment();
    host.append(heading('REPLAY PROCESSING'));
    const note = document.createElement('p');
    note.className = 'muted';
    // Stating this plainly beats an empty panel that reads like a broken queue.
    note.textContent = data.replay.note;
    host.append(note);
    host.append(table([
      { label: 'QUEUE', value: (row) => row.name },
      { label: 'DEPTH', value: (row) => row.depth },
      { label: 'FAILED', value: (row) => row.failed }
    ], data.queues));
    return host;
  },

  async actions() {
    const { data } = await api('/actions');
    const host = document.createDocumentFragment();
    host.append(heading('AVAILABLE ACTIONS'));
    const note = document.createElement('p');
    note.className = 'muted';
    note.textContent = 'Actions are a fixed set. There is no command, query, or script input anywhere in this console.';
    host.append(note);

    for (const entry of data) {
      const form = document.createElement('form');
      form.className = 'action';
      const title = document.createElement('h3');
      title.textContent = entry.action;
      const meta = document.createElement('p');
      meta.className = 'muted';
      meta.textContent = `${entry.capability} · target: ${entry.targetType}${entry.requiresReason ? ' · reason required' : ''}`;

      const target = document.createElement('input');
      target.placeholder = 'target id';
      target.maxLength = 128;

      const value = document.createElement('select');
      for (const option of ['', 'true', 'false']) {
        const item = document.createElement('option');
        item.value = option;
        item.textContent = option === '' ? 'value (none)' : option;
        value.append(item);
      }

      const reason = document.createElement('input');
      reason.placeholder = entry.requiresReason ? 'reason (required)' : 'reason';
      reason.maxLength = 500;

      const dryRun = document.createElement('label');
      const dryRunBox = document.createElement('input');
      dryRunBox.type = 'checkbox';
      dryRunBox.checked = true;
      dryRun.append(dryRunBox, document.createTextNode(' dry run'));

      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.textContent = 'RUN';

      const output = document.createElement('pre');
      output.className = 'output';

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        submit.disabled = true;
        try {
          const payload = await api('/actions', {
            method: 'POST',
            body: {
              action: entry.action,
              targetId: target.value || undefined,
              value: value.value === '' ? undefined : value.value === 'true',
              reason: reason.value || undefined,
              dryRun: dryRunBox.checked
            }
          });
          output.textContent = JSON.stringify(payload.data ?? payload, null, 2);
        } catch (error) {
          output.textContent = String(error.message ?? error);
        } finally {
          submit.disabled = false;
        }
      });

      form.append(title, meta, target, value, reason, dryRun, submit, output);
      host.append(form);
    }
    return host;
  },

  async audit() {
    const { data } = await api('/audit?limit=100');
    return table([
      { label: 'WHEN', value: (row) => new Date(row.at).toISOString() },
      { label: 'OPERATOR', value: (row) => row.operatorId },
      { label: 'ACTION', value: (row) => row.action },
      { label: 'TARGET', value: (row) => `${row.targetType}${row.targetId ? `:${row.targetId}` : ''}` },
      { label: 'OK', value: (row) => (row.success ? 'yes' : `no (${row.failureReason ?? '—'})`) },
      { label: 'DRY RUN', value: (row) => (row.dryRun ? 'yes' : 'no') },
      { label: 'REASON', value: (row) => row.reason },
      { label: 'VERSION', value: (row) => row.deploymentVersion }
    ], data);
  }
};

async function render() {
  const host = view();
  host.replaceChildren();
  const pending = document.createElement('p');
  pending.className = 'muted';
  pending.textContent = 'LOADING…';
  host.append(pending);
  try {
    const content = await VIEWS[currentView]();
    host.replaceChildren(content);
  } catch (error) {
    if (error.message === 'unauthorized') return;
    const failure = document.createElement('p');
    failure.className = 'error';
    failure.textContent = String(error.message ?? error);
    host.replaceChildren(failure);
  }
}

element('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  element('login-error').hidden = true;
  try {
    const response = await fetch(`${BASE}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ operatorId: element('operator-id').value, token: element('operator-token').value })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.ok) {
      showLoginError(payload.error === 'rate-limited' ? 'Too many attempts. Wait and try again.' : 'Sign in failed.');
      return;
    }
    csrfToken = payload.csrfToken;
    element('operator-token').value = '';
    element('operator-label').textContent = `${payload.operatorId} · ${payload.role}`;
    element('login-panel').hidden = true;
    element('console').hidden = false;
    element('who').hidden = false;
    await render();
  } catch {
    showLoginError('Sign in failed.');
  }
});

element('tabs').addEventListener('click', (event) => {
  const target = event.target.closest('button[data-view]');
  if (!target) return;
  for (const button of element('tabs').querySelectorAll('button')) button.classList.toggle('active', button === target);
  currentView = target.dataset.view;
  void render();
});

element('refresh').addEventListener('click', () => void render());

element('sign-out').addEventListener('click', async () => {
  try {
    await api('/session', { method: 'DELETE' });
  } catch { /* signing out locally is correct even if the call fails */ }
  signedOut(null);
});
