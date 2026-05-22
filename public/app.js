const state = {
  currentId: null,
  eventSource: null,
  eventSessionId: null,
  loadingSession: false,
  pendingRefresh: null,
  pendingCanvasReload: false,
  latestRun: null,
  runEvents: [],
  messageIds: new Set(),
  streamingMessages: new Map(),
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
    state.messageIds = new Set();
    state.streamingMessages = new Map();
    renderRun(null, []);
    renderFiles([]);
    els.artifact.removeAttribute('src');
    els.artifact.dataset.sessionId = '';
    return;
  }

  els.sessionTitle.textContent = data.session.title || 'Untitled session';
  state.messageIds = new Set(data.messages.map((message) => message.id));
  state.streamingMessages = new Map();
  els.messages.innerHTML = data.messages.length
    ? data.messages.map(renderMessage).join('')
    : '<p class="empty">No messages yet.</p>';
  state.latestRun = data.run;
  state.runEvents = data.runEvents || [];
  restoreStreamingAssistantMessages(state.runEvents, data.messages);
  scrollMessagesToBottom();
  renderRun(data.run, state.runEvents);
  renderFiles(data.artifactFiles || []);
}

function renderMessage(message) {
  const role = escapeHtml(message.role);
  if (message.role === 'tool') return renderToolMessage(message);
  const parts = Array.isArray(message.parts) && message.parts.length ? renderMessageParts(message.parts) : '';
  return [
    `<article class="message ${role}" data-message-id="${escapeHtml(message.id)}" data-run-id="${escapeHtml(message.runId || '')}">`,
    `<strong>${role}</strong>`,
    renderMessageContent(message),
    parts,
    '</article>',
  ].join('');
}

function renderMessageContent(message) {
  if (message.role === 'assistant') return renderAssistantContent(message.content);
  return escapeHtml(message.content);
}

function renderAssistantContent(content) {
  const parsed = parseJsonObject(content);
  const commands = extractCommandList(parsed);
  if (commands) {
    return [
      '<div class="command-list">',
      ...commands.map((command) => (
        '<div class="command-row">' +
        `<code>${escapeHtml(command.name)}</code>` +
        (command.description ? `<span>${escapeHtml(command.description)}</span>` : '') +
        '</div>'
      )),
      '</div>',
    ].join('');
  }
  if (parsed && Object.keys(parsed).length <= 24) {
    return `<pre class="json-response">${escapeHtml(formatReadableObject(parsed))}</pre>`;
  }
  return escapeHtml(content);
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
  return [
    `<article class="message tool" data-message-id="${escapeHtml(message.id)}" data-run-id="${escapeHtml(message.runId || '')}" data-tool-call-id="${escapeHtml(message.toolCallId || '')}">`,
    renderToolCard({
      name: part?.name || 'tool',
      status: part?.ok === false ? 'error' : 'done',
      args: undefined,
      resultPreview: part?.preview || message.content,
      resultJson: part?.resultJson,
      error: part?.ok === false ? part.preview || message.content : '',
    }),
    '</article>',
  ].join('');
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
      current.category = event.category;
      current.createdAt = event.createdAt;
    }
    if (event.type === 'tool.call.updated') {
      current.status = current.status || 'running';
      if (event.name) current.name = event.name;
      current.patch = event.patch;
      current.updatedAt = event.updatedAt;
    }
    if (event.type === 'tool.call.completed') {
      current.status = 'done';
      if (event.args !== undefined) current.args = event.args;
      current.resultPreview = event.resultPreview;
      current.resultJson = event.resultJson;
      current.completedAt = event.completedAt;
      current.durationMs = event.durationMs;
      current.resultTruncated = event.resultTruncated;
      current.category = event.category || current.category;
      current.debugRef = event.debugRef;
    }
    if (event.type === 'tool.call.failed') {
      current.status = 'error';
      if (event.args !== undefined) current.args = event.args;
      current.error = event.error;
      current.resultPreview = event.resultPreview;
      current.completedAt = event.completedAt;
      current.durationMs = event.durationMs;
      current.resultTruncated = event.resultTruncated;
      current.category = event.category || current.category;
      current.debugRef = event.debugRef;
      current.debug = event.debug;
    }
    tools.set(id, current);
  }
  return [...tools.values()];
}

