# Loomwright Plan

## 1. Product Name and Thesis

Product name: Loomwright.

One-line thesis: Loomwright is the living canvas for AI agents: a shared visual workspace that agents can read, mutate, comment on, and continue from instead of producing disposable static artifacts.

Source anchors: Paper.design MCP proves the read/write visual canvas workflow; MCP docs support MCP as the primary integration standard; MCP authorization and Cloudflare remote MCP material support hosted OAuth-backed remote MCP; Vercel AI SDK generative UI supports React as renderer rather than canonical protocol; OpenClaw/Open WebUI docs support an OpenAI-compatible bridge as a secondary route.

## 2. Hosted MCP Server Recommendation

Hosted MCP is good as the default commercial path, with conditions.

Use hosted remote MCP over Streamable HTTP as the primary integration and monetization surface. It gives Loomwright account auth, tenant isolation, per-canvas permissions, usage metering, durable state, collaboration, share links, audit logs, and paid limits around hosted tool operations, rendering, storage, and history.

Do not make hosted MCP the only path. Ship the same protocol as local/self-hosted MCP for private data, local-first developers, clients with incomplete remote MCP/OAuth support, and open-source trust. The hosted product wins on zero-maintenance remote access, managed OAuth, collaboration, admin, durability, and compliance.

Decision: MCP-first, not MCP-only. Hosted remote MCP is the default product. Local/self-host MCP is first-class. OpenAI-compatible gateway bridges are adoption aids, not the canonical write protocol.

## 3. Target Architecture

Core components:

- Agent hosts: Codex, Cursor, Claude Code, Copilot, OpenCode, Hermes, OpenClaw, Open WebUI through a bridge.
- Loomwright MCP server: exposes tools, resources, and prompts using one stable schema across hosted and self-hosted deployments.
- Auth layer: OAuth 2.1-style protected-resource flow for hosted; loopback token or self-host auth for local deployments.
- Canvas API: validates commands, enforces permissions, checks optimistic concurrency, records audit data, applies rate limits, and persists events.
- Canvas store: append-only event log, latest document snapshots, assets, comments, selections, render artifacts, and migration metadata.
- Web canvas app: human renderer/editor with live updates, comments, selection publishing, snapshots, share links, and event history.
- Render/sandbox service: asset proxy, export generation, sandboxed HTML preview, and allowlisted component rendering.
- Connectors and gateways: Hermes connector, OpenClaw/Open WebUI OpenAI-compatible proxy, MCP config examples, and SDK helpers.

Flow:

```text
Agent host
  -> Loomwright MCP server
  -> Canvas API
  -> Evented canvas store
  -> Web canvas app and render service
```

The agent-facing boundary stays small. Agents receive structured context and submit typed mutations. They do not execute arbitrary JavaScript, write raw database state, or persist React/HTML as the canonical artifact.

## 4. MVP Scope and Non-Goals

MVP scope:

- Structured canvas schema v1 with blocks, assets, comments, selections, events, and snapshots.
- Local MCP server and hosted-compatible MCP server code path.
- Evented store with optimistic concurrency and idempotent writes.
- Web renderer/editor for core block types.
- Current selection publishing and selection-aware agent edits.
- Anchored comments and comment resolution.
- Snapshot creation and version diff support.
- Asset registration and proxied asset rendering.
- Sandboxed HTML import as a gated escape hatch.
- Agent prompt pack for orientation, selected edits, validation repair, review, and change summaries.
- Paper-like acceptance flow: connect an MCP client, ask the agent to create a red rectangle and caption in a frame, verify visible mutation, then revise through a comment.

Explicit non-goals for v1:

- Full Figma replacement.
- General-purpose whiteboard product.
- Arbitrary React, JSX, RSC, or HTML as source of truth.
- Generic "run JavaScript on canvas" tool.
- Browser extension.
- Open WebUI Channels plugin.
- Real-time multiplayer beyond the minimum needed for live canvas updates.
- Design-system management, prototyping animations, or production app hosting.
- Treating screenshots as the only agent context.

## 5. Repo and Package Structure

Use a TypeScript monorepo.

```text
apps/
  web/                         # Canvas UI, renderer, comments, selection, snapshots
  mcp-local/                   # Local stdio/http launcher around the shared MCP server
  api/                         # Hosted Canvas API and MCP HTTP deployment entrypoint
  openai-gateway/              # OpenAI-compatible bridge for OpenClaw/Open WebUI

packages/
  canvas-schema/               # JSON Schema, TypeScript types, validators, migrations
  canvas-store/                # Event log, snapshots, optimistic concurrency, storage adapters
  canvas-ops/                  # Typed operation definitions, validation, diff helpers
  mcp-server/                  # Shared MCP tools, resources, prompts, output schemas
  auth/                        # Hosted OAuth scopes, token checks, local token support
  renderer/                    # Shared block renderer primitives and render ladder
  sandbox/                     # HTML sandbox policy, asset proxy contracts, export jobs
  sdk/                         # Client helpers for connectors and tests
  prompts/                     # Versioned prompt templates

connectors/
  hermes/                      # Session bootstrap, token minting, prompt injection, sidecar config
  openclaw/                    # Config examples and bridge integration helpers

examples/
  codex/
  cursor/
  claude-code/
  openwebui/

docs/
  PLAN.md
  protocol/
  integrations/
```

