import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import request from 'supertest';
import { createArcaneApp } from '../src/server.js';
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
      .expect(201);
    const resumed = await request(app).get(`/api/sessions/${sessionId}`).expect(200);

    expect(response.body.assistant.content).toContain('heard=make a tiny dashboard');
    expect(response.body.run).toMatchObject({ sessionId, status: 'done' });
    expect(resumed.body.run).toMatchObject({ id: response.body.run.id, status: 'done' });
    expect(resumed.body.runs[0]).toMatchObject({ id: response.body.run.id, status: 'done' });
    expect(resumed.body.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
    expect(resumed.body.messages[1].content).toContain(`session=${sessionId}`);
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

    const response = await request(app).post(`/api/sessions/${sessionId}/agent`).send({ content: 'please do a thing' }).expect(502);
    const resumed = await request(app).get(`/api/sessions/${sessionId}`).expect(200);
    const visibleText = resumed.body.messages.map((m: any) => m.content).join('\n');

    expect(response.body.message).toBe('The agent run failed. Open debug details.');
    expect(response.body.run).toMatchObject({
      sessionId,
      status: 'error',
      message: 'The agent run failed. Open debug details.',
    });
    expect(JSON.stringify(response.body.run.debug)).toContain('bridge exploded');
    expect(JSON.stringify(response.body.run.debug)).toContain('hermes chat');
    expect(response.body.assistant).toBeUndefined();
    expect(resumed.body.messages.map((m: any) => m.role)).toEqual(['user']);
    expect(visibleText).toContain('please do a thing');
    expect(visibleText).not.toContain('bridge exploded');
    expect(visibleText).not.toContain('hermes chat');
    expect(visibleText).not.toContain('--quiet -q');
    expect(resumed.body.run).toMatchObject({ id: response.body.run.id, status: 'error' });
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
    expect(cookieText).toContain(`Path=/artifact/${sessionId}`);

    await request(app).get(`/artifact/${sessionId}/index.html`).set('cookie', cookie).expect(200);
    await request(app).get(`/artifact/${sessionId}/styles.css`).set('cookie', cookie).expect(200);
    const artifact = await request(app).get(`/artifact/${sessionId}/index.html?token=secret-token`).expect(200);
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
