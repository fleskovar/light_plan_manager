import { describe, expect, it } from 'vitest';
import type { BoardSnapshot, IssueDto, PeriodDto, ResourceDto } from '$shared';
import { emptyView } from '$shared';
import { Shell } from '$lib/app/shell.svelte.js';
import type { MenuEntry, MenuItem } from '$lib/ui/menu/types.js';
import { isHeading, isSeparator } from '$lib/ui/menu/types.js';
import { Workspace } from '$lib/workspace/workspace.svelte.js';
import { buildIndex } from '$lib/board/index.js';
import { bulkEntries, nodeMenu, paneMenu, remoteEntries, removalEntries } from '$features/canvas/menus.js';
import { RemoteState, type RemoteApi, type RemoteHost } from '$features/drawer/remote/remote.svelte.js';
import { board, config, issue, period, resource, sampleBoard } from './fixtures.js';

/**
 * The bulk menus.
 *
 * Assigning fifteen stories to somebody used to be fifteen trips through the
 * side panel, so the whole point of these builders is that one gesture reaches
 * a whole selection. They are plain descriptions of a menu, which is what lets
 * the rules be checked without rendering one.
 */
function makeWorkspace(extra: (IssueDto | PeriodDto | ResourceDto)[] = []): Workspace {
  const nodes = { ...sampleBoard(), ...board(...extra) };
  const workspace = new Workspace();
  workspace.snapshot = {
    config,
    issues: Object.values(nodes).filter((node): node is IssueDto => node.kind === 'issue'),
    periods: Object.values(nodes).filter((node): node is PeriodDto => node.kind === 'period'),
    resources: Object.values(nodes).filter((node): node is ResourceDto => node.kind === 'resource'),
    squads: [],
    templates: [],
    problems: [],
    readAt: new Date().toISOString(),
  } satisfies BoardSnapshot;
  workspace.view = { ...emptyView('test', 'Test'), members: Object.keys(nodes) };
  workspace.nodes = nodes;
  workspace.index = buildIndex(nodes);
  return workspace;
}

const roster = [
  resource('R1', 'person', { title: 'Ana' }),
  resource('R2', 'person', { title: 'Bo' }),
  resource('R3', 'role', { title: 'Backend pool' }),
];

const timeline = [period('PI-1', '2026-01-01', '2026-03-31', null, 'increment'), period('SP-1', '2026-01-01', '2026-01-14', 'PI-1')];

function context(workspace: Workspace) {
  return { workspace, shell: new Shell() };
}

function item(entries: MenuEntry[], label: string): MenuItem {
  const found = entries.find(
    (entry): entry is MenuItem => !isSeparator(entry) && !isHeading(entry) && entry.label === label,
  );
  if (!found) throw new Error(`No menu entry called "${label}" in ${describeEntries(entries)}`);
  return found;
}

function describeEntries(entries: MenuEntry[]): string {
  return entries
    .map((entry) => (isSeparator(entry) ? '—' : isHeading(entry) ? `[${entry.heading}]` : entry.label))
    .join(', ');
}

const labels = (entries: MenuEntry[] = []): string[] =>
  entries.map((entry) => (isSeparator(entry) ? '—' : isHeading(entry) ? `[${entry.heading}]` : entry.label));

