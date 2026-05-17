# Analyst B - Canvas Protocol + Generative UI

## Recommendation

Loomwright v1 should use MCP as the agent integration surface, but the product protocol should be a Loomwright-owned canvas document model: versioned JSON blocks, append-only events, comments, selection context, assets, and snapshots. Agents should mutate the canvas through typed MCP tools. Humans should see those mutations in a live canvas renderer.

Do not make generated React, arbitrary HTML, or screenshots the canonical artifact. Vercel-style generative UI is useful as a rendering pattern: tool calls produce typed data, and the client maps that data to UI components. For Loomwright, the durable source of truth should be structured canvas blocks and events. React can render them, but React should not define them.

This follows the source pattern:
- MCP is an open standard for connecting AI applications to external systems and exposes tools, resources, and prompts through a JSON-RPC data layer. Source: https://modelcontextprotocol.io/docs/getting-started/intro and https://modelcontextprotocol.io/docs/learn/architecture
- Paper.design proves the read/write canvas workflow: a local MCP server exposes the open design file, agents can inspect selections and write visible canvas changes, and the docs verify this by asking an agent to create a rectangle. Source: https://paper.design/docs/mcp
- Vercel AI SDK generative UI maps model tool calls/results to React components, which is useful for the client experience but too runtime-specific to be the canonical protocol. Source: https://vercel.com/blog/ai-sdk-3-generative-ui and https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces
- Remote MCP and OAuth-style authorization are viable for hosted Loomwright, including Streamable HTTP and bearer-token flows. Source: https://modelcontextprotocol.io/docs/tutorials/security/authorization and https://blog.cloudflare.com/remote-model-context-protocol-servers-mcp/
- Untrusted HTML should be isolated with sandboxed frames and strict capabilities. Source: https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html and https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe

## Design Goals

The canvas protocol should be:

- Durable: every visible artifact can be reloaded from JSON and assets without replaying a chat.
- Agent-friendly: tools accept small, typed operations instead of asking the model to emit a full document every time.
- Human-friendly: selection, comments, snapshots, and previews are first-class.
- Replayable: every change has an event, actor, base version, resulting version, and summary.
- Portable: self-hosted/local and hosted MCP servers expose the same schema.
- Renderer-neutral: React, SVG, HTML canvas, or native clients can render the same canonical document.
- Safe by default: structured blocks first, sandboxed HTML later, allowlisted components last.

## Canonical Canvas Model

Use a JSON document with a stable schema URI and monotonically increasing version. MCP has its own protocol version negotiation, including the `MCP-Protocol-Version` header for HTTP clients after initialization, but Loomwright still needs its own canvas schema version because the canvas document will evolve independently of MCP. Source: https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle

```json
{
  "schema": "https://loomwright.dev/schemas/canvas/v1.json",
  "canvasId": "canv_01JZEXAMPLE",
  "version": 42,
  "title": "Checkout redesign",
  "createdAt": "2026-05-17T12:00:00Z",
  "updatedAt": "2026-05-17T12:09:31Z",
  "rootBlockId": "blk_root",
  "blocks": {
    "blk_root": {
      "id": "blk_root",
      "type": "root",
      "parentId": null,
      "orderKey": "a0",
      "bounds": { "x": 0, "y": 0, "w": 0, "h": 0 },
      "props": {},
      "style": {},
      "meta": { "schemaVersion": 1 }
    }
  },
  "assets": {},
  "threads": {},
  "latestSnapshot": {
    "snapshotId": "snap_01JZEXAMPLE",
    "version": 40,
    "hash": "sha256:..."
  }
}
```

### Block Envelope

Every block should use the same envelope so agents can reason across types:

```json
{
  "id": "blk_01JZEXAMPLE",
  "type": "text",
  "parentId": "blk_frame_main",
  "orderKey": "m4",
  "bounds": { "x": 24, "y": 24, "w": 360, "h": 96 },
  "layout": { "mode": "none" },
  "props": { "text": "Welcome", "variant": "heading" },
  "style": { "fill": "#111827", "fontSize": 32 },
  "locks": { "position": false, "content": false },
  "meta": {
    "schemaVersion": 1,
    "createdBy": "agent:codex",
    "createdAt": "2026-05-17T12:09:31Z",
    "sourceMessageId": "msg_...",
    "name": "Hero title"
  }
}
```

Use stable IDs and `orderKey` rather than array index paths as the public editing model. The server can emit JSON Patch-style deltas for storage, audit, and sync, but agent-facing tools should accept typed operations like `create_block`, `set_text`, and `move_block`. JSON Patch is a useful standard for representing JSON changes, but raw path/index patches are easy for models to get wrong in reordered trees. Source for JSON Patch: https://www.rfc-editor.org/rfc/rfc6902

## Proposed v1 Block Types

| Type | Purpose | Required props | Notes |
| --- | --- | --- | --- |
| `root` | Document root | none | Internal only. |
| `frame` | Artboard/page/major canvas region | `name`, optional `preset` | Paper's `create_artboard` maps here. |
| `group` | Logical grouping without layout | none | Useful for bulk movement and selection. |
| `stack` | Auto-layout container | `direction`, `gap`, `padding`, `align`, `justify` | Prefer this over free-form React layout. |
| `grid` | Repeating two-dimensional layout | `columns`, `rows`, `gap` | Useful for product UI mockups and tables of cards. |
| `text` | Plain text or safe Markdown subset | `text`, `variant` | Raw HTML disabled inside text. |
| `shape` | Rect, ellipse, line, icon placeholder | `shape` | Covers boxes, chips, dividers, badges, basic diagrams. |
| `connector` | Arrow/line between blocks | `from`, `to`, `routing` | Enables flowcharts without arbitrary SVG. |
| `image` | Image asset reference | `assetId`, `alt` | Assets are separately stored and proxied. |
| `table` | Structured rows/columns/cells | `columns`, `rows` | Better than generated HTML tables for editing. |
| `code` | Code snippet | `language`, `code` | Rendered read-only unless explicitly edited. |
| `embed` | External URL or media preview | `url`, `kind` | Never grants the embed page canvas privileges. |
| `html_sandbox` | Sandboxed HTML fragment | `htmlAssetId`, `policy` | Gated escape hatch, not default output. |
| `component_ref` | Allowlisted renderer component plus JSON props | `componentId`, `props`, `componentVersion` | Gated extension, no arbitrary generated code. |

The core happy path is `frame`, `stack`, `grid`, `text`, `shape`, `connector`, `image`, `table`, and `code`. `html_sandbox` and `component_ref` exist so the protocol has an escape hatch, but they should require stricter permissions and validation.

## Event Schema

Use an append-only event log. The current canvas state is the latest snapshot plus events after that snapshot.

```json
{
  "eventId": "evt_01JZEXAMPLE",
  "canvasId": "canv_01JZEXAMPLE",
  "seq": 184,
  "baseVersion": 42,
  "resultVersion": 43,
  "type": "block.updated",
  "actor": {
    "type": "agent",
    "id": "codex",
    "displayName": "Codex"
  },
  "target": { "blockId": "blk_01JZEXAMPLE" },
  "ops": [
    {
      "op": "set_props",
      "blockId": "blk_01JZEXAMPLE",
      "props": { "text": "Welcome back" }
    }
  ],
  "summary": "Updated hero headline text.",
  "createdAt": "2026-05-17T12:10:11Z",
  "clientMutationId": "mut_01JZEXAMPLE"
}
```

Required event types:

- `canvas.created`
- `canvas.renamed`
- `block.created`
- `block.updated`
- `block.deleted`
- `block.moved`
- `block.reordered`
- `asset.created`
- `asset.deleted`
- `selection.changed`
- `comment.created`
- `comment.replied`
- `comment.resolved`
- `snapshot.created`
- `permission.changed`
- `render_policy.changed`

