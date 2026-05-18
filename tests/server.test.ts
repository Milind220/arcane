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
    expect(resumed.body.messages[0].content).toBe('draw it');
    expect(artifact.text).toContain('Visual plan');
  });
});
