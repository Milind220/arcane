# Arcane Hermes Platform Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace Arcane's one-shot `hermes chat --quiet -q` bridge with a first-class Hermes platform/client that preserves Hermes sessions, slash commands, tool calls, tool results, streaming progress, and Arcane artifact/canvas workflows.

**Architecture:** Arcane becomes a proper Hermes surface instead of a subprocess transcript collector. Hermes emits structured run events through an event sink; Arcane stores those events as run steps/messages and streams them to the browser over SSE first, with WebSocket as a later upgrade if bidirectional live controls need it.

**Tech Stack:** TypeScript/Express/SSE in `Milind220/arcane`; Python Hermes Agent changes in `~/.hermes/hermes-agent` or the Hermes source checkout; filesystem-backed Arcane session store; existing Hermes `AIAgent`, gateway command registry, tool dispatcher, and session machinery.

---

## Current State

Arcane currently has the right outer shell and the wrong agent bridge.

Relevant Arcane files:

- `src/server.ts`
  - Express API and SSE endpoint.
  - `ArcaneSessionEvent` currently supports `message.appended`, `run.status`, `artifact.changed`, and `snapshot.created`.
  - `/api/sessions/:sessionId/agent` appends the user message, creates a run, calls `agentBridge.respond()`, appends one final assistant message, and marks the run done/error.
  - `createDefaultAgentBridge()` shells out to `hermes chat --quiet -q <prompt>`.

- `src/session-store.ts`
  - `MessageRole = 'user' | 'assistant' | 'system'`.
  - `ArcaneMessage` is `{ id, role, content, createdAt }`.
  - `AgentRun` stores only status/message/debug.
  - No durable run event/step model.
  - No `tool` message role.
  - No structured message parts.

- `public/app.js`
  - Uses EventSource against `/api/sessions/:sessionId/events`.
  - Re-fetches the whole session on events.
  - Renders plain messages and coarse run status only.
  - No tool cards, tool result previews, assistant deltas, or run-step timeline.

- `tests/server.test.ts`
  - Covers basic agent bridge success/failure and SSE smoke.
  - No structured event stream or tool rendering test yet.

Existing degraded bridge:

```ts
const { stdout, stderr } = await execFileAsync(hermesBin, ['chat', '--quiet', '-q', prompt], {
  timeout,
  maxBuffer: 1024 * 1024,
  env: { ...process.env, ARCANE_SESSION_ID: sessionId },
});
```

This suppresses Hermes tool previews and returns only final stdout/stderr. Arcane cannot render events it never receives. Tiny bridge, tragic raccoon.

## Target Architecture

```text
Browser Arcane UI
  ⇅ EventSource / later WebSocket
Arcane Express server
  ⇅ Arcane run events + session/artifact store
Hermes Arcane platform adapter
  ⇅ Hermes AIAgent + slash command handling + tool dispatcher
Model providers / tools / memory / skills
```

Key decisions:

1. Arcane is a Hermes platform/interface, not a separate agent backend.
2. Hermes owns agent execution, sessions, tool use, slash commands, and memory semantics.
3. Arcane owns browser UX, canvas artifacts, session artifact storage, and visual event rendering.
4. Tool calls are emitted as structured events from inside Hermes, not parsed from stdout.
5. Keep subprocess mode as a fallback until embedded/platform mode is stable.

## Non-Goals For This Milestone

Do not include these in the first serious pass:

- Full collaborative multi-user hosting.
- OAuth/multi-tenant hosted Arcane.
- Canvas selection/annotation/doodles.
- DOM region targeting.
- Artifact diff/revert UI beyond existing snapshots.
- Parsing terminal ANSI/stdout from `hermes chat --verbose`.
- Rewriting Hermes gateway wholesale.

If someone suggests regex-parsing Hermes stdout, confiscate their keyboard briefly.

## Event Protocol

Add a shared TypeScript event shape in Arcane, likely `src/arcane-events.ts`:

