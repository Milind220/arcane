import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import request from 'supertest';
import { createArcaneApp, createDefaultAgentBridge } from '../src/server.js';
import { SessionStore } from '../src/session-store.js';

describe('Arcane web server', () => {
  it('serves the browser shell from static public assets', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-http-static-'));
    const store = new SessionStore(root);
    const app = createArcaneApp(store, null);

    const html = await request(app).get('/').expect(200);
    await request(app).get('/app.css').expect(200);
    await request(app).get('/app.js').expect(200);

    expect(html.text).toContain('href="/app.css"');
    expect(html.text).toContain('src="/app.js"');
    expect(html.text).toContain('sandbox="allow-scripts allow-forms"');
    expect(html.text).toContain('referrerpolicy="no-referrer"');
  });

  it('creates, resumes, and renders a session artifact', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-http-'));
    const store = new SessionStore(root);
    const app = createArcaneApp(store);

    const created = await request(app).post('/api/sessions').send({ title: 'Demo' }).expect(201);
    const sessionId = created.body.id;

    await request(app).post(`/api/sessions/${sessionId}/messages`).send({ role: 'user', content: 'draw it' }).expect(201);
    await request(app).put(`/api/sessions/${sessionId}/files/index.html`).send({ content: '<h1>Visual plan</h1>' }).expect(200);

    const resumed = await request(app).get(`/api/sessions/${sessionId}`).expect(200);
    const artifact = await request(app).get(`/artifact/${sessionId}/index.html`).expect(200);

    expect(resumed.body.session.title).toBe('Demo');
    expect(resumed.body.session.artifact).toMatchObject({ entrypoint: 'index.html' });
    expect(resumed.body.session.artifact.viewToken).toEqual(expect.any(String));
    expect(resumed.body.artifactFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'index.html', size: expect.any(Number), modifiedAt: expect.any(String) }),
      ]),
    );
    expect(Date.parse(resumed.body.artifactFiles.find((file: any) => file.path === 'index.html').modifiedAt)).not.toBeNaN();
    expect(resumed.body.messages[0].content).toBe('draw it');
    expect(artifact.text).toContain('Visual plan');
  });

  it('updates artifact metadata and returns file state after writes', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-http-files-'));
    const store = new SessionStore(root);
    const app = createArcaneApp(store, null);

    const created = await request(app).post('/api/sessions').send({ title: 'Files' }).expect(201);
    const sessionId = created.body.id;

    const written = await request(app)
      .put(`/api/sessions/${sessionId}/files/nested/panel.html`)
      .set('content-type', 'text/html')
      .send('<section>Panel</section>')
      .expect(200);

    const resumed = await request(app).get(`/api/sessions/${sessionId}`).expect(200);

    expect(written.body.file).toMatchObject({
      path: 'nested/panel.html',
      size: Buffer.byteLength('<section>Panel</section>'),
      modifiedAt: expect.any(String),
    });
    expect(written.body.files).toContain('nested/panel.html');
    expect(written.body.artifactFiles.map((file: any) => file.path)).toEqual([...written.body.files].sort());
    expect(resumed.body.session.artifact.files).toContain('nested/panel.html');
    expect(resumed.body.artifactFiles).toContainEqual(written.body.file);
  });

  it('creates snapshots and returns enough state to refresh the browser', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-http-snapshots-'));
    const store = new SessionStore(root);
    const app = createArcaneApp(store, null);

    const created = await request(app).post('/api/sessions').send({ title: 'Snapshots' }).expect(201);
    const sessionId = created.body.id;
    await request(app).put(`/api/sessions/${sessionId}/files/styles.css`).send({ content: 'body { color: red; }' }).expect(200);

    const snapshot = await request(app)
      .post(`/api/sessions/${sessionId}/snapshots`)
      .send({ summary: 'red mode' })
      .expect(201);

    expect(snapshot.body).toMatchObject({
      summary: 'red mode',
      session: { id: sessionId, artifact: { lastSnapshotId: snapshot.body.id } },
    });
    expect(snapshot.body.artifactFiles).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: 'styles.css', size: Buffer.byteLength('body { color: red; }') })]),
    );
    expect(await store.readSnapshotFile(sessionId, snapshot.body.id, 'styles.css')).toContain('color: red');
  });

  it('accepts Hermes metadata when creating a session', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-http-'));
    const store = new SessionStore(root);
    const app = createArcaneApp(store);

    const created = await request(app)
      .post('/api/sessions')
      .send({
        title: 'Linked',
        hermes: {
          profile: 'default',
          sessionId: 'hermes-session',
          source: 'arcane',
          origin: 'cli',
          originThread: null,
        },
      })
      .expect(201);

    expect(created.body.hermes).toEqual({
      profile: 'default',
      sessionId: 'hermes-session',
      source: 'arcane',
      origin: 'cli',
      originThread: null,
    });
  });

  it('bridges a user message to an agent responder and stores the assistant reply', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-agent-'));
    const store = new SessionStore(root);
    const app = createArcaneApp(store, {
      respond: async ({ sessionId, content }) => `session=${sessionId} heard=${content}`,
    });

    const created = await request(app).post('/api/sessions').send({ title: 'Agent demo' }).expect(201);
    const sessionId = created.body.id;

    const response = await request(app)
      .post(`/api/sessions/${sessionId}/agent`)
      .send({ content: 'make a tiny dashboard' })
      .expect(202);
    await waitForRunStatus(store, sessionId, response.body.run.id, 'done');
    const resumed = await request(app).get(`/api/sessions/${sessionId}`).expect(200);

    expect(response.body.assistant).toBeUndefined();
    expect(response.body.run).toMatchObject({ sessionId, status: 'thinking' });
    expect(resumed.body.run).toMatchObject({ id: response.body.run.id, status: 'done' });
    expect(resumed.body.runs[0]).toMatchObject({ id: response.body.run.id, status: 'done' });
    expect(resumed.body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(resumed.body.messages[1].content).toContain(`session=${sessionId}`);
    expect(resumed.body.messages[1].content).toContain('heard=make a tiny dashboard');
    expect(resumed.body.runEvents.map((event: any) => event.type)).toEqual(
      expect.arrayContaining(['run.created', 'run.status', 'assistant.message', 'run.done']),
    );
  });

  it('persists and broadcasts structured bridge events with tool messages', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-agent-structured-'));
    const store = new SessionStore(root);
    const app = createArcaneApp(store, {
      respond: async ({ runId, sessionId, emit }) => {
        await emit({ type: 'assistant.delta', sessionId, runId, messageId: 'msg-1', delta: 'Checking ', index: 0, createdAt: new Date().toISOString() });
        await emit({ type: 'tool.call.started', sessionId, runId, toolCallId: 'tool-1', name: 'arcane_read_file', args: { path: 'index.html' }, createdAt: new Date().toISOString() });
        await emit({
          type: 'tool.call.completed',
          sessionId,
          runId,
          toolCallId: 'tool-1',
          name: 'arcane_read_file',
          ok: true,
          resultPreview: '<main>ready</main>',
          resultJson: { path: 'index.html' },
          completedAt: new Date().toISOString(),
        });
        await emit({ type: 'assistant.message', sessionId, runId, content: 'The canvas is ready.' });
        await emit({ type: 'run.done', sessionId, runId, updatedAt: new Date().toISOString() });
      },
    });

    const created = await request(app).post('/api/sessions').send({ title: 'Structured' }).expect(201);
    const sessionId = created.body.id;
    const server = await listen(app);

    try {
      const response = await fetch(serverUrl(server, `/api/sessions/${sessionId}/events`));
      const stream = createStreamReader(response);
      await stream.waitFor(': connected');

      const started = await request(app).post(`/api/sessions/${sessionId}/agent`).send({ content: 'inspect the canvas' }).expect(202);
      await stream.waitFor('event: tool.call.started');
      await stream.waitFor('event: run.done');
      await stream.cancel();

      await waitForRunStatus(store, sessionId, started.body.run.id, 'done');
      const resumed = await request(app).get(`/api/sessions/${sessionId}`).expect(200);
      const runEvents = await request(app).get(`/api/sessions/${sessionId}/runs/${started.body.run.id}/events`).expect(200);

      expect(resumed.body.messages.map((message: any) => message.role)).toEqual(['user', 'tool', 'assistant']);
      expect(resumed.body.messages[1]).toMatchObject({
        role: 'tool',
        toolCallId: 'tool-1',
        parts: [expect.objectContaining({ type: 'tool_result', name: 'arcane_read_file', preview: '<main>ready</main>' })],
      });
      expect(resumed.body.messages[2].content).toBe('The canvas is ready.');
      expect(runEvents.body.map((event: any) => event.type)).toEqual(
        expect.arrayContaining(['assistant.delta', 'tool.call.started', 'tool.call.completed', 'assistant.message', 'run.done']),
      );
    } finally {
      await closeServer(server);
    }
  });

  it('runs a structured external event-stream bridge command', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-agent-event-stream-'));
    const scriptPath = path.join(root, 'bridge.mjs');
    await writeFile(
      scriptPath,
      [
        "let raw = '';",
        "process.stdin.setEncoding('utf8');",
        "process.stdin.on('data', (chunk) => { raw += chunk; });",
        "process.stdin.on('end', () => {",
        "  const request = JSON.parse(raw);",
        "  console.log(JSON.stringify({ type: 'tool.call.started', toolCallId: 'external-1', name: 'adapter.echo', args: { content: request.content } }));",
        "  console.log(JSON.stringify({ type: 'tool.call.completed', toolCallId: 'external-1', name: 'adapter.echo', resultPreview: 'adapter result', resultJson: { ok: true } }));",
        "  console.log(JSON.stringify({ type: 'assistant.message', content: `adapter heard ${request.content}` }));",
        "  console.log(JSON.stringify({ type: 'run.done' }));",
        "});",
      ].join('\n'),
      'utf8',
    );

    const previousMode = process.env.ARCANE_HERMES_MODE;
    const previousBridge = process.env.ARCANE_HERMES_EVENT_BRIDGE;
    process.env.ARCANE_HERMES_MODE = 'event-stream';
    process.env.ARCANE_HERMES_EVENT_BRIDGE = `${process.execPath} ${scriptPath}`;

    try {
      const store = new SessionStore(root);
      const bridge = createDefaultAgentBridge();
      expect(bridge).not.toBeNull();
      const app = createArcaneApp(store, bridge);
      const created = await request(app).post('/api/sessions').send({ title: 'External bridge' }).expect(201);
      const sessionId = created.body.id;

      const started = await request(app).post(`/api/sessions/${sessionId}/agent`).send({ content: 'hello adapter' }).expect(202);
      await waitForRunStatus(store, sessionId, started.body.run.id, 'done');
      const resumed = await request(app).get(`/api/sessions/${sessionId}`).expect(200);

      expect(resumed.body.messages.map((message: any) => message.role)).toEqual(['user', 'tool', 'assistant']);
      expect(resumed.body.messages[2].content).toBe('adapter heard hello adapter');
      expect(resumed.body.runEvents.map((event: any) => event.type)).toEqual(
        expect.arrayContaining(['tool.call.started', 'tool.call.completed', 'assistant.message', 'run.done']),
      );
    } finally {
      if (previousMode === undefined) delete process.env.ARCANE_HERMES_MODE;
      else process.env.ARCANE_HERMES_MODE = previousMode;
      if (previousBridge === undefined) delete process.env.ARCANE_HERMES_EVENT_BRIDGE;
      else process.env.ARCANE_HERMES_EVENT_BRIDGE = previousBridge;
    }
  });

  it('streams session events over SSE', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-events-'));
    const store = new SessionStore(root);
    const app = createArcaneApp(store, null);
    const created = await request(app).post('/api/sessions').send({ title: 'Events' }).expect(201);
    const sessionId = created.body.id;
    const server = await listen(app);

    try {
      const response = await fetch(serverUrl(server, `/api/sessions/${sessionId}/events`));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const stream = createStreamReader(response);

      await stream.waitFor(': connected');
      await request(app).post(`/api/sessions/${sessionId}/messages`).send({ role: 'user', content: 'hello live events' }).expect(201);

      const raw = await stream.waitFor('event: message.appended');
      expect(raw).toContain('"type":"message.appended"');
      expect(raw).toContain(`"sessionId":"${sessionId}"`);
      await stream.cancel();
    } finally {
      await closeServer(server);
    }
  });

  it('returns a safe error run and stores only the user message when the bridge fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-agent-fail-'));
    const store = new SessionStore(root);
    const app = createArcaneApp(store, {
      respond: async () => { throw new Error('bridge exploded while running hermes chat --quiet -q'); },
    });

    const created = await request(app).post('/api/sessions').send({ title: 'Agent fail demo' }).expect(201);
    const sessionId = created.body.id;

    const response = await request(app).post(`/api/sessions/${sessionId}/agent`).send({ content: 'please do a thing' }).expect(202);
    const failed = await waitForRunStatus(store, sessionId, response.body.run.id, 'error');
    const resumed = await request(app).get(`/api/sessions/${sessionId}`).expect(200);
    const visibleText = resumed.body.messages.map((m: any) => m.content).join('\n');

    expect(response.body.message).toBeUndefined();
    expect(failed).toMatchObject({
      sessionId,
      status: 'error',
      message: 'The agent run failed. Open debug details.',
    });
    expect(JSON.stringify(failed.debug)).toContain('bridge exploded');
    expect(JSON.stringify(failed.debug)).toContain('hermes chat');
    expect(response.body.assistant).toBeUndefined();
    expect(resumed.body.messages.map((m: any) => m.role)).toEqual(['user']);
    expect(visibleText).toContain('please do a thing');
    expect(visibleText).not.toContain('bridge exploded');
    expect(visibleText).not.toContain('hermes chat');
    expect(visibleText).not.toContain('--quiet -q');
    expect(resumed.body.run).toMatchObject({ id: response.body.run.id, status: 'error' });
    expect(resumed.body.runEvents.map((event: any) => event.type)).toContain('run.error');
  });

  it('returns a safe disabled-bridge run without assistant internals', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-agent-disabled-'));
    const store = new SessionStore(root);
    const app = createArcaneApp(store, null);

    const created = await request(app).post('/api/sessions').send({ title: 'Agent disabled demo' }).expect(201);
    const sessionId = created.body.id;

    const response = await request(app).post(`/api/sessions/${sessionId}/agent`).send({ content: 'please do a thing' }).expect(503);
    const resumed = await request(app).get(`/api/sessions/${sessionId}`).expect(200);

    expect(response.body.message).toBe('The agent run failed. Open debug details.');
    expect(response.body.run).toMatchObject({ status: 'error', message: 'The agent run failed. Open debug details.' });
    expect(resumed.body.messages.map((m: any) => m.role)).toEqual(['user']);
  });

  it('cancels an active agent run through AbortSignal', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-agent-cancel-'));
    const store = new SessionStore(root);
    let sawAbort = false;
    let markBridgeReady!: () => void;
    let markAbortObserved!: () => void;
    const bridgeReady = new Promise<void>((resolve) => { markBridgeReady = resolve; });
    const abortObserved = new Promise<void>((resolve) => { markAbortObserved = resolve; });
    const app = createArcaneApp(store, {
      respond: async ({ signal }) => new Promise<void>((_resolve, reject) => {
        const onAbort = () => {
          sawAbort = true;
          markAbortObserved();
          const error = new Error('cancelled by test');
          error.name = 'AbortError';
          reject(error);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        markBridgeReady();
        if (signal.aborted) onAbort();
      }),
    });

    const created = await request(app).post('/api/sessions').send({ title: 'Cancel demo' }).expect(201);
    const sessionId = created.body.id;
    const started = await request(app).post(`/api/sessions/${sessionId}/agent`).send({ content: 'wait forever' }).expect(202);
    await bridgeReady;

    const cancelled = await request(app)
      .post(`/api/sessions/${sessionId}/runs/${started.body.run.id}/cancel`)
      .send({})
      .expect(202);
    await abortObserved;
    const resumed = await request(app).get(`/api/sessions/${sessionId}`).expect(200);

    expect(sawAbort).toBe(true);
    expect(cancelled.body.run).toMatchObject({ id: started.body.run.id, status: 'cancelled' });
    expect(resumed.body.run).toMatchObject({ id: started.body.run.id, status: 'cancelled' });
    expect(resumed.body.messages.map((m: any) => m.role)).toEqual(['user']);
    expect(resumed.body.runEvents.map((event: any) => event.type)).toContain('run.cancelled');
  });

  it('rejects encoded session id traversal before writing files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-traversal-root-'));
    const outside = path.resolve(root, '..', 'arcane-owned');
    await rm(outside, { recursive: true, force: true });

    const store = new SessionStore(root);
    const app = createArcaneApp(store, null);

    await request(app)
      .put('/api/sessions/..%2F..%2Farcane-owned/files/pwn.txt')
      .set('content-type', 'text/plain')
      .send('owned')
      .expect(400);

    await expect(fileExists(path.join(outside, 'artifact', 'pwn.txt'))).resolves.toBe(false);
  });

  it('protects API and artifact routes when an access token is configured', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-auth-'));
    const store = new SessionStore(root);
    const app = createArcaneApp(store, null, { accessToken: 'secret-token' });

    await request(app).get('/').expect(200);
    await request(app).post('/api/sessions').send({ title: 'Nope' }).expect(401);

    const created = await request(app)
      .post('/api/sessions')
      .set('x-arcane-token', 'secret-token')
      .send({ title: 'Locked demo' })
      .expect(201);

    const sessionId = created.body.id;
    const locked = await request(app)
      .get(`/api/sessions/${sessionId}`)
      .set('x-arcane-token', 'secret-token')
      .expect(200);

    await request(app).get(`/artifact/${sessionId}/index.html`).expect(401);
    await request(app).get(`/api/sessions?canvasToken=${locked.body.session.artifact.viewToken}`).expect(401);
    await request(app).get(`/artifact/${sessionId}/index.html?canvasToken=${locked.body.session.artifact.viewToken}`).expect(401);

    const grant = await request(app)
      .post(`/api/sessions/${sessionId}/artifact-access`)
      .set('x-arcane-token', 'secret-token')
      .expect(204);
    const cookie = grant.headers['set-cookie'];
    const cookieText = Array.isArray(cookie) ? cookie.join('\n') : String(cookie || '');
    expect(cookieText).toContain('HttpOnly');
    expect(cookieText).toContain('SameSite=Lax');
    expect(cookieText).toContain(`Path=/artifact/${sessionId}`);

    const httpsGrant = await request(app)
      .post(`/api/sessions/${sessionId}/artifact-access`)
      .set('x-arcane-token', 'secret-token')
      .set('x-forwarded-proto', 'https')
      .expect(204);
    const httpsCookieText = Array.isArray(httpsGrant.headers['set-cookie']) ? httpsGrant.headers['set-cookie'].join('\n') : String(httpsGrant.headers['set-cookie'] || '');
    expect(httpsCookieText).toContain('SameSite=None');
    expect(httpsCookieText).toContain('Secure');

    await request(app).get(`/artifact/${sessionId}/index.html`).set('cookie', cookie).expect(200);
    await request(app).get(`/artifact/${sessionId}/styles.css`).set('cookie', cookie).expect(200);
    const artifact = await request(app)
      .get(`/artifact/${sessionId}/index.html?token=secret-token`)
      .set('x-forwarded-proto', 'https')
      .expect(200);
    const artifactCookieText = Array.isArray(artifact.headers['set-cookie']) ? artifact.headers['set-cookie'].join('\n') : String(artifact.headers['set-cookie'] || '');
    expect(artifactCookieText).toContain('SameSite=None');
    expect(artifactCookieText).toContain('Secure');
    expect(artifact.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(artifact.headers['content-security-policy']).toContain("navigate-to 'none'");
  });

  it('does not serve dotfiles or leak filesystem paths for missing artifacts', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-artifact-hardening-'));
    const store = new SessionStore(root);
    const app = createArcaneApp(store, null);
    const created = await request(app).post('/api/sessions').send({ title: 'Hardening' }).expect(201);
    const sessionId = created.body.id;
    await writeFile(path.join(root, 'sessions', sessionId, 'artifact', '.env'), 'SECRET=potato', 'utf8');

    await request(app).get(`/artifact/${sessionId}/.env`).expect(400).expect((response) => {
      expect(response.text).not.toContain(root);
      expect(response.text).not.toContain('SECRET');
    });
    await request(app).get(`/artifact/${sessionId}/missing.css`).expect(404).expect((response) => {
      expect(response.text).not.toContain(root);
    });
  });
});

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function waitForRunStatus(store: SessionStore, sessionId: string, runId: string, status: string): Promise<any> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const run = (await store.listRuns(sessionId, 10)).find((candidate) => candidate.id === runId);
    if (run?.status === status) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const run = (await store.listRuns(sessionId, 10)).find((candidate) => candidate.id === runId);
  throw new Error(`Timed out waiting for run ${runId} to reach ${status}; current=${run?.status || 'missing'}`);
}

function listen(app: ReturnType<typeof createArcaneApp>): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => resolve(server));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function serverUrl(server: Server, route: string): string {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Server did not bind to a TCP port');
  return `http://127.0.0.1:${address.port}${route}`;
}

function createStreamReader(response: Response): { waitFor: (needle: string) => Promise<string>; cancel: () => Promise<void> } {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('SSE response had no body');
  const decoder = new TextDecoder();
  let buffer = '';

  return {
    async waitFor(needle: string): Promise<string> {
      const deadline = Date.now() + 2_000;
      while (!buffer.includes(needle)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`Timed out waiting for SSE chunk containing ${needle}`);
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`Timed out waiting for SSE chunk containing ${needle}`)), remaining)),
        ]);
        if (result.done) break;
        buffer += decoder.decode(result.value, { stream: true });
      }
      return buffer;
    },
    async cancel(): Promise<void> {
      await reader.cancel().catch(() => undefined);
    },
  };
}
