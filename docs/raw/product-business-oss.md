# Analyst C: Product, Business, and Open Source Boundary

Accessed: 2026-05-17.

## Product thesis

Loomwright should be positioned as the agent-native canvas for work that is too visual and stateful to live in chat, but too early or fluid to become a hard-coded app. The wedge is simple: add a Loomwright MCP server to Codex, Cursor, Claude Code, Copilot, OpenCode, Hermes, or OpenClaw; ask the agent to create or update a workspace; see the result as a living canvas instead of a static HTML artifact link.

This is not "Figma for agents" as a broad design-suite claim. It is narrower and more valuable: a shared visual workspace where agents can read current canvas state, apply structured mutations, attach rationale, and let humans inspect or steer the next step. Paper.design shows the key behavior: its desktop MCP server lets agents mutate a visible design file, and its docs validate the connection by asking an agent to create a red rectangle in the document ([Paper MCP docs](https://paper.design/docs/mcp)). Figma's current pricing page also lists MCP support for sharing design context with AI coding agents, which confirms that agent-accessible design state is now a mainstream workflow, not a novelty ([Figma pricing](https://www.figma.com/pricing/)).

The product should stay MCP-first because MCP is explicitly positioned as an open standard for connecting AI apps to data, tools, and workflows, with broad client support across ChatGPT, Claude, VS Code, Cursor, and others ([MCP intro](https://modelcontextprotocol.io/docs/getting-started/intro)). Hosted remote MCP is the commercial center: Cloudflare's remote MCP work shows authenticated internet-hosted MCP servers are becoming viable, including OAuth, remote transport, and adapters for clients that only support local MCP today ([Cloudflare remote MCP](https://blog.cloudflare.com/remote-model-context-protocol-servers-mcp/)).

## Market positioning

Primary buyer:

- Individual AI-heavy builders who already use Codex, Cursor, Claude Code, or OpenClaw and are tired of one-off artifact previews.
- Small product teams using agents for specs, prototypes, flows, dashboards, product reviews, and implementation planning.
- Agent platform builders who want a visual state surface without building one from scratch.

Positioning statement:

> Loomwright turns agent output into a live, inspectable canvas. Your agent can read it, update it, comment on it, and keep working from the same visual state.

Do not lead with "whiteboard" or "design tool." Those categories imply drawing features, design systems, and broad collaboration requirements. Lead with "agent workspace" and "living canvas" because the unsolved pain is continuity between chat, visual artifact, and next agent action.

Competitive/inspiration landscape:

- Paper.design: best proof that local MCP plus visible canvas mutation is compelling. Its setup examples cover Cursor, Claude Code, Codex, Copilot, Antigravity, and OpenCode, so Loomwright should mimic its low-friction onboarding while offering hosted collaboration and a self-host path ([Paper MCP docs](https://paper.design/docs/mcp)).
- Figma: validates design-context MCP and paid collaboration, but is optimized for design systems and designer workflows. Loomwright should integrate with Figma later, not compete head-on.
- Vercel AI SDK generative UI: useful inspiration for rich streamed UI, but the canonical Loomwright artifact should be structured canvas blocks/events, not React components. Vercel maps tool calls to streamed React Server Components; Loomwright should treat React as a renderer or export target ([Vercel AI SDK generative UI](https://vercel.com/blog/ai-sdk-3-generative-ui)).
- OpenClaw/Open WebUI: validates the gateway route. OpenClaw exposes an OpenAI-compatible API endpoint for Open WebUI, so Loomwright should support both MCP-native use and a gateway/chat bridge for agent stacks that already standardize on OpenAI-compatible chat APIs ([Open WebUI OpenClaw docs](https://docs.openwebui.com/getting-started/quick-start/connect-an-agent/openclaw/)).

## Pricing recommendation

Use seat-plus-usage pricing for hosted Loomwright. The market supports it: Cursor charges $20/month for individual Pro and $40/user/month for Teams ([Cursor pricing](https://cursor.com/pricing)); Vercel charges $20/month for Pro with included usage credit and additional usage pricing ([Vercel pricing](https://vercel.com/pricing)); GitHub Copilot individual pricing spans Free, $10/month Pro, and $39/month Pro+, with premium request allowances and overage pricing ([GitHub Copilot pricing](https://github.com/features/copilot/plans)). Loomwright should be cheaper than a full agent IDE seat, but paid enough to cover persistent state, collaboration, auth, storage, rendering, and remote MCP operations.

Recommended tiers:

| Tier | Price | Included | Boundary |
| --- | ---: | --- | --- |
| OSS self-host | $0 | Local MCP server, structured canvas schema, web viewer/editor, single-tenant persistence, export/import, basic auth hooks, SDK examples | No hosted sync, no managed OAuth, no multi-tenant admin, no SLA |
| Cloud Free | $0 | 1 user, 3 active canvases, 1,000 MCP tool operations/month, 30-day version history, public share links, hosted remote MCP URL | Personal trial only; no private team workspaces |
| Cloud Pro | $15/user/month or $150/year | Unlimited personal canvases, 10,000 MCP tool operations/month, private canvases, 1 GB attachments, 180-day history, comments, snapshots, priority hosted MCP | Overage: $5 per additional 10,000 MCP operations; storage overage optional |
| Team | $25/user/month | Shared workspaces, roles, shared prompts, team canvas library, audit-lite activity log, 50,000 pooled MCP operations/month, 10 GB storage, Hermes/OpenClaw gateway connector | Overage: $10 per additional 50,000 pooled MCP operations |
| Enterprise | Custom | SSO/SAML/OIDC, SCIM, retention controls, audit exports, VPC/private deployment option, data residency, custom limits, premium support | Annual contract and security review |

Price the metered unit as `MCP tool operation`, not model token. Agents already run inside Codex, Cursor, Claude Code, OpenClaw, or Hermes, so Loomwright should not resell inference by default. Bill for the scarce hosted resources Loomwright actually controls: authenticated remote MCP sessions, tool calls that read/write canvas state, version history, storage, collaboration presence, exports, and sandboxed previews.

Free tier limits should be visible but not annoying. The product needs a "red rectangle" moment like Paper's verification flow: a user should connect an agent and see a canvas update in under five minutes. The paywall should appear when the user wants private persistence, more canvases, team collaboration, or substantial agent usage.

## Open-source vs hosted split

Open-source the adoption path:

- Canvas schema and event format.
- Local MCP server.
- Basic web canvas renderer/editor.
- CLI for `loomwright serve`, `loomwright export`, and `loomwright import`.
- Self-host single-tenant server with SQLite/Postgres adapter.
- SDKs/examples for MCP clients and OpenAI-compatible gateway bridges.
- Reference prompts and MCP configuration snippets.

Keep hosted-only:

- Managed remote MCP endpoint with OAuth 2.1 authorization and per-canvas scopes. MCP authorization docs recommend OAuth-style flows for user data, auditing, enterprise access control, and rate limiting ([MCP authorization](https://modelcontextprotocol.io/docs/tutorials/security/authorization)).
- Multi-tenant workspaces, billing, quotas, spend controls, and rate limits.
- Durable hosted history, backups, attachment storage, and collaboration presence.
- Team roles, audit logs, admin console, SSO/SCIM, retention policies, and data residency.
- Managed Hermes/OpenClaw gateway connector and hosted share/review links.
- Hosted sandbox/rendering service for untrusted HTML or future React component previews.

Recommendation: release the core under Apache-2.0 or MIT to reduce adoption friction. Do not use a source-available license with branding restrictions; Open WebUI's license page shows how quickly license/branding conditions can become part of the product conversation instead of the user value conversation ([Open WebUI license](https://docs.openwebui.com/license/)). Protect the hosted business with service value, not by crippling local use.

The open-source version must be good enough that an agent developer can depend on the protocol without fear. The hosted version wins on zero-maintenance remote access, auth, sharing, persistence, compliance, and team workflows.

## Developer onboarding

Minimum onboarding flow:

1. User creates a canvas or runs local self-host.
2. User copies an MCP config block.
3. User copies a short agent prompt.
4. Agent performs a visible mutation.
5. Loomwright shows the canvas, event log, and share link.

Example hosted MCP config:

```json
{
  "mcpServers": {
    "loomwright": {
      "type": "http",
      "url": "https://mcp.loomwright.com/mcp"
    }
  }
}
```

Example local config:

```json
{
  "mcpServers": {
    "loomwright": {
      "command": "npx",
      "args": ["@loomwright/mcp", "--workspace", "."]
    }
  }
}
```

Copy-paste prompt:

```text
Use the Loomwright canvas tools for visual plans, flows, UI states, diagrams, and review artifacts. Before creating a new canvas, list existing canvases and reuse the relevant one. Prefer structured blocks and comments over raw HTML. After each meaningful change, summarize what changed and what you need reviewed.
```

Hermes/OpenClaw onboarding should be a connector, not a fork. For OpenClaw specifically, support an OpenAI-compatible gateway path because its Open WebUI docs already present that as a supported integration model ([Open WebUI OpenClaw docs](https://docs.openwebui.com/getting-started/quick-start/connect-an-agent/openclaw/)). For Hermes, the first paid feature should be a hosted connector that maps gateway sessions to Loomwright canvases with per-agent permissions and usage attribution.

## Landing page promise and wedge

Hero promise:

> The living canvas for AI agents.

Supporting copy:

> Connect Loomwright to Codex, Cursor, Claude Code, OpenClaw, or Hermes. Your agent can read, update, and discuss the same visual workspace your team sees.

Primary CTA:

> Connect an MCP server

Secondary CTA:

> Self-host the open core

First demo:

1. User opens an empty Loomwright canvas.
2. User copies MCP config into Codex/Cursor/Claude Code.
3. User asks: "Map the checkout flow and mark the risky states."
4. Agent creates structured flow blocks, labels risk points, and adds review comments.
5. User clicks a block, replies with guidance, and agent updates the canvas instead of generating a new static artifact.

The wedge is continuity: the same artifact stays readable by humans and writable by agents. Static HTML previews are disposable; Loomwright canvases become project memory.

## Product recommendations

- Make hosted remote MCP the default commercial path, with local MCP as the trust-building OSS path.
- Keep v1 focused on structured blocks, comments, snapshots, and share links. Do not sell arbitrary React generation as the core product.
- Price Pro at $15/month to sit below Cursor/Vercel's $20/month anchor while still feeling like a serious developer tool.
- Price Team at $25/user/month with pooled operation limits because teams pay for governance, shared context, and persistence.
- Meter hosted MCP operations separately from seats. This protects margins if agent loops become heavy and gives customers a clean cost model.
- Treat gateway connectors as paid accelerants. MCP is the standard path; Hermes/OpenClaw connectors are where enterprise and team willingness to pay will concentrate.
- Open-source enough that agents, self-hosters, and protocol contributors can trust the format. Keep hosted collaboration, auth, compliance, and durability as the business.
