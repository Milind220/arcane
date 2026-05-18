# Analyst A - Integration Architecture

## Recommendation

Arcane should be MCP-first, not MCP-only. The default commercial integration surface should be a hosted remote MCP server over Streamable HTTP, with a local/self-hosted MCP server using the same tool schemas and storage protocol. Hermes should get a first-party gateway connector that provisions the hosted MCP endpoint, injects the right prompt/context, and renders the canvas sidecar. OpenClaw and other agents should use the hosted/local MCP path when their runtime supports MCP, with an OpenAI-compatible gateway bridge as a secondary adoption path for Open WebUI-style chat frontends.

The reason is practical: MCP is now positioned as a broad standard for connecting AI applications to tools, data, and workflows, with official docs emphasizing broad client/server support and "build once and integrate everywhere" semantics. Paper.design proves the specific product pattern Arcane wants: an agent reads and writes a visual canvas through MCP, and users verify success by seeing the canvas mutate. OpenClaw/Open WebUI, meanwhile, demonstrate a parallel integration pattern through OpenAI-compatible endpoints and a gateway. Arcane should support both patterns, but the canonical surface should remain MCP because it exposes real canvas operations instead of only chat messages.

Hosted MCP is good as the primary product boundary because it enables account auth, tenant isolation, collaboration, usage metering, paid tool limits, persistent canvas storage, and shareable workspaces. Remote MCP docs describe internet-hosted servers as accessible from any MCP client with an internet connection, and MCP authorization guidance maps cleanly to OAuth-backed user consent, audit, rate limiting, and enterprise controls.

Hosted MCP is bad as the only path. Some users need local-only data, some clients have uneven remote MCP/OAuth support, and local development environments still benefit from a `127.0.0.1` loopback server. The product should therefore ship one protocol implementation with two deployments: hosted SaaS and self-host/local. Avoid a hosted-only architecture that makes the open-source core a toy.

## Target Architecture

```
Agent host
  - Codex, Claude, Cursor, OpenCode, Hermes, OpenClaw, Open WebUI bridge
        |
        | MCP Streamable HTTP or local stdio/http
        v
Arcane MCP server
  - tools, resources, prompts
  - OAuth/resource-scoped auth for hosted
  - local token/config auth for self-host
        |
        v
Canvas API
  - workspace/canvas/session authorization
  - command validation
  - idempotency and rate limits
        |
        v
Canvas state
  - event log
  - current block tree/document snapshot
  - comments, selections, snapshots, render artifacts
        |
        v
Web canvas app
  - human visual editing/review
  - realtime updates
  - share links and embeds
```

Keep the agent-facing boundary small. The MCP server should not expose arbitrary React execution or direct database primitives. It should expose canvas reads, structured patch writes, comments, snapshots, and render/status resources. The Canvas API should own validation, permissions, version checks, and event persistence.

## Hermes: Minimum Viable Integration

Build a first-party Hermes gateway connector around the hosted MCP server. The connector should require no agent source-code changes; it should operate at session setup and request routing time.

Minimum path:

1. Hermes user opens or creates an Arcane canvas from chat.
2. Hermes connector calls Arcane to create an `agent_session` scoped to `{tenant_id, workspace_id, canvas_id, user_id}`.
3. Arcane returns:
   - `mcp_url`, for example `https://api.arcane.dev/mcp`.
   - A short-lived bearer/OAuth token or an OAuth authorization URL.
   - `canvas_url`, for example `https://app.arcane.dev/w/{workspace}/c/{canvas}`.
   - A prompt snippet telling the agent when and how to use Arcane.
4. Hermes registers the MCP server with the current agent session, or proxies MCP tool calls if Hermes centralizes tool execution.
5. Hermes renders the `canvas_url` as a sidecar next to chat and subscribes to canvas events for live updates.

