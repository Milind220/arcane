import path from 'node:path';
import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export type MessageRole = 'user' | 'assistant' | 'system';

export type AgentRunStatus = 'queued' | 'thinking' | 'editing' | 'done' | 'error';

export interface ArcaneHermesMetadata {
  profile?: string;
  sessionId?: string;
  source?: string;
  origin?: 'cli' | 'telegram' | 'arcane' | string;
  originThread?: string | null;
}

export interface ArcaneArtifactMetadata {
  entrypoint: 'index.html' | string;
  files: string[];
  lastSnapshotId?: string | null;
  viewToken?: string;
}

export interface ArcaneArtifactFile {
  path: string;
  size: number;
  modifiedAt: string;
}

export interface ArcaneSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  hermes?: ArcaneHermesMetadata;
  artifact?: ArcaneArtifactMetadata;
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

export interface AgentRun {
  id: string;
  sessionId: string;
  status: AgentRunStatus;
  createdAt: string;
  updatedAt: string;
  message: string;
  debug?: Record<string, unknown>;
}

const DEFAULT_HTML = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Arcane artifact</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main class="empty-state">
      <h1>Arcane session ready</h1>
      <p>Ask the agent to write HTML, CSS, or JS into this canvas.</p>
    </main>
    <script src="script.js"></script>
  </body>