Events should be returned from write tools and exposed as an MCP resource. MCP supports notifications, and resources can be read by URI; Loomwright should use that shape for event polling/subscription rather than inventing per-agent webhooks first. Source: https://modelcontextprotocol.io/docs/learn/architecture and https://modelcontextprotocol.io/specification/2025-06-18/server/resources

## Versioning and Concurrency

Use optimistic concurrency:

- Every write tool requires `baseVersion`.
- The server rejects stale writes with a machine-readable conflict: current version, changed block IDs, and a suggested retry path.
- Idempotent writes include `clientMutationId`.
- The server returns `resultVersion`, `eventIds`, affected block IDs, and validation warnings.
- Schema migrations are explicit: `canvas.schema` and each block's `meta.schemaVersion` are versioned.
- Unknown block types render as locked fallback boxes with their JSON props available for inspection.

Do not rely on last-write-wins for agent edits. Two agents can otherwise silently overwrite the same text block, comment thread, or layout container.

## Selection Context

Selection is user/session scoped, not a permanent canvas fact. It becomes shared context only when a human or agent intentionally publishes it.

```json
{
  "selectionId": "sel_01JZEXAMPLE",
  "canvasId": "canv_01JZEXAMPLE",
  "viewerId": "user_123",
  "version": 42,
  "viewport": { "x": 0, "y": 0, "zoom": 0.8, "w": 1440, "h": 900 },
  "items": [
    {
      "blockId": "blk_hero_title",
      "textRange": { "start": 0, "end": 12 }
    }
  ],
  "updatedAt": "2026-05-17T12:10:00Z"
}
```

`canvas_get_selection` should return:

- Selected block envelopes and props.
- Ancestor chain and immediate siblings.
- Relevant comments anchored to the selection.
- A compact screenshot or preview only when explicitly requested.
- The current canvas version.

This mirrors Paper's emphasis on current file and current selection context. Paper exposes selection, node info, tree summaries, screenshots, JSX, and write operations through MCP tools. Source: https://paper.design/docs/mcp

## Comments

Comments should be structured threads, not text blocks. They anchor to blocks, JSON paths, text ranges, or canvas rectangles.

```json
{
  "threadId": "thr_01JZEXAMPLE",
  "canvasId": "canv_01JZEXAMPLE",
  "status": "open",
  "anchor": {
    "blockId": "blk_hero_title",
    "path": "/props/text",
    "rect": { "x": 24, "y": 24, "w": 360, "h": 96 }
  },
  "messages": [
    {
      "messageId": "cmt_01JZEXAMPLE",
      "actor": { "type": "user", "id": "user_123" },
      "body": "Try a more specific headline.",
      "createdAt": "2026-05-17T12:11:00Z"
    }
  ]
}
```

Agents need comment tools because comments are often the user's most precise instruction layer. A write operation that resolves a comment should include the resolving event ID and summary.

## Snapshots

Snapshots are compact, content-addressed canvas states:

```json
{
  "snapshotId": "snap_01JZEXAMPLE",
  "canvasId": "canv_01JZEXAMPLE",
  "version": 80,
  "hash": "sha256:...",
  "createdBy": "system",
  "createdAt": "2026-05-17T12:30:00Z",
  "reason": "auto"
}
```

Recommendations:

- Create automatic snapshots every N events and before large agent operations.
- Let humans create named checkpoints.
- Expose `snapshot/latest` and `snapshot/{version}` as MCP resources.
- Provide `canvas_diff_versions` for agent review before risky edits.
- Keep event logs as the audit trail, snapshots as fast reload points.

## Proposed MCP Surface

MCP servers expose tools for model-controlled actions, resources for readable context, and prompts for reusable templates. Source: https://modelcontextprotocol.io/docs/learn/architecture and https://modelcontextprotocol.io/specification/2025-06-18/server/index

### Resources

Use URI-addressable resources so clients can read context without invoking write tools.

