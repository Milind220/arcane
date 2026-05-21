import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/session-store.js';

describe('SessionStore', () => {
  it('creates a resumable session with default artifact files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-test-'));
    const store = new SessionStore(root);

    const session = await store.createSession('Copper plan');
    const defaultHtml = await store.readFile(session.id, 'index.html');
    await store.appendMessage(session.id, 'user', 'make me a visual plan');
    await store.writeFile(session.id, 'index.html', '<h1>Hello Arcane</h1>');

    const resumed = await store.getSession(session.id);
    const messages = await store.listMessages(session.id);
    const html = await store.readFile(session.id, 'index.html');

    expect(resumed?.title).toBe('Copper plan');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'make me a visual plan' });
    expect(defaultHtml).toContain('href="styles.css"');
    expect(defaultHtml).toContain('src="script.js"');
    expect(defaultHtml).not.toContain('href="/styles.css"');
    expect(html).toContain('Hello Arcane');
  });

  it('creates sessions with optional Hermes metadata and artifact metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-test-'));
    const store = new SessionStore(root);

    const session = await store.createSession('Linked session', {
      profile: 'default',
      sessionId: 'hermes-123',
      source: 'arcane',
      origin: 'telegram',
      originThread: 'topic-42',
    });

    const resumed = await store.getSession(session.id);

    expect(resumed?.hermes).toEqual({
      profile: 'default',
      sessionId: 'hermes-123',
      source: 'arcane',
      origin: 'telegram',
      originThread: 'topic-42',
    });
    expect(resumed?.artifact).toMatchObject({
      entrypoint: 'index.html',
      files: expect.arrayContaining(['index.html', 'styles.css', 'script.js']),
      lastSnapshotId: null,
    });
  });

  it('loads old session JSON without Hermes or artifact metadata', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-test-'));
    const sessionDir = path.join(root, 'sessions', 'legacy-session');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'session.json'),
      JSON.stringify({
        id: 'legacy-session',
        title: 'Legacy',
        createdAt: '2026-05-21T00:00:00.000Z',
        updatedAt: '2026-05-21T00:00:00.000Z',
      }),
      'utf8',
    );

    const store = new SessionStore(root);
    const session = await store.getSession('legacy-session');

    expect(session).toMatchObject({ id: 'legacy-session', title: 'Legacy' });
    expect(session?.hermes).toBeUndefined();
    expect(session?.artifact).toBeUndefined();
  });

  it('creates, updates, and lists the latest run', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-test-'));
    const store = new SessionStore(root);
    const session = await store.createSession('Runs');

    const queued = await store.createRun(session.id, { status: 'queued', message: 'Queued.' });
    const thinking = await store.updateRun(session.id, queued.id, { status: 'thinking', message: 'Thinking.' });
    const done = await store.updateRun(session.id, queued.id, { status: 'done', message: 'Done.' });
    const runs = await store.listRuns(session.id);
    const latest = await store.getLatestRun(session.id);

    expect(thinking.updatedAt >= queued.updatedAt).toBe(true);
    expect(done).toMatchObject({ id: queued.id, sessionId: session.id, status: 'done', message: 'Done.' });
    expect(runs).toHaveLength(1);
    expect(latest).toMatchObject({ id: queued.id, status: 'done' });
  });

  it('stores structured run events under a run', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-test-'));
    const store = new SessionStore(root);
    const session = await store.createSession('Run events');
    const run = await store.createRun(session.id, { status: 'queued', message: 'Queued.' });

    await store.appendRunEvent(session.id, run.id, {
      type: 'tool.call.started',
      sessionId: session.id,
      runId: run.id,
      toolCallId: 'tool-1',
      name: 'arcane_read_file',
      args: { path: 'index.html' },
      createdAt: '2026-05-21T00:00:00.000Z',
    });
    await store.appendRunEvent(session.id, run.id, {
      type: 'tool.call.completed',
      sessionId: session.id,
      runId: run.id,
      toolCallId: 'tool-1',
      name: 'arcane_read_file',
      ok: true,
      resultPreview: '<h1>Arcane</h1>',
      resultJson: { ok: true },
      completedAt: '2026-05-21T00:00:01.000Z',
    });

    const events = await store.listRunEvents(session.id, run.id);
    const latest = await store.listLatestRunEvents(session.id);

    expect(events.map((event) => event.type)).toEqual(['tool.call.started', 'tool.call.completed']);
    expect(latest).toEqual(events);
  });

  it('rejects dot-segment run ids for run event storage', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-test-'));
    const store = new SessionStore(root);
    const session = await store.createSession('Run id validation');

    await expect(store.listRunEvents(session.id, '..')).rejects.toThrow('Invalid run id');
  });

  it('persists tool messages with structured parts while legacy messages remain valid', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-test-'));
    const store = new SessionStore(root);
    const session = await store.createSession('Parts');
    const run = await store.createRun(session.id, { status: 'queued', message: 'Queued.' });

    await store.appendMessage(session.id, 'assistant', 'plain legacy-compatible text');
    const tool = await store.appendToolMessage(session.id, run.id, 'tool-42', 'arcane_write_file', {
      ok: true,
      preview: 'Wrote index.html',
      resultJson: { path: 'index.html' },
    });

    const messages = await store.listMessages(session.id);

    expect(messages[0]).toMatchObject({ role: 'assistant', content: 'plain legacy-compatible text' });
    expect(messages[0].parts).toBeUndefined();
    expect(tool).toMatchObject({
      role: 'tool',
      runId: run.id,
      toolCallId: 'tool-42',
      parts: [
        {
          type: 'tool_result',
          toolCallId: 'tool-42',
          name: 'arcane_write_file',
          ok: true,
          preview: 'Wrote index.html',
          resultJson: { path: 'index.html' },
        },
      ],
    });
    expect(messages[1]).toEqual(tool);
  });

  it('lists sessions newest first and snapshots artifact state', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-test-'));
    const store = new SessionStore(root);

    const first = await store.createSession('First');
    const second = await store.createSession('Second');
    await store.writeFile(second.id, 'styles.css', 'body { color: hotpink; }');
    const snapshot = await store.createSnapshot(second.id, 'pink mode');

    const sessions = await store.listSessions();
    const snapshotCss = await store.readSnapshotFile(second.id, snapshot.id, 'styles.css');

    expect(sessions.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(snapshot.summary).toBe('pink mode');
    expect(snapshotCss).toContain('hotpink');
  });

  it('ignores stray invalid session directories while listing sessions', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-test-'));
    const store = new SessionStore(root);
    const session = await store.createSession('Valid');
    await mkdir(path.join(root, 'sessions', '..bad'), { recursive: true });

    await expect(store.listSessions()).resolves.toEqual([expect.objectContaining({ id: session.id, title: 'Valid' })]);
  });

  it('rejects unsafe artifact file paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-test-'));
    const store = new SessionStore(root);
    const session = await store.createSession('Safety');

    await expect(store.writeFile(session.id, '../evil.txt', 'nope')).rejects.toThrow(/invalid artifact path/i);
    await expect(store.writeFile(session.id, '.env', 'nope')).rejects.toThrow(/invalid artifact path/i);
    await expect(store.writeFile(session.id, 'nested/../evil.txt', 'nope')).rejects.toThrow(/invalid artifact path/i);
  });
});