Keep storage adapters behind `packages/canvas-store`: start with SQLite for local/self-host and Postgres for hosted. Keep MCP tool schemas in `packages/mcp-server` and import canvas validators from `packages/canvas-schema`; do not duplicate schemas in app code.

## 6. Canvas Protocol v1 Summary

Canonical document:

- JSON document with `schema`, `canvasId`, `version`, `title`, `rootBlockId`, `blocks`, `assets`, `threads`, and `latestSnapshot`.
- Every block uses a common envelope: `id`, `type`, `parentId`, `orderKey`, `bounds`, `layout`, `props`, `style`, `locks`, and `meta`.
- Public editing targets stable block IDs and order keys, not array indexes.
- Assets are stored separately and referenced by `assetId`.
- Comments are structured threads anchored to block IDs, JSON paths, text ranges, or canvas rectangles.
- Selection is user/session scoped and can be published as context, but it is not permanent canvas truth.

Core v1 block types:

- `root`
- `frame`
- `group`
- `stack`
- `grid`
- `text`
- `shape`
- `connector`
- `image`
- `table`
- `code`
- `embed`
- `html_sandbox`
- `component_ref`

Default rendering ladder:

1. Structured blocks rendered by Loomwright components.
2. Safe Markdown subset inside text/code blocks.
3. Sandboxed HTML in a separate-origin iframe with restrictive policy.
4. Allowlisted component references with pinned component versions and JSON-schema props.
5. Generated application code as export only.

Events:

- Append-only event log with `eventId`, `canvasId`, `seq`, `baseVersion`, `resultVersion`, `type`, `actor`, `target`, `ops`, `summary`, `createdAt`, and `clientMutationId`.
- Required event families: canvas, block, asset, selection, comment, snapshot, permission, and render policy.
- Snapshots are compact content-addressed states used for fast reload and rollback.

Concurrency:

- Every write requires `baseVersion`.
- Every mutating call accepts `clientMutationId`.
- Stale writes return structured conflicts with current version, changed blocks, and retry guidance.
- No last-write-wins for agent edits.

## 7. MCP Tool, Resource, and Prompt List

Use the `loomwright_` prefix for tool names to avoid collisions.

Resources:

- `loomwright://canvases`
- `loomwright://canvases/{canvasId}/manifest`
- `loomwright://canvases/{canvasId}/snapshot/latest`
- `loomwright://canvases/{canvasId}/snapshot/{version}`
- `loomwright://canvases/{canvasId}/events?after={seq}`
- `loomwright://canvases/{canvasId}/selection/current`
- `loomwright://canvases/{canvasId}/comments`
- `loomwright://canvases/{canvasId}/assets/{assetId}`
- `loomwright://schemas/canvas/v1`
- `loomwright://schemas/events/v1`

Read tools:

- `loomwright_get_manifest`
- `loomwright_get_snapshot`
- `loomwright_get_selection`
- `loomwright_get_block`
- `loomwright_query_blocks`
- `loomwright_get_events`
- `loomwright_get_comments`
- `loomwright_diff_versions`
- `loomwright_export_preview`

Write tools:

- `loomwright_create_canvas`
- `loomwright_apply_ops`
- `loomwright_set_text`
- `loomwright_upsert_asset`
- `loomwright_add_comment`
- `loomwright_reply_comment`
- `loomwright_resolve_comment`
- `loomwright_create_snapshot`
- `loomwright_set_selection`
- `loomwright_import_html_sandbox`
- `loomwright_register_component_ref`

`loomwright_apply_ops` is the canonical write path. Narrow tools like `loomwright_set_text` and comment tools exist because models call them reliably and they simplify permission checks. Every write returns `canvasId`, `baseVersion`, `resultVersion`, `eventIds`, `affectedBlockIds`, `warnings`, and a preview resource URI.

Prompts:

- `loomwright_canvas_agent`
- `loomwright_canvas_orientation`
- `loomwright_edit_selected`
- `loomwright_wireframe_from_brief`
- `loomwright_review`
- `loomwright_summarize_changes`
- `loomwright_repair_validation_errors`
- `loomwright_export_to_code_plan`