If Hermes already has a tool gateway abstraction, the connector should live there rather than in agent code. If Hermes does not yet support remote MCP registration, the MVP fallback is still useful: Hermes can mint the canvas/session, display the sidecar, and give the user a copy-paste MCP config plus the session prompt. That is less elegant but keeps the protocol stable.

The connector should not translate Arcane commands into a bespoke Hermes-only protocol. It should pass through MCP calls to the same hosted server used by other clients. Hermes-specific code should only handle session bootstrap, token minting, prompt injection, UI placement, and telemetry correlation.

## OpenClaw and Open WebUI: Minimum Viable Integration

OpenClaw/Open WebUI need two paths because their documented integration centers on an OpenAI-compatible gateway, while Arcane's best write surface is MCP.

Path A, preferred when the agent runtime supports tools/MCP:

1. Configure Arcane as a remote or local MCP server in the OpenClaw agent runtime.
2. Keep Open WebUI connected to OpenClaw through its documented OpenAI-compatible endpoint.
3. Add the Arcane prompt snippet to the OpenClaw agent configuration.
4. Open the Arcane `canvas_url` as a sidecar tab or embedded pane.

This preserves Open WebUI as the chat frontend and lets the agent perform first-class canvas operations through MCP.

Path B, bridge for low-friction Open WebUI adoption:

1. Provide an Arcane OpenAI-compatible proxy endpoint, for example `http://localhost:18880/v1` or `https://gateway.arcane.local/v1`.
2. Users configure Open WebUI's OpenAI connection to the Arcane proxy instead of directly to OpenClaw.
3. The proxy forwards chat completions to the OpenClaw gateway at `http://localhost:18789/v1`, injects canvas instructions, and adds canvas metadata/deep links to responses.
4. When function/tool calling is available through the downstream agent runtime, the proxy can pass Arcane tool definitions through. When it is not available, the proxy should degrade to prompt-guided behavior and explicit links rather than pretending it can guarantee canvas writes.

Path B should be treated as an onboarding bridge, not the core architecture. OpenAI-compatible chat APIs are good for routing chat between frontends and agents; they are weaker than MCP for exposing discoverable resources, typed tools, prompts, subscriptions, and permissioned write operations.

Do not prioritize the Open WebUI Channels plugin for v1. The docs identify it as community-contributed and not maintained by Open WebUI or OpenClaw teams. It can be a later integration for bot-in-channel workflows, not the foundation for canvas writes.

## Hosted Remote MCP vs Local/Self-hosted MCP

Hosted remote MCP should be the default:

- It supports Arcane's monetizable boundary: authenticated tool usage, paid write/render limits, persistent storage, collaboration, team administration, audit logs, and share links.
- It avoids per-device installation for users whose agents can connect to remote MCP servers.
- It lets Arcane run expensive or stateful services server-side: render snapshots, asset processing, version storage, and realtime fanout.
- It is aligned with remote MCP guidance that remote servers are internet-hosted and available from clients with network access.

Local/self-hosted MCP should remain a first-class deployment:

- It supports private projects, air-gapped environments, and local-first developers.
- It reduces latency for local agent sessions.
- It gives open-source credibility to the core protocol and avoids locking the canvas schema to SaaS.
- It provides a fallback for clients with incomplete remote MCP or OAuth support.

Use the same MCP tool names, resource URI shapes, prompt names, and JSON schemas in both deployments. The difference should be auth/storage backend, not agent behavior.

## Auth, Tenancy, and Permissions

Hosted MCP should use OAuth 2.1-style authorization for remote clients. MCP authorization docs recommend authorization when servers access user-specific data, need audit trails, require user consent, serve enterprise controls, or need per-user rate limiting. Arcane has all of those properties.

Model the permission hierarchy as:

- `tenant`: billing, plan, admin policy, data residency.
- `workspace`: team/project boundary.
- `canvas`: the unit of visual state and sharing.
- `agent_session`: short-lived authorization for one agent conversation or run.
- `actor`: human user, service account, or agent identity.

