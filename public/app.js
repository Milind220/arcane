const state = {
  currentId: null,
  eventSource: null,
  eventSessionId: null,
  loadingSession: false,
  pendingRefresh: null,
  pendingCanvasReload: false,
  latestRun: null,
  runEvents: [],
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
  cancelRun: document.querySelector('#cancel-run'),
  runStatus: document.querySelector('#run-status'),
  runMessage: document.querySelector('#run-message'),
  runEvents: document.querySelector('#run-events'),
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
    state.latestRun = null;
    state.runEvents = [];
    renderRun(null, []);
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
  state.latestRun = data.run;
  state.runEvents = data.runEvents || [];
  renderRun(data.run, state.runEvents);
  renderFiles(data.artifactFiles || []);
}

function renderMessage(message) {
  const role = escapeHtml(message.role);
  if (message.role === 'tool') return renderToolMessage(message);
  const parts = Array.isArray(message.parts) && message.parts.length ? renderMessageParts(message.parts) : '';
  return [
    `<article class="message ${role}">`,
    `<strong>${role}</strong>`,
    escapeHtml(message.content),
    parts,
    '</article>',
  ].join('');
}

function renderRun(run, runEvents = []) {
  const status = run?.status || 'idle';
  els.runStatus.textContent = status;
  els.runStatus.className = `status-pill status-${status}`;
  els.runMessage.textContent = run?.message || 'No run yet.';
  els.cancelRun.hidden = !isActiveRun(run);
  els.cancelRun.disabled = !isActiveRun(run);
  els.runEvents.innerHTML = renderRunEvents(runEvents);

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

function renderToolMessage(message) {
  const part = Array.isArray(message.parts) ? message.parts.find((item) => item.type === 'tool_result') : null;
  return renderToolCard({
    name: part?.name || 'tool',
    status: part?.ok === false ? 'error' : 'done',
    args: undefined,
    resultPreview: part?.preview || message.content,
    resultJson: part?.resultJson,
    error: part?.ok === false ? part.preview || message.content : '',
  });
}

function renderMessageParts(parts) {
  return parts.map((part) => {
    if (part.type === 'text') return `<p class="message-part">${escapeHtml(part.text)}</p>`;
    if (part.type === 'tool_call') {
      return renderToolCard({
        name: part.name,
        status: part.status,
        args: part.args,
        resultPreview: '',
      });
    }
    if (part.type === 'tool_result') {
      return renderToolCard({
        name: part.name,
        status: part.ok ? 'done' : 'error',
        resultPreview: part.preview,
        resultJson: part.resultJson,
        error: part.ok ? '' : part.preview,
      });
    }
    return '';
  }).join('');
}

function renderRunEvents(events) {
  if (!events.length) return '';
  const cards = [];
  const deltas = events
    .filter((event) => event.type === 'assistant.delta')
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map((event) => event.delta || '')
    .join('');

  if (deltas) {
    cards.push([
      '<article class="assistant-stream">',
      '<header><span>Assistant</span><span>streaming</span></header>',
      `<div>${escapeHtml(deltas)}</div>`,
      '</article>',
    ].join(''));
  }

  for (const tool of summarizeToolEvents(events)) {
    cards.push(renderToolCard(tool));
  }

  return cards.join('');
}

function summarizeToolEvents(events) {
  const tools = new Map();
  for (const event of events) {
    if (!event.type?.startsWith('tool.call.')) continue;
    const id = event.toolCallId || `${event.name || 'tool'}-${tools.size}`;
    const current = tools.get(id) || { toolCallId: id, name: event.name || 'tool', status: 'running' };
    if (event.name) current.name = event.name;
    if (event.type === 'tool.call.started') {
      current.status = 'running';
      current.args = event.args;
      current.createdAt = event.createdAt;
    }
    if (event.type === 'tool.call.updated') {
      current.status = current.status || 'running';
      current.patch = event.patch;
    }
    if (event.type === 'tool.call.completed') {
      current.status = 'done';
      current.resultPreview = event.resultPreview;
      current.resultJson = event.resultJson;
      current.completedAt = event.completedAt;
    }
    if (event.type === 'tool.call.failed') {
      current.status = 'error';
      current.error = event.error;
      current.completedAt = event.completedAt;
    }
    tools.set(id, current);
  }
  return [...tools.values()];
}

function renderToolCard(tool) {
  const status = tool.status || 'running';
  const argsPreview = tool.args === undefined ? '' : previewValue(tool.args);
  const resultPreview = tool.error || tool.resultPreview || '';
  return [
    `<article class="tool-card status-${escapeHtml(status)}">`,
    '<header>',
    `<span class="tool-name">${escapeHtml(tool.name || 'tool')}</span>`,
    `<span class="tool-status">${escapeHtml(status)}</span>`,
    '</header>',
    argsPreview ? `<div class="tool-preview">${escapeHtml(argsPreview)}</div>` : '',
    tool.args === undefined ? '' : renderDetails('Arguments', tool.args),
    resultPreview ? `<div class="tool-result">${escapeHtml(resultPreview)}</div>` : '',
    tool.resultJson === undefined ? '' : renderDetails('Result', tool.resultJson),
    '</article>',
  ].join('');
}

function renderDetails(label, value) {
  return [
    '<details>',
    `<summary>${escapeHtml(label)}</summary>`,
    `<pre>${escapeHtml(formatJson(value))}</pre>`,
    '</details>',
  ].join('');
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
    mergeRunEvent(payload);
  });
  source.addEventListener('run.created', (event) => mergeRunEvent(parseEvent(event)));
  source.addEventListener('assistant.delta', (event) => mergeRunEvent(parseEvent(event)));
  source.addEventListener('tool.call.started', (event) => mergeRunEvent(parseEvent(event)));
  source.addEventListener('tool.call.updated', (event) => mergeRunEvent(parseEvent(event)));
  source.addEventListener('tool.call.completed', (event) => mergeRunEvent(parseEvent(event)));
  source.addEventListener('tool.call.failed', (event) => mergeRunEvent(parseEvent(event)));
  source.addEventListener('assistant.message', () => scheduleRefresh(false));
  source.addEventListener('run.done', (event) => {
    mergeRunEvent(parseEvent(event));
    scheduleRefresh(false);
  });
  source.addEventListener('run.error', (event) => {
    mergeRunEvent(parseEvent(event));
    scheduleRefresh(false);
  });
  source.addEventListener('run.cancelled', (event) => {
    mergeRunEvent(parseEvent(event));
    scheduleRefresh(false);
  });

  state.eventSource = source;
  state.eventSessionId = id;
}