describe('assign to', () => {
  it('lists the people, then the pools, then the way back to nobody', () => {
    const workspace = makeWorkspace(roster);
    const entries = item(bulkEntries(context(workspace), ['S1']), 'Assign to').items ?? [];

    expect(labels(entries)).toEqual(['Ana', 'Bo', '—', 'Backend pool', '—', 'Nobody']);
  });

  it('says which of them is a pool, because a pool is a queue and not a person', () => {
    const workspace = makeWorkspace(roster);
    const entries = item(bulkEntries(context(workspace), ['S1']), 'Assign to').items ?? [];

    expect(item(entries, 'Ana').hint).toBeUndefined();
    expect(item(entries, 'Backend pool').hint).toBe('Role');
  });

  it('assigns every selected issue in one click', () => {
    const workspace = makeWorkspace(roster);
    const entries = item(bulkEntries(context(workspace), ['S1', 'S2', 'S3']), 'Assign to').items ?? [];
    item(entries, 'Ana').onSelect?.();

    expect(['S1', 'S2', 'S3'].map((id) => (workspace.node(id) as IssueDto).assignee)).toEqual([
      'R1',
      'R1',
      'R1',
    ]);
    // One queued change per issue, and a notice saying how many, because the
    // menu closes over the top of the nodes it just edited.
    expect(workspace.pending).toHaveLength(3);
    expect(workspace.notices.at(-1)?.message).toBe('Assigned 3 issues to Ana');
  });

  it('ticks the one they are all already on, and does not queue a no-op', () => {
    const workspace = makeWorkspace(roster);
    const entries = () => item(bulkEntries(context(workspace), ['S1', 'S2']), 'Assign to').items ?? [];

    expect(item(entries(), 'Nobody').hint).toBe('✓');
    item(entries(), 'Nobody').onSelect?.();

    expect(workspace.pending).toHaveLength(0);
    expect(workspace.notices.at(-1)?.message).toBe('Already unassigned');

    item(entries(), 'Bo').onSelect?.();
    expect(item(entries(), 'Bo').hint).toBe('✓');
  });

  it('leaves anything that is not an issue alone', () => {
    const workspace = makeWorkspace(roster);
    const entries = item(bulkEntries(context(workspace), ['S1', 'R2']), 'Assign to').items ?? [];
    item(entries, 'Ana').onSelect?.();

    expect(workspace.pending.map((change) => change.id)).toEqual(['S1']);
  });

  it('is offered but refused on a board with nobody on it', () => {
    const workspace = makeWorkspace();
    expect(item(bulkEntries(context(workspace), ['S1']), 'Assign to').disabled).toBe(true);
  });
});

describe('change status', () => {
  it('moves the whole selection and ticks a column they share', () => {
    const workspace = makeWorkspace();
    const entries = () => item(bulkEntries(context(workspace), ['S3', 'S4']), 'Change status').items ?? [];

    expect(item(entries(), 'Backlog').hint).toBe('✓');
    item(entries(), 'In Review').onSelect?.();

    expect((workspace.node('S3') as IssueDto).status).toBe('in_review');
    expect((workspace.node('S4') as IssueDto).status).toBe('in_review');
  });
});

describe('schedule into', () => {
  it('nests the sprints under their increment, and offers the backlog', () => {
    const workspace = makeWorkspace(timeline);
    const entries = item(bulkEntries(context(workspace), ['S1']), 'Schedule into').items ?? [];

    expect(labels(entries)).toEqual(['PI-1', ' SP-1', '—', 'Backlog']);
  });

  it('schedules the work under a container rather than the container itself', () => {
    const workspace = makeWorkspace(timeline);
    const entries = item(bulkEntries(context(workspace), ['F1']), 'Schedule into').items ?? [];
    item(entries, ' SP-1').onSelect?.();

    expect((workspace.node('S1') as IssueDto).period).toBe('SP-1');
    expect((workspace.node('S2') as IssueDto).period).toBe('SP-1');
    expect((workspace.node('F1') as IssueDto).period).toBeNull();
    expect(workspace.notices.at(-1)?.message).toBe('Scheduled 2 issues into SP-1');
  });

  it('is not offered at all when the board keeps no calendar', () => {
    const workspace = makeWorkspace();
    workspace.snapshot = { ...workspace.snapshot!, config: { ...config, hasPeriods: false } };

    expect(labels(bulkEntries(context(workspace), ['S1']))).toEqual(['Change status', 'Assign to']);
  });
});

describe('the menus these appear in', () => {
  it('heads a node menu with the count when the right-click covers several', () => {
    const workspace = makeWorkspace(roster);
    workspace.selection.set(['S1', 'S2']);

    const entries = nodeMenu(context(workspace), 'S1');
    expect(entries[0]).toEqual({ heading: '2 items selected' });
    expect(labels(entries)).toContain('Assign to');
  });

  it('says nothing about a selection of one', () => {
    const workspace = makeWorkspace(roster);
    workspace.selection.set(['S1']);
    expect(nodeMenu(context(workspace), 'S1').some(isHeading)).toBe(false);
  });

  it('puts the whole selection in the pane menu, which is where it is reachable', () => {
    const workspace = makeWorkspace(roster);
    workspace.selection.set(['S1', 'S2', 'S3']);

    const entries = paneMenu(context(workspace));
    expect(entries[0]).toEqual({ heading: '3 items selected' });
    expect(labels(entries)).toEqual([
      '[3 items selected]',
      'Change status',
      'Assign to',
      'Schedule into',
      '—',
      'Remove 3 items from view',
      'Delete 3 items',
      '—',
      'New',
      'Paste',
      '—',
      'Arrange',
    ]);
  });

  it('offers nothing selection-shaped when nothing is selected', () => {
    const workspace = makeWorkspace(roster);
    expect(labels(paneMenu(context(workspace)))).toEqual([
      'New',
      'Paste',
      '—',
      'Arrange',
    ]);
  });
});

