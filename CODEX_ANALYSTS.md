# Codex Analyst Workstreams

Each analyst must read `docs/RESEARCH_BRIEF.md`, use web research where available, cite sources with URLs, and write the requested file. Be concrete. No motivational fluff.

## Analyst A — Integration Architecture

Output: `docs/raw/integration-architecture.md`

Focus:
- Hermes gateway connector vs MCP-only vs hybrid.
- OpenClaw/Open WebUI integration options.
- How to make adoption require near-zero agent source changes.
- Hosted remote MCP vs local/self-hosted MCP.
- Auth, tenancy, rate limits, tool naming, agent prompts.

Required answer:
- Recommendation: hosted MCP good/bad and why.
- Minimum viable integration path for Hermes.
- Minimum viable integration path for OpenClaw/other agents.

## Analyst B — Canvas Protocol + Generative UI

Output: `docs/raw/canvas-protocol-genui.md`

Focus:
- Block schema, event schema, versioning, selection context, comments, snapshots.
- How Paper.design-style read/write canvas maps to our concept.
- How Vercel AI SDK/generative UI informs but should not dominate architecture.
- Safe rendering: structured blocks first, sandboxed HTML later, React components last.

Required answer:
- Proposed v1 block types.
- Proposed MCP tools/resources/prompts.
- Anti-footguns.

## Analyst C — Product, Business, Open Source Boundary

Output: `docs/raw/product-business-oss.md`

Focus:
- Market positioning.
- Pricing/tier options for hosted MCP/tool usage.
- Open-source vs hosted split.
- Developer onboarding: copy-paste prompt, MCP config, gateway connector.
- Competitive/inspiration landscape.

Required answer:
- Product thesis.
- Free/self-host/pro paid tier proposal.
- Landing page promise and wedge.
