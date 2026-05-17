# Loomwright Research Brief

Goal: design a product-grade agent-native canvas that replaces static HTML artifact links with a living chat+canvas workspace.

User constraints:
- Product, not one-off hack.
- Should integrate with Hermes and OpenClaw naturally.
- Ideally zero/minimal agent source-code changes.
- Hosted MCP server is a serious candidate, because hosted tool usage can be monetized.
- Open-source core/self-host path should remain possible.
- Inspired by Paper.design MCP: agents can read/write a design/canvas surface and humans can see/respond visually.

Research questions:
1. What is the right integration surface: hosted MCP, local MCP, Hermes gateway connector, OpenAI-compatible API, browser extension, or combination?
2. What should the canvas protocol look like? Block schema, events, versioning, permissions, agent operations.
3. What should v1 build? Avoid overbuilding arbitrary React spaghetti.
4. What are monetizable hosted boundaries vs open-source boundaries?
5. How do Paper.design, Vercel AI SDK generative UI, MCP remote auth/Streamable HTTP, and Open WebUI/OpenClaw inform this?

Quality bar:
- Source-backed claims.
- Concrete architecture and protocol proposal.
- Product/pricing recommendation.
- Implementation plan suitable for Codex/Hermes execution.
