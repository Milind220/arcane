# Arcane Hermes Gateway Completion Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Turn Arcane from a local chat/canvas app with a degraded Hermes subprocess bridge into a first-class Hermes messaging gateway/interface with real sessions, slash commands, tool-call visibility, run details, and artifact/canvas workflows.

**Architecture:** Arcane should become a Hermes platform surface, not an independent agent backend. Hermes owns agent execution, sessions, slash commands, tools, skills, memory, and resume semantics. Arcane owns the browser UI, chat/canvas rendering, artifact storage, event visualization, and local/shareable workspace links.

**Tech Stack:** TypeScript, Express, SSE/EventSource, filesystem-backed Arcane sessions, Hermes Python gateway/platform machinery, Hermes `AIAgent`, Hermes command registry, Hermes tool dispatcher, Arcane MCP/tool APIs.

**Created:** 2026-05-22 14:26 HKT

---

## Executive Summary

Arcane is now a credible event-rendering frontend. It is not yet a complete Hermes messaging gateway.

Current readiness estimate:

- Personal Hermes browser gateway: ~40%
- Telegram/WhatsApp-class Hermes gateway: ~20-25%

The current branch has the right shell: structured run events, persisted tool messages, SSE streaming, cancel support, and browser rendering for tool cards. The missing part is the Hermes-side nervous system: real Hermes platform adapter, real tool lifecycle events, slash-command routing, Hermes session mapping, and Arcane-specific tools.

Do not fake this by parsing `hermes chat --verbose` output. Arcane must receive structured events from Hermes internals or a thin adapter that uses Hermes internals.

---

## Verified Current State

Repo:

- Local path: `/root/arcane`
- Branch inspected: `feat/hermes-platform-events`
- Remote branch: `origin/feat/hermes-platform-events`

Recent commits inspected:

- `3e03ecd feat: render live Arcane run events`
- `723de04 feat: persist structured Arcane agent events`
- `aa6189b docs: document Hermes platform event bridge`
- `d9450ad fix: harden Arcane tunnel bridge`
- `e08e116 feat: add Arcane beta link helper`

Verification commands run:

```bash
cd /root/arcane
npm test
npm run build
ARCANE_AGENT_DISABLED=1 PORT=8787 npm start
```

Results:

- `npm test`: 3 files passed, 27 tests passed.
- `npm run build`: TypeScript build passed.
- Browser smoke: `http://127.0.0.1:8787` loaded, existing sessions rendered, artifact iframe rendered.

---

## What Already Exists

### Arcane event contract

File: `src/arcane-events.ts`

Current event types include:

- `run.created`
- `run.status`
- `assistant.delta`
- `assistant.message`
- `tool.call.started`
- `tool.call.updated`
- `tool.call.completed`
- `tool.call.failed`
- `run.error`
- `run.done`
- `run.cancelled`
- `message.appended`
- `artifact.changed`
- `snapshot.created`

### Arcane session storage

File: `src/session-store.ts`

Implemented:

- `MessageRole = 'user' | 'assistant' | 'system' | 'tool'`
- Optional `runId`, `toolCallId`, and `parts` on `ArcaneMessage`
- `ArcaneMessagePart` for text, tool calls, and tool results
- `AgentRunStatus = 'queued' | 'thinking' | 'editing' | 'done' | 'error' | 'cancelled'`
- `appendRunEvent()`
- `listRunEvents()`
- `listLatestRunEvents()`
- `appendToolMessage()`

### Arcane server bridge/event handling

File: `src/server.ts`

Implemented:

- Async `/api/sessions/:sessionId/agent` route returning `202` after run starts.
- Active run tracking with `AbortController`.
- `POST /api/sessions/:sessionId/runs/:runId/cancel`.
- `GET /api/sessions/:sessionId/runs/:runId/events`.
- Session-level SSE stream at `/api/sessions/:sessionId/events`.
- Structured event ingestion and normalization.
- Tool completion/failure events append durable `tool` messages.
- Safe visible error message plus debug payload instead of leaking raw bridge internals into chat.
- `ARCANE_HERMES_MODE=subprocess` fallback.
- `ARCANE_HERMES_MODE=event-stream` / `platform` external JSONL bridge mode.