function renderToolCard(tool) {
  const status = tool.status || 'running';
  const argsPreview = tool.args === undefined ? '' : previewValue(tool.args);
  const resultPreview = tool.error || tool.resultPreview || '';
  const resultText = String(resultPreview || '');
  const showResultDetails = resultText.length > 280;
  const meta = renderToolMeta(tool);
  return [
    `<article class="tool-card status-${escapeHtml(status)}">`,
    '<header>',
    `<span class="tool-name">${escapeHtml(tool.name || 'tool')}</span>`,
    `<span class="tool-status">${escapeHtml(status)}</span>`,
    '</header>',
    meta,
    argsPreview ? `<div class="tool-preview">${escapeHtml(argsPreview)}</div>` : '',
    tool.args === undefined ? '' : renderDetails('Arguments', tool.args),
    resultPreview ? `<div class="tool-result">${escapeHtml(showResultDetails ? previewValue(resultText, 280) : resultText)}</div>` : '',
    showResultDetails ? renderDetails('Full result preview', resultText) : '',
    tool.resultJson === undefined ? '' : renderDetails('Result', tool.resultJson),
    tool.debugRef === undefined ? '' : renderDetails('Debug ref', tool.debugRef),
    tool.debug === undefined ? '' : renderDetails('Debug', tool.debug),
    '</article>',
  ].join('');
}

function renderToolMeta(tool) {
  const items = [];
  if (tool.category) items.push(tool.category);
  if (Number.isFinite(Number(tool.durationMs))) items.push(`${Number(tool.durationMs)} ms`);
  if (tool.resultTruncated) items.push('truncated');
  if (tool.debugRef) items.push(`debug: ${debugRefLabel(tool.debugRef)}`);
  if (!items.length) return '';
  return `<div class="tool-meta">${items.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>`;
}

function renderDetails(label, value) {
  return [
    '<details>',
    `<summary>${escapeHtml(label)}</summary>`,
    `<pre>${escapeHtml(formatJson(value))}</pre>`,
    '</details>',
  ].join('');
}

function parseJsonObject(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractCommandList(value) {
  if (!value) return null;
  const source = Array.isArray(value.commands) ? value.commands : Array.isArray(value.slashCommands) ? value.slashCommands : null;
  if (!source?.length) return null;
  const commands = source
    .map((item) => {
      if (typeof item === 'string') return { name: item, description: '' };
      if (!item || typeof item !== 'object') return null;
      const rawName = item.name || item.command || item.cmd;
      if (typeof rawName !== 'string') return null;
      const name = rawName.startsWith('/') ? rawName : `/${rawName}`;
      const description = typeof item.description === 'string'
        ? item.description
        : typeof item.summary === 'string'
          ? item.summary
          : '';
      return { name, description };
    })
    .filter(Boolean);
  return commands.length ? commands : null;
}

function formatReadableObject(value) {
  const lines = [];
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item)) {
      lines.push(`${key}:`);
      for (const entry of item) lines.push(`  - ${formatInlineValue(entry)}`);
    } else {
      lines.push(`${key}: ${formatInlineValue(item)}`);
    }
  }
  return lines.join('\n');
}

