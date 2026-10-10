import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import {
  createIssue,
  createResource,
  findIssue,
  findPeriod,
  findResource,
  listComments,
  setCurrentUser,
} from '../src/core/index.js';
import { startBoardServer } from '../src/server/index.js';
import { parseView } from '../src/server/views/schema.js';
import { applyChanges } from '../src/sync/apply.js';
import type {
  BoardSnapshot,
  BoardTemplatesDto,
  Change,
  ConfigEditResultDto,
  CurrentUserDto,
  NodePatch,
  QueueSequenceDto,
  ServerInfoDto,
  ViewDocument,
} from '../src/shared/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Payments platform' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout revamp', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  return paths;
}

const create = (id: string, patch: NodePatch): Change => ({
  kind: 'create',
  id,
  nodeKind: 'issue',
  patch,
});

describe('applyChanges', () => {
  it('creates documents and reports the ids it allocated', () => {
    const paths = seed();
    const result = applyChanges(paths, [
      create('new:1', { type: 'user_story', title: 'Guest checkout', parentId: 'LP-3' }),
      create('new:2', { type: 'user_story', title: 'Guest payment', parentId: 'LP-3' }),
    ]);

    expect(result.failures).toEqual([]);
    expect(result.idMap).toEqual({ 'new:1': 'LP-4', 'new:2': 'LP-5' });
    expect(result.applied).toEqual(['new:1', 'new:2']);
    expect(result.board.issues.map((issue) => issue.id)).toEqual([
      'LP-1',
      'LP-2',
      'LP-3',
      'LP-4',
      'LP-5',
    ]);
  });

  it('resolves temporary ids used by later changes', () => {
    const paths = seed();
    const result = applyChanges(paths, [
      create('new:1', { type: 'user_story', title: 'First', parentId: 'LP-3' }),
      create('new:2', {
        type: 'user_story',
        title: 'Second',
        parentId: 'LP-3',
        dependsOn: ['new:1'],
      }),
    ]);

    expect(result.failures).toEqual([]);
    expect(findIssue(reload(paths), 'LP-5')!.depends_on).toEqual(['LP-4']);
  });

  it('pushes a dependency naming a document created later in the same push', () => {
    const paths = seed();
    const result = applyChanges(paths, [
      create('new:1', {
        type: 'user_story',
        title: 'Retry queue',
        parentId: 'LP-3',
        dependsOn: ['new:2'],
      }),
      create('new:2', { type: 'research', title: 'Measure latency', parentId: 'LP-3' }),
    ]);

    expect(result.failures).toEqual([]);
    const board = reload(paths);
    // The story was written before its research existed; the link was replayed.
    expect(findIssue(board, 'LP-4')!.depends_on).toEqual(['LP-5']);
    expect(board.dependents.get('LP-5')).toEqual(['LP-4']);
  });

  it('adds and clears a dependency through an update patch', () => {
    const paths = seed();
    applyChanges(paths, [
      create('new:1', { type: 'research', title: 'Measure latency', parentId: 'LP-3' }),
      create('new:2', { type: 'user_story', title: 'Retry queue', parentId: 'LP-3' }),
    ]);

    applyChanges(paths, [
      { kind: 'update', id: 'LP-5', nodeKind: 'issue', patch: { dependsOn: ['LP-4'] } },
    ]);
    expect(findIssue(reload(paths), 'LP-5')!.depends_on).toEqual(['LP-4']);

    applyChanges(paths, [
      { kind: 'update', id: 'LP-5', nodeKind: 'issue', patch: { dependsOn: [] } },
    ]);
    expect(findIssue(reload(paths), 'LP-5')!.depends_on).toEqual([]);
  });

  it('pushes related files, on a create and through an update', () => {
    const paths = seed();
    applyChanges(paths, [
      create('new:1', {
        type: 'user_story',
        title: 'Guest checkout',
        parentId: 'LP-3',
        relatedFiles: ['docs/prd.md#L10-L42'],
      }),
    ]);
    expect(findIssue(reload(paths), 'LP-4')!.related_files).toEqual(['docs/prd.md#L10-L42']);

    // The whole list travels, so a shorter one is how an entry is removed.
    applyChanges(paths, [
      { kind: 'update', id: 'LP-4', nodeKind: 'issue', patch: { relatedFiles: ['src/a.ts'] } },
    ]);
    expect(findIssue(reload(paths), 'LP-4')!.related_files).toEqual(['src/a.ts']);

    applyChanges(paths, [
      { kind: 'update', id: 'LP-4', nodeKind: 'issue', patch: { relatedFiles: [] } },
    ]);
    expect(findIssue(reload(paths), 'LP-4')!.related_files).toEqual([]);
  });

  it('carries a rename, a retype, a reparent and a relink in one patch', () => {
    const paths = seed();
    applyChanges(paths, [
      create('new:1', { type: 'feature', title: 'Returning flow', parentId: 'LP-2' }),
      create('new:2', { type: 'user_story', title: 'Blocker', parentId: 'LP-3' }),
    ]);

    const result = applyChanges(paths, [
      {
        kind: 'update',
        id: 'LP-4',
        nodeKind: 'issue',
        patch: {
          title: 'Returning customer flow',
          type: 'user_story',
          parentId: 'LP-3',
          status: 'in_progress',
          dependsOn: ['LP-5'],
          attributes: { story_points: 5 },
        },
      },
    ]);

    expect(result.failures).toEqual([]);
    const issue = findIssue(reload(paths), 'LP-4')!;
    expect(issue.title).toBe('Returning customer flow');
    expect(issue.type).toBe('user_story');
    expect(issue.parentId).toBe('LP-3');
    expect(issue.status).toBe('in_progress');
    expect(issue.depends_on).toEqual(['LP-5']);
    expect(issue.attributes.story_points).toBe(5);
    expect(issue.dir).toContain('LP-4');
  });

  it('removes a dependency by pushing the shorter list', () => {
    const paths = seed();
    applyChanges(paths, [
      create('new:1', { type: 'user_story', title: 'A', parentId: 'LP-3' }),
      create('new:2', { type: 'user_story', title: 'B', parentId: 'LP-3', dependsOn: ['new:1'] }),
    ]);

    applyChanges(paths, [
      { kind: 'update', id: 'LP-5', nodeKind: 'issue', patch: { dependsOn: [] } },
    ]);
    expect(findIssue(reload(paths), 'LP-5')!.depends_on).toEqual([]);
  });

  it('deletes a subtree and detaches what pointed at it', () => {
    const paths = seed();
    applyChanges(paths, [
      create('new:1', { type: 'user_story', title: 'A', parentId: 'LP-3' }),
      create('new:2', { type: 'user_story', title: 'B', parentId: 'LP-3', dependsOn: ['new:1'] }),
    ]);

    const result = applyChanges(paths, [{ kind: 'delete', id: 'LP-4', nodeKind: 'issue' }]);
    expect(result.failures).toEqual([]);
    expect(findIssue(reload(paths), 'LP-4')).toBeNull();
    expect(findIssue(reload(paths), 'LP-5')!.depends_on).toEqual([]);
  });

  it('applies the changes it can and reports the ones it cannot', () => {
    const paths = seed();
    const result = applyChanges(paths, [
      create('new:1', { type: 'user_story', title: 'Fine', parentId: 'LP-3' }),
      // An epic cannot live under a feature.
      create('new:2', { type: 'epic', title: 'Wrong depth', parentId: 'LP-3' }),
      create('new:3', { type: 'user_story', title: 'Also fine', parentId: 'LP-3' }),
    ]);

    expect(result.applied).toEqual(['new:1', 'new:3']);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.id).toBe('new:2');
    expect(result.failures[0]!.error).toMatch(/cannot be nested/);
    expect(reload(paths).issues).toHaveLength(5);
  });

  it('refuses a dependency that would close a cycle', () => {
    const paths = seed();
    applyChanges(paths, [
      create('new:1', { type: 'user_story', title: 'A', parentId: 'LP-3' }),
      create('new:2', { type: 'user_story', title: 'B', parentId: 'LP-3', dependsOn: ['new:1'] }),
    ]);

    const result = applyChanges(paths, [
      { kind: 'update', id: 'LP-4', nodeKind: 'issue', patch: { dependsOn: ['LP-5'] } },
    ]);
    expect(result.failures[0]!.error).toMatch(/cycle/);
  });

  /**
   * The queue is not in dependency order and cannot be made to be: an edit
   * merges into the pending change for the same document, which sits wherever
   * that document was first touched — possibly ahead of the sprint or the
   * teammate the edit now names. The reference decides the order, not the slot.
   */
  it('schedules into a period and onto a resource the same push creates later', () => {
    const paths = seed();
    const result = applyChanges(paths, [
      { kind: 'update', id: 'LP-3', nodeKind: 'issue', patch: { period: 'new:1', assignee: 'new:2' } },
      {
        kind: 'create',
        id: 'new:1',
        nodeKind: 'period',
        patch: { type: 'increment', title: 'H2', starts: '2026-07-01', ends: '2026-12-31' },
      },
      { kind: 'create', id: 'new:2', nodeKind: 'resource', patch: { type: 'person', title: 'Ada' } },
    ]);

    expect(result.failures).toEqual([]);
    expect(result.applied).toHaveLength(3);
    const issue = findIssue(reload(paths), 'LP-3')!;
    expect(issue.period).toBe(result.idMap['new:1']);
    expect(issue.assignee).toBe(result.idMap['new:2']);
  });

  it('creates an issue already scheduled into a later create', () => {
    const paths = seed();
    const result = applyChanges(paths, [
      create('new:1', {
        type: 'user_story',
        title: 'Guest checkout',
        parentId: 'LP-3',
        period: 'new:2',
        assignee: 'new:3',
      }),
      {
        kind: 'create',
        id: 'new:2',
        nodeKind: 'period',
        patch: { type: 'increment', title: 'H2', starts: '2026-07-01', ends: '2026-12-31' },
      },
      { kind: 'create', id: 'new:3', nodeKind: 'resource', patch: { type: 'person', title: 'Ada' } },
    ]);

    expect(result.failures).toEqual([]);
    const issue = findIssue(reload(paths), result.idMap['new:1']!)!;
    expect(issue.period).toBe(result.idMap['new:2']);
    expect(issue.assignee).toBe(result.idMap['new:3']);
  });

  /**
   * A create that fails takes down everything that named it, and there can be
   * dozens of those — an epic's worth of issues dropped into a new sprint. They
   * are reported against the create rather than as "no such document", which is
   * both what happened and the one line worth reading.
   */
  it('reports a reference whose create failed against the create, not as a missing document', () => {
    const paths = seed();
    const result = applyChanges(paths, [
      { kind: 'update', id: 'LP-3', nodeKind: 'issue', patch: { period: 'new:1' } },
      { kind: 'update', id: 'LP-2', nodeKind: 'issue', patch: { period: 'new:1' } },
      // A sprint cannot sit under nothing on this board's timeline hierarchy.
      {
        kind: 'create',
        id: 'new:1',
        nodeKind: 'period',
        patch: { type: 'sprint', title: 'Orphan', starts: '2026-07-01', ends: '2026-07-14' },
      },
    ]);

    expect(result.applied).toEqual([]);
    expect(result.failures.map((failure) => failure.id)).toEqual(['new:1', 'LP-3', 'LP-2']);
    expect(result.failures[1]!.error).toBe('Waiting on new:1, which was not created');
    expect(result.failures[2]!.error).toBe('Waiting on new:1, which was not created');
    // Nothing was written, so the board is untouched and the whole lot can be
    // pushed again once the create is fixed.
    expect(findIssue(reload(paths), 'LP-3')!.period).toBeNull();
  });

  /**
   * The scenario this whole ordering exists for: a new increment, a new sprint
   * inside it, and a pile of issues scheduled into the sprint — all in one push.
   */
  it('pushes a new increment, a sprint inside it and the work scheduled into it', () => {
    const paths = seed();
    const result = applyChanges(paths, [
      {
        kind: 'create',
        id: 'new:1',
        nodeKind: 'period',
        patch: { type: 'increment', title: 'PI-5', starts: '2027-01-30', ends: '2027-06-30' },
      },
      {
        kind: 'create',
        id: 'new:2',
        nodeKind: 'period',
        patch: {
          type: 'sprint',
          title: 'New Sprint',
          parentId: 'new:1',
          starts: '2027-01-30',
          ends: '2027-02-12',
        },
      },
      { kind: 'update', id: 'LP-2', nodeKind: 'issue', patch: { period: 'new:2' } },
      { kind: 'update', id: 'LP-3', nodeKind: 'issue', patch: { period: 'new:2' } },
    ]);

    expect(result.failures).toEqual([]);
    const board = reload(paths);
    const sprint = findPeriod(board, result.idMap['new:2']!)!;
    expect(sprint.parentId).toBe(result.idMap['new:1']);
    expect(findIssue(board, 'LP-2')!.period).toBe(sprint.id);
    expect(findIssue(board, 'LP-3')!.period).toBe(sprint.id);
  });

  it('creates and links resources', () => {
    const paths = seed();
    const result = applyChanges(paths, [
      { kind: 'create', id: 'new:1', nodeKind: 'resource', patch: { type: 'role', title: 'Jr Dev', capacity: 2 } },
      { kind: 'create', id: 'new:2', nodeKind: 'resource', patch: { type: 'person', title: 'Ada', covers: ['new:1'] } },
      { kind: 'update', id: 'LP-3', nodeKind: 'issue', patch: { assignee: 'new:2' } },
    ]);

    expect(result.failures).toEqual([]);
    const board = reload(paths);
    expect(findResource(board, 'RS-2')!.covers).toEqual(['RS-1']);
    expect(findIssue(board, 'LP-3')!.assignee).toBe('RS-2');
  });

  /**
   * The period switch, queued in the browser and pushed. `null` has to survive
   * the round trip as its own value: it removes the field, which is a different
   * edit from switching a period off.
   */
  it('creates a period, switches it, and hands it back to its dates', () => {
    const paths = seed();
    const created = applyChanges(paths, [
      {
        kind: 'create',
        id: 'new:1',
        nodeKind: 'period',
        patch: { type: 'increment', title: 'H2', starts: '2026-07-01', ends: '2026-12-31' },
      },
    ]);
    expect(created.failures).toEqual([]);
    const id = created.idMap['new:1']!;
    expect(findPeriod(reload(paths), id)!.active).toBeUndefined();
    expect(created.board.periods[0]!.active).toBeUndefined();

    const off = applyChanges(paths, [
      { kind: 'update', id, nodeKind: 'period', patch: { active: false } },
    ]);
    expect(off.failures).toEqual([]);
    expect(findPeriod(reload(paths), id)!.active).toBe(false);
    // And it reaches the browser again on the snapshot the push returns.
    expect(off.board.periods[0]!.active).toBe(false);

    const back = applyChanges(paths, [
      { kind: 'update', id, nodeKind: 'period', patch: { active: null } },
    ]);
    expect(back.failures).toEqual([]);
    expect(findPeriod(reload(paths), id)!.active).toBeUndefined();
  });
});