### Arcane UI rendering

Files:

- `public/app.js`
- `public/app.css`
- `public/index.html`

Implemented:

- Run status pill and run message.
- Cancel run button.
- Assistant delta rendering.
- Tool cards for started/completed/failed tool calls.
- Tool args/result details.
- Debug drawer for failed runs.
- Artifact file list.
- SSE event subscription and incremental run-event merge.

### Artifact event service

File: `src/artifact-service.ts`

Implemented:

- Shared service for artifact writes and snapshot creation.
- Emits `artifact.changed` and `snapshot.created` events when used by Express routes.

### Docs already present

Files:

- `docs/ARCANE_HERMES_PLATFORM_PLAN.md`
- `docs/hermes-integration.md`

These already document the broader platform/event-stream direction. This document captures the distance-to-complete assessment and the implementation sequence to reach real gateway parity.

---

## What Is Still Missing

### 1. Hermes-native Arcane platform adapter

Current default behavior still shells out:

```bash
hermes chat --quiet -q "<Arcane session prompt>"
```

This is degraded mode. It only returns final text and cannot preserve full gateway semantics.

Target:

- Arcane should be a Hermes platform/interface.
- Hermes should receive Arcane messages through a platform adapter or embedded adapter.
- Arcane session IDs should map to Hermes session/source metadata.
- Hermes should own model/tool/skill/memory/session semantics.

### 2. Hermes event sink

Arcane can render structured events, but Hermes does not yet emit Arcane-compatible run events from its real agent loop.

Target Hermes events:

- run/session start
- assistant final message
- assistant text delta where streaming exists
- tool call parsed/started
- tool result completed
- tool error/failure
- run cancellation/interruption
- run done/error

Relevant Hermes files to inspect:

- `/root/.hermes/hermes-agent/run_agent.py`
- `/root/.hermes/hermes-agent/model_tools.py`
- `/root/.hermes/hermes-agent/tui_gateway/server.py`
- `/root/.hermes/hermes-agent/gateway/run.py`
- `/root/.hermes/hermes-agent/hermes_cli/commands.py`

Existing precedent:

- `tui_gateway/server.py` has `_on_tool_start`, `_on_tool_complete`, and `tool_start_callback` style wiring. Reuse the concept, but do not make TUI display callbacks the source of truth.

### 3. Slash commands

Arcane does not yet route slash commands through Hermes' real slash-command machinery.

Required examples:

- `/help`
- `/commands`
- `/status`
- `/model`
- `/reasoning`
- `/skills`
- `/tools`
- `/usage`
- `/profile`
- `/new` / `/reset`

Rule:

- Do not build a fake Arcane-only slash command parser except for Arcane-specific commands.
- Reuse Hermes command registry and gateway command behavior where possible.
- If a command is CLI-only or platform-unsupported, return a clear unsupported-platform message.

### 4. True Hermes session preservation

Arcane currently has its own session store. Hermes has its own session DB and gateway session keys.

Target:

- Arcane session metadata stores Hermes profile/source/session mapping.
- Hermes can resume the correct conversation state from Arcane messages.
- Arcane run events do not fork from Hermes transcript truth.
- `/new`, `/reset`, `/resume`, and session title behavior have defined Arcane semantics.

### 5. Arcane-specific Hermes tools

Hermes needs tools that operate on the active Arcane workspace.

Initial toolset:

- `arcane_list_files(session_id?)`
- `arcane_read_file(path)`
- `arcane_write_file(path, content)`
- `arcane_create_snapshot(summary?)`
- `arcane_get_session(session_id?)`

Later toolset:

- `arcane_get_canvas_context()`
- `arcane_get_selection()`
- `arcane_annotate_region()`
- `arcane_restore_snapshot(snapshot_id)`

### 6. Gateway setup/config integration

Arcane is not yet a Hermes gateway platform that can be enabled via Hermes config/setup.

Target UX:

```bash
hermes gateway setup arcane
hermes gateway run
```

or equivalent config-backed service behavior.

