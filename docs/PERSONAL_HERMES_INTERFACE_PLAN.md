# Personal Hermes Interface Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Make Arcane Milind's browser-native Hermes interface: a resumable chat session with a live visual artifact canvas, temporary links, and later selection/annotation-driven artifact edits.

**Architecture:** Arcane is a Hermes platform/interface, not a replacement agent backend. The browser app owns the visual workspace and artifact files; Hermes remains the agent runtime that owns tools, skills, memory, slash commands, and session semantics. V0 can use the current local server and Hermes CLI bridge, but the durable path is a Hermes gateway/platform adapter plus a small Arcane toolset.

**Tech Stack:** TypeScript, Express, local filesystem session store, HTML/CSS/JS artifacts in sandboxed iframe, Hermes CLI/gateway integration, Cloudflare Tunnel for temporary links, later WebSocket/SSE for live updates.

Created: 2026-05-21 16:15 HKT

---

## 1. Product Decision

Arcane's first user is Milind.

Do not optimize V0 for a hosted SaaS, public marketplace, multi-tenant MCP, or generic design-tool positioning. The immediate product is:

```text
A browser tab that can replace terminal/Telegram for a Hermes session when visual artifacts matter.
```

The session must remain portable across interfaces:

- Terminal/Telegram can request an Arcane link.
- Arcane can continue the same Hermes-backed conversation in a browser.
- Terminal/Telegram can later resume the same conversation without visual UI.
- Visual clients show artifacts inline; non-visual clients degrade to links/file references.

This is the spine. Everything else is ribs.

## 2. Target User Loop

### Start from terminal or Telegram

```text
User: yo send me an Arcane link
Hermes: <creates/resumes Arcane workspace for current Hermes session>
Hermes: https://<ttl-cloudflare-url>/s/<signed-token>
```

### Continue in browser

Browser opens Arcane with:

- chat pane
- artifact/canvas pane
- current session history
- current artifact state
- run status
- snapshot controls

User talks to Hermes there. Hermes can update artifacts. The canvas refreshes live.

### Resume anywhere

If the browser closes, the session can be resumed from:

- the same Arcane link if still valid
- a fresh `open_arcane_link` call
- terminal via `hermes --resume <session>`
- Telegram topic/session

## 3. Current Baseline

Current repo already has a useful V0 skeleton:

- `src/server.ts` — Express app, inline web UI, HTTP API, artifact serving, Hermes CLI bridge.
- `src/session-store.ts` — local sessions, messages, artifact files, snapshots, traversal safety.
- `src/mcp-local.ts` — local MCP-ish stdio tool surface.
- `tests/*` — server, session store, MCP smoke tests.
- `README.md` — current V0 loop and safety notes.

Current limitations:

- frontend is embedded as a string in `src/server.ts`
- agent bridge is one-shot `hermes chat --quiet -q`, no streaming/lifecycle
- no true Hermes gateway/platform adapter yet
- no slash-command parity guarantee beyond what the CLI bridge happens to support
- no stable mapping between Arcane sessions and Hermes session IDs
- no tunnel helper/tool
- passive iframe canvas; no selection/annotation context

## 4. Architecture Direction

### Components

```text
Hermes runtime
  - sessions
  - slash commands
  - tools/skills/memory
  - model config
  - gateway/platform machinery
        |
        v
Arcane platform adapter / bridge
        |
        v
Arcane local server
  - browser UI
  - session mapping
  - artifact store
  - snapshots
  - tunnel helper
        |
        v
Browser
  - chat pane
  - iframe canvas
  - selection overlay later
```

### Durable rule

Arcane must not become a second agent runtime.

Arcane may store:

- Arcane workspace metadata
- artifact files
- snapshots/diffs
- UI selection state
- mapping to Hermes session IDs

Hermes keeps owning:

- conversation semantics
- slash commands
- tool execution
- skills
- memory
- provider/model configuration
- Telegram/terminal continuity

## 5. Data Model

Extend local session metadata to include Hermes linkage.

Suggested `session.json` shape:

```json
{
  "id": "arcane-session-id",
  "title": "Untitled session",
  "createdAt": "2026-05-21T08:15:04.000Z",
  "updatedAt": "2026-05-21T08:15:04.000Z",
  "hermes": {
    "profile": "default",
    "sessionId": "20260521_...",
    "source": "arcane",
    "origin": "cli|telegram|arcane",
    "originThread": null
  },
  "artifact": {
    "entrypoint": "index.html",
    "files": ["index.html", "styles.css", "script.js"],
    "lastSnapshotId": null
  }
}
```

