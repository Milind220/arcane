import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { SessionStore, type AgentRun, type ArcaneArtifactFile, type ArcaneMessage, type ArcaneSession, type MessageRole } from './session-store.js';

const execFileAsync = promisify(execFile);
const SAFE_AGENT_ERROR_MESSAGE = 'The agent run failed. Open debug details.';
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

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

interface SessionPayload {
  session: ArcaneSession;
  messages: ArcaneMessage[];
  files: string[];
  artifactFiles: ArcaneArtifactFile[];
  run: AgentRun | null;
  runs: AgentRun[];
}

type ArcaneSessionEvent =
  | { type: 'message.appended'; sessionId: string; message: ArcaneMessage }
  | { type: 'run.status'; sessionId: string; run: AgentRun; status: AgentRun['status'] }
  | { type: 'artifact.changed'; sessionId: string; path: string; file?: ArcaneArtifactFile }
  | { type: 'snapshot.created'; sessionId: string; snapshotId: string };

export function createArcaneApp(
  store = new SessionStore(),
  agentBridge: AgentBridge | null = createDefaultAgentBridge(),
  options: ArcaneAppOptions = {},
): Express {
  const app = express();
  const eventBus = createSessionEventBus();

  app.use(express.json({ limit: '5mb' }));
  app.use(express.text({ type: ['text/*', 'application/javascript', 'text/css', 'text/html'], limit: '5mb' }));

  const accessToken = options.accessToken || process.env.ARCANE_ACCESS_TOKEN || '';
  app.use(async (req, res, next) => {
    try {
      if (!accessToken || (!req.path.startsWith('/api/') && !req.path.startsWith('/artifact/'))) return next();
      const supplied = req.get('x-arcane-token') || String(req.query.token || '');
      if (supplied === accessToken) return next();
      if (req.path.startsWith('/artifact/') && await hasValidArtifactCookie(store, req)) return next();
      return res.status(401).json({ error: 'unauthorized' });
    } catch (error) { next(error); }
  });

  app.get('/', sendPublicFile('index.html'));
  app.get('/app.css', sendPublicFile('app.css'));
  app.get('/app.js', sendPublicFile('app.js'));

  app.get('/api/sessions', async (_req, res, next) => {
    try { res.json(await store.listSessions()); } catch (error) { next(error); }
  });

  app.post('/api/sessions', async (req, res, next) => {
    try { res.status(201).json(await store.createSession(req.body?.title, req.body?.hermes)); } catch (error) { next(error); }
  });

  app.get('/api/sessions/:sessionId/events', async (req, res, next) => {
    try {
      const session = await store.getSession(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });

      res.status(200);
      res.setHeader('content-type', 'text/event-stream; charset=utf-8');
      res.setHeader('cache-control', 'no-cache, no-transform');
      res.setHeader('connection', 'keep-alive');
      res.write(': connected\n\n');

      const unsubscribe = eventBus.subscribe(session.id, res);
      req.on('close', unsubscribe);
    } catch (error) { next(error); }
  });

  app.get('/api/sessions/:sessionId', async (req, res, next) => {
    try {
      const payload = await buildSessionPayload(store, req.params.sessionId);
      if (!payload) return res.status(404).json({ error: 'session not found' });
      res.json(payload);
    } catch (error) { next(error); }
  });

  app.post('/api/sessions/:sessionId/artifact-access', async (req, res, next) => {
    try {
      const session = await store.getSession(req.params.sessionId);
      if (!session?.artifact?.viewToken) return res.status(404).json({ error: 'session not found' });
      setArtifactAccessCookie(req, res, session);
      res.status(204).end();
    } catch (error) { next(error); }
  });

  app.post('/api/sessions/:sessionId/messages', async (req, res, next) => {
    try {
      const role = (req.body?.role || 'user') as MessageRole;
      const content = String(req.body?.content || '');
      const message = await store.appendMessage(req.params.sessionId, role, content);
      eventBus.emit({ type: 'message.appended', sessionId: req.params.sessionId, message });
      res.status(201).json(message);
    } catch (error) { next(error); }
  });

  app.post('/api/sessions/:sessionId/agent', async (req, res, next) => {
    try {
      const session = await store.getSession(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });
      const content = String(req.body?.content || '').trim();
      if (!content) return res.status(400).json({ error: 'content is required' });

      const user = await store.appendMessage(session.id, 'user', content);
      eventBus.emit({ type: 'message.appended', sessionId: session.id, message: user });

      const queued = await store.createRun(session.id, { status: 'queued', message: 'Agent run queued.' });
      eventBus.emit({ type: 'run.status', sessionId: session.id, run: queued, status: queued.status });

      let run = await store.updateRun(session.id, queued.id, { status: 'thinking', message: 'Agent is thinking.' });
      eventBus.emit({ type: 'run.status', sessionId: session.id, run, status: run.status });

      if (!agentBridge) {
        run = await store.updateRun(session.id, run.id, {
          status: 'error',
          message: SAFE_AGENT_ERROR_MESSAGE,
          debug: { message: 'agent bridge is not configured' },
        });
        eventBus.emit({ type: 'run.status', sessionId: session.id, run, status: run.status });
        return res.status(503).json({ message: SAFE_AGENT_ERROR_MESSAGE, error: SAFE_AGENT_ERROR_MESSAGE, user, run });
      }

      try {
        const reply = await agentBridge.respond({
          sessionId: session.id,
          content,
          messages: await store.listMessages(session.id),
          files: await store.listFiles(session.id),
        });
        const assistant = await store.appendMessage(session.id, 'assistant', reply);
        eventBus.emit({ type: 'message.appended', sessionId: session.id, message: assistant });

        run = await store.updateRun(session.id, run.id, { status: 'done', message: 'Agent run completed.' });
        eventBus.emit({ type: 'run.status', sessionId: session.id, run, status: run.status });
        res.status(201).json({ user, assistant, run });
      } catch (error: any) {
        run = await store.updateRun(session.id, run.id, {
          status: 'error',
          message: SAFE_AGENT_ERROR_MESSAGE,
          debug: serializeAgentError(error),
        });
        eventBus.emit({ type: 'run.status', sessionId: session.id, run, status: run.status });
        res.status(502).json({ message: SAFE_AGENT_ERROR_MESSAGE, error: SAFE_AGENT_ERROR_MESSAGE, user, run });
      }
    } catch (error) { next(error); }
  });

  app.put('/api/sessions/:sessionId/files/*', async (req, res, next) => {
    try {
      const filePath = (req.params as Record<string, string>)[0];
      const content = typeof req.body === 'string' ? req.body : String(req.body?.content || '');
      await store.writeFile(req.params.sessionId, filePath, content);

      const payload = await buildSessionPayload(store, req.params.sessionId);
      if (!payload) return res.status(404).json({ error: 'session not found' });
      const file = payload.artifactFiles.find((artifactFile) => artifactFile.path === filePath);
      eventBus.emit({ type: 'artifact.changed', sessionId: req.params.sessionId, path: filePath, ...(file ? { file } : {}) });
      res.status(200).json({ ...payload, file: file || null });
    } catch (error) { next(error); }
  });

  app.post('/api/sessions/:sessionId/snapshots', async (req, res, next) => {
    try {
      const snapshot = await store.createSnapshot(req.params.sessionId, req.body?.summary || '');
      const payload = await buildSessionPayload(store, req.params.sessionId);
      if (!payload) return res.status(404).json({ error: 'session not found' });

      eventBus.emit({ type: 'snapshot.created', sessionId: req.params.sessionId, snapshotId: snapshot.id });
      res.status(201).json({ ...snapshot, snapshot, ...payload });
    } catch (error) { next(error); }
  });

  app.get(['/artifact/:sessionId', '/artifact/:sessionId/'], async (req, res, next) => {
    try {
      await sendArtifactFile(store, req.params.sessionId, 'index.html', req, res, accessToken);
    } catch (error) { next(error); }
  });

  app.get('/artifact/:sessionId/*', async (req, res, next) => {
    try {
      await sendArtifactFile(store, req.params.sessionId, (req.params as Record<string, string>)[0] || 'index.html', req, res, accessToken);
    } catch (error) { next(error); }
  });

  app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    res.status(400).json({ error: error.message });
  });

  return app;
}