Arcane should feel like Telegram/WhatsApp from Hermes' perspective: one configured platform among others, with platform-specific adapter details hidden.

---

## Completion Criteria

Arcane is a complete personal Hermes gateway when all of this is true:

1. A user can open Arcane, send a message, and the message is handled by the real Hermes agent loop.
2. Arcane displays live tool calls with names, args, status, result previews, errors, and durations if available.
3. Arcane displays assistant messages and run status without waiting for a one-shot subprocess to exit.
4. Hermes slash commands work from Arcane with normal gateway semantics or explicit unsupported messages.
5. Hermes sessions are preserved/resumable and mapped clearly to Arcane sessions.
6. Hermes can read/write Arcane artifact files through a real tool boundary.
7. Run cancellation stops the active Hermes run/tool path where possible.
8. Failed runs show safe user-facing errors plus debug details.
9. Tests cover structured events, slash commands, tool events, cancellation, and degraded fallback.
10. Docs explain setup, modes, limitations, and fallback behavior.

Arcane is Telegram/WhatsApp-class when additionally:

1. It can be configured as a durable Hermes gateway platform.
2. It has auth appropriate for non-local/tunneled use.
3. Multiple sessions/users/conversations have clear isolation.
4. It can show historical tool details and run traces cleanly.
5. It handles reconnects, long runs, and stale browser sessions gracefully.
6. It has polished command discovery and status UI.

---

## Implementation Tasks

### Task 1: Freeze the Arcane gateway contract

**Objective:** Make the event/session/tool contract explicit before touching Hermes internals.

**Files:**

- Modify: `docs/ARCANE_HERMES_PLATFORM_PLAN.md`
- Modify: `docs/hermes-integration.md`
- Modify: `src/arcane-events.ts` if contract gaps are found
- Test: `tests/server.test.ts`

**Steps:**

1. Review `src/arcane-events.ts` against this document.
2. Add any missing fields needed for real Hermes tool calls:
   - duration
   - raw/debug result reference
   - tool display category if useful
3. Document field stability in `docs/hermes-integration.md`.
4. Add/adjust server tests for any new event fields.
5. Run:

```bash
npm test -- tests/server.test.ts
npm run build
```

**Expected:** Existing structured event tests still pass and the event contract is documented.

---

### Task 2: Add Hermes event sink primitives

**Objective:** Add a generic Hermes event sink that defaults to no-op and does not affect CLI/gateway behavior unless configured.

**Files:**

- Create: `/root/.hermes/hermes-agent/agent/events.py`
- Modify: `/root/.hermes/hermes-agent/run_agent.py`
- Test: add or modify Hermes tests near agent initialization / callbacks

**Target shape:**

```python
class AgentEventSink:
    def emit(self, event: dict) -> None:
        pass

class NullAgentEventSink(AgentEventSink):
    def emit(self, event: dict) -> None:
        return
```

**Steps:**

1. Add `AgentEventSink` and `NullAgentEventSink`.
2. Add optional `event_sink` parameter to `AIAgent`.
3. Default to `NullAgentEventSink`.
4. Ensure existing agent construction sites do not need changes.
5. Add a test proving `AIAgent(..., event_sink=...)` accepts the sink and default behavior remains unchanged.
6. Run the relevant Hermes tests.

**Expected:** Hermes behavior is unchanged when no event sink is provided.

---

### Task 3: Emit Hermes tool lifecycle events

**Objective:** Emit structured events around real Hermes tool execution.

**Files:**

- Modify: `/root/.hermes/hermes-agent/run_agent.py`
- Modify: `/root/.hermes/hermes-agent/model_tools.py` if the cleanest boundary is inside `handle_function_call()`
- Test: Hermes tool dispatch tests

**Steps:**

1. Locate the exact tool-call loop in `AIAgent.run_conversation()`.
2. Emit `tool.call.started` immediately before tool execution.
3. Emit `tool.call.completed` after successful tool execution.
4. Emit `tool.call.failed` when tool execution raises or returns an error path.
5. Include:
   - `toolCallId`
   - tool name
   - parsed args
   - result preview
   - optional structured result where safe