describe('removing a selection', () => {
  it('takes several off the canvas without touching the board', () => {
    const workspace = makeWorkspace();
    item(removalEntries(context(workspace), ['S1', 'S2']), 'Remove 2 items from view').onSelect?.();

    expect(workspace.members).not.toContain('S1');
    expect(workspace.node('S1')).toBeDefined();
    expect(workspace.pending).toHaveLength(0);
  });

  it('asks before deleting, and counts what it is about to delete', () => {
    const workspace = makeWorkspace();
    const ctx = context(workspace);
    item(removalEntries(ctx, ['S1', 'S2']), 'Delete 2 items').onSelect?.();

    expect(ctx.shell.confirmation?.message).toContain('2 documents');
    ctx.shell.resolveConfirmation(true);
    expect(workspace.pending.map((change) => change.kind)).toEqual(['delete', 'delete']);
  });
});

/** A board with no children under an issue, so the schedule menu has a leaf. */
it('schedules a lone story as itself', () => {
  const workspace = makeWorkspace([...timeline, issue('S9', 'user_story', 'F2')]);
  const entries = item(bulkEntries(context(workspace), ['S9']), 'Schedule into').items ?? [];
  item(entries, 'PI-1').onSelect?.();

  expect((workspace.node('S9') as IssueDto).period).toBe('PI-1');
});