function formatInlineValue(value) {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function debugRefLabel(debugRef) {
  if (!debugRef || typeof debugRef !== 'object') return String(debugRef);
  const type = debugRef.kind || 'ref';
  return [type, debugRef.id, debugRef.path].filter(Boolean).join(':');
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

  source.addEventListener('message.appended', (event) => handleMessageAppended(parseEvent(event)));
  source.addEventListener('artifact.changed', () => scheduleRefresh(true));
  source.addEventListener('snapshot.created', () => scheduleRefresh(true));
  source.addEventListener('run.status', (event) => {
    const payload = parseEvent(event);
    mergeRunEvent(payload);
  });
  source.addEventListener('run.created', (event) => mergeRunEvent(parseEvent(event)));
  source.addEventListener('assistant.delta', (event) => {
    const payload = parseEvent(event);
    mergeRunEvent(payload);
    handleAssistantDelta(payload);
  });
  source.addEventListener('tool.call.started', (event) => mergeRunEvent(parseEvent(event)));
  source.addEventListener('tool.call.updated', (event) => mergeRunEvent(parseEvent(event)));
  source.addEventListener('tool.call.completed', (event) => mergeRunEvent(parseEvent(event)));
  source.addEventListener('tool.call.failed', (event) => mergeRunEvent(parseEvent(event)));
  source.addEventListener('assistant.message', (event) => {
    const payload = parseEvent(event);
    mergeRunEvent(payload);
    handleAssistantMessage(payload);
  });
  source.addEventListener('run.done', (event) => {
    mergeRunEvent(parseEvent(event));
  });
  source.addEventListener('run.error', (event) => {
    mergeRunEvent(parseEvent(event));
  });
  source.addEventListener('run.cancelled', (event) => {
    mergeRunEvent(parseEvent(event));
  });

  state.eventSource = source;
  state.eventSessionId = id;
}

function mergeRunEvent(event) {
  if (!event?.type || !event.runId) return;
  if (event.sessionId && event.sessionId !== state.currentId) return;
  let switchedRun = false;
  if (event.run) {
    if (!state.latestRun || state.latestRun.id !== event.run.id || isNewerRun(event.run, state.latestRun)) {
      switchedRun = state.latestRun?.id !== event.run.id;
      state.latestRun = event.run;
    }
  } else if (!state.latestRun || state.latestRun.id === event.runId) {
    switchedRun = !state.latestRun;
    state.latestRun = {
      ...(state.latestRun || { id: event.runId, sessionId: event.sessionId }),
      status: event.status || state.latestRun?.status,
      message: event.message || state.latestRun?.message,
      debug: event.debug || state.latestRun?.debug,
      updatedAt: event.updatedAt || event.createdAt || state.latestRun?.updatedAt,
    };
  }
  if (state.latestRun?.id !== event.runId) return;
  if (switchedRun) state.runEvents = [];
  state.runEvents = [...state.runEvents.filter((item) => eventKey(item) !== eventKey(event)), event];
  renderRun(state.latestRun, state.runEvents);
}

function isNewerRun(nextRun, currentRun) {
  if (!currentRun?.updatedAt || !nextRun?.updatedAt) return true;
  return nextRun.updatedAt >= currentRun.updatedAt;
}

function handleMessageAppended(event) {
  if (!event?.message || event.sessionId !== state.currentId) return;
  upsertMessage(event.message);
}

function handleAssistantMessage(event) {
  if (!event?.message || event.sessionId !== state.currentId) return;
  upsertMessage(event.message, { replaceStream: true });
}

function handleAssistantDelta(event) {
  if (!event || event.type !== 'assistant.delta' || event.sessionId !== state.currentId) return;
  const stream = ensureAssistantStream(event);
  stream.chunks.set(Number(event.index) || 0, String(event.delta || ''));
  stream.content = orderedStreamContent(stream);
  updateAssistantStreamElement(stream);
}

function upsertMessage(message, options = {}) {
  if (!message?.id) return;
  removeEmptyMessage();
  const existing = findMessageElement(message.id);
  if (existing) {
    existing.outerHTML = renderMessage(message);
    state.messageIds.add(message.id);
    scrollMessagesToBottom();
    return;
  }

  const stream = (options.replaceStream || message.role === 'assistant') ? findAssistantStream(message.runId) : null;
  if (stream?.element?.isConnected) {
    stream.element.outerHTML = renderMessage(message);
    state.messageIds.add(message.id);
    removeAssistantStreams(message.runId);
    scrollMessagesToBottom();
    return;
  }

  if (state.messageIds.has(message.id)) return;
  els.messages.insertAdjacentHTML('beforeend', renderMessage(message));
  state.messageIds.add(message.id);
  if (message.role === 'assistant') removeAssistantStreams(message.runId);
  scrollMessagesToBottom();
}

function ensureAssistantStream(event) {
  removeEmptyMessage();
  const key = assistantStreamKey(event);
  const existing = state.streamingMessages.get(key);
  if (existing) return existing;

  const stream = {
    key,
    runId: event.runId,
    messageId: event.messageId || `assistant-${event.runId}`,
    chunks: new Map(),
    content: '',
    element: null,
  };
  state.streamingMessages.set(key, stream);
  els.messages.insertAdjacentHTML('beforeend', renderAssistantStream(stream));
  stream.element = findAssistantStreamElement(key);
  scrollMessagesToBottom();
  return stream;
}

function updateAssistantStreamElement(stream) {
  const element = stream.element?.isConnected ? stream.element : findAssistantStreamElement(stream.key);
  stream.element = element;
  if (!element) return;
  const body = element.querySelector('.stream-content');
  if (body) body.innerHTML = renderAssistantContent(stream.content);
  scrollMessagesToBottom();
}

function restoreStreamingAssistantMessages(events, messages) {
  const assistantRunIds = new Set(messages.filter((message) => message.role === 'assistant').map((message) => message.runId).filter(Boolean));
  const deltas = events
    .filter((event) => event.type === 'assistant.delta' && !assistantRunIds.has(event.runId))
    .sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || '') || (a.index || 0) - (b.index || 0));
  for (const event of deltas) handleAssistantDelta(event);
}

