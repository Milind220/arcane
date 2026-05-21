const state = {
  currentId: null,
  eventSource: null,
  eventSessionId: null,
  loadingSession: false,
  pendingRefresh: null,
  pendingCanvasReload: false,
};

const accessToken = new URLSearchParams(location.search).get('token') || '';

const els = {
  sessions: document.querySelector('#sessions'),
  newSession: document.querySelector('#new-session'),
  messages: document.querySelector('#messages'),
  composer: document.querySelector('#composer'),
  content: document.querySelector('#content'),
  send: document.querySelector('#send'),
  artifact: document.querySelector('#artifact'),
  reloadCanvas: document.querySelector('#reload-canvas'),
  snapshot: document.querySelector('#snapshot'),
  runStatus: document.querySelector('#run-status'),
  runMessage: document.querySelector('#run-message'),
  debugDrawer: document.querySelector('#debug-drawer'),
  debugJson: document.querySelector('#debug-json'),
  files: document.querySelector('#files'),
  fileCount: document.querySelector('#file-count'),
  sessionTitle: document.querySelector('#session-title'),
  eventState: document.querySelector('#event-state'),
};

function withToken(path) {
  if (!accessToken) return path;
  const url = new URL(path, location.origin);
  url.searchParams.set('token', accessToken);
  return `${url.pathname}${url.search}`;
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  if (accessToken) headers['x-arcane-token'] = accessToken;
  const response = await fetch(path, { ...options, headers });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(body?.message || body?.error || `HTTP ${response.status}`);
    error.body = body;
    error.status = response.status;
    throw error;
  }
  return body;
}

async function loadSessions(selectId) {
  const sessions = await api('/api/sessions');
  if (!sessions.length) {
    els.sessions.innerHTML = '<option value="">No sessions</option>';
    els.messages.innerHTML = '<p class="empty">Create a session.</p>';
    renderSession(null);
    return;
  }

  els.sessions.innerHTML = sessions.map((session) => (
    `<option value="${escapeHtml(session.id)}">${escapeHtml(session.title)}</option>`
  )).join('');

  const nextId = selectId || state.currentId || sessions[0].id;
  await loadSession(nextId, { reloadCanvas: state.currentId !== nextId });
}

async function loadSession(id, options = {}) {
  if (!id || state.loadingSession) return;
  state.loadingSession = true;
  try {
    state.currentId = id;
    els.sessions.value = id;
    const data = await api(`/api/sessions/${encodeURIComponent(id)}`);
    renderSession(data);
    connectEvents(id);
    if (options.reloadCanvas || els.artifact.dataset.sessionId !== id) await reloadCanvas();
  } finally {
    state.loadingSession = false;
  }
}

function renderSession(data) {
  if (!data) {
    els.sessionTitle.textContent = 'No session';
    renderRun(null);
    renderFiles([]);
    els.artifact.removeAttribute('src');
    els.artifact.dataset.sessionId = '';
    return;
  }

  els.sessionTitle.textContent = data.session.title || 'Untitled session';
  els.messages.innerHTML = data.messages.length
    ? data.messages.map(renderMessage).join('')
    : '<p class="empty">No messages yet.</p>';
  els.messages.scrollTop = els.messages.scrollHeight;
  renderRun(data.run);
  renderFiles(data.artifactFiles || []);
}

function renderMessage(message) {
  const role = escapeHtml(message.role);
  return [
    `<article class="message ${role}">`,
    `<strong>${role}</strong>`,
    escapeHtml(message.content),
    '</article>',
  ].join('');
}

function renderRun(run) {
  const status = run?.status || 'idle';
  els.runStatus.textContent = status;
  els.runStatus.className = `status-pill status-${status}`;
  els.runMessage.textContent = run?.message || 'No run yet.';

  if (run?.status === 'error') {
    els.debugDrawer.classList.add('open');
    els.debugDrawer.open = true;
    els.debugJson.textContent = JSON.stringify(run.debug || {}, null, 2);
  } else {
    els.debugDrawer.classList.remove('open');
    els.debugDrawer.open = false;
    els.debugJson.textContent = '';
  }
}

