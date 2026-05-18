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
