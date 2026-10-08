import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import {
  boardPathsFor,
  createIssue,
  createPeriod,
  createResource,
  findIssue,
  listComments,
} from '../src/core/index.js';
import { launchCommand } from '../src/cli/commands/mcp/config.js';
import { createMcpServer } from '../src/mcp/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';
import { memoryConnector } from './support/memory-tracker.js';

afterAll(cleanupBoards);

/**
 * The MCP surface, driven through a real client over an in-memory transport —
 * so the schemas, the tool wiring and the replies are all exercised without
 * spawning a process.
 */
async function connect(
  paths: BoardPaths,
  options: { user?: string; profile?: string; readOnly?: boolean; allowRemote?: boolean } = {},
): Promise<Client> {
  const server = createMcpServer(paths, {
    user: options.user ?? null,
    profile: options.profile ?? null,
    readOnly: options.readOnly,
    allowRemote: options.allowRemote,
  });
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
  return { text, isError: result.isError === true, data: safeJson(text) };
}

/** Tool replies are JSON in a text block; a prose reply parses to nothing. */
function safeJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** program > epic > feature, plus two people. */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Platform' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  createResource(reload(paths), { type: 'person', title: 'Planner Bot' });
  createResource(reload(paths), { type: 'person', title: 'Worker Bot' });
  return paths;
}