```ts
export type ArcaneRunEvent =
  | { type: 'run.created'; sessionId: string; runId: string; status: 'queued'; message: string; createdAt: string }
  | { type: 'run.status'; sessionId: string; runId: string; status: AgentRunStatus; message: string; updatedAt: string }
  | { type: 'assistant.delta'; sessionId: string; runId: string; messageId: string; delta: string; index: number }
  | { type: 'assistant.message'; sessionId: string; runId: string; message: ArcaneMessage }
  | { type: 'tool.call.started'; sessionId: string; runId: string; toolCallId: string; name: string; args: unknown; createdAt: string }
  | { type: 'tool.call.updated'; sessionId: string; runId: string; toolCallId: string; patch: unknown; updatedAt: string }
  | { type: 'tool.call.completed'; sessionId: string; runId: string; toolCallId: string; name: string; ok: boolean; resultPreview: string; resultJson?: unknown; completedAt: string }
  | { type: 'tool.call.failed'; sessionId: string; runId: string; toolCallId: string; name: string; error: string; debug?: unknown; completedAt: string }
  | { type: 'artifact.changed'; sessionId: string; runId?: string; path: string; file?: ArcaneArtifactFile }
  | { type: 'run.error'; sessionId: string; runId: string; message: string; debug?: unknown; updatedAt: string }
  | { type: 'run.done'; sessionId: string; runId: string; updatedAt: string };
```

Rules:

- Every event must include `sessionId`.
- Every agent-generated event should include `runId`.
- Tool args/results are structured JSON when safe, plus a string preview for UI.
- Large tool results should be truncated in event payloads and stored/debug-linked separately.
- The event protocol should be versioned before external exposure, but not before v0. Keep the goblin small.

## Data Model Changes

Modify `src/session-store.ts`.

Current:

```ts
export type MessageRole = 'user' | 'assistant' | 'system';

export interface ArcaneMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
}
```

Target:

```ts
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export type ArcaneMessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCallId: string; name: string; args: unknown; status: 'running' | 'done' | 'error' }
  | { type: 'tool_result'; toolCallId: string; name: string; ok: boolean; preview: string; resultJson?: unknown };

export interface ArcaneMessage {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  runId?: string;
  toolCallId?: string;
  parts?: ArcaneMessagePart[];
}

export type AgentRunStepStatus = 'running' | 'done' | 'error';

export interface AgentRunStep {
  id: string;
  sessionId: string;
  runId: string;
  type: ArcaneRunEvent['type'];
  status: AgentRunStepStatus;
  createdAt: string;
  updatedAt: string;
  payload: Record<string, unknown>;
}
```

Storage:

- Keep `messages.jsonl` for transcript compatibility.
- Add `.arcane/sessions/<id>/runs/<runId>/events.jsonl` for event history.
- Add `.arcane/sessions/<id>/runs/<runId>/steps.json` or derive steps from events. Prefer deriving until performance says otherwise.
- Existing sessions without `parts` remain valid.

Add store methods:

```ts
appendMessage(sessionId, role, content, options?: { runId?: string; parts?: ArcaneMessagePart[]; toolCallId?: string })
appendRunEvent(sessionId, runId, event: ArcaneRunEvent)
listRunEvents(sessionId, runId)
listLatestRunEvents(sessionId, limit?)
appendToolMessage(sessionId, runId, toolCallId, name, result)
```

## Hermes Changes Required

This plan requires Hermes-side work. Do not fake it inside Arcane.

Relevant Hermes source areas to inspect/modify:

- `run_agent.py`
  - `AIAgent`
  - `run_conversation()`
  - assistant/tool call loop
  - interrupt/cancel handling

- `model_tools.py`
  - `handle_function_call()`
  - tool dispatch start/finish/error boundaries

- `hermes_cli/commands.py`
  - central slash command registry.
  - Gateway already derives known commands from this registry.

- `gateway/run.py` and `gateway/platforms/*`
  - current platform adapter patterns.
  - gateway command dispatch behavior.

- `tui_gateway/server.py`
  - already has tool start/complete callbacks around lines like `_on_tool_start` and `_on_tool_complete`.
  - This is likely the closest existing precedent for structured tool lifecycle events.

Add Hermes event sink primitives:

```py
class AgentEventSink:
    def emit(self, event: dict) -> None:
        pass

class NullAgentEventSink(AgentEventSink):
    def emit(self, event: dict) -> None:
        return
```

Wire event emission at these boundaries:

- run/session start
- assistant text delta when provider streaming exists
- assistant final message
- tool call parsed/started
- tool call result
- tool call error
- run cancellation/interruption
- run done/error

If provider streaming is not available in a path, emit the final assistant message first and add token deltas later. Tool lifecycle is higher priority than text streaming.

Required invariant:

Display layers consume events. Display layers are not the only source of events.

## Slash Command Handling

Goal: Arcane supports normal Hermes slash commands through Hermes command handling.

Implementation rule:

- Do not implement an Arcane-only slash command parser unless the command is Arcane-specific.
- Route slash-prefixed user messages through the same Hermes command registry/handler path used by gateway/CLI as much as possible.
- If Hermes command handling is split between CLI-only and gateway-only behavior, extract shared command execution behind a service/module before wiring Arcane.

Acceptance examples:

- `/help` renders usable command help in Arcane chat.
- `/status` returns session/platform info.
- `/model`, `/reasoning`, `/skills`, `/tools` behave according to Hermes platform rules or return a clear unsupported-platform message.
- Unknown commands get Hermes' normal unknown-command behavior.

Some CLI-native commands may need graceful degradation. That is acceptable. Silent divergence is not.

## Arcane Server Changes

Modify `src/server.ts`.

Add a richer bridge interface:

```ts
export interface AgentRunContext {
  sessionId: string;
  runId: string;
  content: string;
  messages: ArcaneMessage[];
  files: string[];
  emit: (event: ArcaneRunEvent) => Promise<void> | void;
  signal: AbortSignal;
}

export interface AgentBridge {
  respond(request: AgentRunContext): Promise<{ finalMessage?: string }>;
}
```

Route behavior:

- `/api/sessions/:sessionId/agent`
  - Append user message.
  - Create run.
  - Return quickly with `{ user, run }` once run starts, or keep current synchronous response only until UI can handle async runs.
  - Execute bridge in background with an AbortController tracked by run id.
  - Emit/store all run events.
  - Append final assistant message only when Hermes emits final message.

Add endpoints:

```text
GET  /api/sessions/:sessionId/runs/:runId/events
POST /api/sessions/:sessionId/runs/:runId/cancel
```

Keep existing `/api/sessions/:sessionId/events` as the session-level stream. It should broadcast run events too, not only coarse session events.

Subprocess fallback:

- Keep `ARCANE_HERMES_MODE=subprocess` for current behavior.
- Add `ARCANE_HERMES_MODE=embedded` or `platform` for the new path.
- Default to the new path only after tests pass.

## Arcane Tooling / Artifact Integration

Arcane should eventually expose a small Hermes toolset. Do not stuff this into the generic chat bridge.

Tools to design after platform bridge works:

- `arcane_list_files(session_id?)`
- `arcane_read_file(path)`
- `arcane_write_file(path, content)`
- `arcane_create_snapshot(summary?)`
- `arcane_get_canvas_context()` later

Important existing issue:

- `src/mcp-local.ts` writes directly to the store.
- Direct store writes can bypass the Express event bus.

Fix options:

1. Move artifact writes through an Arcane service that both Express and MCP use, and have that service emit events.
2. Add a filesystem watcher for artifact directories and emit `artifact.changed`.
3. Let MCP call the HTTP API with an internal token.

Preferred: shared service. HTTP self-calls are lazy and will bite later.

## UI Changes

Modify `public/app.js`, `public/app.css`, and possibly `public/index.html`.

Minimum UI:

- Render assistant text while a run is active.
- Render tool cards in the transcript.
- Collapse tool cards by default.
- Show tool name, status, duration, args preview, result preview.
- Show errors in a user-safe way with debug drawer.
- Keep existing run status pill.
- Do not reload the whole session for every small assistant delta if it makes the UI janky.

Suggested rendering model:

- Keep a local in-memory map of active run events from SSE.
- Patch the visible transcript for deltas/tool cards.
- Re-fetch session on `run.done`, `run.error`, and `artifact.changed`.

Tool card example:

```html
<article class="message tool-card status-running">
  <header>
    <span class="tool-name">terminal</span>
    <span class="tool-status">running</span>
  </header>
  <details>
    <summary>Arguments</summary>
    <pre>{ ... }</pre>
  </details>
</article>
```

## Implementation Tasks

### Task 1: Document and freeze the Arcane event contract

**Objective:** Create a typed event protocol that both server and UI can consume.

**Files:**

- Create: `src/arcane-events.ts`
- Modify: `src/server.ts`
- Test: `tests/server.test.ts`

**Steps:**

1. Add `ArcaneRunEvent` and related types.
2. Replace or extend `ArcaneSessionEvent` to include run events.
3. Add tests that a fake run event is emitted through the existing SSE endpoint.
4. Run: `npm test -- tests/server.test.ts`

Expected: server tests pass and SSE can carry typed run events.

### Task 2: Extend message and run storage

**Objective:** Persist message parts and run events without breaking old sessions.

**Files:**