function mergeRunEvent(event) {
  if (!event?.type || !event.runId) return;
  if (!state.latestRun || state.latestRun.id === event.runId || event.run) {
    state.latestRun = event.run || {
      ...(state.latestRun || { id: event.runId, sessionId: event.sessionId }),
      status: event.status || state.latestRun?.status,
      message: event.message || state.latestRun?.message,
      updatedAt: event.updatedAt || event.createdAt || state.latestRun?.updatedAt,
    };
  }
  if (state.latestRun?.id !== event.runId) return;
  state.runEvents = [...state.runEvents.filter((item) => eventKey(item) !== eventKey(event)), event];
  renderRun(state.latestRun, state.runEvents);
}

function eventKey(event) {
  if (event.type === 'assistant.delta') return `${event.type}:${event.messageId}:${event.index}`;
  if (event.toolCallId) return `${event.type}:${event.toolCallId}:${event.completedAt || event.updatedAt || event.createdAt || ''}`;
  return `${event.type}:${event.runId}:${event.updatedAt || event.createdAt || ''}`;
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

function isActiveRun(run) {
  return run?.status === 'queued' || run?.status === 'thinking' || run?.status === 'editing';
}

function formatJson(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function previewValue(value, limit = 140) {
  const text = formatJson(value).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...`;
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

els.cancelRun.addEventListener('click', async () => {
  const runId = state.latestRun?.id;
  if (!state.currentId || !runId) return;
  els.cancelRun.disabled = true;
  try {
    await api(`/api/sessions/${encodeURIComponent(state.currentId)}/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  } finally {
    await loadSession(state.currentId);
  }
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
    await loadSession(state.currentId);
  }
});

loadSessions().catch((error) => {
  els.messages.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
});
