import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyView,
  type BoardSnapshot,
  type ConfigDto,
  type QueueSequenceDto,
  type SquadDto,
} from '$shared';
import { api } from '$lib/api/client.js';
import { Shell } from '$lib/app/shell.svelte.js';
import type { WorkingNodes } from '$lib/board/working.js';
import { Workspace } from '$lib/workspace/workspace.svelte.js';
import { buildQueue, markerOf, markerTitle, queueSections } from '$features/queue/queue.js';
import { QueueSequence, sequenceKey } from '$features/queue/sequence.svelte.js';
import { currentFocus } from '$features/welcome/digest.js';
import { buildGraph } from '$features/canvas/model.js';
import { bulkEntries } from '$features/canvas/menus.js';
import { board, config, issue, period, resource } from './fixtures.js';

/**
 * Planning with the periods, or working the board as one queue.
 *
 * The mode is board config (`planning:` in config.yml), so the app reads it
 * off the snapshot and writes it through the API; and the queue panel's order
 * is the engine's sequence, passed in rather than worked out here. These cases
 * pin both halves, and that queue mode stops drawing the timeline without
 * touching any document.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

const queueConfig: ConfigDto = { ...config, planning: 'queue' };

function snapshotOf(nodes: WorkingNodes, withConfig: ConfigDto = config): BoardSnapshot {
  const all = Object.values(nodes);
  return {
    config: withConfig,
    issues: all.filter((node) => node.kind === 'issue'),
    periods: all.filter((node) => node.kind === 'period'),
    resources: all.filter((node) => node.kind === 'resource'),
    squads: all.filter((node) => node.kind === 'squad'),
    templates: [],
    problems: [],
    readAt: new Date().toISOString(),
  } as BoardSnapshot;
}

describe('the planning mode', () => {
  function workspaceOn(tab: 'periods' | 'gantt' | 'team', withConfig: ConfigDto = config): Workspace {
    const workspace = new Workspace();
    workspace.snapshot = snapshotOf({}, withConfig);
    const view = emptyView('test', 'Test');
    workspace.view = { ...view, drawer: { ...view.drawer, tab }, queue: { ...view.queue, open: false } };
    return workspace;
  }

  /** The server answers the switch, and the re-read board carries the new mode. */
  function serverSwitchesTo(planning: 'periods' | 'queue') {
    const write = vi.spyOn(api, 'setPlanning').mockResolvedValue({ planning, changed: true });
    vi.spyOn(api, 'board').mockResolvedValue(snapshotOf({}, { ...config, planning }));
    vi.spyOn(api, 'saveView').mockImplementation(async (view) => view);
    return write;
  }

  it('is read off the board config, not the view', () => {
    expect(workspaceOn('team').planning).toBe('periods');
    expect(workspaceOn('team', queueConfig).planning).toBe('queue');
  });

  it('is always the queue on a board with no period types', () => {
    const workspace = workspaceOn('team', { ...config, hasPeriods: false });
    expect(workspace.planning).toBe('queue');
    expect(workspace.canPlanWithPeriods).toBe(false);
  });

  it('writes the switch through the API and re-reads the board', async () => {
    const write = serverSwitchesTo('queue');
    const workspace = workspaceOn('team');

    expect(await workspace.setPlanning('queue')).toBe(true);
    expect(write).toHaveBeenCalledWith('queue');
    expect(workspace.planning).toBe('queue');
    workspace.dispose();
  });

  it('opens the queue panel, because choosing it is asking to see it', async () => {
    serverSwitchesTo('queue');
    const workspace = workspaceOn('team');
    await workspace.setPlanning('queue');
    expect(workspace.doc.queue.open).toBe(true);
    expect(workspace.doc.drawer.tab).toBe('team');
    workspace.dispose();
  });

  it('moves the drawer off a calendar tab the queue does not offer', async () => {
    serverSwitchesTo('queue');
    const workspace = workspaceOn('gantt');
    await workspace.setPlanning('queue');
    expect(workspace.doc.drawer.tab).toBe('table');
    workspace.dispose();
  });

  it('asks nothing when the board is already in that mode', async () => {
    const write = serverSwitchesTo('periods');
    expect(await workspaceOn('team').setPlanning('periods')).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });

  it('leaves the view alone and says why when the server refuses', async () => {
    vi.spyOn(api, 'setPlanning').mockRejectedValue(new Error('This board has no period types'));
    const workspace = workspaceOn('gantt');

    expect(await workspace.setPlanning('queue')).toBe(false);
    expect(workspace.doc.drawer.tab).toBe('gantt');
    expect(workspace.planning).toBe('periods');
    expect(workspace.notices.at(-1)?.message).toBe('This board has no period types');
    workspace.dispose();
  });
});

/**
 * Three ready stories whose local order (priority) disagrees with the
 * engine's, plus a chain: IP in progress, W waiting on it.
 */