describe('http api', () => {
  let paths: BoardPaths;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    paths = seed();
    const running = await startBoardServer(paths, { port: 0, serveApp: false });
    server = running.server;
    base = running.url;
  });

  afterAll(() => {
    server.close();
  });

  const json = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${base}${path}`, init);
    return (await response.json()) as T;
  };
  const post = (path: string, body: unknown): RequestInit => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  it('serves no tracker remote route unless started --experimental, and git sharing either way', async () => {
    // A published `lpm ui` offers git sharing only: the tracker routes are not
    // registered, so nothing can reach them whatever the web app shows.
    expect((await json<ServerInfoDto>('/api/health')).experimental).toBe(false);
    expect((await fetch(`${base}/api/remotes`)).status).toBe(404);
    expect((await fetch(`${base}/api/remote-providers`)).status).toBe(404);
    expect((await fetch(`${base}/api/remotes/jira/status`)).status).toBe(404);
    expect((await fetch(`${base}/api/git`)).status).toBe(200);

    const experimental = await startBoardServer(paths, {
      port: 0,
      serveApp: false,
      experimental: true,
    });
    try {
      const info = (await (await fetch(`${experimental.url}/api/health`)).json()) as ServerInfoDto;
      expect(info.experimental).toBe(true);
      expect((await fetch(`${experimental.url}/api/remotes`)).status).toBe(200);
    } finally {
      experimental.server.close();
    }
  });

  it('serves the board snapshot without filesystem paths', async () => {
    const board = await json<BoardSnapshot>('/api/board');
    expect(board.issues.map((issue) => issue.id)).toEqual(['LP-1', 'LP-2', 'LP-3']);
    expect(board.config.hierarchy.issue[0]).toEqual(['program']);
    expect(board.config.hasResources).toBe(true);
    expect(JSON.stringify(board)).not.toContain(paths.boardDir);
  });

  it('creates, lists, saves and deletes a view', async () => {
    const created = await json<ViewDocument>('/api/views', post('/api/views', { name: 'Roadmap' }));
    expect(created.id).toBe('roadmap');

    const saved = await json<ViewDocument>(`/api/views/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...created,
        members: ['LP-3'],
        // A node someone dragged bigger keeps that size across a reload.
        layout: { 'LP-3': { x: 10, y: 20, width: 320, height: 180, collapsed: true } },
        panel: { open: true, pinned: false, width: 480 },
        display: { feature: 'badge' },
      }),
    });
    expect(saved.members).toEqual(['LP-3']);
    expect(saved.layout['LP-3']).toEqual({ x: 10, y: 20, width: 320, height: 180, collapsed: true });
    // The panes someone sized are part of the view, like the canvas geometry.
    expect(saved.panel).toEqual({ open: true, pinned: false, width: 480 });
    // So is which levels the canvas draws as badges rather than as nodes.
    expect(saved.display).toEqual({ feature: 'badge' });
    // Whether the board plans with sprints is not: that is board config now,
    // so every view and every teammate works the same queue.
    expect('planning' in saved).toBe(false);

    expect(await json<{ id: string }[]>('/api/views')).toEqual([
      expect.objectContaining({ id: 'roadmap', members: 1 }),
    ]);

    await fetch(`${base}/api/views/roadmap`, { method: 'DELETE' });
    expect(await json<unknown[]>('/api/views')).toEqual([]);
  });

  it('keeps the id of a renamed view and gives the next view a free id', async () => {
    const put = (view: ViewDocument): RequestInit => ({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(view),
    });
    const created = await json<ViewDocument>('/api/views', post('/api/views', { name: 'Plan' }));
    const renamed = await json<ViewDocument>(
      `/api/views/${created.id}`,
      put({ ...created, name: 'Quarter' }),
    );
    expect(renamed).toMatchObject({ id: 'plan', name: 'Quarter' });

    // The name "Plan" is free again, and the file `plan.json` is not.
    const second = await json<ViewDocument>('/api/views', post('/api/views', { name: 'Plan' }));
    expect(second.id).toBe('plan-2');

    // A name is taken whatever its capitals are.
    const refused = await fetch(`${base}/api/views`, post('/api/views', { name: 'quarter' }));
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/"Quarter" already exists/);

    await fetch(`${base}/api/views/plan`, { method: 'DELETE' });
    await fetch(`${base}/api/views/plan-2`, { method: 'DELETE' });
  });

  it('does not write a deleted view again', async () => {
    const view = await json<ViewDocument>('/api/views', post('/api/views', { name: 'Gone' }));
    await fetch(`${base}/api/views/${view.id}`, { method: 'DELETE' });

    // The autosave of a window that still holds the view.
    const saved = await fetch(`${base}/api/views/${view.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(view),
    });
    expect(saved.status).toBe(400);
    expect(((await saved.json()) as { error: string }).error).toMatch(/No view "gone"/);

    // A push from that window answers, and the view stays deleted.
    const pushed = await fetch(
      `${base}/api/views/${view.id}/push`,
      post(`/api/views/${view.id}/push`, { view }),
    );
    expect(pushed.status).toBe(200);
    expect(await json<unknown[]>('/api/views')).toEqual([]);
  });

  it('pushes a view and clears the changes that landed', async () => {
    const view = await json<ViewDocument>('/api/views', post('/api/views', { name: 'Push test' }));
    const changes: Change[] = [
      { kind: 'create', id: 'new:1', nodeKind: 'issue', patch: { type: 'user_story', title: 'From the app', parentId: 'LP-3' } },
    ];

    const result = await json<{ idMap: Record<string, string>; view: ViewDocument; failures: unknown[] }>(
      `/api/views/${view.id}/push`,
      post(`/api/views/${view.id}/push`, { view: { ...view, members: ['LP-3', 'new:1'], changes } }),
    );

    expect(result.failures).toEqual([]);
    expect(result.idMap['new:1']).toMatch(/^LP-\d+$/);
    expect(result.view.changes).toEqual([]);
    expect(findIssue(reload(paths), result.idMap['new:1']!)!.title).toBe('From the app');
  });

  /**
   * A push is partial, so a rejected change stays pending — and it has to come
   * back naming the ids the push allocated. Left pointing at a `new:` id that
   * has already been spent, it could never land again however often the user
   * pressed Push, and it would name a document the board has never heard of.
   */
  it('hands a rejected change back pointing at the ids the push allocated', async () => {
    const view = await json<ViewDocument>('/api/views', post('/api/views', { name: 'Partial' }));
    const changes: Change[] = [
      {
        kind: 'create',
        id: 'new:1',
        nodeKind: 'period',
        patch: { type: 'increment', title: 'PI-4', starts: '2026-07-01', ends: '2026-12-31' },
      },
      // The period is fine; the status is not, so the whole change is rejected.
      { kind: 'update', id: 'LP-2', nodeKind: 'issue', patch: { period: 'new:1', status: 'nope' } },
    ];

    const result = await json<{ idMap: Record<string, string>; view: ViewDocument; failures: { id: string }[] }>(
      `/api/views/${view.id}/push`,
      post(`/api/views/${view.id}/push`, { view: { ...view, changes } }),
    );

    const period = result.idMap['new:1']!;
    expect(result.failures.map((failure) => failure.id)).toEqual(['LP-2']);
    expect(result.view.changes).toEqual([
      { kind: 'update', id: 'LP-2', nodeKind: 'issue', patch: { period, status: 'nope' } },
    ]);

    // And with the status corrected it lands, without the user re-doing the drag.
    const retry = await json<{ failures: unknown[]; view: ViewDocument }>(
      `/api/views/${view.id}/push`,
      post(`/api/views/${view.id}/push`, {
        view: {
          ...result.view,
          changes: [{ kind: 'update', id: 'LP-2', nodeKind: 'issue', patch: { period } }],
        },
      }),
    );
    expect(retry.failures).toEqual([]);
    expect(findIssue(reload(paths), 'LP-2')!.period).toBe(period);
  });

  /**
   * A registry view is the same view file over a different collection, so the
   * two things that could quietly go wrong are `mode` surviving a round trip
   * and `pruneView` checking members against the right list — a template view
   * pruned against the issues would come back empty every time it was opened.
   */
  it('creates a registry view and keeps its template members', async () => {
    const created = await json<ViewDocument>(
      '/api/views',
      post('/api/views', { name: 'Patterns', mode: 'templates' }),
    );
    expect(created.mode).toBe('templates');

    const pushed = await json<{ idMap: Record<string, string>; view: ViewDocument; failures: unknown[] }>(
      `/api/views/${created.id}/push`,
      post(`/api/views/${created.id}/push`, {
        view: {
          ...created,
          changes: [
            {
              kind: 'create',
              id: 'new:1',
              nodeKind: 'template',
              patch: { type: 'program', title: '{{name}} rollout', description: 'A rollout' },
            },
          ],
          members: ['new:1'],
        },
      }),
    );
    expect(pushed.failures).toEqual([]);
    const templateId = pushed.idMap['new:1']!;
    expect(templateId).toMatch(/^TPL-\d+$/);

    // The client swaps temporary ids for allocated ones and saves, exactly as
    // it does for a board view.
    await json<ViewDocument>(`/api/views/${created.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...pushed.view, members: [templateId] }),
    });

    // Reopened: still a registry view, still holding its member. Pruned against
    // the *registry* — against the issues it would come back empty.
    const reopened = await json<ViewDocument>(`/api/views/${created.id}`);
    expect(reopened.mode).toBe('templates');
    expect(reopened.members).toEqual([templateId]);

    const board = await json<BoardSnapshot>('/api/board');
    expect(board.templates.map((entry) => entry.id)).toContain(templateId);
    expect(board.templates.find((entry) => entry.id === templateId)?.root).toBe(true);
  });

  it('refuses a view mode it does not know', async () => {
    const response = await fetch(
      `${base}/api/views`,
      post('/api/views', { name: 'Nope', mode: 'sideways' }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/Unknown view mode/);
  });

  it('reports a bad request as JSON with the hints core supplies', async () => {
    const response = await fetch(`${base}/api/views/does-not-exist`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(/No view/);
  });

  it('404s an unknown api route', async () => {
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
  });

  it('writes comments straight through rather than queueing them', async () => {
    const path = '/api/documents/LP-3/comments';
    expect(await json<{ comments: unknown[] }>(path)).toEqual({ comments: [] });

    await json(path, post(path, { body: 'Started on this', author: 'Ada' }));
    await json(path, post(path, { body: 'Blocked on credentials', author: 'Ada' }));

    const listed = await json<{ comments: { index: number; body: string; author: string }[] }>(path);
    expect(listed.comments.map((comment) => comment.body)).toEqual([
      'Started on this',
      'Blocked on credentials',
    ]);
    // No push was involved: they are already on disk.
    expect(listComments(reload(paths), 'LP-3')).toHaveLength(2);

    await fetch(`${base}${path}/1`, { method: 'DELETE' });
    expect((await json<{ comments: unknown[] }>(path)).comments).toHaveLength(1);
  });

  it('rejects an empty comment', async () => {
    const response = await fetch(`${base}/api/documents/LP-3/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '  ' }),
    });
    expect(response.status).toBe(400);
  });

  it('writes a flag straight through too, with its comment', async () => {
    const path = '/api/documents/LP-3/flag';
    const raised = await json<{ flag: string }>(
      path,
      post(path, { reason: 'help', comment: 'Need a decision on the retry budget' }),
    );
    expect(raised.flag).toBe('help');

    // On disk immediately: a flag says work has stopped *now*, so queueing it
    // until somebody pressed Push would hold back the one edit that cannot wait.
    expect(findIssue(reload(paths), 'LP-3')!.flag).toBe('help');
    expect(listComments(reload(paths), 'LP-3').at(-1)!.body).toContain('retry budget');

    const cleared = await json<{ flag: string | null }>(
      path,
      post(path, { reason: null, comment: 'Three retries.' }),
    );
    expect(cleared.flag).toBeNull();
    expect(findIssue(reload(paths), 'LP-3')!.flag).toBeNull();
  });

  it('a stale body edit pushed after a flag keeps the activity section — and survives clear too', async () => {
    const paths = makeBoard('scrum', 'CL');
    createIssue(reload(paths), { type: 'program', title: 'Clobber test' });
    createIssue(reload(paths), { type: 'epic', title: 'Epic', parentId: 'CL-1' });
    createIssue(reload(paths), { type: 'feature', title: 'Feature', parentId: 'CL-2' });

    // 1. Create a story with a known body
    const created = applyChanges(paths, [
      { kind: 'create', id: 'new:1', nodeKind: 'issue', patch: { type: 'user_story', title: 'Clobber test', parentId: 'CL-3', body: 'Initial prose.' } },
    ]);
    expect(created.failures).toEqual([]);
    const storyId = created.idMap['new:1']!;
    expect(storyId).toBeTruthy();

    // 2. Start a server on this board
    const running = await startBoardServer(paths, { port: 0, serveApp: false });
    const base = running.url;

    try {
      const f = (url: string, init?: RequestInit) => globalThis.fetch(url, init);

      // 3. Flag the issue — straight to disk
      const flagPath = `${base}/api/documents/${storyId}/flag`;
      await f(flagPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'blocked', comment: 'Waiting on dependency.' }) });
      // Clear the flag
      await f(flagPath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: null, comment: 'Dependency resolved.' }) });

      // 4. Push a stale body edit (captured before the flag events)
      const staleBody: Change = {
        kind: 'update',
        id: storyId,
        nodeKind: 'issue',
        patch: { body: 'Updated prose without the flag section.' },
      };
      const pushResult = applyChanges(paths, [staleBody]);
      expect(pushResult.failures).toEqual([]);

      // 5. On disk: both entries survived the stale body push
      const fresh = reload(paths);
      const issue = findIssue(fresh, storyId)!;
      expect(issue.body).toContain('Updated prose without the flag section.');
      expect(issue.body).toContain('flagged: Blocked');
      expect(issue.body).toContain('Waiting on dependency.');
      expect(issue.body).toContain('flag cleared');
      expect(issue.body).toContain('Dependency resolved.');
    } finally {
      running.server.close();
    }
  });

  it('refuses a flag with no comment, and one on an issue that does not exist', async () => {
    const path = '/api/documents/LP-3/flag';
    const noComment = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'blocked', comment: '  ' }),
    });
    expect(noComment.status).toBe(400);

    const missing = await fetch(`${base}/api/documents/LP-999/flag`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'blocked', comment: 'x' }),
    });
    expect(missing.status).toBe(404);
  });
});

describe('view files', () => {
  it('opens a view saved on the queue tab, now that the queue is a panel of its own', () => {
    const view = parseView({ id: 'old', name: 'Old', drawer: { open: true, tab: 'queue', height: 300 } }, 'old');
    expect(view.drawer.tab).toBe('table');
    expect(view.drawer.height).toBe(300);
  });

  it('gives a view written before the queue panel existed one, open', () => {
    const view = parseView({ id: 'old', name: 'Old' }, 'old');
    expect(view.queue).toEqual({ open: true, width: 300 });
  });

  it('keeps the queue panel as somebody left it', () => {
    const view = parseView({ id: 'v', name: 'V', queue: { open: false, width: 410 } }, 'v');
    expect(view.queue).toEqual({ open: false, width: 410 });
  });
});

describe('GET /api/me', () => {
  it('answers who this checkout says is working, and nobody until somebody is set', async () => {
    // The answer reads LPM_USER first, so a developer's own shell must not
    // decide this test.
    const saved = process.env.LPM_USER;
    delete process.env.LPM_USER;
    const paths = seed();
    const running = await startBoardServer(paths, { port: 0, serveApp: false });
    try {
      const me = async (): Promise<CurrentUserDto> =>
        (await (await fetch(`${running.url}/api/me`)).json()) as CurrentUserDto;

      expect(await me()).toEqual({ id: null, ref: null });

      const alice = createResource(reload(paths), { type: 'person', title: 'Alice' });
      setCurrentUser(reload(paths), alice.id);
      expect((await me()).id).toBe(alice.id);
    } finally {
      running.server.close();
      if (saved === undefined) delete process.env.LPM_USER;
      else process.env.LPM_USER = saved;
    }
  });
});

describe('the queue and the planning switch', () => {
  it('serves the engine’s sequence for the team and for one person', async () => {
    const paths = seed();
    const alice = createResource(reload(paths), { type: 'person', title: 'Alice' });
    createIssue(reload(paths), { type: 'user_story', title: 'First', parentId: 'LP-3', assignee: alice.id });
    createIssue(reload(paths), { type: 'user_story', title: 'Second', parentId: 'LP-3' });
    const running = await startBoardServer(paths, { port: 0, serveApp: false });
    try {
      const queue = async (query = ''): Promise<Response> => fetch(`${running.url}/api/queue${query}`);

      const team = (await (await queue()).json()) as QueueSequenceDto;
      expect(team.resource).toBeNull();
      expect(team.steps.map((step) => step.id).sort()).toEqual(['LP-4', 'LP-5']);
      expect(team.steps.map((step) => step.order)).toEqual([1, 2]);

      const mine = (await (await queue(`?resource=${alice.id}`)).json()) as QueueSequenceDto;
      expect(mine.resource).toBe(alice.id);
      expect(mine.steps.map((step) => step.id)).toEqual(['LP-4']);

      expect((await queue('?resource=RS-99')).status).toBe(404);
    } finally {
      running.server.close();
    }
  });

  it('switches the board to one queue and back, writing only the config', async () => {
    const paths = seed();
    const running = await startBoardServer(paths, { port: 0, serveApp: false });
    const put = (planning: unknown): Promise<Response> =>
      fetch(`${running.url}/api/planning`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ planning }),
      });
    const snapshot = async (): Promise<BoardSnapshot> =>
      (await (await fetch(`${running.url}/api/board`)).json()) as BoardSnapshot;
    try {
      expect((await snapshot()).config.planning).toBe('periods');

      expect(await (await put('queue')).json()).toEqual({ planning: 'queue', changed: true });
      expect((await snapshot()).config.planning).toBe('queue');
      expect(((await (await fetch(`${running.url}/api/queue`)).json()) as QueueSequenceDto).planning).toBe('queue');

      expect(await (await put('periods')).json()).toEqual({ planning: 'periods', changed: true });
      expect((await snapshot()).config.planning).toBe('periods');

      expect((await put('kanban')).status).toBe(400);
    } finally {
      running.server.close();
    }
  });

  it('opens a view that still carries the planning it used to keep', () => {
    const view = parseView({ id: 'old', name: 'Old', planning: 'queue' }, 'old');
    expect('planning' in view).toBe(false);
  });
});

describe('the board configuration routes', () => {
  const send = (url: string, method: string, body?: unknown): Promise<Response> =>
    fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('renames a type in the config, in the documents and in the display of a view', async () => {
    const paths = seed();
    const running = await startBoardServer(paths, { port: 0, serveApp: false });
    try {
      const view = (await (await send(`${running.url}/api/views`, 'POST', { name: 'Roadmap' })).json()) as ViewDocument;
      await send(`${running.url}/api/views/${view.id}`, 'PUT', { ...view, display: { epic: 'badge' } });

      const response = await send(`${running.url}/api/config/edits`, 'POST', {
        edits: [{ op: 'update-type', kind: 'issue', type: 'epic', name: 'milestone', label: 'Milestone' }],
      });
      expect(response.status).toBe(200);
      const result = (await response.json()) as ConfigEditResultDto;
      expect(result.rewritten).toBe(1);
      expect(result.renamedTypes).toEqual({ epic: 'milestone' });

      const board = (await (await fetch(`${running.url}/api/board`)).json()) as BoardSnapshot;
      expect(board.config.types.milestone?.label).toBe('Milestone');
      expect(board.config.hierarchy.issue[1]).toEqual(['milestone']);
      expect(board.issues.find((issue) => issue.id === 'LP-2')?.type).toBe('milestone');

      const stored = (await (await fetch(`${running.url}/api/views/${view.id}`)).json()) as ViewDocument;
      expect(stored.display).toEqual({ milestone: 'badge' });
    } finally {
      running.server.close();
    }
  });

  it('answers 400 with the reason when an edit is refused, and for a body with no edits', async () => {
    const paths = seed();
    const running = await startBoardServer(paths, { port: 0, serveApp: false });
    try {
      const refused = await send(`${running.url}/api/config/edits`, 'POST', {
        edits: [{ op: 'remove-type', kind: 'issue', type: 'epic' }],
      });
      expect(refused.status).toBe(400);
      expect(await refused.json()).toEqual({
        error: 'Cannot remove the type "epic"',
        details: ['1 document has this type, for example LP-2.', 'Convert or delete those documents first.'],
      });

      expect((await send(`${running.url}/api/config/edits`, 'POST', { edits: [] })).status).toBe(400);
    } finally {
      running.server.close();
    }
  });

  it('saves the board config as a template and sets the default template', async () => {
    const previous = process.env.LPM_HOME;
    const home = mkdtempSync(path.join(os.tmpdir(), 'lpm-home-'));
    process.env.LPM_HOME = home;
    const paths = seed();
    const running = await startBoardServer(paths, { port: 0, serveApp: false });
    try {
      const url = `${running.url}/api/board-templates`;
      const listed = (await (await fetch(url)).json()) as BoardTemplatesDto;
      expect(listed.templates.map((template) => template.name)).toEqual(['scrum', 'kanban', 'blank']);
      expect(listed.default).toBe('scrum');
      expect(listed.folder).toBe(home);

      const saved = (await (await send(url, 'POST', { name: 'team-flow' })).json()) as BoardTemplatesDto;
      expect(saved.templates.at(-1)).toEqual({ name: 'team-flow', source: 'user' });
      expect((await send(url, 'POST', { name: 'team-flow' })).status).toBe(400);

      const chosen = (await (await send(`${url}/default`, 'PUT', { name: 'team-flow' })).json()) as BoardTemplatesDto;
      expect(chosen.default).toBe('team-flow');

      const removed = (await (await send(`${url}/team-flow`, 'DELETE')).json()) as BoardTemplatesDto;
      expect(removed.templates.map((template) => template.name)).toEqual(['scrum', 'kanban', 'blank']);
      expect(removed.default).toBe('scrum');
    } finally {
      running.server.close();
      rmSync(home, { recursive: true, force: true });
      if (previous === undefined) delete process.env.LPM_HOME;
      else process.env.LPM_HOME = previous;
    }
  });
});