6. Truncate large results.
7. Do not leak secrets in event payloads.
8. Run Hermes tests for tool dispatch.

**Expected:** A test sink receives real tool lifecycle events without changing normal transcript behavior.

---

### Task 4: Emit Hermes assistant/run lifecycle events

**Objective:** Emit assistant final messages and run status from Hermes.

**Files:**

- Modify: `/root/.hermes/hermes-agent/run_agent.py`
- Test: Hermes agent loop tests

**Steps:**

1. Emit `run.status` when the agent begins thinking.
2. Emit `assistant.message` when the agent returns a final response.
3. Emit `run.done` on successful completion.
4. Emit `run.error` for fatal agent failures.
5. Emit `run.cancelled` or interruption event where Hermes cancellation is supported.
6. Add streaming `assistant.delta` only if the provider path already supports streaming cleanly. Tool events are higher priority.
7. Run relevant Hermes tests.

**Expected:** A test sink can reconstruct the high-level run from Hermes events.

---

### Task 5: Build the external `hermes-arcane-adapter` first

**Objective:** Use Arcane's existing `event-stream` bridge mode to connect to real Hermes events before making Arcane a full gateway platform.

**Files:**

- Create: `/root/.hermes/hermes-agent/scripts/hermes_arcane_adapter.py` or equivalent
- Modify: `/root/arcane/docs/hermes-integration.md`
- Test: Arcane server event-stream bridge test plus Hermes adapter smoke

**Behavior:**

The adapter reads one JSON object from stdin:

```json
{"sessionId":"...","runId":"...","content":"...","messages":[],"files":[]}
```

It writes one Arcane run event per stdout line:

```json
{"type":"tool.call.started","toolCallId":"...","name":"terminal","args":{}}
{"type":"tool.call.completed","toolCallId":"...","name":"terminal","resultPreview":"..."}
{"type":"assistant.message","content":"..."}
{"type":"run.done"}
```

**Steps:**

1. Implement adapter with stdin JSON parsing.
2. Instantiate Hermes `AIAgent(platform='arcane', session_id=<mapped id>, event_sink=<stdout sink>)`.
3. Convert Hermes sink events to Arcane event names/fields.
4. Preserve profile/config environment.
5. Return non-zero with stderr on adapter failure.
6. Run Arcane with:

```bash
ARCANE_HERMES_MODE=event-stream \
ARCANE_HERMES_EVENT_BRIDGE="python /root/.hermes/hermes-agent/scripts/hermes_arcane_adapter.py" \
PORT=8787 \
npm start
```

7. Send a prompt that forces a harmless tool call.
8. Verify Arcane displays tool cards.

**Expected:** Arcane shows real Hermes tool calls without parsing Hermes CLI stdout.

---

### Task 6: Route slash commands through Hermes

**Objective:** Make Arcane support Hermes slash commands using Hermes command handling, not an Arcane-only imitation.

**Files:**

- Hermes: `/root/.hermes/hermes-agent/gateway/run.py`
- Hermes: `/root/.hermes/hermes-agent/hermes_cli/commands.py`
- Hermes: new shared command service if needed
- Arcane adapter: adapter created in Task 5
- Arcane tests: `tests/server.test.ts` if Arcane-side behavior changes

**Steps:**

1. Inspect how gateway resolves and dispatches slash commands.
2. Extract reusable command execution if gateway logic is too coupled to platform adapters.
3. In the Arcane adapter, detect slash-prefixed messages and route them through Hermes' command path.
4. Verify `/help` or `/commands` returns useful command info.
5. Verify `/status` returns Arcane/platform/session info.
6. Verify unsupported commands return clear messages.
7. Add tests or a smoke harness for `/help`, `/status`, and an unknown command.

**Expected:** Arcane can show and use normal Hermes slash commands.

---

### Task 7: Add Arcane workspace toolset for Hermes

**Objective:** Let Hermes directly operate on Arcane artifact files through tools.

**Files:**

Hermes side:

- Create: `/root/.hermes/hermes-agent/tools/arcane_tools.py`
- Modify: `/root/.hermes/hermes-agent/model_tools.py`
- Modify: `/root/.hermes/hermes-agent/toolsets.py`
- Test: Hermes tool tests