const sample = () =>
  board(
    issue('F', 'feature', null),
    issue('IP', 'user_story', 'F', { status: 'in_progress' }),
    issue('W', 'user_story', 'F', { dependsOn: ['IP'] }),
    issue('A', 'user_story', 'F', { attributes: { priority: 'high' } }),
    issue('B', 'user_story', 'F', { attributes: { priority: 'medium' } }),
    issue('C', 'user_story', 'F', { attributes: { priority: 'low' } }),
  );

const ids = (cards: { issue: { id: string } }[]): string[] => cards.map((card) => card.issue.id);

describe('the queue in the engine’s order', () => {
  // As `simulateQueue` might answer: IP first (already started), then C, then
  // W once IP is done, then B and A.
  const engine = new Map([
    ['IP', 1],
    ['C', 2],
    ['W', 3],
    ['B', 4],
    ['A', 5],
  ]);

  it('orders every lane by the engine’s step, not by its own ranking', () => {
    const local = buildQueue(sample(), config);
    expect(ids(local.ready)).toEqual(['A', 'B', 'C']);

    const queue = buildQueue(sample(), config, { sequence: engine });
    expect(ids(queue.ready)).toEqual(['C', 'B', 'A']);
    expect(queue.ready.map((card) => card.step)).toEqual([2, 4, 5]);
    expect(queue.blocked.map((card) => card.step)).toEqual([3]);
  });

  it('puts what the engine has not seen after what it has, in the local order', () => {
    const nodes = { ...sample(), N: issue('N', 'user_story', 'F', { attributes: { priority: 'high' } }) };
    const queue = buildQueue(nodes, config, { sequence: engine });
    expect(ids(queue.ready)).toEqual(['C', 'B', 'A', 'N']);
    expect(queue.ready.at(-1)!.step).toBeNull();
  });

  it('numbers each card with its step, one numbering through every section', () => {
    const queue = buildQueue(sample(), config, { sequence: engine });
    const sections = queueSections(queue);
    const marks = (id: string) =>
      sections.find((section) => section.id === id)!.cards.map((card, position) =>
        markerOf(card, sections.find((section) => section.id === id)!, position, true),
      );
    expect(marks('now')).toEqual(['1']);
    expect(marks('next')).toEqual(['2', '4', '5']);
    expect(marks('waiting')).toEqual(['3']);
  });

  it('marks a card nobody has pushed yet, and a waiting card the engine never reaches', () => {
    const nodes = { ...sample(), N: issue('N', 'user_story', 'F') };
    const queue = buildQueue(nodes, config, { sequence: new Map([['IP', 1]]) });
    const [, next, waiting] = queueSections(queue);
    const fresh = next!.cards.find((card) => card.issue.id === 'N')!;
    expect(markerOf(fresh, next!, 0, true)).toBe('–');
    expect(markerTitle(fresh, next!, true)).toMatch(/pushed/);
    expect(markerOf(waiting!.cards[0]!, waiting!, 0, true)).toBe('');
    expect(markerTitle(waiting!.cards[0]!, waiting!, true)).toMatch(/Never reached/);
  });

  it('numbers the line by position, as before, when the engine has not answered', () => {
    const queue = buildQueue(sample(), config);
    const [now, next] = queueSections(queue);
    expect(next!.cards.map((card, position) => markerOf(card, next!, position, false))).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(markerOf(now!.cards[0]!, now!, 0, false)).toBe('');
  });
});

describe('queue mode reads no period', () => {
  const squad: SquadDto = {
    kind: 'squad',
    id: 'SQ',
    type: 'squad',
    title: 'Platform',
    body: '',
    parentId: null,
    depth: 0,
    attributes: {},
    members: ['BOB'],
  };
  const nodes = () =>
    board(
      resource('ALICE', 'person', { title: 'Alice' }),
      resource('BOB', 'person', { title: 'Bob' }),
      squad,
      { ...period('OFF', '2026-01-01', '2026-01-14'), active: false },
      { ...period('OWNED', '2026-01-15', '2026-01-28'), squad: 'SQ' },
      issue('F', 'feature', null),
      issue('P', 'user_story', 'F', { assignee: 'ALICE', period: 'OFF' }),
      issue('O', 'user_story', 'F', { assignee: 'ALICE', period: 'OWNED' }),
    );

  it('offers work a switched-off period was holding back', () => {
    expect(ids(buildQueue(nodes(), config).ready)).not.toContain('P');
    expect(ids(buildQueue(nodes(), queueConfig).ready)).toContain('P');
  });

  it('lets anybody take work in a sprint a squad owns', () => {
    expect(ids(buildQueue(nodes(), config, { resourceId: 'ALICE' }).ready)).toEqual([]);
    expect(ids(buildQueue(nodes(), queueConfig, { resourceId: 'ALICE' }).ready).sort()).toEqual([
      'O',
      'P',
    ]);
  });

  it('keeps every period on the documents', () => {
    const queue = buildQueue(nodes(), queueConfig);
    expect(queue.ready.find((card) => card.issue.id === 'P')!.issue.period).toBe('OFF');
  });
});

