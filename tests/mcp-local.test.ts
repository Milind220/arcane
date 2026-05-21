import { describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { handleMcpRequest } from '../src/mcp-local.js';
import { SessionStore } from '../src/session-store.js';

describe('Arcane MCP local JSON-RPC surface', () => {
  it('ignores JSON-RPC notifications without writing invalid null-id responses', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-mcp-'));
    const store = new SessionStore(root);

    await expect(handleMcpRequest(store, { jsonrpc: '2.0', method: 'notifications/initialized' })).resolves.toBeNull();
    await expect(handleMcpRequest(store, { jsonrpc: '2.0', method: 'notifications/unknown' })).resolves.toBeNull();
  });

  it('lists tools and calls session/file tools', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'arcane-mcp-'));
    const store = new SessionStore(root);

    const tools = await handleMcpRequest(store, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(tools.result.tools.map((tool: any) => tool.name)).toContain('arcane_create_session');

    const created = await handleMcpRequest(store, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'arcane_create_session', arguments: { title: 'MCP Demo' } },
    });
    const session = JSON.parse(created.result.content[0].text);

    await handleMcpRequest(store, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'arcane_write_file', arguments: { sessionId: session.id, path: 'index.html', content: '<h1>MCP wrote this</h1>' } },
    });

    const read = await handleMcpRequest(store, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'arcane_read_file', arguments: { sessionId: session.id, path: 'index.html' } },
    });

    expect(read.result.content[0].text).toContain('MCP wrote this');
  });
});
