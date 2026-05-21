import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { execFile, spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { ArcaneArtifactService } from './artifact-service.js';
import { type ArcaneRunEvent, type ArcaneSessionEvent } from './arcane-events.js';
import {
  SessionStore,
  type AgentRun,
  type AgentRunStatus,
  type ArcaneArtifactFile,
  type ArcaneMessage,
  type ArcaneMessagePart,
  type ArcaneSession,
  type MessageRole,
} from './session-store.js';

const execFileAsync = promisify(execFile);
const SAFE_AGENT_ERROR_MESSAGE = 'The agent run failed. Open debug details.';
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export interface AgentRequest {
  sessionId: string;
  runId: string;
  content: string;
  messages: Awaited<ReturnType<SessionStore['listMessages']>>;
  files: string[];
  emit: (event: AgentBridgeRunEventInput) => Promise<void> | void;
  signal: AbortSignal;
}

export type AgentBridgeRunEventInput = ArcaneRunEvent | { type: string; [key: string]: unknown };

export interface AgentBridgeResult {
  finalMessage?: string;
}

export interface AgentBridge {
  respond(request: AgentRequest): Promise<string | AgentBridgeResult | void>;
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
  runEvents: ArcaneRunEvent[];
}

export function createArcaneApp(
  store = new SessionStore(),
  agentBridge: AgentBridge | null = createDefaultAgentBridge(),
  options: ArcaneAppOptions = {},
): Express {
  const app = express();
  const eventBus = createSessionEventBus();
  const artifactService = new ArcaneArtifactService(store, (event) => eventBus.emit(event));
  const activeRuns = new Map<string, ActiveRun>();

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
      const message = await store.appendMessage(req.params.sessionId, role, content, {
        ...(req.body?.runId ? { runId: String(req.body.runId) } : {}),
        ...(req.body?.toolCallId ? { toolCallId: String(req.body.toolCallId) } : {}),
        ...(Array.isArray(req.body?.parts) ? { parts: req.body.parts as ArcaneMessagePart[] } : {}),
      });
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
      await persistRunEvent(store, eventBus, {
        type: 'run.created',
        sessionId: session.id,
        runId: queued.id,
        status: 'queued',
        message: queued.message,
        createdAt: queued.createdAt,
        run: queued,
      });

      if (!agentBridge) {
        const run = await store.updateRun(session.id, queued.id, {
          status: 'error',
          message: SAFE_AGENT_ERROR_MESSAGE,
          debug: { message: 'agent bridge is not configured' },
        });
        await persistRunEvent(store, eventBus, {
          type: 'run.error',
          sessionId: session.id,
          runId: run.id,
          message: run.message,
          debug: run.debug,
          updatedAt: run.updatedAt,
          run,
        });
        return res.status(503).json({ message: SAFE_AGENT_ERROR_MESSAGE, error: SAFE_AGENT_ERROR_MESSAGE, user, run });
      }

      const controller = new AbortController();
      const activeRun: ActiveRun = { controller, terminal: false, assistantFinal: false };
      activeRuns.set(activeRunKey(session.id, queued.id), activeRun);

      const run = await store.updateRun(session.id, queued.id, { status: 'thinking', message: 'Agent is thinking.' });
      await persistRunEvent(store, eventBus, {
        type: 'run.status',
        sessionId: session.id,
        runId: run.id,
        status: run.status,
        message: run.message,
        updatedAt: run.updatedAt,
        run,
      });

      void executeAgentRun({
        store,
        eventBus,
        agentBridge,
        activeRuns,
        activeRun,
        sessionId: session.id,
        runId: run.id,
        content,
      });

      res.status(202).json({ user, run });
    } catch (error) { next(error); }
  });

  app.get('/api/sessions/:sessionId/runs/:runId/events', async (req, res, next) => {
    try {
      const session = await store.getSession(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });
      res.json(await store.listRunEvents(session.id, req.params.runId));
    } catch (error) { next(error); }
  });

  app.post('/api/sessions/:sessionId/runs/:runId/cancel', async (req, res, next) => {
    try {
      const session = await store.getSession(req.params.sessionId);
      if (!session) return res.status(404).json({ error: 'session not found' });

      const key = activeRunKey(session.id, req.params.runId);
      const activeRun = activeRuns.get(key);
      if (activeRun) activeRun.terminal = true;
      if (activeRun && !activeRun.controller.signal.aborted) activeRun.controller.abort();

      const run = await store.updateRun(session.id, req.params.runId, { status: 'cancelled', message: 'Agent run cancelled.' });
      await persistRunEvent(store, eventBus, {
        type: 'run.cancelled',
        sessionId: session.id,
        runId: run.id,
        message: run.message,
        updatedAt: run.updatedAt,
        run,
      });

      res.status(202).json({ run });
    } catch (error) { next(error); }
  });

  app.put('/api/sessions/:sessionId/files/*', async (req, res, next) => {
    try {
      const filePath = (req.params as Record<string, string>)[0];
      const content = typeof req.body === 'string' ? req.body : String(req.body?.content || '');
      const file = await artifactService.writeFile(req.params.sessionId, filePath, content);

      const payload = await buildSessionPayload(store, req.params.sessionId);
      if (!payload) return res.status(404).json({ error: 'session not found' });
      res.status(200).json({ ...payload, file: file || null });
    } catch (error) { next(error); }
  });

  app.post('/api/sessions/:sessionId/snapshots', async (req, res, next) => {
    try {
      const snapshot = await artifactService.createSnapshot(req.params.sessionId, req.body?.summary || '');
      const payload = await buildSessionPayload(store, req.params.sessionId);
      if (!payload) return res.status(404).json({ error: 'session not found' });

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
  const run = runs[0] || null;
  return {
    session,
    messages: await store.listMessages(session.id),
    files: await store.listFiles(session.id),
    artifactFiles: await store.listArtifactFileMetadata(session.id),
    run,
    runs,
    runEvents: run ? await store.listRunEvents(session.id, run.id) : [],
  };
}

interface ActiveRun {
  controller: AbortController;
  terminal: boolean;
  assistantFinal: boolean;
}

interface ExecuteAgentRunInput {
  store: SessionStore;
  eventBus: ReturnType<typeof createSessionEventBus>;
  agentBridge: AgentBridge;
  activeRuns: Map<string, ActiveRun>;
  activeRun: ActiveRun;
  sessionId: string;
  runId: string;
  content: string;
}

async function executeAgentRun(input: ExecuteAgentRunInput): Promise<void> {
  const { store, eventBus, agentBridge, activeRuns, activeRun, sessionId, runId, content } = input;
  const key = activeRunKey(sessionId, runId);

  try {
    const messages = await store.listMessages(sessionId);
    const files = await store.listFiles(sessionId);
    if (activeRun.terminal || activeRun.controller.signal.aborted) return;

    const result = await agentBridge.respond({
      sessionId,
      runId,
      content,
      messages,
      files,
      signal: activeRun.controller.signal,
      emit: async (event) => {
        if (activeRun.terminal) return;
        await ingestBridgeRunEvent(store, eventBus, activeRun, sessionId, runId, event);
      },
    });

    if (activeRun.controller.signal.aborted) return;

    const finalMessage = bridgeFinalMessage(result);
    if (finalMessage !== undefined && !activeRun.assistantFinal) {
      await appendAssistantMessageEvent(store, eventBus, activeRun, sessionId, runId, finalMessage);
    }

    if (!activeRun.terminal) {
      const run = await store.updateRun(sessionId, runId, { status: 'done', message: 'Agent run completed.' });
      activeRun.terminal = true;
      await persistRunEvent(store, eventBus, {
        type: 'run.done',
        sessionId,
        runId,
        updatedAt: run.updatedAt,
        run,
      });
    }
  } catch (error) {
    if (activeRun.terminal) return;

    if (activeRun.controller.signal.aborted || isAbortError(error)) {
      const run = await store.updateRun(sessionId, runId, { status: 'cancelled', message: 'Agent run cancelled.' });
      activeRun.terminal = true;
      await persistRunEvent(store, eventBus, {
        type: 'run.cancelled',
        sessionId,
        runId,
        message: run.message,
        updatedAt: run.updatedAt,
        run,
      });
      return;
    }

    const run = await store.updateRun(sessionId, runId, {
      status: 'error',
      message: SAFE_AGENT_ERROR_MESSAGE,
      debug: serializeAgentError(error),
    });
    activeRun.terminal = true;
    await persistRunEvent(store, eventBus, {
      type: 'run.error',
      sessionId,
      runId,
      message: run.message,
      debug: run.debug,
      updatedAt: run.updatedAt,
      run,
    });
  } finally {
    activeRuns.delete(key);
  }
}

async function ingestBridgeRunEvent(
  store: SessionStore,
  eventBus: ReturnType<typeof createSessionEventBus>,
  activeRun: ActiveRun,
  sessionId: string,
  runId: string,
  input: AgentBridgeRunEventInput,
): Promise<void> {
  const record = asRecord(input);
  if (!record.type) throw new Error('Agent bridge event is missing type');

  if (record.type === 'assistant.message') {
    const messageRecord = asRecord(record.message);
    const content = typeof messageRecord.content === 'string' ? messageRecord.content : String(record.content ?? '');
    const parts = Array.isArray(messageRecord.parts)
      ? (messageRecord.parts as ArcaneMessagePart[])
      : Array.isArray(record.parts)
        ? (record.parts as ArcaneMessagePart[])
        : undefined;
    const toolCallId = typeof messageRecord.toolCallId === 'string'
      ? messageRecord.toolCallId
      : typeof record.toolCallId === 'string'
        ? record.toolCallId
        : undefined;
    await appendAssistantMessageEvent(store, eventBus, activeRun, sessionId, runId, content, { parts, toolCallId });
    return;
  }

  let event = normalizeRunEventInput(record, sessionId, runId);

  if (event.type === 'run.status') {
    const run = await store.updateRun(sessionId, runId, { status: event.status, message: event.message });
    event = { ...event, status: run.status, message: run.message, updatedAt: run.updatedAt, run };
  }

  if (event.type === 'run.done') {
    const run = await store.updateRun(sessionId, runId, { status: 'done', message: 'Agent run completed.' });
    activeRun.terminal = true;
    event = { ...event, updatedAt: run.updatedAt, run };
  }

  if (event.type === 'run.error') {
    const run = await store.updateRun(sessionId, runId, {
      status: 'error',
      message: event.message || SAFE_AGENT_ERROR_MESSAGE,
      ...(event.debug !== undefined ? { debug: asDebugRecord(event.debug) } : {}),
    });
    activeRun.terminal = true;
    event = { ...event, message: run.message, debug: run.debug, updatedAt: run.updatedAt, run };
  }

  if (event.type === 'run.cancelled') {
    const run = await store.updateRun(sessionId, runId, { status: 'cancelled', message: event.message || 'Agent run cancelled.' });
    activeRun.terminal = true;
    event = { ...event, message: run.message, updatedAt: run.updatedAt, run };
  }

  await persistRunEvent(store, eventBus, event);

  if (event.type === 'tool.call.completed') {
    const message = await store.appendToolMessage(sessionId, runId, event.toolCallId, event.name, {
      ok: true,
      preview: event.resultPreview,
      ...(event.resultJson !== undefined ? { resultJson: event.resultJson } : {}),
    });
    eventBus.emit({ type: 'message.appended', sessionId, message });
  }

  if (event.type === 'tool.call.failed') {
    const message = await store.appendToolMessage(sessionId, runId, event.toolCallId, event.name, {
      ok: false,
      preview: event.error,
    });
    eventBus.emit({ type: 'message.appended', sessionId, message });
  }
}

async function appendAssistantMessageEvent(
  store: SessionStore,
  eventBus: ReturnType<typeof createSessionEventBus>,
  activeRun: ActiveRun,
  sessionId: string,
  runId: string,
  content: string,
  options: { parts?: ArcaneMessagePart[]; toolCallId?: string } = {},
): Promise<ArcaneMessage> {
  const message = await store.appendMessage(sessionId, 'assistant', content, {
    runId,
    ...(options.parts ? { parts: options.parts } : {}),
    ...(options.toolCallId ? { toolCallId: options.toolCallId } : {}),
  });
  activeRun.assistantFinal = true;
  const event: ArcaneRunEvent = { type: 'assistant.message', sessionId, runId, message, createdAt: message.createdAt };
  await persistRunEvent(store, eventBus, event);
  eventBus.emit({ type: 'message.appended', sessionId, message });
  return message;
}

async function persistRunEvent(
  store: SessionStore,
  eventBus: ReturnType<typeof createSessionEventBus>,
  event: ArcaneRunEvent,
): Promise<ArcaneRunEvent> {
  await store.appendRunEvent(event.sessionId, event.runId, event);
  eventBus.emit(event);
  return event;
}

function normalizeRunEventInput(record: Record<string, unknown>, sessionId: string, runId: string): ArcaneRunEvent {
  const now = new Date().toISOString();
  const type = String(record.type);

  switch (type) {
    case 'run.created':
      return {
        type,
        sessionId,
        runId,
        status: 'queued',
        message: stringOr(record.message, 'Agent run queued.'),
        createdAt: stringOr(record.createdAt, now),
      };
    case 'run.status':
      return {
        type,
        sessionId,
        runId,
        status: isAgentRunStatus(record.status) ? record.status : 'thinking',
        message: stringOr(record.message, 'Agent is thinking.'),
        updatedAt: stringOr(record.updatedAt, now),
      };
    case 'assistant.delta':
      return {
        type,
        sessionId,
        runId,
        messageId: stringOr(record.messageId, `assistant-${runId}`),
        delta: String(record.delta ?? ''),
        index: Number.isFinite(Number(record.index)) ? Number(record.index) : 0,
        createdAt: stringOr(record.createdAt, now),
      };
    case 'tool.call.started':
      return {
        type,
        sessionId,
        runId,
        toolCallId: stringOr(record.toolCallId, randomToolCallId()),
        name: stringOr(record.name, 'tool'),
        args: record.args ?? record.arguments ?? {},
        createdAt: stringOr(record.createdAt, now),
      };
    case 'tool.call.updated':
      return {
        type,
        sessionId,
        runId,
        toolCallId: stringOr(record.toolCallId, randomToolCallId()),
        ...(typeof record.name === 'string' ? { name: record.name } : {}),
        patch: record.patch ?? {},
        updatedAt: stringOr(record.updatedAt, now),
      };
    case 'tool.call.completed':
      return {
        type,
        sessionId,
        runId,
        toolCallId: stringOr(record.toolCallId, randomToolCallId()),
        name: stringOr(record.name, 'tool'),
        ok: true,
        resultPreview: stringOr(record.resultPreview, previewValue(record.resultJson ?? record.result ?? '')),
        ...(record.resultJson !== undefined ? { resultJson: record.resultJson } : record.result !== undefined ? { resultJson: record.result } : {}),
        completedAt: stringOr(record.completedAt, now),
      };
    case 'tool.call.failed':
      return {
        type,
        sessionId,
        runId,
        toolCallId: stringOr(record.toolCallId, randomToolCallId()),
        name: stringOr(record.name, 'tool'),
        ok: false,
        error: stringOr(record.error, 'Tool call failed.'),
        ...(record.debug !== undefined ? { debug: record.debug } : {}),
        completedAt: stringOr(record.completedAt, now),
      };
    case 'run.error':
      return {
        type,
        sessionId,
        runId,
        message: stringOr(record.message, SAFE_AGENT_ERROR_MESSAGE),
        ...(record.debug !== undefined ? { debug: record.debug } : {}),
        updatedAt: stringOr(record.updatedAt, now),
      };
    case 'run.done':
      return { type, sessionId, runId, updatedAt: stringOr(record.updatedAt, now) };
    case 'run.cancelled':
      return {
        type,
        sessionId,
        runId,
        message: stringOr(record.message, 'Agent run cancelled.'),
        updatedAt: stringOr(record.updatedAt, now),
      };
    default:
      throw new Error(`Unknown agent bridge event type: ${type}`);
  }
}

function bridgeFinalMessage(result: string | AgentBridgeResult | void): string | undefined {
  if (typeof result === 'string') return result;
  if (result && typeof result.finalMessage === 'string') return result.finalMessage;
  return undefined;
}

function activeRunKey(sessionId: string, runId: string): string {
  return `${sessionId}:${runId}`;
}

function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return value === 'queued' || value === 'thinking' || value === 'editing' || value === 'done' || value === 'error' || value === 'cancelled';
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message.toLowerCase().includes('aborted'));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asDebugRecord(value: unknown): Record<string, unknown> {
  return asRecord(value) === value ? (value as Record<string, unknown>) : { value };
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function previewValue(value: unknown, limit = 500): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function randomToolCallId(): string {
  return `tool-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
  if (process.env.ARCANE_AGENT_DISABLED === '1' || process.env.ARCANE_HERMES_MODE === 'disabled') return null;
  const mode = String(process.env.ARCANE_HERMES_MODE || (process.env.ARCANE_HERMES_EVENT_BRIDGE ? 'event-stream' : 'subprocess')).toLowerCase();

  if (mode === 'event-stream' || mode === 'platform') {
    return { respond: runEventStreamBridge };
  }

  if (mode !== 'subprocess') {
    return {
      async respond() {
        throw new Error(`Unsupported ARCANE_HERMES_MODE: ${mode}`);
      },
    };
  }

  return {
    async respond(request) {
      return runSubprocessBridge(request);
    },
  };
}

async function runSubprocessBridge({ sessionId, content, messages, files, signal }: AgentRequest): Promise<AgentBridgeResult> {
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
        signal,
        env: { ...process.env, ARCANE_SESSION_ID: sessionId },
      });
      const text = stdout.trim() || stderr.trim();
      if (!text) throw new Error('agent returned no response');
      return { finalMessage: text };
}

async function runEventStreamBridge(request: AgentRequest): Promise<AgentBridgeResult> {
  const command = process.env.ARCANE_HERMES_EVENT_BRIDGE;
  if (!command) throw new Error('ARCANE_HERMES_EVENT_BRIDGE is required when ARCANE_HERMES_MODE=event-stream');

  const child = spawn(command, {
    shell: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ARCANE_SESSION_ID: request.sessionId,
      ARCANE_RUN_ID: request.runId,
    },
  });

  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-4096);
  });

  const abort = () => {
    if (!child.killed) child.kill('SIGTERM');
  };
  request.signal.addEventListener('abort', abort, { once: true });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const outputTask = (async () => {
    for await (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      await request.emit(JSON.parse(trimmed) as AgentBridgeRunEventInput);
    }
  })();

  const exitTask = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signalName) => resolve({ code, signal: signalName }));
  });

  child.stdin?.end(`${JSON.stringify({
    sessionId: request.sessionId,
    runId: request.runId,
    content: request.content,
    messages: request.messages,
    files: request.files,
  })}\n`);

  try {
    const [exit] = await Promise.all([exitTask, outputTask.then(() => undefined)]);
    if (request.signal.aborted) throw createAbortError();
    if (exit.code !== 0) {
      const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
      throw new Error(`Hermes event bridge exited with code ${exit.code ?? exit.signal}${detail}`);
    }
    return {};
  } catch (error) {
    if (!child.killed) child.kill('SIGTERM');
    throw error;
  } finally {
    request.signal.removeEventListener('abort', abort);
    lines.close();
  }
}

function createAbortError(): Error {
  const error = new Error('Agent run cancelled.');
  error.name = 'AbortError';
  return error;
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