Artifacts remain simple files for V0:

```text
.arcane/sessions/<arcaneSessionId>/artifact/index.html
.arcane/sessions/<arcaneSessionId>/artifact/styles.css
.arcane/sessions/<arcaneSessionId>/artifact/script.js
.arcane/sessions/<arcaneSessionId>/snapshots/<snapshotId>/
```

## 6. V0 Scope: Personal Usable Loop

### In scope

- local Arcane server
- browser chat + iframe canvas
- create/resume Arcane sessions
- map Arcane session to Hermes session ID where possible
- append messages through Hermes-backed bridge
- agent-writeable artifact files
- snapshot creation
- manual browser reload or simple polling after agent response
- `open_arcane_link` command/tool/script that starts or reuses server and returns a temporary URL
- access token for public tunnel safety
- docs for terminal/Telegram usage

### Out of scope for V0

- hosted multi-tenant product
- OAuth remote MCP
- full structured canvas protocol
- multiplayer collaboration
- selection/annotation editing
- arbitrary React/RSC renderer
- replacing Hermes session store
- billing, teams, quotas, SaaS nonsense

## 7. First Implementation Milestone

Build reliable chat loop with session linkage and artifact refresh.

Acceptance test:

1. Start Arcane locally.
2. Open browser URL.
3. Create or resume a session.
4. Send a message in Arcane chat.
5. Hermes responds without leaking raw internal errors into the transcript.
6. Hermes can write/update `index.html`, `styles.css`, or `script.js` through Arcane tools/API.
7. Canvas refreshes and shows the updated artifact.
8. Close and reopen browser; session history and artifact state persist.
9. From terminal/Telegram, request a fresh Arcane link for the same session and reopen it.

## 8. Ordered Task Plan

### Task 1: Add explicit Arcane-Hermes session linkage

**Objective:** Store optional Hermes session metadata on every Arcane session.

**Files:**
- Modify: `src/session-store.ts`
- Modify: `tests/session-store.test.ts`
- Update docs: `README.md`

**Steps:**
1. Add a `hermes` object to the session type.
2. Preserve backward compatibility for old `session.json` files with no `hermes` field.
3. Add tests for creating sessions with and without Hermes metadata.
4. Verify with `npm test` and `npm run build`.

### Task 2: Create a user-safe agent run model

**Objective:** Track agent run status separately from chat transcript.

**Files:**
- Modify: `src/server.ts`
- Modify: `src/session-store.ts`
- Modify: `tests/server.test.ts`

**Run states:**

```text
queued -> thinking -> editing -> done
queued -> thinking -> error
```

**Steps:**
1. Add a run record type with status, timestamps, user-safe message, and optional debug details.
2. Update `/api/sessions/:sessionId/agent` to create/update run status.
3. Do not write raw bridge exceptions as assistant messages.
4. Return structured error JSON with safe `message` and hidden `debug` field.
5. Add tests for successful run and failed bridge run.

### Task 3: Split visible transcript from debug details

**Objective:** Prevent command failures and implementation details from polluting the chat.

**Files:**
- Modify: `src/server.ts`
- Modify: inline UI in `src/server.ts` or extracted frontend if done first
- Modify: `tests/server.test.ts`

**Steps:**
1. Show a short assistant-safe error: `The agent run failed. Open debug details.`
2. Keep stderr/command/debug details out of messages by default.
3. Add a collapsible debug drawer in the UI.
4. Test that visible messages do not contain raw `hermes chat` command strings.

### Task 4: Add artifact file panel and explicit reload

**Objective:** Make artifact state visible, not spooky action at a distance.

**Files:**
- Modify: `src/server.ts`
- Modify: `tests/server.test.ts`

**Steps:**
1. Extend session API response to expose artifact file list and modified times.
2. Add a small file panel above/below iframe.
3. Add `Reload canvas` button.
4. Reload iframe after agent response and after file writes.
5. Test API includes files.

### Task 5: Add `open_arcane_link` helper script

**Objective:** Let terminal/Telegram Hermes produce a usable Arcane URL.

**Files:**
- Create: `scripts/open-arcane-link.ts` or `scripts/open-arcane-link.mjs`
- Modify: `package.json`
- Modify: `README.md`

**Behavior:**
1. Ensure Arcane server is running or print exact start command.
2. Generate or reuse `ARCANE_ACCESS_TOKEN`.
3. Optionally start `cloudflared tunnel --url http://127.0.0.1:8787` with TTL guidance.
4. Print local URL and, if available, tunnel URL with token included.
5. Do not expose Arcane publicly without a token.