- Modify: `src/session-store.ts`
- Test: `tests/session-store.test.ts`

**Steps:**

1. Add `tool` to `MessageRole`.
2. Add optional `runId`, `toolCallId`, and `parts` to `ArcaneMessage`.
3. Add `appendRunEvent()` and `listRunEvents()`.
4. Store run events under each run directory as JSONL.
5. Add backward-compat tests for old messages with no `parts`.
6. Run: `npm test -- tests/session-store.test.ts`

Expected: old transcript behavior still works; run events persist and reload.

### Task 3: Make Arcane bridge event-driven with fake events first

**Objective:** Prove Arcane can render a structured fake Hermes run before touching Hermes.

**Files:**

- Modify: `src/server.ts`
- Modify: `public/app.js`
- Modify: `public/app.css`
- Test: `tests/server.test.ts`

**Steps:**

1. Change `AgentBridge.respond()` to receive `runId`, `emit`, and `AbortSignal`.
2. Update tests' fake bridge to emit:
   - `assistant.delta`
   - `tool.call.started`
   - `tool.call.completed`
   - `assistant.message`
   - `run.done`
3. Persist emitted events through `SessionStore`.
4. Broadcast events over SSE.
5. Render basic tool cards in `public/app.js`.
6. Run: `npm test && npm run build`

Expected: fake structured runs appear in Arcane without subprocess parsing.

### Task 4: Add cancel support

**Objective:** Allow Arcane UI to stop active runs cleanly.

**Files:**

- Modify: `src/server.ts`
- Modify: `public/app.js`
- Modify: `public/index.html`
- Test: `tests/server.test.ts`

**Steps:**

1. Track active runs in memory: `Map<runId, AbortController>`.
2. Add `POST /api/sessions/:sessionId/runs/:runId/cancel`.
3. Mark run as error/cancelled. If adding a new status, update `AgentRunStatus` to include `cancelled`.
4. Ensure subprocess fallback gets killed on cancel.
5. Add a cancel button visible only during active runs.
6. Run: `npm test && npm run build`

Expected: cancelling a fake or subprocess run updates run state and unblocks UI.

### Task 5: Add Hermes Agent event sink

**Objective:** Emit structured tool and response lifecycle events from Hermes internals.

**Files in Hermes source checkout:**

- Modify: `run_agent.py`
- Modify: `model_tools.py`
- Add if useful: `agent/events.py`
- Test: add/modify Hermes tests near agent/tool dispatch coverage.

**Steps:**

1. Add `AgentEventSink` and `NullAgentEventSink`.
2. Add optional sink parameter to `AIAgent`.
3. Emit tool start before `handle_function_call()` executes.
4. Emit tool complete/error after dispatch.
5. Emit assistant final message.
6. Add text delta events only where provider streaming is already available; otherwise skip for now.
7. Ensure existing CLI/gateway behavior is unchanged when using `NullAgentEventSink`.
8. Run Hermes tests relevant to agent/tool dispatch.

Expected: Hermes can run normally while optionally producing structured events.

### Task 6: Build Hermes Arcane platform adapter

**Objective:** Route Arcane messages through Hermes as a first-class platform.

**Files in Hermes source checkout:**

- Add/modify under `gateway/platforms/` if using gateway pattern.
- Or add a local API/embedded adapter if that is cleaner after inspection.
- Modify command handling only if needed to share slash-command behavior.

**Steps:**

1. Create an Arcane platform identity: `platform='arcane'`.
2. Map Arcane session id to Hermes session id/source metadata.
3. Route normal user messages into `AIAgent.run_conversation()`.
4. Route slash commands through Hermes' real command handling path.
5. Send emitted events to Arcane's bridge/event callback.
6. Preserve profile selection via env/config.
7. Add tests or a harness that runs `/help` and a fake tool call through the adapter.

Expected: Arcane messages are handled by Hermes platform logic, not by prompt-wrapped CLI subprocess calls.

### Task 7: Replace default bridge with platform mode

**Objective:** Make Arcane use the real Hermes adapter by default, while keeping subprocess fallback.

**Files:**

- Modify: `src/server.ts`
- Modify: `docs/hermes-integration.md`
- Test: `tests/server.test.ts`

**Steps:**

1. Add `ARCANE_HERMES_MODE=platform|subprocess|disabled`.
2. Make platform mode the default once available.
3. Keep subprocess fallback explicitly documented as degraded.
4. Ensure `ARCANE_AGENT_DISABLED=1` still works for tests/dev.
5. Run: `npm test && npm run build`