| Resource URI | Purpose |
| --- | --- |
| `loomwright://canvases` | List canvases visible to the current token. |
| `loomwright://canvases/{canvasId}/manifest` | Title, version, permissions, frame list, block count, latest snapshot. |
| `loomwright://canvases/{canvasId}/snapshot/latest` | Latest compact canonical document. |
| `loomwright://canvases/{canvasId}/snapshot/{version}` | Historical canonical document. |
| `loomwright://canvases/{canvasId}/events?after={seq}` | Event stream page for incremental sync. |
| `loomwright://canvases/{canvasId}/selection/current` | Current user's published selection context. |
| `loomwright://canvases/{canvasId}/comments` | Open and recently resolved threads. |
| `loomwright://canvases/{canvasId}/assets/{assetId}` | Asset metadata and signed/proxied fetch URL. |
| `loomwright://schemas/canvas/v1` | JSON Schema for canvas documents and blocks. |
| `loomwright://schemas/events/v1` | JSON Schema for event envelopes. |

### Read Tools

| Tool | Purpose |
| --- | --- |
| `canvas_get_manifest` | Return high-level canvas facts without loading every block. |
| `canvas_get_snapshot` | Return a versioned snapshot, optionally compacted by frame/block IDs. |
| `canvas_get_selection` | Return selected blocks, nearby context, comments, and optional preview. |
| `canvas_get_block` | Return one block plus optional ancestors/children/siblings. |
| `canvas_query_blocks` | Search by type, name, text, frame, metadata, or comment status. |
| `canvas_get_events` | Return events after a sequence/version. |
| `canvas_get_comments` | Return threads filtered by block, status, actor, or frame. |
| `canvas_diff_versions` | Return a structured diff between versions or snapshots. |
| `canvas_export_preview` | Return PNG/SVG/PDF/HTML preview for selected blocks or frames. |

### Write Tools

| Tool | Purpose |
| --- | --- |
| `canvas_create` | Create a canvas or frame seed. |
| `canvas_apply_ops` | Transactionally apply typed operations with `baseVersion`. |
| `canvas_create_block` | Create a block under a parent with validated props. |
| `canvas_update_block` | Update props/style/layout for a block. |
| `canvas_move_blocks` | Move blocks across parents/frames with stable order keys. |
| `canvas_delete_blocks` | Delete or archive blocks. |
| `canvas_set_text` | Safer text-only mutation for selected text blocks. |
| `canvas_upsert_asset` | Register image/file assets and return asset IDs. |
| `canvas_add_comment` | Create a thread anchored to a block/path/rect. |
| `canvas_reply_comment` | Add a comment reply. |
| `canvas_resolve_comment` | Mark a thread resolved with linked event IDs. |
| `canvas_create_snapshot` | Create a named checkpoint. |
| `canvas_set_selection` | Publish agent focus/cursor when useful to the human. |
| `canvas_import_html_sandbox` | Convert uploaded HTML into a gated `html_sandbox` block. |
| `canvas_register_component_ref` | Create a `component_ref` only from an allowlisted registry entry. |

All write tools should return:

```json
{
  "canvasId": "canv_01JZEXAMPLE",
  "baseVersion": 42,
  "resultVersion": 43,
  "eventIds": ["evt_01JZEXAMPLE"],
  "affectedBlockIds": ["blk_01JZEXAMPLE"],
  "warnings": [],
  "preview": {
    "resourceUri": "loomwright://canvases/canv_01JZEXAMPLE/snapshot/43"
  }
}
```

### Prompts

Prompts should make agents better at using the tools without requiring agent source-code changes.