function sendPublicFile(fileName: 'index.html' | 'app.css' | 'app.js'): express.RequestHandler {
  return async (_req, res, next) => {
    try {
      res.type(fileName).send(await readFile(path.join(PUBLIC_DIR, fileName)));
    } catch (error) {
      next(error);
    }
  };
}

async function sendArtifactFile(store: SessionStore, sessionId: string, relativePath: string, req: Request, res: Response, accessToken = ''): Promise<void> {
  const session = await store.getSession(sessionId);
  if (!session) {
    res.status(404).send('session not found');
    return;
  }

  if (accessToken && String(req.query.token || '') === accessToken) setArtifactAccessCookie(req, res, session);
  setArtifactSecurityHeaders(req, res);
  const filePath = relativePath.endsWith('/') ? `${relativePath}index.html` : relativePath;
  let artifactPath: string;
  try {
    artifactPath = resolveSafeArtifactPath(store.artifactRoot(session.id), filePath);
  } catch {
    res.status(400).send('invalid artifact path');
    return;
  }

  try {
    res.type(path.extname(artifactPath) || 'html').send(await readFile(artifactPath));
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    if (path.extname(artifactPath)) {
      res.status(404).send('artifact not found');
      return;
    }
    try {
      const htmlPath = resolveSafeArtifactPath(store.artifactRoot(session.id), `${filePath}.html`);
      res.type('html').send(await readFile(htmlPath));
    } catch (htmlError: any) {
      if (htmlError?.code !== 'ENOENT') throw htmlError;
      res.status(404).send('artifact not found');
    }
  }
}