Arcane side if needed:

- Modify: `src/server.ts`
- Modify: `src/artifact-service.ts`
- Test: `tests/server.test.ts`

**Initial tools:**

- `arcane_list_files(session_id?: string)`
- `arcane_read_file(path: string, session_id?: string)`
- `arcane_write_file(path: string, content: string, session_id?: string)`
- `arcane_create_snapshot(summary?: string, session_id?: string)`
- `arcane_get_session(session_id?: string)`

**Steps:**

1. Define how tools discover the active Arcane session:
   - `ARCANE_SESSION_ID`
   - explicit `session_id`
   - adapter-provided context
2. Prefer HTTP API calls to Arcane server or direct local store access, but keep one canonical path for event emission.
3. Ensure writes emit `artifact.changed` through Arcane.
4. Add path traversal tests.
5. Add a live smoke where Hermes writes `index.html`, `styles.css`, and `script.js`.
6. Verify the canvas reloads.

**Expected:** The agent can update Arcane canvas artifacts through first-class tools.

---

### Task 8: Map Arcane sessions to Hermes sessions

**Objective:** Preserve Hermes session/history semantics when using Arcane.

**Files:**

- Arcane: `src/session-store.ts`
- Arcane: `src/server.ts`
- Hermes adapter/platform code from Tasks 5-6
- Docs: `docs/hermes-integration.md`

**Steps:**

1. Define session metadata:
   - Hermes profile
   - Hermes session id
   - Hermes source
   - Arcane session id
   - origin/origin thread if launched from another surface
2. When Arcane creates a session from Hermes metadata, preserve it.
3. When the adapter runs, pass stable Hermes session IDs into `AIAgent`.
4. Define `/new` and `/reset` behavior in Arcane.
5. Define title behavior.
6. Test two Arcane sessions do not leak context into each other.

**Expected:** Arcane sessions are resumable and do not fork Hermes context accidentally.

---

### Task 9: Promote from adapter to Hermes platform/gateway integration

**Objective:** Make Arcane configurable as a Hermes gateway platform rather than only an external event-stream command.

**Files:**

- Hermes: `/root/.hermes/hermes-agent/gateway/platforms/`
- Hermes: `/root/.hermes/hermes-agent/gateway/run.py`
- Hermes: `/root/.hermes/hermes-agent/gateway/config.py`
- Hermes CLI setup/config files as needed
- Arcane docs

**Steps:**

1. Study existing platform adapters for Telegram/Discord/API server/Open WebUI.
2. Decide whether Arcane is:
   - a platform adapter that hosts/communicates with Arcane server, or
   - a companion gateway mode with an HTTP/SSE bridge.
3. Add config keys for Arcane:
   - enabled
   - host/port
   - access token
   - Arcane home
   - tunnel/link behavior if needed
4. Add startup/shutdown behavior.
5. Add status output.
6. Add docs for setup.
7. Verify `hermes gateway run` can include Arcane.

**Expected:** Arcane can be started/used as a normal Hermes gateway surface.

---

### Task 10: Polish the command/tool/run UX

**Objective:** Make Arcane useful as a daily-driver interface, not just a proof of plumbing.

**Files:**

- `public/app.js`
- `public/app.css`
- `public/index.html`
- `tests/server.test.ts`

**Steps:**

1. Add a command discovery panel or `/commands` rendering that is readable in the browser.
2. Improve tool cards:
   - collapsed by default
   - duration if available
   - copy args/result buttons if needed
   - clear error styling
3. Add run history/timeline panel.
4. Add better active-run state so the composer is not blocked unnecessarily for long runs if cancellation/queueing is supported.
5. Add reconnect handling for stale SSE connections.
6. Add browser smoke test or documented manual QA flow.

**Expected:** Arcane visibly competes with Telegram as a Hermes surface for long tool-using runs.

---

### Task 11: Harden security for local/tunneled use

**Objective:** Make accidental public exposure less dangerous.

**Files:**

