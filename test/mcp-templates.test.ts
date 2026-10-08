import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import { createIssue, createTemplate, findRegistryTemplate, linkTemplate } from '../src/core/index.js';
import { createMcpServer } from '../src/mcp/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/**
 * The registry as an agent sees it, driven through a real MCP client over an
 * in-memory transport — so the input schemas and the replies are exercised, not
 * just the functions behind them.
 */
async function connect(paths: BoardPaths, readOnly = false): Promise<Client> {
  const server = createMcpServer(paths, { readOnly });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = result.content.map((part) => part.text).join('\n');
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A refusal is prose, not JSON.
  }
  return { text, isError: result.isError === true, data };
}

/** A board with a program and an epic, and one feature template in the registry. */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Platform' });
  createIssue(reload(paths), { type: 'epic', title: 'Payments', parentId: 'LP-1' });

  createTemplate(reload(paths), { type: 'folder', title: 'Delivery', description: 'Patterns' });
  createTemplate(reload(paths), { type: 'folder', title: 'Epic slot', parentId: 'TPL-1' });
  createTemplate(reload(paths), {
    type: 'feature',
    title: '{{name}} API',
    description: 'REST endpoint with tests and docs',
    parentId: 'TPL-2',
    params: { name: { type: 'string', required: true, description: 'What it is for' } },
  });
  createTemplate(reload(paths), {
    type: 'user_story',
    title: 'Design {{name}}',
    parentId: 'TPL-3',
  });
  createTemplate(reload(paths), { type: 'user_story', title: 'Build {{name}}', parentId: 'TPL-3' });

  const board = reload(paths);
  linkTemplate(board, findRegistryTemplate(board, 'TPL-5')!, { dependsOn: ['TPL-4'] });
  return paths;
}

describe('the registry over MCP', () => {
  it('registers the three template tools', async () => {
    const client = await connect(seed());
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('list_templates');
    expect(names).toContain('get_template');
    expect(names).toContain('instantiate_template');
  });

  it('lists only the roots, with what each is for', async () => {
    const client = await connect(seed());
    const { data } = await call(client, 'list_templates');
    const templates = data.templates as Record<string, unknown>[];
    expect(templates).toHaveLength(1);
    expect(templates[0]).toMatchObject({
      id: 'TPL-3',
      type: 'feature',
      description: 'REST endpoint with tests and docs',
      folder: 'Delivery / Epic slot',
      creates: 3,
    });
    expect(templates[0]!.params).toEqual([
      {
        name: 'name',
        type: 'string',
        required: true,
        default: undefined,
        values: undefined,
        description: 'What it is for',
      },
    ]);
  });

  it('searches by title and description', async () => {
    const client = await connect(seed());
    expect(((await call(client, 'list_templates', { search: 'REST' })).data.templates as [])).toHaveLength(1);
    expect(((await call(client, 'list_templates', { search: 'zzz' })).data.templates as [])).toHaveLength(0);
  });

  it('returns the whole tree a template would create', async () => {
    const client = await connect(seed());
    const { data } = await call(client, 'get_template', { id: 'TPL-3' });
    const creates = data.creates as Record<string, unknown>[];
    expect(creates).toHaveLength(3);
    expect(creates[0]).toMatchObject({ type: 'feature', depth: 0 });
    expect(creates[2]).toMatchObject({ title: 'Build {{name}}', dependsOn: ['TPL-4'] });
  });

  it('instantiates onto the board with the parameters filled in', async () => {
    const paths = seed();
    const client = await connect(paths);
    const { data, isError } = await call(client, 'instantiate_template', {
      id: 'TPL-3',
      params: { name: 'Payments' },
      parent: 'LP-2',
    });
    expect(isError).toBe(false);
    expect((data.created as string[])).toHaveLength(3);

    const board = reload(paths);
    const titles = board.issues.map((issue) => issue.title);
    expect(titles).toContain('Payments API');
    expect(titles).toContain('Design Payments');
    // The registry is untouched.
    expect(board.templates).toHaveLength(5);
  });

  it('reports what would land without writing anything', async () => {
    const paths = seed();
    const client = await connect(paths);
    const { data } = await call(client, 'instantiate_template', {
      id: 'TPL-3',
      params: { name: 'Payments' },
      parent: 'LP-2',
      dryRun: true,
    });
    expect((data.wouldCreate as Record<string, unknown>[])[0]).toMatchObject({
      type: 'feature',
      title: 'Payments API',
    });
    expect(reload(paths).issues).toHaveLength(2);
  });

  it('refuses a missing parameter with a message naming it', async () => {
    const client = await connect(seed());
    const { text, isError } = await call(client, 'instantiate_template', {
      id: 'TPL-3',
      params: {},
      parent: 'LP-2',
    });
    expect(isError).toBe(true);
    expect(text).toContain('"name" is required');
  });

  it('refuses a parent that is not on the board', async () => {
    const client = await connect(seed());
    const { text, isError } = await call(client, 'instantiate_template', {
      id: 'TPL-3',
      params: { name: 'X' },
      parent: 'LP-99',
    });
    expect(isError).toBe(true);
    expect(text).toContain('LP-99');
  });

  it('shows the registry in board_overview and get_document', async () => {
    const client = await connect(seed());
    const overview = await call(client, 'board_overview');
    expect((overview.data.counts as Record<string, number>).templates).toBe(1);
    expect((overview.data.types as Record<string, unknown>[]).some((type) => type.name === 'folder')).toBe(
      true,
    );

    const document = await call(client, 'get_document', { id: 'TPL-3' });
    expect(document.data).toMatchObject({ kind: 'template', root: true });
    expect(document.data.params).toHaveProperty('name');
  });

  it('lists the registry through list_documents', async () => {
    const client = await connect(seed());
    const { data } = await call(client, 'list_documents', { kind: 'template' });
    expect(data.total).toBe(5);
  });

  it('reads the registry on a read-only server but refuses to instantiate', async () => {
    const client = await connect(seed(), true);
    expect((await call(client, 'list_templates')).isError).toBe(false);
    const attempt = await call(client, 'instantiate_template', {
      id: 'TPL-3',
      params: { name: 'X' },
      parent: 'LP-2',
    });
    expect(attempt.isError).toBe(true);
    expect(attempt.text).toContain('read-only');
  });

  it('tells an agent to look at the registry before writing anything', async () => {
    const client = await connect(seed());
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('list_templates');
  });
});