Default agent prompt contract:

```text
Use Loomwright for visual plans, flows, UI states, diagrams, and review artifacts. Read the current canvas before mutating it. Prefer structured patches over wholesale replacement. Preserve existing user content unless asked to replace it. After substantial changes, create a snapshot and include the canvas link in your response.
```

## 8. Hermes Integration Path

Build a first-party Hermes gateway connector around the hosted MCP server. Do not fork the Loomwright protocol for Hermes.

Minimum flow:

1. User opens or creates a Loomwright canvas from Hermes chat.
2. Hermes connector creates an `agent_session` scoped to tenant, workspace, canvas, user, and agent run.
3. Loomwright returns `mcp_url`, short-lived token or OAuth authorization URL, `canvas_url`, and the prompt snippet.
4. Hermes registers the remote MCP server for the current agent session or proxies MCP calls through its tool gateway.
5. Hermes renders `canvas_url` as a sidecar and subscribes or polls for canvas events.
6. Tool usage is attributed to the Hermes session for billing, audit, and debugging.

If Hermes cannot register remote MCP in v1, fallback to session creation plus sidecar rendering plus copy-paste MCP config. Keep the MCP server and canvas protocol unchanged.

Hermes-specific code owns only bootstrap, token minting, prompt injection, UI placement, and telemetry correlation.

## 9. OpenClaw and Other Agent Integration Path

Preferred OpenClaw path:

1. Configure Loomwright as remote or local MCP in the OpenClaw agent runtime when MCP is available.
2. Keep Open WebUI connected to OpenClaw through its OpenAI-compatible endpoint.
3. Add the Loomwright prompt snippet to the OpenClaw agent configuration.
4. Open the Loomwright canvas URL as a sidecar tab or embedded pane.

Bridge path for low-friction Open WebUI adoption:

1. Provide `apps/openai-gateway` at local `http://localhost:18880/v1` and hosted `https://gateway.loomwright.com/v1`.
2. User points Open WebUI at the Loomwright gateway instead of directly at OpenClaw.
3. Gateway forwards chat completions to OpenClaw, injects Loomwright instructions, and attaches canvas links and metadata.
4. When downstream tool calling is available, pass through Loomwright tool definitions. When it is not, degrade to prompt-guided behavior and explicit links.

Other agents:

- Publish MCP config snippets for Codex, Cursor, Claude Code, Copilot, OpenCode, and local stdio/http clients.
- Keep one shared prompt pack and one shared schema.
- Avoid per-agent bespoke write APIs.

## 10. Hosted vs OSS Boundary and Pricing Sketch

Open-source core:

- Canvas schema and event format.
- Local MCP server.
- Basic web renderer/editor.
- CLI for serve, import, and export.
- Single-tenant self-host server with SQLite/Postgres adapters.
- SDK examples, prompt templates, and MCP config snippets.
- OpenAI-compatible bridge reference implementation.

Hosted-only:

- Managed remote MCP endpoint.
- OAuth 2.1 authorization, per-canvas scopes, and short-lived agent sessions.
- Multi-tenant workspaces, roles, billing, quotas, and spend controls.
- Durable hosted history, backups, attachment storage, and collaboration presence.
- Audit logs, admin console, SSO/SCIM, retention controls, data residency, and SLA.
- Managed Hermes/OpenClaw connectors.
- Hosted share/review links.
- Hosted sandbox/render/export service.

Pricing sketch:

| Tier | Price | Included | Boundary |
| --- | ---: | --- | --- |
| OSS self-host | $0 | Local MCP, schema, renderer/editor, single-tenant persistence, export/import, SDK examples | No hosted sync, managed OAuth, billing, SLA, or multi-tenant admin |
| Cloud Free | $0 | 1 user, 3 active canvases, 1,000 MCP tool ops/month, 30-day history, public share links | Trial and personal demos |
| Cloud Pro | $15/user/month or $150/year | Unlimited personal canvases, 10,000 MCP tool ops/month, private canvases, 1 GB attachments, 180-day history, comments, snapshots | $5 per extra 10,000 ops |
| Team | $25/user/month | Shared workspaces, roles, prompts, audit-lite, 50,000 pooled ops/month, 10 GB storage, Hermes/OpenClaw connector | $10 per extra 50,000 pooled ops |
| Enterprise | Custom | SSO/SAML/OIDC, SCIM, retention, audit export, private deployment, data residency, custom limits, support | Annual contract |

Meter hosted usage as `MCP tool operation`, not model tokens. Loomwright controls canvas state, storage, rendering, history, and collaboration; the user's agent runtime controls inference.

## 11. Implementation Phases and Verification Gates

Phase 0: Protocol skeleton.

