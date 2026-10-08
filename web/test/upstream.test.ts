import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardSnapshot, IssueDto, PeriodDto, ResourceDto } from '$shared';
import { emptyView } from '$shared';
import { Shell } from '$lib/app/shell.svelte.js';
import { buildIndex } from '$lib/board/index.js';
import type { MenuEntry, MenuItem } from '$lib/ui/menu/types.js';
import { isHeading, isSeparator } from '$lib/ui/menu/types.js';
import { addUpstream, scheduleUpstream } from '$lib/workspace/mutations.js';
import { Workspace } from '$lib/workspace/workspace.svelte.js';
import { nodeMenu } from '$features/canvas/menus.js';
import { board, config, issue, period, resource } from './fixtures.js';

/**
 * Drawing and scheduling the work behind an issue.
 *
 * What counts as upstream is decided once, in `$shared/blocking.ts`, and tested
 * against a real board in `test/upstream.test.ts`. What is checked here is the
 * part that is genuinely this app's: which nodes end up on the canvas, what
 * lands in the pending queue, and when the menu offers any of it at all.
 */

/**
 * A feature (F1) holding a chain of three stories — S1 -> S2 -> S3 — plus a
 * second feature (F2) whose story S4 waits on the whole of F1.
 */
function makeWorkspace(): Workspace {
  const nodes = board(
    issue('P1', 'program', null),
    issue('E1', 'epic', 'P1'),
    issue('F1', 'feature', 'E1'),
    issue('S1', 'user_story', 'F1'),
    issue('S2', 'user_story', 'F1', { dependsOn: ['S1'] }),
    issue('S3', 'user_story', 'F1', { dependsOn: ['S2'] }),
    issue('F2', 'feature', 'E1', { dependsOn: ['F1'] }),
    issue('S4', 'user_story', 'F2', { period: 'SP-1', assignee: 'R1' }),
    period('PI-1', '2026-01-01', '2026-03-31', null, 'increment'),
    period('SP-1', '2026-01-01', '2026-01-14', 'PI-1'),
    resource('R1', 'person', { title: 'Ana' }),
    resource('R2', 'person', { title: 'Bo' }),
  );

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
  // Nothing is on the canvas to begin with: adding upstream work is the point.
  workspace.view = { ...emptyView('test', 'Test'), members: ['S4'] };
  workspace.nodes = nodes;
  workspace.index = buildIndex(nodes);
  return workspace;
}

function item(entries: MenuEntry[], label: string): MenuItem | undefined {
  return entries.find(
    (entry): entry is MenuItem => !isSeparator(entry) && !isHeading(entry) && entry.label === label,
  );
}

let workspace: Workspace;
beforeEach(() => {
  workspace = makeWorkspace();
});

describe('addUpstream', () => {
  it('puts the whole chain on the canvas, with the containers around it', () => {
    addUpstream(workspace, 'S4');

    // The edge names F1; its three open stories are what F1 amounts to.
    for (const id of ['F1', 'S1', 'S2', 'S3']) expect(workspace.isMember(id)).toBe(true);
    // Ancestors come along so nothing floats free of its subflow.
    for (const id of ['P1', 'E1']) expect(workspace.isMember(id)).toBe(true);
    // And the issue that was waiting stays, or the chain leads nowhere.
    expect(workspace.isMember('S4')).toBe(true);
  });

  it('changes nothing on the board — it is a way of looking, not an edit', () => {
    addUpstream(workspace, 'S4');
    expect(workspace.pending).toEqual([]);
  });

  it('reports when there is nothing upstream', () => {
    addUpstream(workspace, 'S1');
    expect(workspace.notices.at(-1)?.message).toContain('No open upstream work for S1');
  });

  it('leaves a document that is not an issue alone', () => {
    expect(addUpstream(workspace, 'SP-1')).toEqual([]);
  });
});

describe('scheduleUpstream', () => {
  it('queues the sprint and the owner onto the unclaimed work units', () => {
    scheduleUpstream(workspace, 'S4');

    const patched = new Map(
      workspace.pending.map((change) => [change.id, 'patch' in change ? change.patch : {}]),
    );
    for (const id of ['S1', 'S2', 'S3']) {
      expect(patched.get(id)).toEqual({ period: 'SP-1', assignee: 'R1' });
    }
    // The feature is a container: a period on it would offer nobody anything.
    expect(patched.has('F1')).toBe(false);
    // And the issue doing the waiting is not rescheduled onto itself.
    expect(patched.has('S4')).toBe(false);
  });

  it('leaves work somebody already holds alone, and says how much', () => {
    workspace.nodes.S2 = { ...(workspace.nodes.S2 as IssueDto), assignee: 'R2' };
    workspace.index = buildIndex(workspace.nodes);

    scheduleUpstream(workspace, 'S4');
    expect(workspace.pending.some((change) => change.id === 'S2')).toBe(false);
    expect(workspace.notices.at(-1)?.details?.[0]).toContain('Skipped 1 issue that already has an owner');
  });

  it('reports the refusal when there is nothing to copy', () => {
    scheduleUpstream(workspace, 'S3');
    expect(workspace.notices.at(-1)?.level).toBe('error');
    expect(workspace.pending).toEqual([]);
  });
});

describe('the node menu', () => {
  const menu = (id: string): MenuEntry[] => nodeMenu({ workspace, shell: new Shell() }, id);

  it('offers both entries on an issue', () => {
    const entries = menu('S4');
    expect(item(entries, 'Add upstream dependencies')).toBeDefined();
    expect(item(entries, 'Schedule upstream dependencies')?.disabled).toBeFalsy();
  });

  it('greys out scheduling when the issue has no sprint and no owner', () => {
    const entry = item(menu('S3'), 'Schedule upstream dependencies');
    expect(entry?.disabled).toBe(true);
    expect(entry?.hint).toContain('Needs a sprint or an assignee');
  });

  it('offers neither in a registry view: a template is a shape, not a schedule', () => {
    workspace.view = { ...emptyView('test', 'Test'), members: ['S4'], mode: 'templates' };
    expect(item(menu('S4'), 'Add upstream dependencies')).toBeUndefined();
    expect(item(menu('S4'), 'Schedule upstream dependencies')).toBeUndefined();
  });
});
