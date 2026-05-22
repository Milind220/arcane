import type { AgentRun, AgentRunStatus, ArcaneArtifactFile, ArcaneMessage } from './session-store.js';

export interface ArcaneEventDebugRef {
  kind: 'log' | 'file' | 'trace' | 'raw' | string;
  id?: string;
  path?: string;
  note?: string;
}

export type ArcaneRunEvent =
  | {
      type: 'run.created';
      sessionId: string;
      runId: string;
      status: 'queued';
      message: string;
      createdAt: string;
      run?: AgentRun;
    }
  | {
      type: 'run.status';
      sessionId: string;
      runId: string;
      status: AgentRunStatus;
      message: string;
      updatedAt: string;
      run?: AgentRun;
    }
  | {
      type: 'assistant.delta';
      sessionId: string;
      runId: string;
      messageId: string;
      delta: string;
      index: number;
      createdAt: string;
    }
  | {
      type: 'assistant.message';
      sessionId: string;
      runId: string;
      message: ArcaneMessage;
      createdAt: string;
    }
  | {
      type: 'tool.call.started';
      sessionId: string;
      runId: string;
      toolCallId: string;
      name: string;
      args: unknown;
      category?: string;
      createdAt: string;
    }
  | {
      type: 'tool.call.updated';
      sessionId: string;
      runId: string;
      toolCallId: string;
      name?: string;
      patch: unknown;
      updatedAt: string;
    }
  | {
      type: 'tool.call.completed';
      sessionId: string;
      runId: string;
      toolCallId: string;
      name: string;
      ok: true;
      args?: unknown;
      resultPreview: string;
      resultJson?: unknown;
      resultTruncated?: boolean;
      durationMs?: number;
      category?: string;
      debugRef?: ArcaneEventDebugRef;
      completedAt: string;
    }
  | {
      type: 'tool.call.failed';
      sessionId: string;
      runId: string;
      toolCallId: string;
      name: string;
      ok: false;
      args?: unknown;
      error: string;
      resultPreview?: string;
      resultTruncated?: boolean;
      durationMs?: number;
      category?: string;
      debug?: unknown;
      debugRef?: ArcaneEventDebugRef;
      completedAt: string;
    }
  | {
      type: 'run.error';
      sessionId: string;
      runId: string;
      message: string;
      debug?: unknown;
      updatedAt: string;
      run?: AgentRun;
    }
  | {
      type: 'run.done';
      sessionId: string;
      runId: string;
      updatedAt: string;
      run?: AgentRun;
    }
  | {
      type: 'run.cancelled';
      sessionId: string;
      runId: string;
      message: string;
      updatedAt: string;
      run?: AgentRun;
    };

export type ArcaneSessionEvent =
  | ArcaneRunEvent
  | { type: 'message.appended'; sessionId: string; message: ArcaneMessage }
  | { type: 'artifact.changed'; sessionId: string; path: string; file?: ArcaneArtifactFile; runId?: string }
  | { type: 'snapshot.created'; sessionId: string; snapshotId: string; runId?: string };

export function isArcaneRunEvent(event: ArcaneSessionEvent): event is ArcaneRunEvent {
  return (
    event.type === 'run.created' ||
    event.type === 'run.status' ||
    event.type === 'assistant.delta' ||
    event.type === 'assistant.message' ||
    event.type === 'tool.call.started' ||
    event.type === 'tool.call.updated' ||
    event.type === 'tool.call.completed' ||
    event.type === 'tool.call.failed' ||
    event.type === 'run.error' ||
    event.type === 'run.done' ||
    event.type === 'run.cancelled'
  );
}