Expected: default Arcane no longer invokes `hermes chat --quiet -q` for normal use.

### Task 8: Add artifact events for all write paths

**Objective:** Ensure canvas refreshes whenever Arcane artifact files change, including MCP/tool writes.

**Files:**

- Modify: `src/server.ts`
- Modify: `src/mcp-local.ts`
- Possibly create: `src/artifact-service.ts`
- Test: `tests/mcp-local.test.ts`, `tests/server.test.ts`

**Steps:**

1. Extract artifact write/read/snapshot operations into a shared service.
2. Have Express and MCP use the same service.
3. Emit `artifact.changed` after writes.
4. Emit `snapshot.created` after snapshots.
5. Add a test proving MCP writes result in a browser-observable event, or define a callback bridge if testing SSE from MCP is awkward.
6. Run: `npm test && npm run build`

Expected: no more event-bus bypass. Canvas update goblin contained.

### Task 9: End-to-end smoke test

**Objective:** Verify the user-facing behavior, not just the code.

**Files:**

- Possibly add: `tests/e2e/arcane-hermes-smoke.test.ts` later.
- Manual smoke first.

**Steps:**

1. Start Arcane:
   ```bash
   PORT=8799 npm start
   ```
2. Open `http://127.0.0.1:8799`.
3. Create/resume a session.
4. Send a message that triggers a known harmless tool call.
5. Verify the chat shows:
   - user message
   - run status
   - assistant progress/final text
   - tool start card
   - tool result card
   - final run done
6. Send `/help`.
7. Verify Hermes command output appears normally.
8. Run:
   ```bash
   npm test
   npm run build
   ```

Expected: Arcane feels like a Hermes client, not a subprocess receipt printer.

## Migration / Compatibility

- Existing `.arcane` sessions must load without migration.
- Missing `parts`, `runId`, and run event files should be treated as empty/legacy state.
- Existing artifact URLs stay unchanged.
- Existing `npm run link` helper remains valid.
- Existing MCP/local artifact tools should keep their external contract.
- Subprocess mode remains available for rollback.

## Risks

1. Hermes command handling may not be fully shared between CLI and gateway.
   - Mitigation: extract shared command execution first; degrade unsupported CLI-only commands clearly.

2. Hermes event emission may be tangled with display code.
   - Mitigation: add event sink at runtime/tool boundaries, then let display consume events later.

3. Streaming deltas may not exist uniformly across providers.
   - Mitigation: ship tool lifecycle events first; assistant final-message events are enough for v1 correctness.

4. Long tool results can bloat SSE/session files.
   - Mitigation: truncate event payload previews; store full debug separately if needed.

5. Embedded Hermes inside a TypeScript server may be awkward if process boundaries remain Python/Node.
   - Mitigation: use a small local Hermes adapter process speaking JSON events over stdio/WebSocket if direct embedding is not practical. Still structured. Still not stdout necromancy.

## Acceptance Criteria

The fix is done when:

- Arcane no longer depends on `hermes chat --quiet -q` for normal agent runs.
- Arcane can display Hermes tool call start/result/error events before the final assistant reply.
- Arcane can display normal assistant replies and run completion/errors.
- `/help` works through Hermes command handling.
- At least one other slash command works or returns a clear Hermes-origin unsupported message.
- Existing sessions/artifacts still load.
- `npm test` passes.
- `npm run build` passes.
- Manual browser smoke confirms tool cards appear live.

## Rejected Alternatives

### Parse `hermes chat --verbose` stdout

Rejected. Brittle, lossy, hard to test, provider/display-dependent, and doomed to ANSI archaeology.

### Reimplement Hermes slash commands in Arcane

Rejected. That forks behavior and guarantees drift.

### Store only final assistant messages

Rejected. Tool visibility and debugging require durable run events.

### Make Arcane a separate agent backend

Rejected. Arcane is an interface for Hermes, not a second Hermes wearing a fake moustache.

## Final Shape

After this plan lands, Arcane should behave like this:

1. User opens Arcane.
2. User sends a message.
3. Arcane creates an agent run.
4. Hermes processes the message as platform `arcane`.
5. Hermes emits structured events.
6. Arcane stores/broadcasts events.
7. Browser renders assistant text, tool cards, artifact changes, and final result live.
8. Slash commands use Hermes behavior.
9. Subprocess fallback exists only as a safety rope.

That is the line between “browser UI for Hermes” and “React cage around a CLI hamster.”