</html>
`;

const DEFAULT_CSS = `:root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; background: #09090f; color: #f5f3ff; }
.empty-state { min-height: 100vh; display: grid; place-content: center; gap: 0.5rem; text-align: center; color: #a78bfa; }
`;

const DEFAULT_JS = `console.log('Arcane artifact loaded');\n`;

const DEFAULT_ARTIFACT_FILES = ['index.html', 'styles.css', 'script.js'];

export class SessionStore {
  constructor(private readonly rootDir: string = path.join(process.cwd(), '.arcane')) {}

  async createSession(title = 'Untitled session', hermes?: ArcaneHermesMetadata): Promise<ArcaneSession> {
    const now = new Date().toISOString();
    const session: ArcaneSession = {
      id: randomUUID(),
      title,
      createdAt: now,
      updatedAt: now,
      ...(hermes ? { hermes } : {}),
      artifact: { entrypoint: 'index.html', files: [...DEFAULT_ARTIFACT_FILES], lastSnapshotId: null, viewToken: randomUUID() },
    };
    await mkdir(this.sessionDir(session.id), { recursive: true });
    await mkdir(this.artifactDir(session.id), { recursive: true });
    await mkdir(this.snapshotsDir(session.id), { recursive: true });
    await mkdir(this.runsDir(session.id), { recursive: true });
    await this.writeSession(session);
    await writeFile(this.messagePath(session.id), '', 'utf8');
    await writeFile(path.join(this.artifactDir(session.id), 'index.html'), DEFAULT_HTML, 'utf8');
    await writeFile(path.join(this.artifactDir(session.id), 'styles.css'), DEFAULT_CSS, 'utf8');
    await writeFile(path.join(this.artifactDir(session.id), 'script.js'), DEFAULT_JS, 'utf8');
    return session;
  }

  async listSessions(): Promise<ArcaneSession[]> {
    await mkdir(this.sessionsRoot(), { recursive: true });
    const entries = await readdir(this.sessionsRoot(), { withFileTypes: true });
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          try {
            return await this.getSession(entry.name);
          } catch {
            return null;
          }
        }),
    );
    return sessions
      .filter((session): session is ArcaneSession => Boolean(session))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getSession(id: string): Promise<ArcaneSession | null> {
    this.assertValidSessionId(id);
    try {
      const session = JSON.parse(await readFile(this.sessionPath(id), 'utf8')) as ArcaneSession;
      if (session.id !== id) throw new Error('Session id mismatch');
      const normalized = this.withArtifactViewToken(session);
      if (normalized !== session) await this.writeSession(normalized);
      return normalized;
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
    let raw = '';
    try {
      raw = await readFile(this.messagePath(sessionId), 'utf8');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return raw
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ArcaneMessage);
  }

  async listFiles(sessionId: string): Promise<string[]> {
    await this.requireSession(sessionId);
    return this.listArtifactFiles(sessionId);
  }

  async listArtifactFileMetadata(sessionId: string): Promise<ArcaneArtifactFile[]> {
    await this.requireSession(sessionId);
    const files = await Promise.all(
      (await this.listArtifactFiles(sessionId)).map(async (filePath) => {
        const info = await stat(this.safeArtifactPath(sessionId, filePath));
        return { path: filePath, size: info.size, modifiedAt: info.mtime.toISOString() };
      }),
    );
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async createRun(
    sessionId: string,
    input: { status: AgentRunStatus; message: string; debug?: Record<string, unknown> },
  ): Promise<AgentRun> {
    const session = await this.requireSession(sessionId);
    const now = new Date().toISOString();
    const run: AgentRun = {
      id: randomUUID(),
      sessionId,
      status: input.status,
      createdAt: now,
      updatedAt: now,
      message: input.message,
      ...(input.debug ? { debug: input.debug } : {}),
    };
    await mkdir(this.runsDir(sessionId), { recursive: true });
    await this.writeRun(run);
    await this.writeSession({ ...session, updatedAt: now });
    return run;
  }

  async updateRun(
    sessionId: string,
    runId: string,
    input: { status?: AgentRunStatus; message?: string; debug?: Record<string, unknown> },
  ): Promise<AgentRun> {
    const session = await this.requireSession(sessionId);
    const current = await this.readRun(sessionId, runId);
    const now = new Date().toISOString();
    const run: AgentRun = {
      ...current,
      status: input.status ?? current.status,
      message: input.message ?? current.message,
      updatedAt: now,
      ...(input.debug !== undefined ? { debug: input.debug } : {}),
    };
    await this.writeRun(run);
    await this.writeSession({ ...session, updatedAt: now });
    return run;
  }

  async listRuns(sessionId: string, limit = 20): Promise<AgentRun[]> {
    await this.requireSession(sessionId);
    let entries;
    try {
      entries = await readdir(this.runsDir(sessionId), { withFileTypes: true });
    } catch (error: any) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map(async (entry) => JSON.parse(await readFile(path.join(this.runsDir(sessionId), entry.name), 'utf8')) as AgentRun),
    );
    return runs
      .filter((run) => run.sessionId === sessionId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async getLatestRun(sessionId: string): Promise<AgentRun | null> {
    return (await this.listRuns(sessionId, 1))[0] || null;
  }

  private async listArtifactFiles(sessionId: string): Promise<string[]> {
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
    return (await walk(this.artifactDir(sessionId))).sort((a, b) => a.localeCompare(b));
  }

  async writeFile(sessionId: string, relativePath: string, content: string): Promise<void> {
    const session = await this.requireSession(sessionId);
    const fullPath = this.safeArtifactPath(sessionId, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf8');
    await this.writeSession({
      ...session,
      artifact: await this.refreshArtifactMetadata(session.id, session.artifact),
      updatedAt: new Date().toISOString(),
    });
  }

  async readFile(sessionId: string, relativePath: string): Promise<string> {
    await this.requireSession(sessionId);
    return readFile(this.safeArtifactPath(sessionId, relativePath), 'utf8');
  }

  async createSnapshot(sessionId: string, summary = ''): Promise<ArcaneSnapshot> {
    const session = await this.requireSession(sessionId);
    const snapshot: ArcaneSnapshot = { id: randomUUID(), summary, createdAt: new Date().toISOString() };
    const target = path.join(this.snapshotsDir(sessionId), snapshot.id);
    await mkdir(target, { recursive: true });
    await cp(this.artifactDir(sessionId), path.join(target, 'artifact'), { recursive: true });
    await writeFile(path.join(target, 'snapshot.json'), JSON.stringify(snapshot, null, 2), 'utf8');
    await this.writeSession({
      ...session,
      artifact: await this.refreshArtifactMetadata(sessionId, session.artifact, snapshot.id),
      updatedAt: snapshot.createdAt,
    });
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

  private runsDir(sessionId: string): string {
    return path.join(this.sessionDir(sessionId), 'runs');
  }

  private runPath(sessionId: string, runId: string): string {
    this.assertValidSessionId(sessionId);
    if (!runId || path.isAbsolute(runId) || runId.includes('/') || runId.includes('\\')) {
      throw new Error('Invalid run id');
    }
    return path.join(this.runsDir(sessionId), `${runId}.json`);
  }

  private async writeSession(session: ArcaneSession): Promise<void> {
    this.assertValidSessionId(session.id);
    await mkdir(this.sessionDir(session.id), { recursive: true });
    await writeFile(this.sessionPath(session.id), JSON.stringify(session, null, 2), 'utf8');
  }

  private async readRun(sessionId: string, runId: string): Promise<AgentRun> {
    return JSON.parse(await readFile(this.runPath(sessionId, runId), 'utf8')) as AgentRun;
  }

  private async writeRun(run: AgentRun): Promise<void> {
    await mkdir(this.runsDir(run.sessionId), { recursive: true });
    await writeFile(this.runPath(run.sessionId, run.id), JSON.stringify(run, null, 2), 'utf8');
  }

  private async refreshArtifactMetadata(
    sessionId: string,
    current?: ArcaneArtifactMetadata,
    lastSnapshotId: string | null | undefined = current?.lastSnapshotId ?? null,
  ): Promise<ArcaneArtifactMetadata> {
    return {
      entrypoint: current?.entrypoint || 'index.html',
      files: await this.listArtifactFiles(sessionId),
      lastSnapshotId,
      viewToken: current?.viewToken || randomUUID(),
    };
  }

  private async requireSession(sessionId: string): Promise<ArcaneSession> {
    const session = await this.getSession(sessionId);
    if (!session) throw new Error(`Unknown Arcane session: ${sessionId}`);
    return session;
  }

  private safeArtifactPath(sessionId: string, relativePath: string): string {
    this.assertValidSessionId(sessionId);
    if (!relativePath || path.isAbsolute(relativePath)) throw new Error('Invalid artifact path');
    if (relativePath.includes('\\')) throw new Error('Invalid artifact path');
    const parts = relativePath.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.'))) {
      throw new Error('Invalid artifact path');
    }
    const base = path.resolve(this.artifactDir(sessionId));
    const resolved = path.resolve(base, relativePath);
    if (!resolved.startsWith(base + path.sep) && resolved !== base) throw new Error('Invalid artifact path');
    return resolved;
  }

  private withArtifactViewToken(session: ArcaneSession): ArcaneSession {
    if (!session.artifact || session.artifact.viewToken) return session;
    return {
      ...session,
      artifact: {
        entrypoint: session.artifact?.entrypoint || 'index.html',
        files: session.artifact?.files || [],
        lastSnapshotId: session.artifact?.lastSnapshotId ?? null,
        viewToken: randomUUID(),
      },
    };
  }

  private assertValidSessionId(sessionId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(sessionId)) {
      throw new Error('Invalid session id');
    }
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
