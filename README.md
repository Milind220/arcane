# Arcane

Agent-native chat + canvas workspace. V0 is deliberately tiny: a local web app with chat on the left, a live HTML artifact on the right, local session persistence, hot reload by refresh, and a tiny MCP-compatible tool surface for agents to create/update artifacts.

## V0 loop

1. Start Arcane on the agent machine.
2. Open the local/tunneled URL.
3. Create or resume a session.
4. Chat in the left pane.
5. Agent writes artifact files via HTTP or MCP tools.
6. Canvas iframe updates by reopening/reloading the session.
7. Session history and artifact state live under `.arcane/sessions/`.

No annotation. No DOM selection. No doodles. No circus animals.

## Plans

- `docs/PERSONAL_HERMES_INTERFACE_PLAN.md` — personal Hermes-native Arcane roadmap: browser chat + visual artifacts + temporary links + resume + later selection-aware edits.
- `docs/PLAN.md` — broader product/protocol research plan.

## Run

```bash
npm install
npm start
# open http://127.0.0.1:8787
```

Optional local storage path:

```bash
ARCANE_HOME=/path/to/.arcane npm start
```

## Open link helper

For internal beta use, the link helper creates or reuses `.arcane/access-token`, probes Arcane, and prints a browser URL that includes the token:

```bash
npm run link
```

If Arcane is not running, it prints the exact `ARCANE_HOME`, `ARCANE_ACCESS_TOKEN`, and `PORT` command to start it. Run that command in another terminal, then create a session link when needed. If Arcane is already running without access-token enforcement, the helper refuses to create/share links and does not emit the `Arcane URL:` contract line. Decorative tokens are for costume jewelry, not public tunnels.

```bash
npm run link -- --create-session --title "Smoke"
```

Hermes can pass simple metadata into created sessions with `HERMES_PROFILE`, `HERMES_SESSION_ID`, `HERMES_SOURCE`, `HERMES_ORIGIN`, and `HERMES_THREAD_ID`.

To create a temporary Cloudflare tunnel URL:

```bash
npm run link -- --tunnel
```

This requires `cloudflared` on `PATH`; otherwise the helper prints the exact `cloudflared tunnel --url ...` command to run manually. When a tunnel starts, the helper prints the stop command too. Use it. Public tunnels are not houseplants.

## Hermes chat bridge

The web UI can call a local Hermes CLI process when you submit a message:

```bash
ARCANE_HOME=/root/arcane/.arcane npm start
```

By default it runs:

```bash
hermes chat --quiet -q "<Arcane session prompt>"
```

Disable the bridge with `ARCANE_AGENT_DISABLED=1`, or override the binary with `ARCANE_HERMES_BIN=/path/to/hermes`.

## Public tunnel safety

If exposing Arcane through a tunnel, set an access token. The root UI stays loadable, but API/artifact routes require `x-arcane-token` or `?token=`:

```bash
ARCANE_ACCESS_TOKEN=$(openssl rand -hex 16) npm start
# open/share http://127.0.0.1:8787/?token=$ARCANE_ACCESS_TOKEN
```

The link helper above is the preferred way to produce an internal test URL because it always includes a token.

Without this, a public tunnel can trigger the local Hermes bridge. That is funny only if your threat model is a potato.

## MCP stdio server

```bash
npm run mcp
```

Supported tools:

- `arcane_create_session`
- `arcane_list_sessions`
- `arcane_get_session`
- `arcane_write_file`
- `arcane_read_file`
- `arcane_list_files`
- `arcane_append_message`
- `arcane_create_snapshot`

## HTTP API quick poke

```bash
# create session
curl -s -X POST http://127.0.0.1:8787/api/sessions \
  -H 'content-type: application/json' \
  -d '{"title":"Demo"}'

# write artifact
curl -s -X PUT http://127.0.0.1:8787/api/sessions/$SESSION_ID/files/index.html \
  -H 'content-type: application/json' \
  -d '{"content":"<h1>Hello Arcane</h1>"}'
```

## Verify

```bash
npm test
npm run build
```
