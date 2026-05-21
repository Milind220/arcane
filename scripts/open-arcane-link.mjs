#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const DEFAULT_PORT = '8787';
const DEFAULT_TITLE = 'Arcane beta session';
const TOKEN_FILE_NAME = 'access-token';
const TUNNEL_URL_WAIT_MS = 8000;

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const port = process.env.PORT || DEFAULT_PORT;
  if (!/^\d+$/.test(port)) throw new Error(`PORT must be a number, got ${JSON.stringify(port)}`);

  const arcaneHome = path.resolve(process.env.ARCANE_HOME || path.join(repoRoot, '.arcane'));
  const token = await resolveAccessToken(arcaneHome);
  const baseUrl = `http://127.0.0.1:${port}`;
  const localUrl = withToken(`${baseUrl}/`, token);
  const startCommand = buildStartCommand({ arcaneHome, token, port });

  const probe = await probeArcane(`${baseUrl}/api/sessions`, token);
  if (!probe.running) {
    console.log(`Arcane URL: ${localUrl}`);
    console.log('');
    console.log('Arcane is not running. Start it with:');
    console.log(startCommand);
    if (options.tunnel) {
      console.log('');
      console.log('Start Arcane first, then run this helper with --tunnel again.');
    }
    return;
  }

  if (!probe.authorized) {
    console.log('');
    console.log('Arcane is running but rejected this token. Restart it with:');
    console.log(startCommand);
    return;
  }

  if (!probe.authEnforced) {
    console.log('');
    console.log('Arcane is running without access-token enforcement. Restart it before sharing links:');
    console.log(startCommand);
    return;
  }

  console.log(`Arcane URL: ${localUrl}`);
  console.log('Arcane is running with access-token enforcement.');

  if (options.createSession) {
    const session = await createSession(`${baseUrl}/api/sessions`, token, options.title || DEFAULT_TITLE);
    console.log(`Created session: ${session.id}`);
  }

  if (options.tunnel) {
    console.log('');
    await openTunnel({ port, token });
  }
}

function parseArgs(args) {
  const options = { createSession: false, help: false, title: '', tunnel: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--create-session') {
      options.createSession = true;
    } else if (arg === '--tunnel') {
      options.tunnel = true;
    } else if (arg === '--title') {
      const title = args[index + 1];
      if (!title) throw new Error('--title requires a value');
      options.title = title;
      index += 1;
    } else if (arg.startsWith('--title=')) {
      options.title = arg.slice('--title='.length);
      if (!options.title) throw new Error('--title requires a value');
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/open-arcane-link.mjs [options]

Options:
  --create-session       Create an Arcane session when the server is running.
  --title <title>        Session title for --create-session. Defaults to "${DEFAULT_TITLE}".
  --tunnel               Start a cloudflared tunnel and print a trycloudflare URL.
  -h, --help             Show this help.

Environment:
  PORT                   Arcane port. Defaults to ${DEFAULT_PORT}.
  ARCANE_HOME            Arcane storage directory. Defaults to <repo>/.arcane.
  ARCANE_ACCESS_TOKEN    Access token to use. Defaults to .arcane/${TOKEN_FILE_NAME}.
  HERMES_PROFILE         Optional Hermes metadata for created sessions.
  HERMES_SESSION_ID      Optional Hermes metadata for created sessions.
`);
}

async function resolveAccessToken(arcaneHome) {
  if (process.env.ARCANE_ACCESS_TOKEN) return process.env.ARCANE_ACCESS_TOKEN;

  await mkdir(arcaneHome, { recursive: true });
  const tokenPath = path.join(arcaneHome, TOKEN_FILE_NAME);

  try {
    const token = (await readFile(tokenPath, 'utf8')).trim();
    if (token) {
      await chmodTokenFile(tokenPath);
      return token;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const token = randomBytes(32).toString('hex');
  try {
    await writeFile(tokenPath, `${token}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = (await readFile(tokenPath, 'utf8')).trim();
    if (!existing) throw new Error(`${tokenPath} exists but is empty`);
    await chmodTokenFile(tokenPath);
    return existing;
  }
  await chmodTokenFile(tokenPath);
  return token;
}