Recommended OAuth scopes:

- `arcane:canvas.read`
- `arcane:canvas.write`
- `arcane:canvas.comment`
- `arcane:canvas.snapshot`
- `arcane:workspace.read`
- `arcane:workspace.admin`

Tokens should include or resolve to `tenant_id`, `workspace_id`, `user_id`, `actor_type`, `plan_id`, `scopes`, and an audience bound to the Arcane MCP/API origin. For agent sessions, prefer short-lived tokens and canvas-scoped access. Avoid giving an agent tenant-wide write authority unless the user explicitly authorizes it.

Every mutating operation should require:

- Scope check.
- Canvas permission check.
- Current document version or base event id.
- Idempotency key.
- Tool-call audit record.
- Optional human confirmation flag for destructive or broad operations.

For local/self-hosted MCP, support simpler auth modes:

- Loopback-only HTTP bound to `127.0.0.1`.
- Static local token or config file secret.
- Self-host OAuth for teams that want parity with SaaS.

Follow MCP transport security guidance for local HTTP: bind to localhost, validate origins, and require authentication for nontrivial connections.

## Rate Limits and Monetization Boundary

Rate limits should be product primitives, not only abuse controls.

Meter by `{tenant_id, actor_id, canvas_id, tool_name}` and assign operation weights:

- Read operations: low cost, high quota.
- Search/tree/selection reads: low to medium cost depending on result size.
- Patch writes: medium cost, stricter burst control.
- Snapshot/render/export: high cost, plan-gated.
- Large asset ingestion or sandboxed HTML rendering: highest cost, explicit quota.

Apply both technical and commercial limits:

- Per-minute and per-hour burst limits to protect the service.
- Monthly included tool units by plan.
- Separate limits for render/export/storage.
- Enterprise overrides and audit export.

Return structured, agent-readable limit errors. A rate-limit response should include reset time, remaining quota where safe, and a suggested smaller operation. This helps agents recover by batching less aggressively instead of failing the whole task.

## Tool Naming, Resources, and Prompts

Use stable, prefixed MCP names. Paper's tool list is concrete and action-oriented (`get_selection`, `get_node_info`, `write_html`, `update_styles`, etc.), but Arcane should add a product prefix to reduce collisions and improve recognizability in multi-server agent sessions.

Recommended v1 tool names for Analyst A scope:

- `arcane_get_workspace`
- `arcane_get_canvas`
- `arcane_get_selection`
- `arcane_search_canvas`
- `arcane_apply_patch`
- `arcane_add_comment`
- `arcane_create_snapshot`
- `arcane_get_render_status`

Keep writes concentrated in `arcane_apply_patch` rather than exposing many overlapping mutators. This makes auth, audit, optimistic concurrency, validation, and rollback simpler. The patch schema can still support multiple operations internally.

Recommended resource URI patterns:

- `arcane://workspace/{workspace_id}`
- `arcane://canvas/{canvas_id}`
- `arcane://canvas/{canvas_id}/selection`
- `arcane://canvas/{canvas_id}/snapshot/{snapshot_id}`
- `arcane://canvas/{canvas_id}/events?after={event_id}`

Recommended MCP prompt:

- `arcane_canvas_agent`: tells the model to inspect canvas context before writing, make structured patches, preserve existing content unless asked to replace it, keep changes small enough to review, and snapshot after major milestones.

MCP tools should return structured content with output schemas whenever possible. The MCP tools specification supports structured tool results and output schemas; Arcane should use that for predictable agent parsing and client validation.

## Agent Prompt Contract

The connector or onboarding docs should add this prompt snippet to agent sessions:

```text
You have access to Arcane, a living visual canvas. When the user asks for UI, diagrams, workflows, visual artifacts, or changes to an existing canvas, use the Arcane tools instead of only describing the result. Read the current canvas before mutating it. Prefer structured patches over wholesale replacement. Preserve existing user content unless the user asks to replace it. After substantial changes, create a snapshot and include the canvas link in your response.
```