### Task 6: Add Hermes-side tool/command stub

**Objective:** Define the integration point Hermes will call to open Arcane.

**Files:**
- Create: `docs/hermes-integration.md`
- Optional later: `connectors/hermes/`

**Steps:**
1. Document desired Hermes command/tool: `open_arcane_link`.
2. Inputs: current Hermes session ID/profile/source, optional TTL, optional Arcane session title.
3. Output: signed Arcane URL, Arcane session ID, expiry.
4. Include the degraded non-visual behavior: terminal/Telegram show URL and artifact refs.

### Task 7: Replace CLI bridge with Hermes platform adapter path

**Objective:** Move from one-shot subprocess bridge toward real Hermes platform semantics.

**Files:**
- Create: `docs/hermes-platform-adapter-plan.md`
- Later external Hermes repo changes: `gateway/platforms/arcane.py`, command registry reuse, session source handling.

**Steps:**
1. Document required Hermes extension points.
2. Preserve slash command behavior by routing Arcane chat messages through Hermes gateway/session machinery.
3. Preserve `/model`, `/skills`, `/reasoning`, `/resume`, `/status`, `/help` behavior.
4. Keep current CLI bridge as fallback until adapter works.

### Task 8: Add live update transport

**Objective:** Stop relying on submit-response reload only.

**Files:**
- Modify: `src/server.ts`
- Modify: `tests/server.test.ts`

**Options:**
- SSE endpoint: `/api/sessions/:sessionId/events`
- or WebSocket endpoint later

**Events:**

```json
{"type":"message.appended","sessionId":"..."}
{"type":"artifact.changed","sessionId":"...","path":"index.html"}
{"type":"run.status","sessionId":"...","status":"thinking"}
```

**Steps:**
1. Add SSE endpoint for session events.
2. Emit events after messages, artifact writes, snapshots, and run status changes.
3. UI listens and refreshes affected panels.
4. Test event stream shape if practical.

## 9. Post-V0: Selection and Annotation

Only start this after chat + canvas + resume is reliable.

### Selection capture

Inject a small script/overlay into the artifact iframe or wrap rendered artifact with a same-origin helper.

Capture:

```json
{
  "artifactPath": "index.html",
  "arcaneBlockId": "pricing-card-2",
  "selector": "[data-arcane-id='pricing-card-2']",
  "text": "visible selected text",
  "nearbyHtml": "<section ...>",
  "bbox": { "x": 412, "y": 220, "width": 300, "height": 180 },
  "comment": "expand this"
}
```

### Stable block IDs

Generated artifacts should use stable IDs:

```html
<section data-arcane-id="market-map">
  ...
</section>
```

Without this, targeted editing becomes fragile DOM archaeology.

### Selection-aware prompt

When user selects a region and asks for a change, Arcane sends Hermes:

```text
User request: expand this section
Selected artifact context: <JSON selection payload>
Current files: index.html, styles.css, script.js
Instruction: patch only the relevant region unless a larger refactor is necessary.
```

Acceptance test:

1. User clicks/circles a specific artifact section.
2. User says: `go deeper here`.
3. Hermes receives exact region context.
4. Hermes patches only the relevant HTML/CSS.
5. Canvas updates live.
6. Snapshot records before/after.

## 10. Safety Rules

- Public tunnel requires access token.
- Artifact routes and API routes require token when exposed.
- No arbitrary filesystem paths; keep traversal protection.
- Snapshot before destructive artifact changes.
- Keep raw command stderr out of visible transcript.
- If bridge fails, show safe error and debug drawer.
- Do not let generated artifact JavaScript access Arcane server credentials.
- Treat selection context as advisory; writes still go through Arcane file/session APIs.

## 11. Verification Commands

Run after each implementation slice:

```bash
npm test
npm run build
ARCANE_AGENT_DISABLED=1 PORT=8787 npm start
```

Browser smoke:

1. Open `http://127.0.0.1:8787`.
2. Create session.
3. Send a message with bridge disabled; confirm safe error behavior.
4. Write artifact through API; confirm iframe renders.
5. Create snapshot; confirm files exist under `.arcane/sessions/<id>/snapshots/`.

## 12. Exit Criteria for Personal V0

Personal V0 is done when Milind can consistently do this:

```text
Terminal/Telegram -> "send me an Arcane link"
Browser opens -> chat + artifact canvas
Talk to Hermes -> artifact updates visually
Close browser -> reopen/resume later
Return to terminal/Telegram -> same session still makes sense
```

Everything else is later. Useful first. Magic second. SaaS last, if ever.
