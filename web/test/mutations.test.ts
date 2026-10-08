import { beforeEach, describe, expect, it } from 'vitest';
import type { BoardSnapshot, IssueDto, NodeDto, PeriodDto } from '$shared';
import { emptyView, planStartNow } from '$shared';
import {
  addDependency,
  applyPlan,
  boardViewOf,
  breakDown,
  carryOverPeriod,
  completePeriod,
  createNode,
  duplicate,
  insertOnEdge,
  previewReparent,
  removeNodes,
  reparent,
  reparentChoices,
  reparentWithBridge,
  schedule,
  scheduleLeaves,
  setPeriodActive,
  spliceOntoEdge,
} from '$lib/workspace/mutations.js';
import { Workspace } from '$lib/workspace/workspace.svelte.js';
import { buildIndex } from '$lib/board/index.js';
// `issue` is the local reader below, so the fixture builders are aliased.
import {
  board,
  config,
  issue as anIssue,
  period as aPeriod,
  sampleBoard,
} from './fixtures.js';

/**
 * The mutations are written against a `Workspace`, so the tests build a real
 * one and hand it a board instead of a server. Nothing here touches the
 * network: `open` is the only method that would, and it is not used.
 */
function makeWorkspace(): Workspace {
  const workspace = new Workspace();
  const nodes = sampleBoard();
  workspace.snapshot = {
    config,
    issues: Object.values(nodes).filter((node): node is IssueDto => node.kind === 'issue'),
    periods: [],
    resources: [],
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

const issue = (workspace: Workspace, id: string): IssueDto => workspace.node(id) as IssueDto;
const children = (workspace: Workspace, id: string): NodeDto[] =>
  Object.values(workspace.nodes).filter((node) => node.parentId === id);

let workspace: Workspace;
beforeEach(() => {
  workspace = makeWorkspace();
});

describe('createNode', () => {
  it('queues a create and puts the issue on the canvas', () => {
    const id = createNode(workspace, { type: 'user_story', parentId: 'F1', title: 'New one' });
    expect(workspace.node(id)).toMatchObject({ title: 'New one', parentId: 'F1', depth: 3 });
    expect(workspace.pending).toEqual([
      expect.objectContaining({ kind: 'create', id, nodeKind: 'issue' }),
    ]);
    expect(workspace.isMember(id)).toBe(true);
  });

  it('hands out a fresh temporary id each time', () => {
    const first = createNode(workspace, { type: 'user_story', parentId: 'F1' });
    const second = createNode(workspace, { type: 'user_story', parentId: 'F1' });
    expect(first).not.toBe(second);
  });
});

describe('removeNodes', () => {
  it('queues one delete for a subtree rather than one per node', () => {
    removeNodes(workspace, ['F1', 'S1']);
    expect(workspace.pending).toEqual([
      expect.objectContaining({ kind: 'delete', id: 'F1' }),
    ]);
    expect(workspace.node('S1')).toBeUndefined();
    expect(workspace.isMember('S2')).toBe(false);
  });
});

describe('previewReparent', () => {
  it('reports the demotion a drop would cause', () => {
    const spare = createNode(workspace, { type: 'feature', parentId: 'E', title: 'Spare' });
    expect(previewReparent(workspace, spare, 'F1')).toEqual({ type: 'user_story', allowed: true });
  });

  it('refuses a drop that would leave a descendant nowhere to sit', () => {
    // F2 under F1 makes F2 a story, which would push its own stories to level
    // 4, where only sub_tasks are allowed.
    const preview = previewReparent(workspace, 'F2', 'F1');
    expect(preview.allowed).toBe(false);
    expect(preview.reason).toMatch(/nowhere to sit/);
  });

  it('refuses to move a document under itself', () => {
    expect(previewReparent(workspace, 'F1', 'S1').allowed).toBe(false);
  });

  it('applies the type change along with the move', () => {
    const spare = createNode(workspace, { type: 'feature', parentId: 'E', title: 'Spare' });
    expect(reparent(workspace, spare, 'F1')).toBe(true);
    expect(workspace.node(spare)).toMatchObject({
      type: 'user_story',
      parentId: 'F1',
      depth: 3,
    });
  });

  it('reports why a refused drop was refused', () => {
    expect(reparent(workspace, 'F2', 'F1')).toBe(false);
    expect(workspace.notices.at(-1)?.message).toMatch(/nowhere to sit/);
  });
});

describe('reparentChoices / reparentWithBridge', () => {
  it('offers both readings of a drop the hierarchy will not take', () => {
    // A story onto a program: it becomes an epic, or it gets an epic and a
    // feature built for it.
    const choices = reparentChoices(workspace, 'S1', 'P');
    expect(choices.convert).toEqual({ type: 'epic', allowed: true });
    expect(choices.bridge).toEqual(['epic', 'feature']);
  });

  it('offers no containers when the move is up the hierarchy', () => {
    // A feature onto an epic already fits; nothing has to be built.
    expect(reparentChoices(workspace, 'F1', 'E').bridge).toEqual([]);
  });

  it('builds the levels in between and leaves the type alone', () => {
    const created = reparentWithBridge(workspace, 'S1', 'P');
    expect(created).toHaveLength(2);

    const [epic, feature] = created;
    expect(workspace.node(epic!)).toMatchObject({ type: 'epic', parentId: 'P', depth: 1 });
    expect(workspace.node(feature!)).toMatchObject({ type: 'feature', parentId: epic, depth: 2 });
    expect(workspace.node('S1')).toMatchObject({
      type: 'user_story',
      parentId: feature,
      depth: 3,
    });
    // The containers are on the canvas too, or the story would appear to have
    // been dropped into nothing.
    expect(workspace.isMember(epic!)).toBe(true);
  });

  it('names the containers after the document they were made for', () => {
    const [epic] = reparentWithBridge(workspace, 'S1', 'P');
    expect(workspace.node(epic!)!.title).toBe('Epic for S1');
  });

  it('uses the titles the dialog collected', () => {
    const created = reparentWithBridge(workspace, 'S1', 'P', ['Checkout', 'Guest flow']);
    expect(created.map((id) => workspace.node(id)!.title)).toEqual(['Checkout', 'Guest flow']);
  });

  it('says so rather than half-doing it when nothing can be built', () => {
    expect(reparentWithBridge(workspace, 'F1', 'E')).toEqual([]);
    expect(workspace.notices.at(-1)?.message).toMatch(/Nothing can be created/);
  });
});

describe('schedule', () => {
  it('puts issues in a period and takes them out again', () => {
    schedule(workspace, ['S1', 'S2'], 'SP1');
    expect((workspace.node('S1') as IssueDto).period).toBe('SP1');
    expect(workspace.pending).toHaveLength(2);

    schedule(workspace, ['S1'], null);
    expect((workspace.node('S1') as IssueDto).period).toBeNull();
  });

  it('queues nothing for an issue already in that period', () => {
    schedule(workspace, ['S1'], 'SP1');
    const queued = workspace.pending.length;
    schedule(workspace, ['S1'], 'SP1');
    expect(workspace.pending).toHaveLength(queued);
  });

  it('ignores anything that is not an issue', () => {
    schedule(workspace, ['nope'], 'SP1');
    expect(workspace.pending).toEqual([]);
  });
});

/**
 * Dragging a node off the canvas into a sprint. The sample board is
 * P > E > F1 (S1, S2) ∥ F2 (S3, S4), so every container has leaves under it and
 * "what actually goes in the sprint" is a different set from "what was dragged".
 */
describe('scheduleLeaves', () => {
  it('schedules the stories under an epic, not the epic', () => {
    const moved = scheduleLeaves(workspace, ['E'], 'SP1');
    expect(moved.sort()).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect((workspace.node('S1') as IssueDto).period).toBe('SP1');
    // The containers are not work, so they are not in the sprint.
    expect((workspace.node('E') as IssueDto).period).toBeNull();
    expect((workspace.node('F1') as IssueDto).period).toBeNull();
  });

  it('takes only the stories under the feature that was dragged', () => {
    expect(scheduleLeaves(workspace, ['F1'], 'SP1').sort()).toEqual(['S1', 'S2']);
    expect((workspace.node('S3') as IssueDto).period).toBeNull();
  });

  it('schedules a leaf as itself', () => {
    expect(scheduleLeaves(workspace, ['S3'], 'SP1')).toEqual(['S3']);
  });

  it('counts a story once when its feature is dragged with it', () => {
    expect(scheduleLeaves(workspace, ['F1', 'S1'], 'SP1').sort()).toEqual(['S1', 'S2']);
    expect(workspace.pending).toHaveLength(2);
  });

  it('reports only what moved, so nothing claims to have scheduled the settled', () => {
    scheduleLeaves(workspace, ['F1'], 'SP1');
    const queued = workspace.pending.length;

    expect(scheduleLeaves(workspace, ['F1'], 'SP1')).toEqual([]);
    expect(workspace.pending).toHaveLength(queued);
  });

  it('unschedules the work under a container dropped on the backlog', () => {
    scheduleLeaves(workspace, ['E'], 'SP1');
    expect(scheduleLeaves(workspace, ['E'], null).sort()).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect((workspace.node('S1') as IssueDto).period).toBeNull();
  });

  it('does nothing for an id the board does not have', () => {
    expect(scheduleLeaves(workspace, ['gone'], 'SP1')).toEqual([]);
    expect(workspace.pending).toEqual([]);
  });

  /**
   * "Leaf" is about the tree, not about the type. Giving a story a sub-task
   * makes the story a container, and it stops being the thing that goes in the
   * sprint — the same way the feature above it already had.
   */
  it('follows the tree all the way down, however deep it goes', () => {
    const detail = createNode(workspace, { type: 'sub_task', parentId: 'S1', title: 'Detail' });
    const moved = scheduleLeaves(workspace, ['F1'], 'SP1');

    expect(moved.sort()).toEqual([detail, 'S2'].sort());
    expect((workspace.node('S1') as IssueDto).period).toBeNull();
  });
});

describe('dependencies', () => {
  it('refuses an edge that would close a cycle, and says so', () => {
    expect(addDependency(workspace, 'S1', 'S4')).toBe(false);
    expect(workspace.notices.at(-1)?.message).toMatch(/cycle/);
    expect(workspace.pending).toEqual([]);
  });

  it('splices a node onto an existing edge', () => {
    const other = createNode(workspace, { type: 'user_story', parentId: 'F1', title: 'Middle' });
    expect(spliceOntoEdge(workspace, other, 'S2', 'S3')).toBe(true);

    expect(issue(workspace, other).dependsOn).toEqual(['S2']);
    expect(issue(workspace, 'S3').dependsOn).toEqual([other]);
  });

  it('inserts a new issue on an edge at the upstream node level', () => {
    const id = insertOnEdge(workspace, 'S2', 'S3')!;
    expect(workspace.node(id)).toMatchObject({ type: 'user_story', parentId: 'F1' });
    expect(issue(workspace, id).dependsOn).toEqual(['S2']);
    expect(issue(workspace, 'S3').dependsOn).toEqual([id]);
  });
});

describe('duplicate', () => {
  it('copies a subtree and rewires the edges that stayed inside it', () => {
    const copies = duplicate(workspace, ['F1']);
    expect(copies).toHaveLength(3);

    const copiedFeature = workspace.node(copies[0]!)!;
    expect(copiedFeature.title).toBe('F1 (copy)');
    expect(children(workspace, copiedFeature.id)).toHaveLength(2);

    // S1 -> S2 was internal, so the copies keep it...
    const copiedS2 = children(workspace, copiedFeature.id).find((node) =>
      node.title.startsWith('S2'),
    )!;
    expect((copiedS2 as IssueDto).dependsOn).toHaveLength(1);
    // ...and the copy does not re-block S3, which was outside the selection.
    expect(issue(workspace, 'S3').dependsOn).toEqual(['S2']);
  });
});

describe('breakDown', () => {
  it('nests the pieces and chains them', () => {
    const pieces = breakDown(workspace, 'S4', { count: 3, mode: 'children' });
    expect(pieces).toHaveLength(3);
    expect(workspace.node('S4')).toBeDefined();

    for (const id of pieces) expect(workspace.node(id)!.parentId).toBe('S4');
    expect(issue(workspace, pieces[0]!).dependsOn).toEqual([]);
    expect(issue(workspace, pieces[1]!).dependsOn).toEqual([pieces[0]]);
    expect(issue(workspace, pieces[2]!).dependsOn).toEqual([pieces[1]]);
    // A story's children are sub_tasks, one level down.
    expect(workspace.node(pieces[0]!)!.type).toBe('sub_task');
  });

  it('replaces the original and rewires both ends of the graph', () => {
    // S3 sits between S2 and S4; splitting it must keep that path intact.
    const pieces = breakDown(workspace, 'S3', { count: 2, mode: 'replace' });

    expect(workspace.node('S3')).toBeUndefined();
    expect(workspace.node(pieces[0]!)!.parentId).toBe('F2');
    expect(issue(workspace, pieces[0]!).dependsOn).toEqual(['S2']);
    expect(issue(workspace, pieces[1]!).dependsOn).toEqual([pieces[0]]);
    expect(issue(workspace, 'S4').dependsOn).toEqual([pieces[1]]);
  });

  it('splits the effort across the pieces', () => {
    // Replacing keeps the pieces at story level, where story_points exists.
    const pieces = breakDown(workspace, 'S4', {
      count: 4,
      mode: 'replace',
      splitAttribute: 'story_points',
    });
    // S4 is 8 points; four pieces of 2.
    expect(pieces.map((id) => workspace.node(id)!.attributes.story_points)).toEqual([2, 2, 2, 2]);
  });

  it('leaves the effort alone when the pieces cannot hold it', () => {
    // Sub-tasks do not declare story_points, and writing it onto one would be
    // rejected by the board on push.
    const pieces = breakDown(workspace, 'S4', {
      count: 4,
      mode: 'children',
      splitAttribute: 'story_points',
    });
    expect(pieces).toHaveLength(4);
    expect(pieces.every((id) => !('story_points' in workspace.node(id)!.attributes))).toBe(true);
  });

  it('uses the titles it is given and numbers the rest', () => {
    const pieces = breakDown(workspace, 'S4', {
      count: 3,
      mode: 'children',
      titles: ['Schema', 'API'],
    });
    expect(pieces.map((id) => workspace.node(id)!.title)).toEqual(['Schema', 'API', 'S4 (3)']);
  });

  it('refuses when the hierarchy has no level below the issue', () => {
    const detail = createNode(workspace, { type: 'sub_task', parentId: 'S1', title: 'Detail' });
    expect(breakDown(workspace, detail, { count: 2, mode: 'children' })).toEqual([]);
    expect(workspace.notices.at(-1)?.message).toMatch(/no issue type below/);
  });
});

/**
 * The timeline mutations. They queue like every other edit, which is the point:
 * switching a sprint off and carrying its work over are both things you can
 * read in the pending list and change your mind about before pushing.
 */
describe('running the timeline', () => {
  /** Two sprints in a quarter, with one story done and one open in the first. */
  function timeline(): Workspace {
    const workspace = new Workspace();
    const nodes = board(
      aPeriod('PI', '2026-01-01', '2026-03-31', null, 'increment'),
      aPeriod('SP1', '2026-01-01', '2026-01-14', 'PI'),
      aPeriod('SP2', '2026-01-15', '2026-01-28', 'PI'),
      anIssue('DONE', 'user_story', null, { period: 'SP1', status: 'done' }),
      anIssue('OPEN', 'user_story', null, { period: 'SP1' }),
    );
    workspace.snapshot = {
      config,
      issues: Object.values(nodes).filter((node): node is IssueDto => node.kind === 'issue'),
      periods: Object.values(nodes).filter((node): node is PeriodDto => node.kind === 'period'),
      resources: [],
      squads: [],
      templates: [],
      problems: [],
      readAt: new Date().toISOString(),
    } satisfies BoardSnapshot;
    workspace.view = { ...emptyView('test', 'Test'), members: Object.keys(nodes) };
    workspace.nodes = nodes;
    return workspace;
  }

  it('holds the switch on and off, and hands it back to the dates', () => {
    const workspace = timeline();

    setPeriodActive(workspace, 'SP1', false);
    expect((workspace.node('SP1') as PeriodDto).active).toBe(false);

    // null is "back on the dates", which is the field being absent again.
    setPeriodActive(workspace, 'SP1', null);
    expect((workspace.node('SP1') as PeriodDto).active).toBeUndefined();
  });

  it('leaves anything that is not a period alone', () => {
    const workspace = timeline();
    setPeriodActive(workspace, 'OPEN', false);
    expect(workspace.view!.changes).toEqual([]);
  });

  it('completes the open work in a period and nothing else', () => {
    const workspace = timeline();
    completePeriod(workspace, 'SP1');
    expect((workspace.node('OPEN') as IssueDto).status).toBe('done');
    // It was already done, so nothing was queued for it.
    expect(workspace.view!.changes.map((change) => change.id)).toEqual(['OPEN']);
  });

  it('carries the open work into the next period, leaving the finished behind', () => {
    const workspace = timeline();
    carryOverPeriod(workspace, 'SP1');
    expect((workspace.node('OPEN') as IssueDto).period).toBe('SP2');
    expect((workspace.node('DONE') as IssueDto).period).toBe('SP1');
  });

  it('says so rather than unscheduling work when there is no next period', () => {
    const workspace = timeline();
    carryOverPeriod(workspace, 'SP2');
    carryOverPeriod(workspace, 'SP1');
    // SP2 is the last one: nothing was queued, and the refusal is on screen.
    expect((workspace.node('OPEN') as IssueDto).period).toBe('SP2');
    expect(workspace.notices.at(-1)?.message).toMatch(/no period after/i);
  });

  it('queues a start-now plan as ordinary edits', () => {
    const workspace = timeline();
    const plan = planStartNow(boardViewOf(workspace), 'SP2', '2026-02-10');
    expect(plan.ok).toBe(true);
    applyPlan(workspace, plan);

    expect(workspace.node('SP2')).toMatchObject({ starts: '2026-02-10', ends: '2026-02-23' });
    // The quarter stretched to hold it, and every change is still pending.
    expect(workspace.node('PI')).toMatchObject({ ends: '2026-03-31' });
    expect(workspace.view!.changes.length).toBeGreaterThan(0);
  });
});
