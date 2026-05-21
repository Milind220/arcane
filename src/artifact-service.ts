import { SessionStore, type ArcaneArtifactFile, type ArcaneSnapshot } from './session-store.js';
import type { ArcaneSessionEvent } from './arcane-events.js';

export type ArtifactEvent =
  | Extract<ArcaneSessionEvent, { type: 'artifact.changed' }>
  | Extract<ArcaneSessionEvent, { type: 'snapshot.created' }>;

export type ArtifactEventEmitter = (event: ArtifactEvent) => void | Promise<void>;

export class ArcaneArtifactService {
  constructor(
    private readonly store: SessionStore,
    private readonly emit?: ArtifactEventEmitter,
  ) {}

  async writeFile(sessionId: string, relativePath: string, content: string, options: { runId?: string } = {}): Promise<ArcaneArtifactFile | null> {
    await this.store.writeFile(sessionId, relativePath, content);
    const file = (await this.store.listArtifactFileMetadata(sessionId)).find((artifactFile) => artifactFile.path === relativePath) || null;
    await this.emit?.({
      type: 'artifact.changed',
      sessionId,
      path: relativePath,
      ...(file ? { file } : {}),
      ...(options.runId ? { runId: options.runId } : {}),
    });
    return file;
  }

  async createSnapshot(sessionId: string, summary = '', options: { runId?: string } = {}): Promise<ArcaneSnapshot> {
    const snapshot = await this.store.createSnapshot(sessionId, summary);
    await this.emit?.({
      type: 'snapshot.created',
      sessionId,
      snapshotId: snapshot.id,
      ...(options.runId ? { runId: options.runId } : {}),
    });
    return snapshot;
  }
}
