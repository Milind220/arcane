# Hermes Integration

Arcane exposes a beta-grade link helper that Hermes can call when a terminal or chat surface needs to hand a user a visual workspace URL.

## Command

```bash
npm run link -- [--create-session] [--title "Session title"] [--tunnel]
```

The helper uses:

- `PORT`, default `8787`
- `ARCANE_HOME`, default `<repo>/.arcane`
- `ARCANE_ACCESS_TOKEN`, or `<ARCANE_HOME>/access-token` with mode `0600`

It probes `http://127.0.0.1:<PORT>/api/sessions` with `x-arcane-token`. If Arcane is not running, it prints the exact `ARCANE_HOME`, `ARCANE_ACCESS_TOKEN`, and `PORT` command to start it, plus the local URL with `?token=`. If Arcane is already running without rejecting an invalid token, the helper refuses to create/share links and prints the restart command without emitting the `Arcane URL:` contract line.

## Hermes Inputs

Hermes can pass session context through environment variables before invoking the helper:

- `HERMES_PROFILE`
- `HERMES_SESSION_ID`
- `HERMES_SOURCE`
- `HERMES_ORIGIN`
- `HERMES_ORIGIN_THREAD` or `HERMES_THREAD_ID`

When `--create-session` is present, Arcane stores those values in the session `hermes` metadata. `--title` sets the Arcane session title; otherwise the helper uses `Arcane beta session`.

## Output Contract

Hermes should read stdout for:

- `Arcane URL: <local-url-with-token>`
- `Created session: <arcane-session-id>` when `--create-session` succeeds
- `Tunnel URL: <trycloudflare-url-with-token>` when `--tunnel` succeeds
- `Stop tunnel: kill -TERM -<process-group>` when `--tunnel` succeeds

There is no hosted expiry service in this beta helper. Treat local links as valid until the access token changes. Tunnel links stay valid until the printed `cloudflared` process group is stopped or exits.

If Arcane is unavailable, Hermes should show the printed start command and URL. If `cloudflared` is missing or no tunnel URL appears quickly, Hermes should show the printed `cloudflared tunnel --url http://127.0.0.1:<PORT>` command.

## Degraded Behavior

When the current Hermes surface cannot render Arcane inline, show the URL as plain text and keep artifact references in the terminal or chat transcript. The user can open the URL in a browser while Hermes continues the text session.