| Prompt | Purpose |
| --- | --- |
| `canvas_orientation` | Explain the available Loomwright tools, schema rules, and safe rendering ladder. |
| `canvas_edit_selected` | Use current selection as the edit target and ask clarifying questions only when needed. |
| `canvas_wireframe_from_brief` | Create structured frames/stacks/text/shapes from a product brief. |
| `canvas_review` | Inspect a canvas and create anchored comments for issues. |
| `canvas_summarize_changes` | Summarize event diffs between versions for the chat transcript. |
| `canvas_repair_validation_errors` | Fix schema validation errors from a failed write. |
| `canvas_export_to_code_plan` | Plan a code implementation from selected frames without treating canvas blocks as React source. |

## Paper.design Mapping

Paper's MCP server is a strong product reference because it lets agents read and write a visual design file through common agent hosts including Codex, Claude Code, Cursor, Copilot, and OpenCode. It uses a local HTTP MCP endpoint and exposes tools for selection, node inspection, screenshots, JSX, exports, artboard creation, HTML writing, text updates, renames, and duplication. Source: https://paper.design/docs/mcp

Loomwright should copy the workflow, not the exact data model.

| Paper pattern | Loomwright equivalent | Recommendation |
| --- | --- | --- |
| Current open file is implicit context | Active canvas from token/session or explicit `canvasId` | Hosted needs explicit tenancy; local can infer active canvas. |
| `get_selection` | `canvas_get_selection` | Make selection the default edit target. |
| `get_node_info`, `get_children`, `get_tree_summary` | `canvas_get_block`, `canvas_query_blocks` | Return structured block envelopes, not only visual descriptions. |
| `get_screenshot` and `export` | `canvas_export_preview` | Previews are optional context, not the source of truth. |
| `get_jsx` | `canvas_export_to_code_plan` or export tool | JSX is an export, not canonical storage. |
| `write_html` | `canvas_import_html_sandbox` plus structured conversion | HTML import should be gated and preferably converted to blocks. |
| `set_text_content` | `canvas_set_text` | Keep narrow text tools because models call them reliably. |
| Visible mutation verification | write tools return version/event IDs and UI updates live | Human trust depends on immediate visible changes. |

## Generative UI Recommendation

Use generative UI as the human-facing renderer and streaming interaction layer, not as the document protocol.

The Vercel AI SDK docs describe generative UI as connecting tool-call results to React components; the older AI SDK 3 announcement introduced streaming React Server Components from LLM/tool flows. Sources: https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces and https://vercel.com/blog/ai-sdk-3-generative-ui

For Loomwright:

- Tool result cards in chat can be React components: "created 6 blocks", "3 validation warnings", "preview version 43".
- The live canvas renderer can be React if the app is React, but it should render from `CanvasDocument` and events.
- `component_ref` blocks should store only `{ componentId, componentVersion, props }`, validated by JSON Schema against an allowlisted registry.
- Do not persist generated JSX/RSC payloads as canvas content.
- Do not require Next.js, RSC, or Vercel AI SDK for self-hosted core. They can be a reference client implementation.
- OpenAI-compatible chat bridges, such as the OpenClaw/Open WebUI path noted in the research sources, should still consume the same events and snapshots rather than a separate React artifact format. Source: https://docs.openwebui.com/getting-started/quick-start/connect-an-agent/openclaw/

### Rendering Ladder

1. Structured blocks: render with Loomwright-owned components. This is the default and should cover most product, diagram, document, and UI mockup work.
2. Safe Markdown subset: allowed inside `text` and `code` blocks after sanitization. No raw HTML.
3. Sandboxed HTML: `html_sandbox` blocks load a stored HTML asset in an iframe on a separate origin with restrictive sandbox and CSP. Scripts are disabled by default.
4. Allowlisted components: `component_ref` points to a pre-registered renderer component with pinned version and JSON-schema props.
5. Generated application code: export path only. It can become a repo artifact, not an in-canvas live block in v1.

OWASP recommends sandboxed iframes for untrusted content, and MDN warns that combining script execution with same-origin privileges can remove meaningful sandbox protection when embedded content shares an origin. Sources: https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html and https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe

## Permissions and Auth

For hosted MCP, map OAuth scopes to canvas operations:

- `canvas:read`
- `canvas:write`
- `canvas:comment`
- `canvas:export`
- `canvas:admin`
- `canvas:render:html`
- `canvas:render:component`

MCP authorization guidance uses OAuth 2.1 patterns with protected resource metadata and bearer tokens. Source: https://modelcontextprotocol.io/docs/tutorials/security/authorization

The server should enforce:

- Per-canvas ACLs on every resource/tool call.
- Separate permission gates for `html_sandbox` and `component_ref`.
- Audit events for every write.
- Rate limits by tenant, user, canvas, and tool.
- Human approval requirements for destructive bulk changes.

## Anti-Footguns

- Do not make arbitrary React, JSX, RSC payloads, or HTML the source of truth.
- Do not expose a generic "run JavaScript on the canvas" tool.
- Do not ask agents to rewrite the entire canvas document for small edits.
- Do not accept write operations without `baseVersion`.
- Do not use array-index JSON Patch paths as the main agent editing interface.
- Do not let screenshots become the only context; pair previews with structured block data.
- Do not put comments into visual text blocks unless the user explicitly wants visible notes.
- Do not treat selection as global truth; it is user/session scoped and can go stale.
- Do not auto-run scripts in imported HTML.
- Do not serve untrusted HTML from the same origin as the main app with powerful sandbox flags.
- Do not allow `component_ref` to load arbitrary packages or remote code selected by the model.
- Do not collapse assets into base64 strings in the main document; store assets separately.
- Do not let agents silently delete large subtrees; require affected count and summary in the tool result.
- Do not omit alt text, names, and semantic roles from blocks that will be exported or inspected.
- Do not overfit v1 to design mockups only; include text, tables, comments, and code so the canvas can replace static artifacts.

## v1 Build Recommendation

Build the smallest complete loop:

1. `@loomwright/canvas-schema`: JSON Schema, TypeScript types, validators, migration stubs.
2. Evented store: snapshots plus append-only events with optimistic concurrency.
3. MCP server: resources, read tools, narrow write tools, and prompt templates above.
4. Web renderer: structured blocks first, event subscription/polling, selection publishing, comments.
5. Safe render service: asset proxy, sandboxed HTML iframe path, allowlisted component registry.
6. Agent prompt pack: `canvas_orientation`, `canvas_edit_selected`, and `canvas_repair_validation_errors`.

The acceptance test should be Paper-like: connect Codex or another MCP host, ask it to create a red rectangle and a short caption in the selected frame, verify that the human sees the canvas mutate, then ask for a comment-threaded revision and verify that events, comments, and snapshots are all source-backed.

## Source URLs

- Research brief: `docs/RESEARCH_BRIEF.md`
- Local source notes: `docs/SOURCES.md`
- Paper.design MCP: https://paper.design/docs/mcp
- MCP introduction: https://modelcontextprotocol.io/docs/getting-started/intro
- MCP architecture: https://modelcontextprotocol.io/docs/learn/architecture
- MCP lifecycle/version negotiation: https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle
- MCP server primitives: https://modelcontextprotocol.io/specification/2025-06-18/server/index
- MCP resources: https://modelcontextprotocol.io/specification/2025-06-18/server/resources
- MCP tools: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- MCP prompts: https://modelcontextprotocol.io/specification/2025-06-18/server/prompts
- MCP authorization: https://modelcontextprotocol.io/docs/tutorials/security/authorization
- Cloudflare remote MCP: https://blog.cloudflare.com/remote-model-context-protocol-servers-mcp/
- Vercel AI SDK 3 generative UI: https://vercel.com/blog/ai-sdk-3-generative-ui
- AI SDK generative user interfaces: https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces
- OWASP HTML5 sandboxed frames: https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html
- MDN iframe sandbox: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe
- JSON Patch RFC 6902: https://www.rfc-editor.org/rfc/rfc6902
- OpenClaw/Open WebUI: https://docs.openwebui.com/getting-started/quick-start/connect-an-agent/openclaw/