describe('asking the engine for the sequence', () => {
  const answer = (steps: string[]): QueueSequenceDto => ({
    resource: null,
    planning: 'periods',
    steps: steps.map((id, index) => ({ id, order: index + 1, started: false })),
    skipped: [],
  });

  it('asks again when what the order depends on changes, and not for a reworded body', () => {
    const before = snapshotOf(sample());
    const retitled = snapshotOf({ ...sample(), A: { ...sample().A!, title: 'New', body: 'More' } });
    const started = snapshotOf({ ...sample(), A: { ...sample().A!, status: 'in_progress' } } as WorkingNodes);
    const switched = snapshotOf(sample(), queueConfig);

    expect(sequenceKey(retitled)).toBe(sequenceKey(before));
    expect(sequenceKey(started)).not.toBe(sequenceKey(before));
    expect(sequenceKey(switched)).not.toBe(sequenceKey(before));
  });

  it('fetches once per board and reader, and keeps the steps', async () => {
    const fetch = vi.fn(async () => answer(['C', 'B']));
    const sequence = new QueueSequence(fetch);
    const snapshot = snapshotOf(sample());

    await sequence.refresh(snapshot, null);
    await sequence.refresh({ ...snapshot, readAt: 'later' }, null);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect([...sequence.steps!]).toEqual([
      ['C', 1],
      ['B', 2],
    ]);

    await sequence.refresh(snapshot, 'ALICE');
    expect(fetch).toHaveBeenLastCalledWith('ALICE');
  });

  it('lets only the newest answer land', async () => {
    let release: (dto: QueueSequenceDto) => void = () => {};
    const slow = new Promise<QueueSequenceDto>((resolve) => (release = resolve));
    const fetch = vi
      .fn<(resourceId: string | null) => Promise<QueueSequenceDto>>()
      .mockReturnValueOnce(slow)
      .mockResolvedValueOnce(answer(['B']));
    const sequence = new QueueSequence(fetch);

    const first = sequence.refresh(snapshotOf(sample()), null);
    await sequence.refresh(snapshotOf(sample()), 'BOB');
    release(answer(['A']));
    await first;
    expect([...sequence.steps!.keys()]).toEqual(['B']);
  });

  it('falls back to the local order and tries again after a failure', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('down')).mockResolvedValue(answer(['A']));
    const sequence = new QueueSequence(fetch);
    const snapshot = snapshotOf(sample());

    await sequence.refresh(snapshot, null);
    expect(sequence.steps).toBeNull();
    expect(sequence.error).toBe('down');

    await sequence.refresh(snapshot, null);
    expect(sequence.steps?.get('A')).toBe(1);
    expect(sequence.error).toBeNull();
  });
});

describe('the rest of the app in queue mode', () => {
  const scheduled = () =>
    board(
      period('SP', '2026-01-01', '2026-01-14'),
      issue('F', 'feature', null),
      issue('S1', 'user_story', 'F', { period: 'SP' }),
      issue('S2', 'user_story', 'F'),
      issue('S3', 'user_story', 'F', { status: 'in_progress' }),
    );

  it('draws no period badge on a node', () => {
    const scheduleOf = (withConfig: ConfigDto) =>
      buildGraph({
        nodes: scheduled(),
        config: withConfig,
        members: ['S1'],
        isCollapsed: () => false,
        today: '2026-01-05',
      }).nodes.find((node) => node.id === 'S1')!.data.schedule;

    expect(scheduleOf(config)).toEqual({ chain: ['SP'], current: true });
    expect(scheduleOf(queueConfig)).toBeNull();
  });

  it('reads the whole board as the one run on the landing page', () => {
    const focus = currentFocus(scheduled(), queueConfig, { today: '2026-03-01' });
    expect(focus.continuous).toBe(true);
    expect(focus.sprint).toBeNull();
    expect(focus.open).toBe(3);
    expect(focus.active.map((entry) => entry.issue.id)).toEqual(['S3']);

    // The same board planning with periods, after its only sprint ended, has
    // nothing running to show.
    expect(currentFocus(scheduled(), config, { today: '2026-03-01' }).continuous).toBe(false);
  });

  it('offers no "Schedule into" on a node', () => {
    const workspace = new Workspace();
    workspace.snapshot = snapshotOf(scheduled(), queueConfig);
    workspace.view = emptyView('test', 'Test');
    workspace.nodes = scheduled();
    const labels = bulkEntries({ workspace, shell: new Shell() }, ['S2']).map(
      (entry) => ('label' in entry ? entry.label : ''),
    );
    expect(labels).not.toContain('Schedule into');
    workspace.dispose();
  });
});