async function chmodTokenFile(tokenPath) {
  try {
    await chmod(tokenPath, 0o600);
  } catch (error) {
    if (error?.code !== 'ENOSYS' && error?.code !== 'EINVAL') throw error;
  }
}

async function probeArcane(url, token) {
  try {
    const response = await fetch(url, {
      headers: { 'x-arcane-token': token },
      signal: AbortSignal.timeout(2000),
    });

    if (!response.ok) return { running: true, authorized: false, authEnforced: true, status: response.status };

    const invalidToken = `arcane-invalid-${randomBytes(16).toString('hex')}`;
    const invalidResponse = await fetch(url, {
      headers: { 'x-arcane-token': invalidToken },
      signal: AbortSignal.timeout(2000),
    });
    const authEnforced = invalidResponse.status === 401 || invalidResponse.status === 403;
    return { running: true, authorized: true, authEnforced };
  } catch (error) {
    return { running: false, authorized: false, authEnforced: false, error };
  }
}

async function createSession(url, token, title) {
  const hermes = buildHermesMetadata();
  const body = { title, ...(Object.keys(hermes).length ? { hermes } : {}) };
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-arcane-token': token,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(payload?.error || payload?.message || `Failed to create session: HTTP ${response.status}`);
  return payload.session || payload;
}

function buildHermesMetadata() {
  const env = process.env;
  return omitEmpty({
    profile: env.HERMES_PROFILE,
    sessionId: env.HERMES_SESSION_ID,
    source: env.HERMES_SOURCE,
    origin: env.HERMES_ORIGIN,
    originThread: env.HERMES_ORIGIN_THREAD || env.HERMES_THREAD_ID,
  });
}

function omitEmpty(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ''));
}

async function openTunnel({ port, token }) {
  const command = `cloudflared tunnel --url ${shellQuote(`http://127.0.0.1:${port}`)}`;
  if (!(await commandExists('cloudflared'))) {
    console.log('cloudflared was not found. Run this command after installing it:');
    console.log(command);
    return;
  }

  const logPath = path.join(tmpdir(), `arcane-cloudflared-${process.pid}-${Date.now()}.log`);
  const logFd = openSync(logPath, 'a', 0o600);
  const child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  child.unref();

  const deadline = Date.now() + TUNNEL_URL_WAIT_MS;
  while (Date.now() < deadline) {
    const output = await readOptionalFile(logPath);
    const match = output.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i);
    if (match) {
      console.log(`Tunnel URL: ${withToken(match[0], token)}`);
      console.log(`cloudflared is running as process group ${child.pid}. Log: ${logPath}`);
      console.log(`Stop tunnel: kill -TERM -${child.pid}`);
      return;
    }
    await wait(250);
  }

  stopProcessGroup(child.pid);
  console.log('No trycloudflare.com URL appeared quickly. Run this command manually:');
  console.log(command);
  console.log(`cloudflared log: ${logPath}`);
}

async function readOptionalFile(filePath) {
  try {
    return await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return '';
    throw error;
  }
}

function stopProcessGroup(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Best effort only; the fallback command is printed for manual retry.
  }
}

async function commandExists(command) {
  const result = spawnSync(command, ['--version'], { stdio: 'ignore', timeout: 2000 });
  return !result.error && result.status === 0;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withToken(rawUrl, token) {
  const url = new URL(rawUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

function buildStartCommand({ arcaneHome, token, port }) {
  return [
    `ARCANE_HOME=${shellQuote(arcaneHome)}`,
    `ARCANE_ACCESS_TOKEN=${shellQuote(token)}`,
    `PORT=${shellQuote(port)}`,
    'npm start',
  ].join(' ');
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_/:.,@%+=-]+$/.test(value)) return value;
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