For hosted Hermes sessions, inject this automatically. For generic MCP clients, expose it as an MCP prompt and include it in onboarding docs. For OpenClaw/Open WebUI bridge mode, prepend it at the proxy or agent configuration layer.

## Adoption Strategy

The adoption ladder should be:

1. Hosted remote MCP with OAuth: best for SaaS users, teams, collaboration, and monetization.
2. Hermes gateway connector: best first-party product integration, with automatic prompt/tool/canvas setup.
3. Local/self-hosted MCP: best for privacy, open-source adoption, and clients with local-only support.
4. OpenAI-compatible bridge: best for Open WebUI/OpenClaw chat routing and low-friction trials.
5. Browser extension: defer. It can help capture webpages or overlay canvas previews later, but it is not the right write protocol.

This ladder keeps near-zero agent source changes as the rule: users add an MCP server, connect a gateway, or point Open WebUI at a proxy. Agents discover tools through the host instead of being rewritten.

## Risks and Mitigations

Risk: MCP client support differs across agents.
Mitigation: maintain hosted Streamable HTTP, local HTTP/stdio, and a small OpenAI-compatible bridge; publish exact config snippets for top clients.

Risk: agents hallucinate tool names or misuse broad patch tools.
Mitigation: small tool surface, strict JSON schemas, structured errors, prompt guidance, and optional guided workflows.

Risk: hosted OAuth is hard to implement correctly.
Mitigation: use standard OAuth 2.1 flows and consider managed/serverless helpers for the first remote MCP deployment. Cloudflare's remote MCP materials show a Workers OAuth provider pattern that can wrap MCP endpoints and support dynamic client registration and metadata.

Risk: agent writes damage user work.
Mitigation: optimistic concurrency, patch previews for destructive changes, snapshots, undo from event log, and per-canvas permissions.

Risk: the OpenAI-compatible bridge becomes a second protocol.
Mitigation: treat the bridge as a bootstrap/router. The canonical write API remains MCP plus the Canvas API.

## Source Notes

- Paper.design MCP docs show the target UX: agents can read and write design files, users connect many agent clients to a local MCP endpoint, and a simple verification prompt creates a visible rectangle on the canvas. Paper's reference tools also show a practical read/write visual tool surface: https://paper.design/docs/mcp
- MCP introduction docs define MCP as an open-source standard for connecting AI apps to external systems and note broad ecosystem support: https://modelcontextprotocol.io/docs/getting-started/intro
- MCP transport docs define stdio and Streamable HTTP, including local security guidance and HTTP endpoint behavior: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- MCP authorization docs recommend OAuth-style authorization for user data, audit, consent, enterprise access controls, and per-user rate limiting: https://modelcontextprotocol.io/docs/tutorials/security/authorization
- MCP remote server docs describe remote MCP servers as internet-hosted tools/resources and emphasize accessibility from clients with network access: https://modelcontextprotocol.io/docs/develop/connect-remote-servers
- MCP tools docs define model-invoked tools, schemas, structured content, output schemas, access controls, and rate limiting considerations: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- Cloudflare's remote MCP post shows a practical hosted MCP/OAuth implementation pattern on Workers, including `workers-oauth-provider`, `McpAgent`, and dynamic client registration support: https://blog.cloudflare.com/remote-model-context-protocol-servers-mcp/
- OpenClaw/Open WebUI docs show OpenClaw's OpenAI-compatible gateway path, default gateway port `18789`, the `/v1` connection URL, model routing, and the warning that Channels plugin is community-maintained: https://docs.openwebui.com/getting-started/quick-start/connect-an-agent/openclaw/
- Vercel AI SDK generative UI docs are useful background for rich streamed UI, but they reinforce that framework-specific UI rendering should not become Arcane's canonical integration protocol: https://vercel.com/blog/ai-sdk-3-generative-ui
