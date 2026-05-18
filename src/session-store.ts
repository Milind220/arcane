import path from 'node:path';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ArcaneSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArcaneMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface ArcaneSnapshot {
  id: string;
  summary: string;
  createdAt: string;
}

const DEFAULT_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Arcane artifact</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="empty-state">
      <p>Arcane canvas ready.</p>
      <p>Ask the agent to draw something useful here.</p>
    </main>
    <script src="/script.js"></script>
  </body>
</html>
`;

const DEFAULT_CSS = `:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; background: #09090f; color: #f5f3ff; }
.empty-state { min-height: 100vh; display: grid; place-content: center; gap: 0.5rem; text-align: center; color: #a78bfa; }
`;

const DEFAULT_JS = `console.log('Arcane artifact loaded');\n`;

export class SessionStore {
  constructor(private readonly rootDir: string = path.join(process.cwd(), '.arcane')) {}

  async createSession(title = 'Untitled session'): Promise<ArcaneSession> {
    const now = new Date().toISOString();
    const session: ArcaneSession = { id: randomUUID(), title, createdAt: now, updatedAt: now };
    await mkdir(this.sessionDir(session.id), { recursive: true });
    await mkdir(this.artifactDir(session.id), { recursive: true });
    await mkdir(this.snapshotsDir(session.id), { recursive: true });
    await this.writeSession(session);
    await writeFile(this.messagePath(session.id), '', 'utf8');
    await this.writeFile(session.id, 'index.html', DEFAULT_HTML);
    await this.writeFile(session.id, 'styles.css', DEFAULT_CSS);
    await this.writeFile(session.id, 'script.js', DEFAULT_JS);
    return session;
  }

  async listSessions(): Promise<ArcaneSession[]> {
    await mkdir(this.sessionsRoot(), { recursive: true });
    const entries = await readdir(this.sessionsRoot(), { withFileTypes: true });
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => this.getSession(entry.name)),
    );
    return sessions
      .filter((session): session is ArcaneSession => Boolean(session))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSession(id: string): Promise<ArcaneSession | null> {
    try {
      return JSON.parse(await readFile(this.sessionPath(id), 'utf8')) as ArcaneSession;
    } catch (error: any) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async appendMessage(sessionId: string, role: MessageRole, content: string): Promise<ArcaneMessage> {
    const session = await this.requireSession(sessionId);
    const message: ArcaneMessage = { id: randomUUID(), role, content, createdAt: new Date().toISOString() };
    await writeFile(this.messagePath(sessionId), `${JSON.stringify(message)}\n`, { encoding: 'utf8', flag: 'a' });
    await this.writeSession({ ...session, updatedAt: message.createdAt });
    return message;
  }

  async listMessages(sessionId: string): Promise<ArcaneMessage[]> {
    await this.requireSession(sessionId);
    const raw = await readFile(this.messagePath(sessionId), 'utf8');
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ArcaneMessage);
  }

  async listFiles(sessionId: string): Promise<string[]> {
    await this.requireSession(sessionId);
    const walk = async (dir: string, prefix = ''): Promise<string[]> => {
      const entries = await readdir(dir, { withFileTypes: true });
      const out: string[] = [];
      for (const entry of entries) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...(await walk(full, rel)));
        if (entry.isFile()) out.push(rel);
      }
      return out;
    };
    return walk(this.artifactDir(sessionId));
  }

  async writeFile(sessionId: string, relativePath: string, content: string): Promise<void> {
    const session = await this.getSession(sessionId);
    const fullPath = this.safeArtifactPath(sessionId, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf8');
    if (session) await this.writeSession({ ...session, updatedAt: new Date().toISOString() });
  }

  async readFile(sessionId: string, relativePath: string): Promise<string> {
    await this.requireSession(sessionId);
    return readFile(this.safeArtifactPath(sessionId, relativePath), 'utf8');
  }

  async createSnapshot(sessionId: string, summary = ''): Promise<ArcaneSnapshot> {
    await this.requireSession(sessionId);
    const snapshot: ArcaneSnapshot = { id: randomUUID(), summary, createdAt: new Date().toISOString() };
    const target = path.join(this.snapshotsDir(sessionId), snapshot.id);
    await mkdir(target, { recursive: true });
    await cp(this.artifactDir(sessionId), path.join(target, 'artifact'), { recursive: true });
    await writeFile(path.join(target, 'snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf8');
    return snapshot;
  }

  async readSnapshotFile(sessionId: string, snapshotId: string, relativePath: string): Promise<string> {
    await this.requireSession(sessionId);
    const base = path.join(this.snapshotsDir(sessionId), snapshotId, 'artifact');
    const resolved = path.resolve(base, relativePath);
    if (!resolved.startsWith(path.resolve(base) + path.sep) && resolved !== path.resolve(base)) {
      throw new Error('Invalid artifact path');
    }
    return readFile(resolved, 'utf8');
  }

  artifactRoot(sessionId: string): string {
    return this.artifactDir(sessionId);
  }

  private sessionsRoot(): string {
    return path.join(this.rootDir, 'sessions');
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.sessionsRoot(), sessionId);
  }

  private sessionPath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'session.json');
  }

  private messagePath(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'messages.jsonl');
  }

  private artifactDir(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'artifact');
  }

  private snapshotsDir(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'snapshots');
  }

  private async writeSession(session: ArcaneSession): Promise<void> {
    await mkdir(this.sessionDir(session.id), { recursive: true });
    await writeFile(this.sessionPath(session.id), JSON.stringify(session, null, 2), 'utf8');
  }

  private async requireSession(sessionId: string): Promise<ArcaneSession> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Unknown Arcane session: ${sessionId}`);
    return session;
  }

  private safeArtifactPath(sessionId: string, relativePath: string): string {
    if (!relativePath || path.isAbsolute(relativePath)) throw new Error('Invalid artifact path');
    const base = path.resolve(this.artifactDir(sessionId));
    const resolved = path.resolve(base, relativePath);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) throw new Error('Invalid artifact path');
    return resolved;
  }
}

export async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
