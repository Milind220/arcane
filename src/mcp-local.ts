import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import { SessionStore } from './session-store.js';

export interface JsonRpcRequest {
  jsonrpc?: '2.0';
  id?: string | number | null;
  method: string;
  params?: any;
}

const toolDescriptions = [
  { name: 'arcane_create_session', description: 'Create a resumable Arcane chat+canvas session.', inputSchema: { type: 'object', properties: { title: { type: 'string' } } } },
  { name: 'arcane_list_sessions', description: 'List local Arcane sessions newest first.', inputSchema: { type: 'object', properties: {} } },
  { name: 'arcane_get_session', description: 'Get session metadata, messages, and files.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
  { name: 'arcane_write_file', description: 'Write an artifact file inside a session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, path: { type: 'string' }, content: { type: 'string' } }, required: ['sessionId', 'path', 'content'] } },
  { name: 'arcane_read_file', description: 'Read an artifact file from a session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, path: { type: 'string' } }, required: ['sessionId', 'path'] } },
  { name: 'arcane_list_files', description: 'List artifact files in a session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' } }, required: ['sessionId'] } },
  { name: 'arcane_append_message', description: 'Append a chat message to a session.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, role: { type: 'string' }, content: { type: 'string' } }, required: ['sessionId', 'role', 'content'] } },
  { name: 'arcane_create_snapshot', description: 'Snapshot current artifact files.', inputSchema: { type: 'object', properties: { sessionId: { type: 'string' }, summary: { type: 'string' } }, required: ['sessionId'] } },
];

export async function handleMcpRequest(store: SessionStore, request: JsonRpcRequest): Promise<any> {
  try {
    if (request.method === 'initialize') {
      return ok(request.id, {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'arcane-local', version: '0.0.1' },
        capabilities: { tools: {} },
      });
    }

    if (request.method === 'tools/list') return ok(request.id, { tools: toolDescriptions });

    if (request.method === 'tools/call') {
      const name = request.params?.name;
      const args = request.params?.arguments || {};
      const result = await callTool(store, name, args);
      return ok(request.id, { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] });
    }

    return error(request.id, -32601, `Unknown method: ${request.method}`);
  } catch (err: any) {
    return error(request.id, -32000, err?.message || String(err));
  }
}

async function callTool(store: SessionStore, name: string, args: any): Promise<any> {
  switch (name) {
    case 'arcane_create_session':
      return store.createSession(args.title || 'Untitled session');
    case 'arcane_list_sessions':
      return store.listSessions();
    case 'arcane_get_session': {
      const session = await store.getSession(args.sessionId);
      if (!session) throw new Error('session not found');
      return { session, messages: await store.listMessages(args.sessionId), files: await store.listFiles(args.sessionId) };
    }
    case 'arcane_write_file':
      await store.writeFile(args.sessionId, args.path, args.content || '');
      return { ok: true };
    case 'arcane_read_file':
      return store.readFile(args.sessionId, args.path);
    case 'arcane_list_files':
      return store.listFiles(args.sessionId);
    case 'arcane_append_message':
      return store.appendMessage(args.sessionId, args.role || 'user', args.content || '');
    case 'arcane_create_snapshot':
      return store.createSnapshot(args.sessionId, args.summary || '');
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function ok(id: JsonRpcRequest['id'], result: any): any {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function error(id: JsonRpcRequest['id'], code: number, message: string): any {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export async function main(): Promise<void> {
  const store = new SessionStore(process.env.ARCANE_HOME || path.join(process.cwd(), '.arcane'));
  const rl = createInterface({ input, output: process.stderr });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const response = await handleMcpRequest(store, JSON.parse(line));
    output.write(`${JSON.stringify(response)}\n`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
