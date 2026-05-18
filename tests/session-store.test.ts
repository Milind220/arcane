import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
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

  it('rejects path traversal in artifact files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-test-'));
    const store = new SessionStore(root);
    const session = await store.createSession('Safety');

    await expect(store.writeFile(session.id, '../evil.txt', 'nope')).rejects.toThrow(/invalid artifact path/i);
  });
});
