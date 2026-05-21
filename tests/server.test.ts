import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { createArcaneApp } from '../src/server.js';
import { SessionStore } from '../src/session-store.js';

describe('Arcane web server', () => {
  it('creates, resumes, and renders a session artifact', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-http-'));
    const store = new SessionStore(root);
    const app = createArcaneApp(store);

    const created = await request(app).post('/api/sessions').send({ title: 'Demo' }).expect(201);
    const sessionId = created.body.id;

    await request(app).post(`/api/sessions/${sessionId}/messages`).send({ role: 'user', content: 'draw it' }).expect(201);
    await request(app).put(`/api/sessions/${sessionId}/files/index.html`).send({ content: '<h1>Visual plan</h1>' }).expect(204);

    const resumed = await request(app).get(`/api/sessions/${sessionId}`).expect(200);
    const artifact = await request(app).get(`/artifact/${sessionId}/index.html`).expect(200);

    expect(resumed.body.session.title).toBe('Demo');
    expect(resumed.body.session.artifact).toMatchObject({ entrypoint: 'index.html' });
    expect(resumed.body.messages[0].content).toBe('draw it');
    expect(artifact.text).toContain('Visual plan');
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

  it('returns a safe error run and stores only the user message when the bridge fails', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-agent-fail-'));
    const store = new SessionStore(root);
    const app = createArcaneApp(store, {
      respond: async () => { throw new Error('bridge exploded while running hermes chat --quiet -q'); },
    });

    const created = await request(app).post('/api/sessions').send({ title: 'Agent fail demo' }).expect(201);
    const sessionId = created.body.id;

    const response = await request(app)
      .post(`/api/sessions/${sessionId}/agent`)
      .send({ content: 'please do a thing' })
      .expect(502);

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

    const response = await request(app)
      .post(`/api/sessions/${sessionId}/agent`)
      .send({ content: 'please do a thing' })
      .expect(503);

    const resumed = await request(app).get(`/api/sessions/${sessionId}`).expect(200);

    expect(response.body.message).toBe('The agent run failed. Open debug details.');
    expect(response.body.run).toMatchObject({ status: 'error', message: 'The agent run failed. Open debug details.' });
    expect(resumed.body.messages.map((m: any) => m.role)).toEqual(['user']);
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
    await request(app).get(`/artifact/${sessionId}/index.html`).expect(401);
    await request(app).get(`/artifact/${sessionId}/index.html?token=secret-token`).expect(200);
  });
});