function renderAssistantStream(stream) {
  return [
    `<article class="message assistant streaming" data-stream-key="${escapeHtml(stream.key)}" data-run-id="${escapeHtml(stream.runId || '')}">`,
    '<strong>assistant</strong>',
    `<div class="stream-content">${renderAssistantContent(stream.content)}</div>`,
    '</article>',
  ].join('');
}

function removeAssistantStreams(runId) {
  if (!runId) return;
  for (const [key, stream] of [...state.streamingMessages.entries()]) {
    if (stream.runId !== runId) continue;
    stream.element?.remove();
    state.streamingMessages.delete(key);
  }
}

function findAssistantStream(runId) {
  if (!runId) return null;
  return [...state.streamingMessages.values()].find((stream) => stream.runId === runId) || null;
}

function orderedStreamContent(stream) {
  return [...stream.chunks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, delta]) => delta)
    .join('');
}

function assistantStreamKey(event) {
  return `${event.runId}:${event.messageId || `assistant-${event.runId}`}`;
}

function findMessageElement(messageId) {
  return [...els.messages.querySelectorAll('[data-message-id]')].find((element) => element.dataset.messageId === messageId) || null;
}

function findAssistantStreamElement(key) {
  return [...els.messages.querySelectorAll('[data-stream-key]')].find((element) => element.dataset.streamKey === key) || null;
}

function removeEmptyMessage() {
  const empty = els.messages.querySelector('.empty');
  if (empty) empty.remove();
}

function scrollMessagesToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
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
    const response = await api(`/api/sessions/${encodeURIComponent(state.currentId)}/runs/${encodeURIComponent(runId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (response?.run) mergeRunEvent({ type: 'run.cancelled', sessionId: state.currentId, runId, run: response.run });
  } finally {
    els.cancelRun.disabled = !isActiveRun(state.latestRun);
  }
});

els.composer.addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = els.content.value.trim();
  if (!state.currentId || !content) return;

  els.content.value = '';
  setBusy(true);
  try {
    const response = await api(`/api/sessions/${encodeURIComponent(state.currentId)}/agent`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    if (response?.user) upsertMessage(response.user);
    if (response?.run) {
      if (state.latestRun?.id !== response.run.id) state.runEvents = [];
      state.latestRun = response.run;
      renderRun(state.latestRun, state.runEvents);
    }
  } catch (error) {
    if (error.body?.user) upsertMessage(error.body.user);
    if (error.body?.run) {
      if (state.latestRun?.id !== error.body.run.id) state.runEvents = [];
      state.latestRun = error.body.run;
      renderRun(state.latestRun, state.runEvents);
    }
    if (!error.body?.run) {
      els.runMessage.textContent = error.message;
      els.runStatus.textContent = 'error';
      els.runStatus.className = 'status-pill status-error';
    }
  } finally {
    setBusy(false);
    if (!state.eventSource && state.currentId) await loadSession(state.currentId);
  }
});

loadSessions().catch((error) => {
  els.messages.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
});