- `src/server.ts`
- `scripts/open-arcane-link.mjs`
- `docs/hermes-integration.md`
- `README.md`
- Tests: `tests/server.test.ts`

**Steps:**

1. Keep token enforcement on API/artifact routes.
2. Audit whether any route can trigger agent execution without token.
3. Ensure token is not logged.
4. Ensure artifact iframe CSP remains strict enough for local generated artifacts.
5. Document safe tunnel behavior.
6. Add tests for unauthorized API calls.

**Expected:** Public tunnel mistakes are contained.

---

## Recommended Execution Order

1. Task 1: Freeze Arcane contract.
2. Task 2: Add Hermes event sink primitives.
3. Task 3: Emit Hermes tool lifecycle events.
4. Task 4: Emit Hermes assistant/run lifecycle events.
5. Task 5: Build external adapter and prove real tool events render in Arcane.
6. Task 6: Wire slash commands.
7. Task 7: Add Arcane workspace tools.
8. Task 8: Preserve Hermes sessions.
9. Task 9: Promote to Hermes platform/gateway config.
10. Task 10: Polish UX.
11. Task 11: Harden security.

First serious milestone:

> Real Hermes event-stream adapter with live tool cards and `/help` working in Arcane.

This milestone proves the core gateway value without waiting for full `hermes gateway setup arcane` polish.

---

## Risks

### Risk: stdout parsing temptation

Do not parse `hermes chat --verbose` or CLI ANSI output. It will break and it will deserve to.

Mitigation: add Hermes event sink and use structured JSONL events.

### Risk: two session stores diverge

Arcane and Hermes both store session-like data.

Mitigation: define ownership clearly:

- Hermes transcript/session truth belongs to Hermes.
- Arcane UI/artifact/run-event state belongs to Arcane.
- Store explicit mapping metadata.

### Risk: tool outputs leak secrets

Tool args/results can contain secrets.

Mitigation:

- Use result previews.
- Truncate large payloads.
- Redact known secret patterns.
- Put full debug behind local-only/debug controls if needed.

### Risk: command behavior forks

If Arcane implements its own slash commands, it will drift from Telegram/CLI.

Mitigation: use Hermes command registry/shared gateway command handling.

### Risk: adapter becomes permanent architecture

The event-stream adapter is useful as a bridge, but the long-term shape is a first-class Hermes platform/gateway integration.

Mitigation: keep adapter thin and make it use the same event sink/platform code that the final gateway adapter will use.

---

## Verification Gates

Run after Arcane changes:

```bash
cd /root/arcane
npm test
npm run build
```

Run after Hermes changes:

```bash
cd /root/.hermes/hermes-agent
source venv/bin/activate 2>/dev/null || source .venv/bin/activate 2>/dev/null
python -m pytest tests/ -o 'addopts=' -q
```

Run a local Arcane smoke:

```bash
cd /root/arcane
ARCANE_AGENT_DISABLED=1 PORT=8787 npm start
# Open http://127.0.0.1:8787
```

Run an event-stream adapter smoke after Task 5:

```bash
cd /root/arcane
ARCANE_HERMES_MODE=event-stream \
ARCANE_HERMES_EVENT_BRIDGE="python /root/.hermes/hermes-agent/scripts/hermes_arcane_adapter.py" \
PORT=8787 \
npm start
```

Manual acceptance smoke:

1. Open Arcane in browser.
2. Create a new session.
3. Send `/help`; verify command output is usable.
4. Send a prompt requiring a harmless tool call; verify live tool card appears.
5. Ask Hermes to write an artifact; verify canvas updates.
6. Cancel a long run; verify run becomes cancelled and UI unblocks.
7. Refresh browser; verify messages, tool events, run state, and artifact files persist.

---

## Final Target Experience

A user should be able to treat Arcane like a richer Telegram for Hermes:

- Open a browser workspace.
- Chat with the same Hermes agent/personality/profile.
- Use slash commands normally.
- See run state while the agent works.
- See every tool call as a readable expandable card.
- See tool args, results, errors, and debug details.
- Watch artifact/canvas changes live.
- Resume the session later.
- Share a temporary link when needed.

That is the product. Anything less is a demo with a nice hat.