describe('mcp server', () => {
  let paths: BoardPaths;
  let planner: Client;

  beforeAll(async () => {
    paths = seed();
    planner = await connect(paths, { user: 'Planner Bot' });
  });

  it('lists the planning and working tools', async () => {
    const names = (await planner.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'board_overview',
        'list_documents',
        'get_document',
        'create_document',
        'split_issue',
        'insert_between',
        'start_period',
        'correct_period',
        'convert_document',
        'next_tasks',
        'start_task',
        'finish_task',
        'add_comment',
        'get_instructions',
        'flag_issue',
        'clear_flag',
        'flagged_issues',
      ]),
    );
  });

  it('flags an issue with its comment, and only the plan owner clears it', async () => {
    const created = await call(planner, 'create_document', {
      type: 'user_story',
      title: 'Guest can pay',
      parent: 'LP-3',
      relatedFiles: ['docs/prd.md#L10-L42', 'src/checkout/pay.ts'],
    });
    const id = created.data.created as string;

    // The files travelled with the create and come back on the document.
    const doc = await call(planner, 'get_document', { id });
    expect(doc.data.relatedFiles).toEqual(['docs/prd.md#L10-L42', 'src/checkout/pay.ts']);
    expect(doc.data.flag).toBeNull();

    await call(planner, 'start_task', { id, assignee: 'Worker Bot' });
    const flagged = await call(planner, 'flag_issue', {
      id,
      reason: 'help',
      comment: 'Need a decision on the retry budget',
    });
    expect(flagged.isError).toBe(false);
    expect(flagged.data.flag).toBe('help');
    expect(findIssue(reload(paths), id)!.flag).toBe('help');
    // The comment is written by the same call; the flag is never bare.
    expect(listComments(reload(paths), id).at(-1)!.body).toContain('retry budget');

    // The issue keeps its status — a flag is not a column.
    expect((await call(planner, 'get_document', { id })).data.status).toBe('in_progress');

    const list = await call(planner, 'flagged_issues');
    expect((list.data.flagged as { id: string }[]).map((entry) => entry.id)).toContain(id);

    const cleared = await call(planner, 'clear_flag', { id, comment: 'Three retries. Go.' });
    expect(cleared.data.was).toBe('help');
    expect(findIssue(reload(paths), id)!.flag).toBeNull();
  });

  it('refuses a flag reason it does not know', async () => {
    const created = await call(planner, 'create_document', {
      type: 'user_story',
      title: 'Guest can browse',
      parent: 'LP-3',
    });
    const result = await call(planner, 'flag_issue', {
      id: created.data.created as string,
      reason: 'sleepy',
      comment: 'zzz',
    });
    expect(result.isError).toBe(true);
  });

  it('replaces related files through update_document', async () => {
    const created = await call(planner, 'create_document', {
      type: 'user_story',
      title: 'Guest can return',
      parent: 'LP-3',
      relatedFiles: ['src/a.ts'],
    });
    const id = created.data.created as string;
    await call(planner, 'update_document', { id, relatedFiles: ['src/a.ts', 'src/b.ts'] });
    expect(findIssue(reload(paths), id)!.related_files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('hands out a working brief with the ancestry laid out above the issue', async () => {
    const created = await call(planner, 'create_document', {
      type: 'user_story',
      title: 'Guest can refund',
      parent: 'LP-3',
      body: '## Acceptance\n\n- [ ] a refund happens',
    });
    const id = created.data.created as string;

    const { data, isError } = await call(planner, 'get_instructions', { id });
    expect(isError).toBe(false);
    expect(data.id).toBe(id);
    const brief = String(data.instructions);
    // The whole ancestry, outermost first, then the issue's own body.
    expect(brief).toContain('Platform');
    expect(brief).toContain('Checkout');
    expect(brief).toContain('Guest flow');
    expect(brief.indexOf('Checkout')).toBeLessThan(brief.indexOf('- [ ] a refund happens'));
    expect(data.warnings).toEqual([]);
    expect(data.availableTemplates).toContain('user_story');
  });

  it('renders a brief from a named template, and refuses one that is not there', async () => {
    const bad = await call(planner, 'get_instructions', { id: 'LP-3', template: 'nope' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('No context template');

    const good = await call(planner, 'get_instructions', { id: 'LP-3', template: 'default' });
    expect(good.isError).toBe(false);
    expect(String(good.data.template)).toContain('default.md');
  });

  it('says which issue a brief was asked for that does not exist', async () => {
    const { isError, text } = await call(planner, 'get_instructions', { id: 'LP-404' });
    expect(isError).toBe(true);
    expect(text).toContain('No issue with id');
  });

  it('never lets an agent past the template safety check', async () => {
    const board = seed();
    const agent = await connect(board, { user: 'Worker Bot' });
    // LP-3 is a feature, so this is the layout that would actually be used.
    writeFileSync(
      path.join(board.templatesDir, 'context', 'feature.md'),
      '<%= issue.title %> <%= process.env.AWS_SECRET_ACCESS_KEY %>',
      'utf8',
    );

    const refused = await call(agent, 'get_instructions', { id: 'LP-3' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('Refusing to render');
    // There is no input that could turn this off: unlike the CLI, the tool has
    // no --unsafe, because letting an agent opt out is the whole hole.
    const forced = await call(agent, 'get_instructions', { id: 'LP-3', allowUnsafe: true });
    expect(forced.isError).toBe(true);
    await agent.close();
  });

  it('describes the board in its own vocabulary', async () => {
    const { data } = await call(planner, 'board_overview');
    const hierarchy = (data.hierarchy as { issue: string[][] }).issue;
    expect(hierarchy.slice(0, 3)).toEqual([['program'], ['epic'], ['feature']]);
    expect(data.currentUser).toBe('RS-1');
    expect(data.effortAttribute).toBe('story_points');
    // The tools speak the board's own status names, not a fixed vocabulary.
    expect((data.statuses as { id: string }[]).map((status) => status.id)).toContain('in_progress');
  });

  it('creates a document and reads it back in full', async () => {
    const created = await call(planner, 'create_document', {
      type: 'user_story',
      title: 'Guest can pay',
      parent: 'LP-3',
      attributes: { story_points: 12, priority: 'high' },
      body: '## Acceptance\n\n- [ ] works',
    });
    expect(created.isError).toBe(false);
    const id = created.data.created as string;

    const { data } = await call(planner, 'get_document', { id });
    expect(data).toMatchObject({
      id,
      type: 'user_story',
      title: 'Guest can pay',
      parentId: 'LP-3',
      status: 'backlog',
    });
    expect(data.attributes).toMatchObject({ story_points: 12, priority: 'high' });
    expect(String(data.body)).toContain('## Acceptance');
    expect(data.ancestors).toEqual(['LP-3', 'LP-2', 'LP-1']);
  });

  it('splits an issue and rewires the graph', async () => {
    const story = await call(planner, 'create_document', {
      type: 'user_story',
      title: 'Big one',
      parent: 'LP-3',
      attributes: { story_points: 9 },
    });
    const follow = await call(planner, 'create_document', {
      type: 'user_story',
      title: 'After it',
      parent: 'LP-3',
      dependsOn: [story.data.created as string],
    });

    const split = await call(planner, 'split_issue', {
      id: story.data.created,
      count: 3,
      mode: 'replace',
      splitEffort: true,
    });
    expect(split.isError).toBe(false);
    const pieces = split.data.created as string[];
    expect(pieces).toHaveLength(3);

    const board = reload(paths);
    expect(findIssue(board, story.data.created as string)).toBeNull();
    expect(pieces.map((id) => findIssue(board, id)!.attributes.story_points)).toEqual([3, 3, 3]);
    // What waited on the original waits on the last piece.
    expect(findIssue(board, follow.data.created as string)!.depends_on).toEqual([pieces[2]]);
  });

  it('inserts an issue into a dependency', async () => {
    const a = await call(planner, 'create_document', { type: 'user_story', title: 'A', parent: 'LP-3' });
    const b = await call(planner, 'create_document', {
      type: 'user_story',
      title: 'B',
      parent: 'LP-3',
      dependsOn: [a.data.created as string],
    });

    const inserted = await call(planner, 'insert_between', {
      source: a.data.created,
      target: b.data.created,
      title: 'Middle',
    });
    expect(inserted.isError).toBe(false);

    const board = reload(paths);
    const middle = inserted.data.inserted as string;
    expect(findIssue(board, middle)!.depends_on).toEqual([a.data.created]);
    expect(findIssue(board, b.data.created as string)!.depends_on).toEqual([middle]);
  });

  it('converts a type and reports the move', async () => {
    const story = await call(planner, 'create_document', {
      type: 'user_story',
      title: 'Promote me',
      parent: 'LP-3',
    });
    const converted = await call(planner, 'convert_document', {
      id: story.data.created,
      type: 'feature',
    });
    expect(converted.data).toMatchObject({ type: 'feature', parentId: 'LP-2' });
  });

  it('reports a refusal as a readable message instead of throwing', async () => {
    const result = await call(planner, 'create_document', {
      type: 'epic',
      title: 'Wrong depth',
      parent: 'LP-3',
    });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/cannot be nested/);
  });

  it('walks a worker through picking work up and writing it down', async () => {
    const worker = await connect(paths, { user: 'Worker Bot' });

    const next = await call(worker, 'next_tasks', { includeUnassigned: true, limit: 5 });
    const tasks = next.data.tasks as { id: string }[];
    expect(tasks.length).toBeGreaterThan(0);

    const id = tasks[0]!.id;
    const started = await call(worker, 'start_task', { id });
    expect(started.data).toMatchObject({ started: id, assignee: 'RS-2', status: 'in_progress' });

    await call(worker, 'add_comment', { id, body: 'Needed a sandbox key; asked the reviewer.' });
    const finished = await call(worker, 'finish_task', { id, comment: 'Done, key worked.' });
    expect(finished.data).toMatchObject({ finished: id, status: 'done' });

    const comments = listComments(reload(paths), id);
    expect(comments).toHaveLength(2);
    expect(comments[0]!.author).toContain('Worker Bot');
    expect(comments[1]!.body).toBe('Done, key worked.');

    const doc = await call(worker, 'get_document', { id });
    expect(doc.data.status).toBe('done');
    await worker.close();
  });

  it('keeps each session on its own identity', async () => {
    const other = await connect(paths, { user: 'Planner Bot' });
    const { data } = await call(other, 'board_overview');
    expect(data.currentUser).toBe('RS-1');
    await other.close();
    // The worker session above did not overwrite it on disk.
    expect((await call(planner, 'board_overview')).data.currentUser).toBe('RS-1');
  });

  it('reports the whole chain of work behind an issue', async () => {
    const story = async (title: string, dependsOn?: string[]): Promise<string> =>
      (
        await call(planner, 'create_document', {
          type: 'user_story',
          title,
          parent: 'LP-3',
          ...(dependsOn ? { dependsOn } : {}),
        })
      ).data.created as string;

    const first = await story('Gateway');
    const second = await story('Guest checkout', [first]);
    const third = await story('Refunds', [second]);

    const { data } = await call(planner, 'upstream_work', { id: third });
    const upstream = data.upstream as { id: string; reason: string; distance: number }[];
    // Past the nearest blocker, which is where `next_tasks` would stop.
    expect(upstream.map((entry) => entry.id)).toEqual([second, first]);
    expect(upstream.map((entry) => entry.distance)).toEqual([1, 2]);
    expect(upstream.every((entry) => entry.reason === 'dependency')).toBe(true);
  });

  it('withholds the writing tools in read-only mode, but not the reading ones', async () => {
    const reader = await connect(paths, { user: 'Worker Bot', readOnly: true });
    const names = (await reader.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('board_overview');
    expect(names).not.toContain('create_document');
    expect(names).not.toContain('delete_document');
    // "What has to happen first?" is free, and is exactly what a read-only
    // agent is there to ask; only acting on the answer is withheld.
    expect(names).toContain('upstream_work');
    expect(names).not.toContain('schedule_upstream');

    const refused = await call(reader, 'add_comment', { id: 'LP-3', body: 'nope' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/read-only/);
    await reader.close();
  });

  /**
   * Running the timeline. An agent gets the same three moves a person gets in
   * the periods view — switch it, restart it, correct an overrun — because
   * they are the same planners underneath.
   */
  describe('the timeline tools', () => {
    /** A quarter with two sprints and one open story in the first. */
    async function timeline(client: Client): Promise<void> {
      await call(client, 'create_document', {
        type: 'increment',
        title: 'H2',
        starts: '2026-07-01',
        ends: '2026-08-31',
      });
      await call(client, 'create_document', {
        type: 'sprint',
        title: 'Sprint 1',
        parent: 'TL-1',
        starts: '2026-07-01',
        ends: '2026-07-14',
      });
      await call(client, 'create_document', {
        type: 'sprint',
        title: 'Sprint 2',
        parent: 'TL-1',
        starts: '2026-07-15',
        ends: '2026-07-28',
      });
    }

    it('holds the switch over the dates, and hands it back', async () => {
      const board = seed();
      const client = await connect(board, { user: 'Planner Bot' });
      await timeline(client);

      await call(client, 'update_document', { id: 'TL-2', active: false });
      expect((await call(client, 'get_document', { id: 'TL-2' })).data.running).toBe('off');

      // The sprint inside a parked quarter is parked with it.
      await call(client, 'update_document', { id: 'TL-1', active: false });
      await call(client, 'update_document', { id: 'TL-2', active: null });
      expect((await call(client, 'get_document', { id: 'TL-2' })).data.running).toBe('off');

      await call(client, 'update_document', { id: 'TL-1', active: null });
      expect((await call(client, 'get_document', { id: 'TL-2' })).data.running).toBe('auto');
      await client.close();
    });

    it('starts a period today, moving what is inside it', async () => {
      const board = seed();
      const client = await connect(board, { user: 'Planner Bot' });
      await timeline(client);

      const today = new Date().toISOString().slice(0, 10);
      const dry = await call(client, 'start_period', { id: 'TL-1', dryRun: true });
      expect(dry.data.wouldStart).toMatchObject({ starts: today, moved: ['TL-2', 'TL-3'] });
      expect((await call(client, 'get_document', { id: 'TL-1' })).data.starts).toBe('2026-07-01');

      const started = await call(client, 'start_period', { id: 'TL-1' });
      expect(started.data.started).toMatchObject({ starts: today });
      expect((await call(client, 'get_document', { id: 'TL-2' })).data.starts).toBe(today);
      expect((await call(client, 'check_board')).data.errors).toBe(0);
      await client.close();
    });

    it('corrects an overrun both ways, and refuses what it cannot do', async () => {
      const board = seed();
      const client = await connect(board, { user: 'Planner Bot' });
      await timeline(client);
      const story = await call(client, 'create_document', {
        type: 'user_story',
        title: 'Not shipped',
        parent: 'LP-3',
        period: 'TL-2',
      });
      const id = story.data.created as string;

      const carried = await call(client, 'correct_period', { id: 'TL-2', mode: 'carry' });
      expect(carried.data.corrected).toMatchObject({ movedTo: 'TL-3', issues: [id] });
      expect((await call(client, 'get_document', { id })).data.period).toBe('TL-3');

      // TL-3 is the last sprint: there is nowhere further to push.
      const stuck = await call(client, 'correct_period', { id: 'TL-3', mode: 'carry' });
      expect(stuck.isError).toBe(true);
      expect(stuck.text).toMatch(/no period after/i);

      await call(client, 'correct_period', { id: 'TL-3', mode: 'complete' });
      expect((await call(client, 'get_document', { id })).data.status).toBe('done');
      await client.close();
    });
  });

  it('validates the board it just built', async () => {
    const { data } = await call(planner, 'check_board');
    expect(data.errors).toBe(0);
  });
});

/**
 * `workUnitsOnly` is the listing side of the rule `next_tasks` ranks by, so the
 * two have to agree about what carries work.
 */
describe('listing the documents that carry work', () => {
  let paths: BoardPaths;
  let client: Client;

  beforeAll(async () => {
    paths = seed();
    createIssue(reload(paths), { type: 'user_story', title: 'Carrier', parentId: 'LP-3' });
    createIssue(reload(paths), { type: 'sub_task', title: 'Step one', parentId: 'LP-4' });
    createIssue(reload(paths), { type: 'sub_task', title: 'Step two', parentId: 'LP-4' });
    createIssue(reload(paths), { type: 'user_story', title: 'Standalone', parentId: 'LP-3' });
    client = await connect(paths);
  });

  const listed = async (args: Record<string, unknown>): Promise<string[]> => {
    const { data } = await call(client, 'list_documents', args);
    return (data.documents as { id: string }[]).map((document) => document.id);
  };

  it('keeps an atomic story and drops the sub-tasks inside it', async () => {
    // LP-1/2/3 are containers; LP-4 is a story with sub-tasks LP-5 and LP-6.
    expect(await listed({ kind: 'issue', workUnitsOnly: true })).toEqual(['LP-4', 'LP-7']);
  });

  it('lists everything when the filter is off', async () => {
    const all = await listed({ kind: 'issue' });
    expect(all).toEqual(['LP-1', 'LP-2', 'LP-3', 'LP-4', 'LP-5', 'LP-6', 'LP-7']);
  });

  it('answers from the whole board, not from what an earlier filter left', async () => {
    // Narrowing to the sub-tasks first must not make them look like carriers:
    // they are inside LP-4, whatever else the listing was filtered by.
    expect(await listed({ kind: 'issue', parent: 'LP-4', workUnitsOnly: true })).toEqual([]);
    expect(await listed({ kind: 'issue', type: 'sub_task', workUnitsOnly: true })).toEqual([]);
  });

  it('falls back to childlessness for periods, which know nothing of atomic', async () => {
    createPeriod(reload(paths), {
      type: 'increment',
      title: 'H2',
      starts: '2026-07-01',
      ends: '2026-12-31',
    });
    createPeriod(reload(paths), {
      type: 'sprint',
      title: 'S1',
      parentId: 'TL-1',
      starts: '2026-07-01',
      ends: '2026-07-14',
    });
    const fresh = await connect(paths);
    const { data } = await call(fresh, 'list_documents', {
      kind: 'period',
      workUnitsOnly: true,
    });
    expect((data.documents as { id: string }[]).map((d) => d.id)).toEqual(['TL-2']);
  });
});

/**
 * An agent pointed at a profile. The point of the flag is that a swarm can
 * share one checkout with each member offered a different part of the board,
 * so what is asserted here is the seam: narrowed where work is *offered*,
 * untouched where a document is *asked for* by id.
 */
describe('the containers a dependency puts in order', () => {
  let paths: BoardPaths;
  let client: Client;

  /**
   * program LP-1
   *   epic LP-2 (Checkout)       epic LP-5 (Accounts)
   *     feature LP-3               feature LP-6
   *       story LP-4                 story LP-7
   */
  beforeAll(async () => {
    paths = seed();
    createIssue(reload(paths), { type: 'user_story', title: 'Guest checkout', parentId: 'LP-3' });
    createIssue(reload(paths), { type: 'epic', title: 'Accounts', parentId: 'LP-1' });
    createIssue(reload(paths), { type: 'feature', title: 'Sign-up', parentId: 'LP-5' });
    createIssue(reload(paths), { type: 'user_story', title: 'Email sign-up', parentId: 'LP-6' });
    client = await connect(paths, { user: 'Planner Bot' });
  });

  afterAll(async () => {
    await client.close();
  });

  it('reports them when the dependency is written', async () => {
    const result = await call(client, 'link_issues', { blocked: 'LP-4', blockedBy: ['LP-7'] });
    expect(result.data.added).toEqual(['LP-7']);
    expect(result.data.alsoOrders).toEqual([
      { issue: 'LP-3', waitsOn: 'LP-6', because: { blocked: 'LP-4', blockedBy: 'LP-7' } },
      { issue: 'LP-2', waitsOn: 'LP-5', because: { blocked: 'LP-4', blockedBy: 'LP-7' } },
    ]);
  });

  it('reads them back off the container, in both directions', async () => {
    const feature = await call(client, 'get_document', { id: 'LP-3', includeComments: false });
    // Nothing was written on it; the reflection is read off the work inside.
    expect(feature.data.blockedBy).toEqual([]);
    expect(feature.data.rolledUpBlockedBy).toEqual([
      { id: 'LP-6', because: { blocked: 'LP-4', blockedBy: 'LP-7' } },
    ]);

    const blocker = await call(client, 'get_document', { id: 'LP-6', includeComments: false });
    expect(blocker.data.rolledUpBlocks).toEqual([
      { id: 'LP-3', because: { blocked: 'LP-4', blockedBy: 'LP-7' } },
    ]);
    expect(blocker.data.rolledUpBlockedBy).toEqual([]);
  });

  it('says nothing on the story the dependency is written on', async () => {
    const story = await call(client, 'get_document', { id: 'LP-4', includeComments: false });
    expect(story.data.blockedBy).toEqual(['LP-7']);
    expect(story.data.rolledUpBlockedBy).toEqual([]);
  });
});

describe('a scoped mcp session', () => {
  let paths: BoardPaths;
  let scoped: Client;

  beforeAll(async () => {
    paths = seed();
    createIssue(reload(paths), { type: 'epic', title: 'Billing', parentId: 'LP-1' });
    createIssue(reload(paths), { type: 'feature', title: 'Invoices', parentId: 'LP-4' });
    createIssue(reload(paths), {
      type: 'user_story',
      title: 'Guest pays',
      parentId: 'LP-3',
      assignee: 'RS-1',
    });
    createIssue(reload(paths), {
      type: 'user_story',
      title: 'Invoice PDF',
      parentId: 'LP-5',
      assignee: 'RS-1',
    });

    const file = path.join(paths.root, 'agent.yml');
    writeFileSync(file, 'user: Planner Bot\nscope:\n  under: [LP-2]\n', 'utf8');
    scoped = await connect(paths, { profile: file });
  });

  it('takes its identity from the profile', async () => {
    const { data } = await call(scoped, 'board_overview');
    expect(data.currentUser).toBe('RS-1');
    expect(data.scope).toBe('under LP-2');
    expect(data.scopeWarnings).toEqual([]);
  });

  it('leaves out-of-scope issues out of a listing, and says how many', async () => {
    const { data } = await call(scoped, 'list_documents', { kind: 'issue' });
    const listed = (data.documents as { id: string }[]).map((document) => document.id);

    expect(listed).toEqual(['LP-2', 'LP-3', 'LP-6']);
    expect(data.outOfScope).toBe(4);
  });

  it('offers only work inside the scope', async () => {
    const { data } = await call(scoped, 'next_tasks', {});
    expect((data.tasks as { id: string }[]).map((task) => task.id)).toEqual(['LP-6']);
  });

  /** Scope decides what is offered, never what is reachable. */
  it('still reads a document outside the scope by id', async () => {
    const { data, isError } = await call(scoped, 'get_document', { id: 'LP-7' });
    expect(isError).toBe(false);
    expect(data.title).toBe('Invoice PDF');
  });

  it('reports a scope this board has nothing for', async () => {
    const file = path.join(paths.root, 'stale.yml');
    writeFileSync(file, 'scope:\n  under: [LP-404]\n', 'utf8');
    const stale = await connect(paths, { user: 'Worker Bot', profile: file });

    const { data } = await call(stale, 'board_overview');
    expect(data.scopeWarnings).toEqual(['this board has nothing named "LP-404"']);
    expect((await call(stale, 'next_tasks', {})).data.tasks).toEqual([]);
    await stale.close();
  });

  it('says why a profile it cannot read is not being applied', async () => {
    const file = path.join(paths.root, 'broken.yml');
    writeFileSync(file, 'scope:\n  excludes: [LP-2]\n', 'utf8');
    const broken = await connect(paths, { user: 'Worker Bot', profile: file });

    const { data } = await call(broken, 'board_overview');
    expect(data.scope).toBe('the whole board');
    expect((data.scopeWarnings as string[]).join(' ')).toMatch(/excludes/);
    await broken.close();
  });

  it('resolves the session user from LPM_USER when no --user flag is given', async () => {
    // Simulate what serve.ts does: flag wins, env is the fallback
    const USER_ENV_VAR = 'LPM_USER';
    const previous = process.env[USER_ENV_VAR];
    process.env[USER_ENV_VAR] = 'Worker Bot';
    try {
      // serve.ts style resolution: flag ?? env ?? null
      const user = process.env[USER_ENV_VAR]?.trim() || undefined;
      const client = await connect(paths, { user });
      const { data } = await call(client, 'board_overview');
      expect(data.currentUser).toBe('RS-2');
      await client.close();
    } finally {
      if (previous !== undefined) process.env[USER_ENV_VAR] = previous;
      else delete process.env[USER_ENV_VAR];
    }
  });

  it('lets the --user flag override LPM_USER', async () => {
    const USER_ENV_VAR = 'LPM_USER';
    const previous = process.env[USER_ENV_VAR];
    process.env[USER_ENV_VAR] = 'Wrong Person';
    try {
      // Flag overrides the env
      const client = await connect(paths, { user: 'Planner Bot' });
      const { data } = await call(client, 'board_overview');
      expect(data.currentUser).toBe('RS-1');
      await client.close();
    } finally {
      if (previous !== undefined) process.env[USER_ENV_VAR] = previous;
      else delete process.env[USER_ENV_VAR];
    }
  });
});

describe('mcp setup', () => {
  const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

  function lpm(cwd: string, ...args: string[]): { status: number; all: string } {
    const result = spawnSync(process.execPath, [CLI, 'mcp', 'setup', ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { status: result.status ?? 0, all: (result.stdout ?? '') + (result.stderr ?? '') };
  }

  const read = (file: string): Record<string, Record<string, unknown>> =>
    JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, unknown>>;

  let root: string;
  beforeAll(() => {
    root = makeBoard('scrum', 'CF').root;
    createResource(reload(boardPathsFor(root)), { type: 'person', title: 'Ada Lovelace' });
  });

  it('writes a config that launches this board', () => {
    const result = lpm(root, '--user', 'Ada Lovelace');
    expect(result.status).toBe(0);

    const config = read(path.join(root, '.mcp.json'));
    const entry = config.mcpServers!['light-plan'] as {
      command: string;
      args: string[];
      cwd: string;
      env?: Record<string, string>;
    };
    expect(entry.args.slice(0, 1)).toEqual(['mcp']);
    expect(entry.env?.LPM_USER).toBe('Ada Lovelace');
    expect(entry.cwd).toBe(root);
  });

  it('refuses to clobber a file it did not open', () => {
    const result = lpm(root);
    expect(result.status).toBe(1);
    expect(result.all).toMatch(/already exists/);
  });

  it('merges into an existing config, leaving the rest of it alone', () => {
    const file = path.join(root, 'host.json');
    writeFileSync(
      file,
      JSON.stringify({
        $schema: 'https://example.com/s.json',
        mcpServers: { filesystem: { command: 'npx', args: ['-y', 'server-filesystem'] } },
        theme: 'dark',
      }),
      'utf8',
    );

    expect(lpm(root, '--file', 'host.json').status).toBe(0);
    const config = read(file);
    expect(Object.keys(config.mcpServers!)).toEqual(['filesystem', 'light-plan']);
    expect(config.$schema).toBe('https://example.com/s.json');
    expect(config.theme).toBe('dark');
  });

  it('refuses a duplicate entry unless forced', () => {
    expect(lpm(root, '--file', 'host.json').status).toBe(1);
    expect(lpm(root, '--file', 'host.json', '--force').status).toBe(0);
    expect(lpm(root, '--file', 'host.json', '--name', 'light-plan-ro', '--read-only').status).toBe(
      0,
    );

    const config = read(path.join(root, 'host.json'));
    expect(Object.keys(config.mcpServers!)).toContain('light-plan-ro');
    expect((config.mcpServers!['light-plan-ro'] as { args: string[] }).args).toContain(
      '--read-only',
    );
  });

  it("follows VS Code's `servers` key when the file already uses it", () => {
    const file = path.join(root, 'vscode.json');
    writeFileSync(file, JSON.stringify({ servers: { other: { command: 'x', args: [] } } }), 'utf8');

    expect(lpm(root, '--file', 'vscode.json').status).toBe(0);
    const config = read(file);
    expect(Object.keys(config)).toEqual(['servers']);
    expect(Object.keys(config.servers!)).toEqual(['other', 'light-plan']);
  });

  it('reports invalid JSON without touching the file', () => {
    const file = path.join(root, 'broken.json');
    writeFileSync(file, '{ not json', 'utf8');

    const result = lpm(root, '--file', 'broken.json');
    expect(result.status).toBe(1);
    expect(result.all).toMatch(/not valid JSON/);
    expect(readFileSync(file, 'utf8')).toBe('{ not json');
  });

  it('prints without writing when asked', () => {
    const target = path.join(root, 'nowhere.json');
    const result = lpm(root, '--print', '--output', 'nowhere.json');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.all).mcpServers['light-plan']).toBeDefined();
    expect(existsSync(target)).toBe(false);
  });
});

describe('the command an mcp config launches', () => {
  const cached = '/home/ada/.npm/_npx/3f2a/node_modules/light-plan/dist/cli/index.js';
  const cachedWin = 'C:\\Users\\ada\\AppData\\Local\\npm-cache\\_npx\\3f2a\\node_modules\\light-plan\\dist\\cli\\index.js';
  const checkout = '/home/ada/src/light_plan_manager/dist/cli/index.js';

  it('names lpm when it is on the PATH, wherever this copy runs from', () => {
    expect(launchCommand(true, cached, 'linux')).toEqual({ command: 'lpm', args: ['mcp'] });
  });

  it('starts npx rather than pointing into the npx cache npm may clear', () => {
    expect(launchCommand(false, cached, 'linux')).toEqual({
      command: 'npx',
      args: ['-y', 'light-plan', 'mcp'],
    });
    expect(launchCommand(false, cachedWin, 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'npx', '-y', 'light-plan', 'mcp'],
    });
  });

  it('points at a checkout that is not on the PATH', () => {
    expect(launchCommand(false, checkout, 'linux')).toEqual({
      command: process.execPath,
      args: [checkout, 'mcp'],
    });
  });
});

/**
 * LP-343 — the remote tools for agents.  The gate is the feature: `remote_status`
 * and `remote_preview` are always registered; `remote_sync` writes to a tracker
 * outside the checkout and is registered only under `--allow-remote`, and never
 * on a read-only server.  The behaviour tests drive the real GitHub provider
 * against the in-memory tracker (`fetch` stubbed), exactly as the conformance
 * suite does, so a preview and a sync are exercised offline.
 */
describe('the remote tools', () => {
  const REMOTES = `
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      types:
        program: { labels: [program] }
        epic: { labels: [epic] }
        feature: { labels: [feature] }
        user_story: { labels: [story] }
      statuses:
        backlog: Backlog
        ready: Ready
        in_progress: In Progress
        in_review: In Review
        done: { remote: [Done], push: Done, closed: true }
      periods:
        container: sprint
`;

  /** A scrum board with a GitHub remote declared and one story worth of tree. */
  function remoteSeed(): BoardPaths {
    const paths = makeBoard('scrum', 'LP');
    createIssue(reload(paths), { type: 'program', title: 'Platform' });
    createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
    createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
    createIssue(reload(paths), { type: 'user_story', title: 'Guest can pay', parentId: 'LP-3' });
    const configPath = path.join(paths.root, '.lpm', 'config.yml');
    writeFileSync(configPath, readFileSync(configPath, 'utf8') + REMOTES);
    return paths;
  }

  it('registers remote_status and remote_preview, and withholds remote_sync without --allow-remote', async () => {
    const client = await connect(remoteSeed());
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('remote_status');
    expect(names).toContain('remote_preview');
    expect(names).not.toContain('remote_sync');
    await client.close();
  });

  it('registers remote_sync only with --allow-remote, and --read-only still excludes it', async () => {
    const paths = remoteSeed();

    const allowed = await connect(paths, { allowRemote: true });
    expect((await allowed.listTools()).tools.map((tool) => tool.name)).toContain('remote_sync');
    await allowed.close();

    const reader = await connect(paths, { allowRemote: true, readOnly: true });
    const names = (await reader.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('remote_status');
    expect(names).toContain('remote_preview');
    expect(names).not.toContain('remote_sync');
    await reader.close();
  });

  it('reports drift, previews a plan, then syncs it away', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    vi.stubGlobal('fetch', memoryConnector({ repo: 'acme/payments' }).fetch);
    try {
      const client = await connect(remoteSeed(), { allowRemote: true });

      const before = await call(client, 'remote_status', {});
      expect(before.isError).toBe(false);
      expect(before.data.unlinked).toEqual(['LP-1', 'LP-2', 'LP-3', 'LP-4']);
      expect(before.data.exitCode).toBe(1);

      const preview = await call(client, 'remote_preview', {});
      expect(preview.isError).toBe(false);
      expect(String(preview.data.plan)).toContain('create');
      expect(String(preview.data.plan)).toContain('Guest can pay');

      const sync = await call(client, 'remote_sync', { yes: true });
      expect(sync.isError).toBe(false);
      expect((sync.data.push as { created: number }).created).toBe(4);

      const after = await call(client, 'remote_status', {});
      expect(after.isError).toBe(false);
      expect(after.data.exitCode).toBe(0);
      await client.close();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('remote_sync accepts a filter and syncs only that subtree', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_test');
    vi.stubGlobal('fetch', memoryConnector({ repo: 'acme/payments' }).fetch);
    try {
      const client = await connect(remoteSeed(), { allowRemote: true });

      const sync = await call(client, 'remote_sync', { filter: 'LP-4', yes: true });
      expect(sync.isError).toBe(false);
      expect((sync.data.push as { created: number }).created).toBe(1);

      const status = await call(client, 'remote_status', {});
      // The three containers above the story are still never pushed.
      expect(status.data.unlinked).toEqual(['LP-1', 'LP-2', 'LP-3']);
      await client.close();
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('refuses a filter naming no document, as a readable error', async () => {
    const client = await connect(remoteSeed(), { allowRemote: true });
    const result = await call(client, 'remote_sync', { filter: 'LP-404', dryRun: true });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/no document/);
    await client.close();
  });
});