function renderFiles(files) {
  els.fileCount.textContent = String(files.length);
  els.files.innerHTML = files.length
    ? files.map((file) => (
      `<div class="file-row">` +
      `<div class="file-path">${escapeHtml(file.path)}</div>` +
      `<div class="file-meta"><span>${formatBytes(file.size)}</span><span>${formatTime(file.modifiedAt)}</span></div>` +
      `</div>`
    )).join('')
    : '<p class="empty">No artifact files.</p>';
}

function connectEvents(id) {
  if (state.eventSource && state.eventSessionId === id) return;
  if (state.eventSource) state.eventSource.close();
  if (!window.EventSource) {
    els.eventState.textContent = 'live events unavailable';
    return;
  }

  const source = new EventSource(withToken(`/api/sessions/${encodeURIComponent(id)}/events`));
  source.onopen = () => {
    els.eventState.textContent = 'live';
  };
  source.onerror = () => {
    els.eventState.textContent = 'reconnecting';
  };

  source.addEventListener('message.appended', () => scheduleRefresh(false));
  source.addEventListener('artifact.changed', () => scheduleRefresh(true));
  source.addEventListener('snapshot.created', () => scheduleRefresh(true));
  source.addEventListener('run.status', (event) => {
    const payload = parseEvent(event);
    scheduleRefresh(payload?.status === 'done' || payload?.status === 'error');
  });

  state.eventSource = source;
  state.eventSessionId = id;
}

function scheduleRefresh(reloadCanvasAfter) {
  state.pendingCanvasReload = state.pendingCanvasReload || reloadCanvasAfter;
  if (state.pendingRefresh) clearTimeout(state.pendingRefresh);
  state.pendingRefresh = setTimeout(async () => {
    state.pendingRefresh = null;
    const reload = state.pendingCanvasReload;
    state.pendingCanvasReload = false;
    if (state.currentId) await loadSession(state.currentId, { reloadCanvas: reload });
  }, 80);
}

async function reloadCanvas() {
  if (!state.currentId) return;
  if (accessToken) {
    await api(`/api/sessions/${encodeURIComponent(state.currentId)}/artifact-access`, { method: 'POST' });
  }
  const url = new URL(`/artifact/${state.currentId}/index.html`, location.origin);
  url.searchParams.set('t', String(Date.now()));
  els.artifact.dataset.sessionId = state.currentId;
  els.artifact.src = `${url.pathname}${url.search}`;
}

function setBusy(isBusy) {
  els.send.disabled = isBusy;
  els.content.disabled = isBusy;
  els.send.textContent = isBusy ? 'Working...' : 'Send';
}

function parseEvent(event) {
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function formatBytes(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

els.sessions.addEventListener('change', () => {
  if (els.sessions.value) loadSession(els.sessions.value, { reloadCanvas: true });
});

els.newSession.addEventListener('click', async () => {
  const title = window.prompt('Session title', 'Untitled session') || 'Untitled session';
  const session = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title }) });
  await loadSessions(session.id);
});

els.reloadCanvas.addEventListener('click', () => {
  reloadCanvas().catch((error) => {
    els.runMessage.textContent = error.message;
    els.runStatus.textContent = 'error';
    els.runStatus.className = 'status-pill status-error';
  });
});

els.snapshot.addEventListener('click', async () => {
  if (!state.currentId) return;
  await api(`/api/sessions/${encodeURIComponent(state.currentId)}/snapshots`, {
    method: 'POST',
    body: JSON.stringify({ summary: 'manual snapshot' }),
  });
  await loadSession(state.currentId, { reloadCanvas: true });
});

els.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = els.content.value.trim();
  if (!state.currentId || !content) return;

  els.content.value = '';
  setBusy(true);
  try {
    await api(`/api/sessions/${encodeURIComponent(state.currentId)}/agent`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
  } catch (error) {
    if (!error.body?.run) {
      els.runMessage.textContent = error.message;
      els.runStatus.textContent = 'error';
      els.runStatus.className = 'status-pill status-error';
    }
  } finally {
    setBusy(false);
    await loadSession(state.currentId, { reloadCanvas: true });
  }
});

loadSessions().catch((error) => {
  els.messages.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
});