- Create schema package, block envelopes, event envelopes, operation schemas, and fixtures.
- Gate: JSON Schema validation passes for valid fixtures and rejects malformed blocks, stale events, bad anchors, unsafe sandbox policies, and missing `baseVersion`.

Phase 1: Evented store.

- Implement snapshots plus append-only events with SQLite local adapter and Postgres-ready interfaces.
- Gate: concurrency tests prove stale writes fail, idempotent writes dedupe, snapshots restore, and diffs match event history.

Phase 2: MCP server.

- Implement resources, read tools, write tools, prompt templates, structured errors, and output schemas.
- Gate: MCP client can list canvases, read a manifest, apply a block operation, create a comment, and create a snapshot.

Phase 3: Web canvas app.

- Render core blocks, publish selection, show comments, apply live updates, and display snapshots/events.
- Gate: Paper-like red rectangle test passes in browser: agent creates a rectangle and caption, human sees mutation, human comments, agent revises selected content.

Phase 4: Safety and rendering.

- Add asset proxy, sandboxed HTML import, component registry stub, export preview, and destructive-change checks.
- Gate: untrusted HTML cannot access app origin, scripts are disabled by default, component refs require allowlist, and large deletes require explicit affected counts.

Phase 5: Hosted auth and quotas.

- Add tenant/workspace/canvas permissions, OAuth-style token checks, rate limits, usage events, and billing counters.
- Gate: unauthorized calls fail, scoped tokens cannot cross canvases, quota errors are structured and agent-readable, audit records exist for every write.

Phase 6: Integrations.

- Build Hermes connector and OpenAI-compatible gateway bridge.
- Gate: Hermes can create a session, attach MCP, render sidecar, and attribute usage; Open WebUI can route through gateway and surface canvas links.

## 12. Risks and Mitigations

Risk: MCP client support differs across agent hosts.
Mitigation: support hosted Streamable HTTP, local stdio/http, exact client config snippets, and an OpenAI-compatible bridge for Open WebUI-style stacks.

Risk: agents misuse broad write tools or hallucinate operations.
Mitigation: small prefixed tool surface, strict JSON schemas, narrow convenience tools, structured validation errors, and repair prompts.

Risk: hosted OAuth and remote MCP add implementation complexity.
Mitigation: start with canvas-scoped short-lived tokens and standard OAuth metadata; keep local auth simple and isolated.

Risk: agent writes damage user work.
Mitigation: optimistic concurrency, snapshots, event rollback, destructive-change summaries, human approval flags, and scoped permissions.

Risk: generated HTML/React becomes a security and persistence trap.
Mitigation: structured blocks as default, HTML only in sandboxed iframe, component refs only from allowlisted registry, generated code as export only.

Risk: bridge path becomes a second canonical protocol.
Mitigation: gateway forwards or prompts toward the same MCP/canvas operations and never owns a separate document model.

Risk: v1 tries to become a full design suite.
Mitigation: scope the product to agent-readable visual workspaces, core blocks, comments, snapshots, and integrations.

## 13. First Sprint Task List for Codex Execution

1. Initialize the TypeScript monorepo with `apps/web`, `apps/mcp-local`, `apps/api`, and core `packages/*`.
2. Implement `packages/canvas-schema` with v1 JSON Schemas, TypeScript types, fixtures, and validator tests.
3. Implement `packages/canvas-ops` with typed operations for create, update, move, delete, set text, comments, assets, snapshots, and selection.
4. Implement `packages/canvas-store` with an in-memory store plus SQLite adapter, append-only events, snapshots, optimistic concurrency, and idempotency.
5. Implement `packages/mcp-server` with resources, `loomwright_get_manifest`, `loomwright_get_snapshot`, `loomwright_get_selection`, `loomwright_apply_ops`, `loomwright_set_text`, comment tools, and prompt templates.
6. Wire `apps/mcp-local` to run the MCP server against a local workspace database.
7. Build `apps/web` minimal canvas renderer for frame, stack, grid, text, shape, connector, image placeholder, table, and code blocks.
8. Add selection publishing, comments panel, event list, and snapshot controls to the web app.
9. Add the red-rectangle acceptance fixture and an automated smoke test that applies MCP ops and verifies the rendered canvas state.
10. Add sandbox policy stubs for `html_sandbox` and reject unsafe imports until the sandbox service is implemented.
11. Document Codex, Cursor, Claude Code, and OpenClaw local MCP config examples under `examples/`.
12. Add a first Hermes connector stub that creates a session object, returns `mcp_url`, `canvas_url`, token placeholder, and prompt snippet.
13. Add an OpenAI-compatible gateway skeleton that forwards chat to an upstream OpenClaw URL and injects the Loomwright prompt.
14. Add CI tasks for typecheck, schema tests, store tests, MCP smoke tests, and web build.