describe('the remote entries', () => {
  /**
   * A menu entry hands its work to the state machine and returns nothing, so a
   * test cannot await it. One turn of the microtask queue is enough for the
   * push to reach the fake — and a push now takes one hop more than it did,
   * because it asks the readiness check before it writes anything.
   */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };

  /** A remote state machine with one remote whose report is already read. */
  async function remoteState(
    over: {
      ahead?: string[];
      links?: Record<string, { remoteId: string; remoteKey: string; remoteUrl: string }>;
      /** Documents the mirror is missing around `anchors`. */
      gaps?: Array<{ id: string; anchor: string }>;
    } = {},
    bodies: Array<Record<string, unknown>> = [],
  ): Promise<RemoteState> {
    const api: RemoteApi = {
      listRemotes: async () => [
        { name: 'upstream', provider: 'github', direction: 'both', target: 'acme/payments', lastSync: null },
      ],
      remoteStatus: async () => ({
        remote: { name: 'upstream', provider: 'github', target: 'acme/payments', lastSync: null },
        inSync: [],
        ahead: over.ahead ?? [],
        behind: [],
        conflicted: [],
        unlinked: [],
        orphaned: [],
        decoupled: [],
        unreadable: [],
        failed: [],
        links: over.links ?? {},
      }) as never,
      remoteReadiness: async () => ({
        remote: { name: 'upstream', provider: 'github', target: 'acme/payments' },
        findings: [],
        documents: 0,
        blocked: false,
        askedUsers: true,
        askedPeriods: true,
      }),
      remoteReadinessFix: async () => ({ changed: [] }),
      remoteCoverage: async () => ({
        remote: { name: 'upstream', provider: 'github', target: 'acme/payments' },
        mirrored: 0,
        total: 0,
        gaps: (over.gaps ?? []).map((gap) => ({
          id: gap.id,
          kind: 'issue' as const,
          type: 'user_story',
          title: gap.id,
          reasons: [{ relation: 'child' as const, anchors: [gap.anchor], count: 1 }],
        })),
        groups: over.gaps?.length
          ? [{ relation: 'child' as const, ids: over.gaps.map((gap) => gap.id) }]
          : [],
        decoupled: [],
        outOfScope: [],
        filesPeriods: false,
      }),
      remotePreview: async () => ({ remoteName: 'upstream', direction: 'push', preflight: [], preflightBlocked: false, renders: [] }),
      remoteSync: async (_name, body) => {
        bodies.push(body as Record<string, unknown>);
      },
      remoteConflict: async () => {
        throw new Error('no conflict');
      },
      resolve: async () => ({ remoteName: 'upstream', localId: 'x', fields: {} }),
    };
    const host: RemoteHost = {
      setSyncBadges: () => {},
      select: () => {},
      titleOf: (id: string) => id,
      notify: () => {},
      report: () => {},
      dirty: () => false,
      refresh: async () => {},
      push: async () => {},
    };
    const state = new RemoteState(api, host);
    state.enabled = true;
    await state.load();
    return state;
  }

  it('offers nothing at all when no remote is being watched', async () => {
    // Absent rather than present-and-disabled: with no remote there is nowhere
    // to push to, and a permanently greyed-out pair of entries is just noise.
    const workspace = makeWorkspace();
    expect(remoteEntries(context(workspace), ['S1'])).toEqual([]);
  });

  it('offers nothing without lpm ui --experimental, even over a loaded mirror', async () => {
    // Tracker remotes are experimental: a published build names no tracker in
    // any menu, whatever state the remote panel happens to hold.
    const workspace = makeWorkspace();
    const remote = await remoteState();
    remote.enabled = false;
    expect(remoteEntries({ ...context(workspace), remote }, ['S1'])).toEqual([]);
    const labels = (entries: MenuEntry[]): unknown[] =>
      entries.map((entry) => ('label' in entry ? entry.label : '—'));
    expect(labels(nodeMenu({ ...context(workspace), remote }, 'S1'))).toEqual(
      labels(nodeMenu(context(workspace), 'S1')),
    );
  });

  it('pushes exactly the selection, never the subtrees under it', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const workspace = makeWorkspace();
    const remote = await remoteState({}, bodies);

    const entries = remoteEntries({ ...context(workspace), remote }, ['S1', 'S2']);
    expect(entries.map((entry) => (entry as MenuItem).label)).toEqual(['Push 2 items', 'Pull 0 items']);

    await (entries[0] as MenuItem).onSelect!();
    await settle();
    expect(bodies[0]).toMatchObject({ direction: 'push', only: ['S1', 'S2'] });
  });

  it('offers to push what the mirror is missing around the selection', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const workspace = makeWorkspace();
    // Two selected stories in one feature are missing the same document, and
    // it is offered once.
    const remote = await remoteState(
      { gaps: [{ id: 'S7', anchor: 'S1' }, { id: 'S7', anchor: 'S2' }, { id: 'S8', anchor: 'S2' }] },
      bodies,
    );

    const entries = remoteEntries({ ...context(workspace), remote }, ['S1', 'S2']);
    const gapEntry = entries.find((entry) =>
      (entry as MenuItem).label?.includes('missing'),
    ) as MenuItem;
    expect(gapEntry.label).toBe('Push 2 missing documents');

    await gapEntry.onSelect!();
    await settle();
    expect(bodies[0]).toMatchObject({ direction: 'push', only: ['S7', 'S8'] });
  });

  it('says nothing about gaps when the mirror has none', async () => {
    const workspace = makeWorkspace();
    const remote = await remoteState();

    const entries = remoteEntries({ ...context(workspace), remote }, ['S1']);
    expect(entries.map((entry) => (entry as MenuItem).label)).toEqual(['Push', 'Pull']);
  });

  it('will not offer to pull what has no twin', async () => {
    const workspace = makeWorkspace();
    const remote = await remoteState();

    const entries = remoteEntries({ ...context(workspace), remote }, ['S1']);
    expect((entries[1] as MenuItem).disabled).toBe(true);
  });

  it('counts only the twins it could actually pull', async () => {
    const workspace = makeWorkspace();
    const remote = await remoteState({ links: { S1: { remoteId: '42', remoteKey: 'PAY-42', remoteUrl: '' } } });

    const entries = remoteEntries({ ...context(workspace), remote }, ['S1', 'S2']);
    expect((entries[1] as MenuItem).label).toBe('Pull 1 item');
    expect((entries[1] as MenuItem).disabled).toBe(false);
  });

  it('appears in the node menu once a remote is watched', async () => {
    const workspace = makeWorkspace();
    const remote = await remoteState();
    const withRemote = nodeMenu({ ...context(workspace), remote }, 'S1');
    const without = nodeMenu(context(workspace), 'S1');

    const labels = (entries: MenuEntry[]): string[] =>
      entries.filter((entry): entry is MenuItem => !isSeparator(entry) && !isHeading(entry)).map((entry) => entry.label);

    expect(labels(withRemote)).toContain('Push');
    expect(labels(without)).not.toContain('Push');
  });
});
