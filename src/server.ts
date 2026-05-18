import express, { type Express } from 'express';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { SessionStore, type MessageRole } from './session-store.js';

const execFileAsync = promisify(execFile);

export interface AgentRequest {
  sessionId: string;
  content: string;
  messages: Awaited<ReturnType<SessionStore['listMessages']>>;
  files: string[];
}

export interface AgentBridge {
  respond(request: AgentRequest): Promise<string>;
}

export interface ArcaneAppOptions {
  accessToken?: string;
}

const STATIC_INDEX = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Arcane</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #080712; color: #f7f2ff; }
      * { box-sizing: border-box; }
      body { margin: 0; height: 100vh; overflow: hidden; }
      header { height: 48px; display: flex; gap: 12px; align-items: center; padding: 0 16px; border-bottom: 1px solid #26213b; background: #100e1d; }
      header strong { color: #d8b4fe; }
      button, input, textarea, select { font: inherit; }
      button { border: 1px solid #7c3aed; background: #6d28d9; color: white; border-radius: 10px; padding: 8px 12px; cursor: pointer; }
      button.secondary { background: #17142a; border-color: #3b315b; }
      main { height: calc(100vh - 48px); display: grid; grid-template-columns: 340px 1fr; }
      aside { border-right: 1px solid #26213b; background: #0d0b18; display: grid; grid-template-rows: auto 1fr auto; min-width: 0; }
      .sessions { display: flex; gap: 8px; padding: 10px; border-bottom: 1px solid #26213b; }
      select { min-width: 0; flex: 1; border: 1px solid #3b315b; background: #17142a; color: #f7f2ff; border-radius: 10px; padding: 8px; }
      .messages { padding: 12px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
      .message { border: 1px solid #2d2647; background: #151225; border-radius: 14px; padding: 10px; white-space: pre-wrap; }
      .message.user { border-color: #7c3aed; }
      .message.pending { opacity: 0.72; border-style: dashed; }
      .message.error { border-color: #ef4444; color: #fecaca; }
      .composer { padding: 10px; border-top: 1px solid #26213b; display: grid; gap: 8px; }
      .composer button[disabled] { opacity: 0.55; cursor: wait; }
      textarea { resize: none; height: 92px; border: 1px solid #3b315b; background: #17142a; color: #f7f2ff; border-radius: 12px; padding: 10px; }
      iframe { width: 100%; height: 100%; border: 0; background: white; }
      .empty { color: #a78bfa; padding: 12px; }
      @media (max-width: 760px) {
        body { overflow: auto; }
        main { height: auto; min-height: calc(100vh - 48px); grid-template-columns: 1fr; grid-template-rows: minmax(56vh, auto) 44vh; }
        aside { border-right: 0; border-bottom: 1px solid #26213b; min-height: 56vh; }
      }
    </style>
  </head>
  <body>
    <header><strong>Arcane</strong><span>chat + canvas, no circus.</span><button id="snapshot" class="secondary">Snapshot</button></header>
    <main>
      <aside>
        <div class="sessions"><select id="sessions"></select><button id="new">New</button></div>
        <div id="messages" class="messages"><p class="empty">Pick or create a session.</p></div>
        <form id="composer" class="composer"><textarea id="content" placeholder="Message the agent..."></textarea><button>Send</button></form>
      </aside>
      <iframe id="artifact" title="Arcane canvas"></iframe>
    </main>
    <script>
      let currentId = null;
      const accessToken = new URLSearchParams(location.search).get('token') || '';
      const sessionsEl = document.querySelector('#sessions');
      const messagesEl = document.querySelector('#messages');
      const artifactEl = document.querySelector('#artifact');
      const contentEl = document.querySelector('#content');
      const sendButton = document.querySelector('#composer button');

      async function api(path, options = {}) {
        const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
        if (accessToken) headers['x-arcane-token'] = accessToken;
        const res = await fetch(path, { ...options, headers });
        if (!res.ok) throw new Error(await res.text());
        if (res.status === 204) return null;
        return res.json();
      }

      async function loadSessions(selectId) {
        const sessions = await api('/api/sessions');
        sessionsEl.innerHTML = sessions.map(s => '<option value="' + s.id + '">' + escapeHtml(s.title) + '</option>').join('');
        if (sessions.length) await loadSession(selectId || sessions[0].id);
      }

      async function loadSession(id) {
        currentId = id;
        sessionsEl.value = id;
        const data = await api('/api/sessions/' + id);
        messagesEl.innerHTML = data.messages.length ? data.messages.map(renderMessage).join('') : '<p class="empty">No messages yet. Start the spell.</p>';
        messagesEl.scrollTop = messagesEl.scrollHeight;
        const tokenParam = accessToken ? '&token=' + encodeURIComponent(accessToken) : '';
        artifactEl.src = '/artifact/' + id + '/index.html?t=' + Date.now() + tokenParam;
      }

      function renderMessage(m) {
        const classes = ['message', m.role, m.pending ? 'pending' : '', m.error ? 'error' : ''].filter(Boolean).join(' ');
        return '<div class="' + classes + '"><strong>' + escapeHtml(m.role) + '</strong><br>' + escapeHtml(m.content) + '</div>';
      }

      function setBusy(isBusy) {
        sendButton.disabled = isBusy;
        contentEl.disabled = isBusy;
        sendButton.textContent = isBusy ? 'Thinking…' : 'Send';
      }

      function appendTransient(message) {
        if (messagesEl.querySelector('.empty')) messagesEl.innerHTML = '';
        messagesEl.insertAdjacentHTML('beforeend', renderMessage(message));
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }

      function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      }

      sessionsEl.addEventListener('change', () => loadSession(sessionsEl.value));
      document.querySelector('#new').addEventListener('click', async () => {
        const title = prompt('Session title?', 'Untitled session') || 'Untitled session';
        const session = await api('/api/sessions', { method: 'POST', body: JSON.stringify({ title }) });
        await loadSessions(session.id);
      });
      document.querySelector('#snapshot').addEventListener('click', async () => {
        if (!currentId) return;
        await api('/api/sessions/' + currentId + '/snapshots', { method: 'POST', body: JSON.stringify({ summary: 'manual snapshot' }) });
        alert('Snapshot saved. Tiny time machine acquired.');
      });
      document.querySelector('#composer').addEventListener('submit', async (event) => {
        event.preventDefault();
        const content = contentEl.value.trim();
        if (!currentId || !content) return;
        contentEl.value = '';
        appendTransient({ role: 'user', content, pending: true });
        appendTransient({ role: 'assistant', content: 'Thinking…', pending: true });
        setBusy(true);
        try {
          const response = await fetch('/api/sessions/' + currentId + '/agent', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(accessToken ? { 'x-arcane-token': accessToken } : {}) },
            body: JSON.stringify({ content }),
          });
          if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            if (!body.assistant) throw new Error(body.error || 'Agent request failed');
          }
        } catch (error) {
          appendTransient({ role: 'assistant', content: 'Error: ' + error.message, error: true });
        } finally {
          setBusy(false);
          await loadSession(currentId);
        }
      });

      loadSessions();
    </script>
  </body>
</html>`;

export function createArcaneApp(
  store = new SessionStore(),
  agentBridge: AgentBridge | null = createDefaultAgentBridge(),
  options: ArcaneAppOptions = {},
): Express {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use(express.text({ type: ['text/*', 'application/javascript', 'text/css', 'text/html'], limit: '5mb' }));

  const accessToken = options.accessToken || process.env.ARCANE_ACCESS_TOKEN || '';
  app.use((req, res, next) => {
    if (!accessToken || (!req.path.startsWith('/api/') && !req.path.startsWith('/artifact/'))) return next();
    const supplied = req.get('x-arcane-token') || String(req.query.token || '');
    if (supplied === accessToken) return next();
    return res.status(401).json({ error: 'unauthorized' });
  });

  app.get('/', (_req, res) => res.type('html').send(STATIC_INDEX));

  app.get('/api/sessions', async (_req, res, next) => {
    try { res.json(await store.listSessions()); } catch (error) { next(error); }
  });

  app.post('/api/sessions', async (req, res, next) => {
    try { res.status(201).json(await store.createSession(req.body?.title)); } catch (error) { next(error); }
  });

  app.get('/api/sessions/:sessionId', async (req, res, next) => {
    try {
      const session = await store.getSession(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });
      res.json({ session, messages: await store.listMessages(session.id), files: await store.listFiles(session.id) });
    } catch (error) { next(error); }
  });

  app.post('/api/sessions/:sessionId/messages', async (req, res, next) => {
    try {
      const role = (req.body?.role || 'user') as MessageRole;
      const content = String(req.body?.content || '');
      const message = await store.appendMessage(req.params.sessionId, role, content);
      res.status(201).json(message);
    } catch (error) { next(error); }
  });

  app.post('/api/sessions/:sessionId/agent', async (req, res, next) => {
    try {
      if (!agentBridge) return res.status(503).json({ error: 'agent bridge is not configured' });
      const session = await store.getSession(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });
      const content = String(req.body?.content || '').trim();
      if (!content) return res.status(400).json({ error: 'content is required' });

      const user = await store.appendMessage(session.id, 'user', content);
      try {
        const reply = await agentBridge.respond({
          sessionId: session.id,
          content,
          messages: await store.listMessages(session.id),
          files: await store.listFiles(session.id),
        });
        const assistant = await store.appendMessage(session.id, 'assistant', reply);
        res.status(201).json({ user, assistant });
      } catch (error: any) {
        const assistant = await store.appendMessage(
          session.id,
          'assistant',
          `Agent bridge failed: ${error?.message || String(error)}`,
        );
        res.status(502).json({ user, assistant, error: assistant.content });
      }
    } catch (error) { next(error); }
  });

  app.put('/api/sessions/:sessionId/files/*', async (req, res, next) => {
    try {
      const filePath = (req.params as Record<string, string>)[0];
      const content = typeof req.body === 'string' ? req.body : String(req.body?.content || '');
      await store.writeFile(req.params.sessionId, filePath, content);
      res.status(204).end();
    } catch (error) { next(error); }
  });

  app.post('/api/sessions/:sessionId/snapshots', async (req, res, next) => {
    try { res.status(201).json(await store.createSnapshot(req.params.sessionId, req.body?.summary || '')); } catch (error) { next(error); }
  });

  app.use('/artifact/:sessionId', async (req, res, next) => {
    try {
      const session = await store.getSession(req.params.sessionId);
      if (!session) return res.status(404).send('session not found');
      express.static(store.artifactRoot(session.id), { extensions: ['html'] })(req, res, next);
    } catch (error) { next(error); }
  });

  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(400).json({ error: error.message });
  });

  return app;
}

export function createDefaultAgentBridge(): AgentBridge | null {
  if (process.env.ARCANE_AGENT_DISABLED === '1') return null;
  return {
    async respond({ sessionId, content, messages, files }) {
      const hermesBin = process.env.ARCANE_HERMES_BIN || 'hermes';
      const timeout = Number(process.env.ARCANE_AGENT_TIMEOUT_MS || 120000);
      const prompt = [
        `You are responding inside Arcane session ${sessionId}.`,
        'Arcane is a local chat+canvas app. If Arcane MCP tools are available, use them to update the session artifact files before replying.',
        'When writing artifact HTML, link CSS/JS with relative paths like styles.css and script.js. Never use /styles.css or /script.js because artifacts are served under /artifact/<sessionId>/.',
        `Relevant artifact files: ${files.join(', ') || '(none)'}.`,
        'Keep the final reply short and say what changed.',
        '',
        'Recent messages:',
        ...messages.slice(-12).map((message) => `${message.role}: ${message.content}`),
        '',
        `Latest user request: ${content}`,
      ].join('\n');

      const { stdout, stderr } = await execFileAsync(hermesBin, ['chat', '--quiet', '-q', prompt], {
        timeout,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, ARCANE_SESSION_ID: sessionId },
      });
      const text = stdout.trim() || stderr.trim();
      if (!text) throw new Error('agent returned no response');
      return text;
    },
  };
}

export async function main(): Promise<void> {
  const port = Number(process.env.PORT || 8787);
  const store = new SessionStore(process.env.ARCANE_HOME || path.join(process.cwd(), '.arcane'));
  const app = createArcaneApp(store);
  app.listen(port, () => {
    console.log(`Arcane running: http://127.0.0.1:${port}`);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
