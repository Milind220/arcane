# Source Notes

## Paper.design MCP

URL: https://paper.design/docs/mcp

Paper exposes a local MCP server from its desktop app, usually at `http://127.0.0.1:29979/mcp`. The server lets agents read and write Paper design files. Paper docs explicitly support Cursor, Claude Code, Codex, Copilot, Antigravity, and OpenCode. The verification prompt is literally: ask an agent to create a red rectangle in Paper; expected result is visible canvas mutation. Core lesson: agents need read/write canvas tools, not screenshots alone.

## MCP positioning

URL: https://modelcontextprotocol.io/docs/getting-started/intro

MCP is an open standard for connecting AI applications to external systems: data, tools, workflows. The official framing is “USB-C for AI applications” and “build once and integrate everywhere.” This strongly supports Arcane’s integration surface as MCP-first rather than writing bespoke plugins for every agent.

## MCP authorization

URL: https://modelcontextprotocol.io/docs/tutorials/security/authorization

Protected MCP servers use OAuth 2.1 patterns. Unauthorized requests can return `401` with `WWW-Authenticate: Bearer ... resource_metadata=...`; clients discover protected resource metadata, authorization servers, supported scopes, then call MCP with bearer tokens. For hosted Arcane, this maps cleanly to tenant/user auth, per-canvas permissions, and paid usage scopes.

## Cloudflare remote MCP

URL: https://blog.cloudflare.com/remote-model-context-protocol-servers-mcp/

Cloudflare supports remote MCP servers on Workers and introduced `workers-oauth-provider`, `McpAgent`, `mcp-remote`, and an AI playground remote MCP client. Key point: remote MCP moves MCP beyond local developer machines and makes authenticated multi-user internet services plausible. Good fit for hosted Arcane MCP.

## Vercel AI SDK generative UI

URL: https://vercel.com/blog/ai-sdk-3-generative-ui

Vercel AI SDK 3 introduced generative UI by mapping LLM/tool calls to streamed React Server Components. Useful inspiration for rich UI, but for Arcane the source of truth should be structured canvas blocks/events. React/RSC can be a renderer, not the canonical artifact format.

## OpenClaw/Open WebUI

URL: https://docs.openwebui.com/getting-started/quick-start/connect-an-agent/openclaw/

OpenClaw exposes an OpenAI-compatible API endpoint and can be used with Open WebUI as a frontend. This suggests a second integration route: not just MCP tools, but a gateway/API connector or OpenAI-compatible chat bridge for agents that already expose chat APIs.