async function hasValidArtifactCookie(store: SessionStore, req: Request): Promise<boolean> {
  const match = /^\/artifact\/([^/]+)(?:\/|$)/.exec(req.path);
  if (!match) return false;
  try {
    const session = await store.getSession(decodeURIComponent(match[1]));
    if (!session?.artifact?.viewToken) return false;
    const supplied = parseCookies(req.get('cookie') || '')[artifactCookieName(session.id)];
    return supplied === session.artifact.viewToken;
  } catch {
    return false;
  }
}

function setArtifactAccessCookie(req: Request, res: Response, session: ArcaneSession): void {
  if (!session.artifact?.viewToken) return;
  const secure = isHttpsRequest(req);
  res.cookie(artifactCookieName(session.id), session.artifact.viewToken, {
    httpOnly: true,
    sameSite: secure ? 'none' : 'lax',
    secure,
    path: `/artifact/${session.id}`,
  });
}

function isHttpsRequest(req: Request): boolean {
  return req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https';
}

function artifactCookieName(sessionId: string): string {
  return `arcane_canvas_${sessionId}`;
}

function parseCookies(header: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!key) continue;
    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }
  return cookies;
}

function setArtifactSecurityHeaders(req: Request, res: Response): void {
  const sameHostSources = artifactSameHostCspSources(req);
  res.setHeader(
    'content-security-policy',
    [
      "default-src 'none'",
      ["script-src", "'self'", "'unsafe-inline'", ...sameHostSources].join(' '),
      ["style-src", "'self'", "'unsafe-inline'", ...sameHostSources].join(' '),
      ["img-src", "'self'", ...sameHostSources, 'data:', 'blob:'].join(' '),
      ["font-src", "'self'", ...sameHostSources, 'data:'].join(' '),
      ["media-src", "'self'", ...sameHostSources, 'data:', 'blob:'].join(' '),
      "connect-src 'none'",
      "navigate-to 'none'",
      "frame-ancestors 'self'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; '),
  );
  res.setHeader('x-content-type-options', 'nosniff');
}

function artifactSameHostCspSources(req: Request): string[] {
  const host = req.get('host') || '';
  if (!/^[A-Za-z0-9.-]+(?::\d+)?$/.test(host)) return [];
  return [`http://${host}`, `https://${host}`];
}

function resolveSafeArtifactPath(root: string, relativePath: string): string {
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes('\\')) throw new Error('Invalid artifact path');
  const parts = relativePath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) throw new Error('Invalid artifact path');
  const base = path.resolve(root);
  const resolved = path.resolve(base, relativePath);
  if (!resolved.startsWith(base + path.sep) && resolved !== base) throw new Error('Invalid artifact path');
  return resolved;
}

async function buildSessionPayload(store: SessionStore, sessionId: string): Promise<SessionPayload | null> {
  const session = await store.getSession(sessionId);
  if (!session) return null;
  const runs = await store.listRuns(session.id, 5);
  return {
    session,
    messages: await store.listMessages(session.id),
    files: await store.listFiles(session.id),
    artifactFiles: await store.listArtifactFileMetadata(session.id),
    run: runs[0] || null,
    runs,
  };
}

function createSessionEventBus(): {
  subscribe: (sessionId: string, response: Response) => () => void;
  emit: (event: ArcaneSessionEvent) => void;
} {
  const clients = new Map<string, Set<Response>>();
  return {
    subscribe(sessionId, response) {
      let sessionClients = clients.get(sessionId);
      if (!sessionClients) {
        sessionClients = new Set();
        clients.set(sessionId, sessionClients);
      }
      sessionClients.add(response);
      return () => {
        sessionClients?.delete(response);
        if (sessionClients?.size === 0) clients.delete(sessionId);
      };
    },
    emit(event) {
      const sessionClients = clients.get(event.sessionId);
      if (!sessionClients?.size) return;
      const chunk = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      for (const response of [...sessionClients]) {
        if (response.writableEnded) {
          sessionClients.delete(response);
          continue;
        }
        try {
          response.write(chunk);
        } catch {
          sessionClients.delete(response);
        }
      }
    },
  };
}

function serializeAgentError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const debug: Record<string, unknown> = {
      name: error.name,
      message: error.message,
    };
    if (error.stack) debug.stack = error.stack;
    for (const key of ['code', 'signal', 'stdout', 'stderr', 'cmd', 'killed']) {
      const value = (error as unknown as Record<string, unknown>)[key];
      if (value !== undefined) debug[key] = value;
    }
    return debug;
  }

  if (typeof error === 'string') return { message: error };

  try {
    return { message: JSON.stringify(error) || String(error) };
  } catch {
    return { message: String(error) };
  }
}

export function createDefaultAgentBridge(): AgentBridge | null {
  if (process.env.ARCANE_AGENT_DISABLED === '1') return null;
  return {
    async respond({ sessionId, content, messages, files }) {
      const hermesBin = process.env.ARCANE_HERMES_BIN || 'hermes';
      const timeout = Number(process.env.ARCANE_AGENT_TIMEOUT_MS || 300000);
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
