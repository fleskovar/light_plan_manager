import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import { createIssue, findIssue, readLibraryDoc } from '../src/core/index.js';
import { createMcpServer } from '../src/mcp/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/**
 * The library tools of the MCP server, through a real client over an
 * in-memory transport: create, list, read, update, move and delete.
 */
async function connect(paths: BoardPaths, readOnly = false): Promise<Client> {
  const server = createMcpServer(paths, { readOnly });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    content: { text: string }[];
    isError?: boolean;
  };
  const text = result.content.map((part) => part.text).join('\n');
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A refusal is prose.
  }
  return { text, isError: result.isError === true, data };
}

describe('the MCP library tools', () => {
  it('create, list, read, update, move and delete a document', async () => {
    const paths = makeBoard();
    createIssue(reload(paths), { type: 'program', title: 'Payments', relatedFiles: ['library:prd/payments'] });
    const client = await connect(paths);

    const created = await call(client, 'create_library_document', {
      id: 'prd/payments',
      title: 'Payments PRD',
      body: '## Goals\n',
    });
    expect(created.isError).toBe(false);

    const listed = await call(client, 'list_library', { search: 'payments' });
    expect(listed.data.documents).toEqual([expect.objectContaining({ id: 'prd/payments', title: 'Payments PRD' })]);

    const read = await call(client, 'get_library_document', { id: 'prd/payments' });
    expect(read.data).toMatchObject({ body: '## Goals\n', referencedBy: ['LP-1'] });

    const updated = await call(client, 'update_library_document', {
      id: 'prd/payments',
      body: '## Goals\n\nTake cards.\n',
      revision: read.data.revision,
    });
    expect(updated.isError).toBe(false);
    const stale = await call(client, 'update_library_document', {
      id: 'prd/payments',
      body: 'Lost',
      revision: read.data.revision,
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain('changed on disk');

    const moved = await call(client, 'move_library_document', { id: 'prd/payments', newId: 'requirements/payments' });
    expect(moved.data).toEqual({
      moved: [{ from: 'prd/payments', to: 'requirements/payments' }],
      rewritten: ['LP-1'],
      stale: [],
    });
    expect(findIssue(reload(paths), 'LP-1')!.related_files).toEqual(['library:requirements/payments']);
    expect(readLibraryDoc(paths, 'requirements/payments')?.body).toBe('## Goals\n\nTake cards.\n');

    const deleted = await call(client, 'delete_library_document', { id: 'requirements/payments' });
    expect(deleted.data).toEqual({ deleted: 'requirements/payments', stillReferencedBy: ['LP-1'] });
    expect((await call(client, 'list_library')).data.total).toBe(0);
  });

  it('registers only the reading tools on a read-only server', async () => {
    const reader = await connect(makeBoard(), true);
    const names = (await reader.listTools()).tools.map((tool) => tool.name).filter((name) => name.includes('library'));
    expect(names.sort()).toEqual(['get_library_document', 'list_library']);
  });
});
