import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import {
  checkBoard,
  createIssue,
  createPeriod,
  findIssue,
  findPeriod,
  linkIssue,
  loadBoard,
  moveNode,
} from '../src/core/index.js';
import type { BoardView, Plan } from '../src/shared/index.js';
import {
  counterFactory,
  planBreakdown,
  planBridgeReparent,
  planCarryOver,
  planCompletePeriod,
  planConvert,
  planDuplicate,
  planInsert,
  planReparent,
  planStartNow,
  previewReparent,
  reparentChoices,
} from '../src/shared/index.js';
import { applyChanges } from '../src/sync/apply.js';
import { toSnapshot } from '../src/sync/dto.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/**
 * The planners are pure, so they are tested against a real board read through
 * the same DTO the app and the CLI see — and then the plans are actually
 * applied, because a plan that cannot be replayed is worthless.
 */
function viewOf(paths: BoardPaths): BoardView {
  const snapshot = toSnapshot(loadBoard(paths));
  const nodes = Object.fromEntries(
    [...snapshot.issues, ...snapshot.periods, ...snapshot.resources].map((node) => [node.id, node]),
  );
  return { config: snapshot.config, nodes };
}

/** program > epic > feature > 2 stories chained LP-5 -> LP-6. */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Platform' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  createIssue(reload(paths), { type: 'feature', title: 'Returning', parentId: 'LP-2' });
  createIssue(reload(paths), {
    type: 'user_story',
    title: 'Form',
    parentId: 'LP-3',
    attributes: { story_points: 12 },
  });
  createIssue(reload(paths), { type: 'user_story', title: 'Payment', parentId: 'LP-3' });
  linkIssue(reload(paths), findIssue(reload(paths), 'LP-6')!, { dependsOn: ['LP-5'] });
  return paths;
}

function run(paths: BoardPaths, plan: Plan): Record<string, string> {
  expect(plan.ok).toBe(true);
  if (!plan.ok) throw new Error('plan failed');
  const result = applyChanges(paths, plan.changes);
  expect(result.failures).toEqual([]);
  return result.idMap;
}

describe('planBreakdown', () => {
  it('nests the pieces under the original and chains them', () => {
    const paths = seed();
    const plan = planBreakdown(viewOf(paths), counterFactory(), 'LP-5', {
      count: 3,
      mode: 'children',
    });
    const idMap = run(paths, plan);

    const board = reload(paths);
    const pieces = plan.ok ? plan.created.map((temp) => findIssue(board, idMap[temp]!)!) : [];
    expect(pieces.map((piece) => piece.type)).toEqual(['sub_task', 'sub_task', 'sub_task']);
    expect(pieces.every((piece) => piece.parentId === 'LP-5')).toBe(true);
    expect(pieces[0]!.depends_on).toEqual([]);
    expect(pieces[1]!.depends_on).toEqual([pieces[0]!.id]);
    expect(pieces[2]!.depends_on).toEqual([pieces[1]!.id]);
    // The original survives and keeps its own place in the graph.
    expect(findIssue(board, 'LP-5')).not.toBeNull();
    expect(findIssue(board, 'LP-6')!.depends_on).toEqual(['LP-5']);
  });

  it('replaces the original and rewires both ends of the graph', () => {
    const paths = seed();
    const plan = planBreakdown(viewOf(paths), counterFactory(), 'LP-5', {
      count: 2,
      mode: 'replace',
    });
    const idMap = run(paths, plan);

    const board = reload(paths);
    const [first, second] = plan.ok ? plan.created.map((temp) => idMap[temp]!) : [];
    expect(findIssue(board, 'LP-5')).toBeNull();
    expect(findIssue(board, first!)!.parentId).toBe('LP-3');
    expect(findIssue(board, first!)!.type).toBe('user_story');
    expect(findIssue(board, second!)!.depends_on).toEqual([first]);
    // Whatever waited on the original now waits on the last piece.
    expect(findIssue(board, 'LP-6')!.depends_on).toEqual([second]);
  });

  it('carries the upstream dependencies onto the first piece', () => {
    const paths = seed();
    // LP-6 depends on LP-5; splitting LP-6 must keep that.
    const plan = planBreakdown(viewOf(paths), counterFactory(), 'LP-6', {
      count: 2,
      mode: 'replace',
    });
    const idMap = run(paths, plan);
    const first = plan.ok ? idMap[plan.created[0]!]! : '';
    expect(findIssue(reload(paths), first)!.depends_on).toEqual(['LP-5']);
  });

  it('divides the effort attribute across the pieces', () => {
    const paths = seed();
    // Replacing keeps the pieces at story level, where story_points exists.
    const plan = planBreakdown(viewOf(paths), counterFactory(), 'LP-5', {
      count: 4,
      mode: 'replace',
      splitAttribute: 'story_points',
    });
    const idMap = run(paths, plan);
    const board = reload(paths);
    const points = plan.ok
      ? plan.created.map((temp) => findIssue(board, idMap[temp]!)!.attributes.story_points)
      : [];
    expect(points).toEqual([3, 3, 3, 3]);
  });

  it('leaves the effort alone when the pieces cannot hold it', () => {
    const paths = seed();
    // A story splits into sub_tasks, which are measured in hours, not points.
    const plan = planBreakdown(viewOf(paths), counterFactory(), 'LP-5', {
      count: 4,
      mode: 'children',
      splitAttribute: 'story_points',
    });
    const idMap = run(paths, plan);
    const board = reload(paths);
    const pieces = plan.ok ? plan.created.map((temp) => findIssue(board, idMap[temp]!)!) : [];
    expect(pieces.every((piece) => !('story_points' in piece.attributes))).toBe(true);
    expect(pieces[0]!.attributes).toHaveProperty('estimate_hours');
  });

  it('uses the titles it is given and numbers the rest', () => {
    const paths = seed();
    const plan = planBreakdown(viewOf(paths), counterFactory(), 'LP-5', {
      count: 3,
      mode: 'children',
      titles: ['Schema', 'API'],
    });
    const idMap = run(paths, plan);
    const board = reload(paths);
    const titles = plan.ok
      ? plan.created.map((temp) => findIssue(board, idMap[temp]!)!.title)
      : [];
    expect(titles).toEqual(['Schema', 'API', 'Form (3)']);
  });

  it('refuses when the hierarchy has no level below the issue', () => {
    const paths = seed();
    createIssue(reload(paths), { type: 'sub_task', title: 'Detail', parentId: 'LP-5' });
    const plan = planBreakdown(viewOf(paths), counterFactory(), 'LP-7', {
      count: 2,
      mode: 'children',
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/no issue type below/);
  });
});

describe('planDuplicate', () => {
  it('copies a subtree and repoints the edges that stayed inside it', () => {
    const paths = seed();
    const plan = planDuplicate(viewOf(paths), counterFactory(), ['LP-3']);
    const idMap = run(paths, plan);

    const board = reload(paths);
    const copies = plan.ok ? plan.created.map((temp) => findIssue(board, idMap[temp]!)!) : [];
    expect(copies).toHaveLength(3);
    expect(copies[0]!.title).toBe('Guest flow (copy)');
    expect(copies[0]!.parentId).toBe('LP-2');

    // LP-6 -> LP-5 was internal to the copied subtree, so the copies keep it.
    const copiedPayment = copies.find((copy) => copy.title.startsWith('Payment'))!;
    const copiedForm = copies.find((copy) => copy.title.startsWith('Form'))!;
    expect(copiedPayment.depends_on).toEqual([copiedForm.id]);
    // ...and the originals are untouched.
    expect(findIssue(board, 'LP-6')!.depends_on).toEqual(['LP-5']);
  });

  it('does not copy a child twice when both it and its parent are selected', () => {
    const paths = seed();
    const plan = planDuplicate(viewOf(paths), counterFactory(), ['LP-3', 'LP-5']);
    expect(plan.ok && plan.created).toHaveLength(3);
  });

  it('wires a copy that points at a copy made after it', () => {
    const paths = makeBoard('scrum', 'LP');
    createIssue(reload(paths), { type: 'program', title: 'Platform' });
    createIssue(reload(paths), { type: 'epic', title: 'Checkout', parentId: 'LP-1' });
    createIssue(reload(paths), { type: 'feature', title: 'Flow', parentId: 'LP-2' });
    createIssue(reload(paths), { type: 'user_story', title: 'First', parentId: 'LP-3' });
    createIssue(reload(paths), { type: 'user_story', title: 'Second', parentId: 'LP-3' });
    // The *earlier* story depends on the later one, so its copy is created
    // before the copy it has to point at.
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, { dependsOn: ['LP-5'] });

    const plan = planDuplicate(viewOf(paths), counterFactory(), ['LP-3']);
    const idMap = run(paths, plan);

    const board = reload(paths);
    const copies = plan.ok ? plan.created.map((temp) => findIssue(board, idMap[temp]!)!) : [];
    const first = copies.find((copy) => copy.title.startsWith('First'))!;
    const second = copies.find((copy) => copy.title.startsWith('Second'))!;
    expect(first.depends_on).toEqual([second.id]);
  });
});

describe('planInsert', () => {
  it('creates an issue inside a dependency at the upstream level', () => {
    const paths = seed();
    const plan = planInsert(viewOf(paths), counterFactory(), {
      source: 'LP-5',
      target: 'LP-6',
      title: 'Validate input',
    });
    const idMap = run(paths, plan);

    const board = reload(paths);
    const middle = findIssue(board, idMap[plan.ok ? plan.created[0]! : '']!)!;
    expect(middle.type).toBe('user_story');
    expect(middle.parentId).toBe('LP-3');
    expect(middle.depends_on).toEqual(['LP-5']);
    // The original edge is replaced, not kept alongside the new one.
    expect(findIssue(board, 'LP-6')!.depends_on).toEqual([middle.id]);
  });

  it('moves an existing issue into the dependency', () => {
    const paths = seed();
    createIssue(reload(paths), { type: 'user_story', title: 'Middle', parentId: 'LP-3' });
    const plan = planInsert(viewOf(paths), counterFactory(), {
      source: 'LP-5',
      target: 'LP-6',
      issueId: 'LP-7',
    });
    run(paths, plan);

    const board = reload(paths);
    expect(findIssue(board, 'LP-7')!.depends_on).toEqual(['LP-5']);
    expect(findIssue(board, 'LP-6')!.depends_on).toEqual(['LP-7']);
  });

  it('refuses when the two issues are not connected', () => {
    const paths = seed();
    const plan = planInsert(viewOf(paths), counterFactory(), { source: 'LP-6', target: 'LP-5' });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/does not depend on/);
  });

  it('refuses an insertion that would close a cycle', () => {
    const paths = seed();
    // LP-6 already depends on LP-5, so putting LP-6 inside that edge loops.
    const plan = planInsert(viewOf(paths), counterFactory(), {
      source: 'LP-5',
      target: 'LP-6',
      issueId: 'LP-6',
    });
    expect(plan.ok).toBe(false);
  });
});

describe('planConvert', () => {
  it('swaps a type at the same depth', () => {
    const paths = seed();
    run(paths, planConvert(viewOf(paths), 'LP-5', 'bug'));
    expect(findIssue(reload(paths), 'LP-5')!.type).toBe('bug');
  });

  it('promotes a document to the ancestor that can hold it', () => {
    const paths = seed();
    // A story under LP-3 becomes a feature under LP-2.
    run(paths, planConvert(viewOf(paths), 'LP-5', 'feature'));
    const promoted = findIssue(reload(paths), 'LP-5')!;
    expect(promoted.type).toBe('feature');
    expect(promoted.parentId).toBe('LP-2');
    expect(promoted.depth).toBe(2);
  });

  it('sends a top-level type to the root', () => {
    const paths = seed();
    run(paths, planConvert(viewOf(paths), 'LP-5', 'program'));
    const promoted = findIssue(reload(paths), 'LP-5')!;
    expect(promoted.parentId).toBeNull();
    expect(promoted.depth).toBe(0);
  });

  it('refuses to demote without a new parent', () => {
    const paths = seed();
    const plan = planConvert(viewOf(paths), 'LP-3', 'user_story');
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/sits below/);
  });

  it('refuses a type from another namespace', () => {
    const paths = seed();
    const plan = planConvert(viewOf(paths), 'LP-5', 'sprint');
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toMatch(/is a period type/);
  });

  it('refuses a conversion that would strand a child', () => {
    const paths = seed();
    createIssue(reload(paths), { type: 'sub_task', title: 'Detail', parentId: 'LP-5' });
    // LP-3 (feature) -> epic would push its story to level 2 and sub_task to 3,
    // which is fine; but feature -> program pushes the sub_task off the end.
    const plan = planConvert(viewOf(paths), 'LP-3', 'program');
    expect(plan.ok).toBe(false);
  });
});

describe('previewReparent / planReparent', () => {
  it('reports the demotion a move would cause', () => {
    const paths = seed();
    // LP-4 is a childless feature; under LP-3 it must become a story.
    expect(previewReparent(viewOf(paths), 'LP-4', 'LP-3')).toEqual({
      type: 'user_story',
      allowed: true,
    });
  });

  it('applies the demotion along with the move', () => {
    const paths = seed();
    run(paths, planReparent(viewOf(paths), 'LP-4', 'LP-3'));
    const moved = findIssue(reload(paths), 'LP-4')!;
    expect(moved.type).toBe('user_story');
    expect(moved.parentId).toBe('LP-3');
  });

  it('refuses a move that would leave a descendant nowhere to sit', () => {
    const paths = seed();
    // LP-3 has stories; under LP-4 it becomes a story and they become sub_tasks,
    // which fits. Adding a sub_task pushes them off the end.
    createIssue(reload(paths), { type: 'sub_task', title: 'Detail', parentId: 'LP-5' });
    const preview = previewReparent(viewOf(paths), 'LP-3', 'LP-4');
    expect(preview.allowed).toBe(false);
    expect(preview.reason).toMatch(/nowhere to sit/);
  });

  it('refuses to move a document under itself', () => {
    const paths = seed();
    expect(previewReparent(viewOf(paths), 'LP-3', 'LP-5').allowed).toBe(false);
  });
});

describe('reparentChoices / planBridgeReparent', () => {
  it('offers both ways of making a drop fit', () => {
    const paths = seed();
    // LP-5 is a story; the program LP-1 is three levels above it.
    const choices = reparentChoices(viewOf(paths), 'LP-5', 'LP-1');
    expect(choices.convert).toEqual({ type: 'epic', allowed: true });
    expect(choices.bridge).toEqual(['epic', 'feature']);
  });

  it('offers no containers for a move that already fits', () => {
    const paths = seed();
    expect(reparentChoices(viewOf(paths), 'LP-4', 'LP-2').bridge).toEqual([]);
  });

  it('offers one container when only one level is missing', () => {
    const paths = seed();
    // A feature onto a program: either it becomes an epic, or an epic is built.
    expect(reparentChoices(viewOf(paths), 'LP-3', 'LP-1').bridge).toEqual(['epic']);
  });

  it('offers no containers when the drop is below the type it already has', () => {
    const paths = seed();
    // A feature onto a story can only be a demotion — containers are what you
    // build above something, never below it.
    const choices = reparentChoices(viewOf(paths), 'LP-4', 'LP-5');
    expect(choices.bridge).toEqual([]);
    expect(choices.convert).toEqual({ type: 'sub_task', allowed: true });
  });

  it('creates the missing levels and keeps the document as it was', () => {
    const paths = seed();
    const plan = planBridgeReparent(viewOf(paths), counterFactory(), 'LP-5', 'LP-1');
    const idMap = run(paths, plan);

    const board = reload(paths);
    const epic = findIssue(board, idMap['new:1']!)!;
    const feature = findIssue(board, idMap['new:2']!)!;
    const story = findIssue(board, 'LP-5')!;

    expect(epic).toMatchObject({ type: 'epic', parentId: 'LP-1' });
    expect(feature).toMatchObject({ type: 'feature', parentId: epic.id });
    // The point of the whole exercise: the story is still a story.
    expect(story).toMatchObject({ type: 'user_story', parentId: feature.id });
  });

  it('takes the whole subtree with it, unchanged', () => {
    const paths = seed();
    const detail = createIssue(reload(paths), {
      type: 'sub_task',
      title: 'Detail',
      parentId: 'LP-5',
    });
    run(paths, planBridgeReparent(viewOf(paths), counterFactory(), 'LP-5', 'LP-1'));

    const moved = findIssue(reload(paths), detail.id)!;
    expect(moved.type).toBe('sub_task');
    expect(moved.parentId).toBe('LP-5');
  });

  it('names the containers after the document, unless it is told otherwise', () => {
    const paths = seed();
    const named = planBridgeReparent(viewOf(paths), counterFactory(), 'LP-5', 'LP-1', {
      titles: ['Checkout'],
    });
    expect(named.ok && named.changes[0]).toMatchObject({ patch: { title: 'Checkout' } });
    // The short list is filled in rather than leaving a container untitled.
    expect(named.ok && named.changes[1]).toMatchObject({ patch: { title: 'Feature for Form' } });
  });

  it('refuses when there is nothing to build', () => {
    const paths = seed();
    const plan = planBridgeReparent(viewOf(paths), counterFactory(), 'LP-4', 'LP-2');
    expect(plan.ok).toBe(false);
  });
});

/**
 * The timeline planners. Like every other planner here they are applied to a
 * real board, because a plan that cannot be replayed is worthless — and these
 * ones rewrite dates and reschedule work, which is exactly where that matters.
 */
describe('running the timeline', () => {
  /** H2 holding three fortnightly sprints, with stories in the first two. */
  function timeline(): BoardPaths {
    const paths = seed();
    createPeriod(reload(paths), {
      type: 'increment',
      title: 'H2',
      starts: '2026-07-01',
      ends: '2026-08-31',
    });
    for (const [title, starts, ends] of [
      ['Sprint 1', '2026-07-01', '2026-07-14'],
      ['Sprint 2', '2026-07-15', '2026-07-28'],
      ['Sprint 3', '2026-07-29', '2026-08-11'],
    ] as const) {
      createPeriod(reload(paths), { type: 'sprint', title, starts, ends, parentId: 'TL-1' });
    }
    moveNode(reload(paths), findIssue(reload(paths), 'LP-5')!, { period: 'TL-2' });
    moveNode(reload(paths), findIssue(reload(paths), 'LP-6')!, { period: 'TL-2' });
    return paths;
  }

  const dates = (paths: BoardPaths, id: string): string => {
    const period = findPeriod(reload(paths), id)!;
    return `${period.starts}..${period.ends}`;
  };

  describe('planStartNow', () => {
    it('moves a sprint onto today, keeping how long it runs', () => {
      const paths = timeline();
      run(paths, planStartNow(viewOf(paths), 'TL-3', '2026-09-07'));
      expect(dates(paths, 'TL-3')).toBe('2026-09-07..2026-09-20');
    });

    it('takes the sprints inside an increment with it', () => {
      const paths = timeline();
      // H2 starts 2026-07-01; moving it to 2026-09-01 is a shift of 62 days.
      run(paths, planStartNow(viewOf(paths), 'TL-1', '2026-09-01'));
      expect(dates(paths, 'TL-1')).toBe('2026-09-01..2026-11-01');
      expect(dates(paths, 'TL-2')).toBe('2026-09-01..2026-09-14');
      expect(dates(paths, 'TL-4')).toBe('2026-09-29..2026-10-12');
      // The whole run still fits inside the increment, so the board is clean.
      expect(checkBoard(reload(paths))).toEqual([]);
    });

    it('closes whatever was running and stretches the increment', () => {
      const paths = timeline();
      // Today is inside Sprint 1, and Sprint 3 would run past H2's end.
      const plan = planStartNow(viewOf(paths), 'TL-4', '2026-07-06');
      expect(plan.ok && plan.closing.map((period) => period.id)).toEqual(['TL-2']);
      run(paths, plan);
      expect(dates(paths, 'TL-2')).toBe('2026-07-01..2026-07-05');
      expect(dates(paths, 'TL-4')).toBe('2026-07-06..2026-07-19');
      expect(dates(paths, 'TL-1')).toBe('2026-07-01..2026-08-31');
    });

    it('refuses anything that is not a period', () => {
      const paths = timeline();
      expect(planStartNow(viewOf(paths), 'LP-5', '2026-09-07').ok).toBe(false);
    });
  });

  describe('correcting an overrun', () => {
    /** Sprint 1 with one story finished and one still open. */
    function overrun(): BoardPaths {
      const paths = timeline();
      moveNode(reload(paths), findIssue(reload(paths), 'LP-5')!, { status: 'done' });
      return paths;
    }

    it('completes what is still open, and leaves the rest alone', () => {
      const paths = overrun();
      run(paths, planCompletePeriod(viewOf(paths), 'TL-2'));
      const board = reload(paths);
      expect(findIssue(board, 'LP-6')!.status).toBe('done');
      // It was already done, and it did not move sprint.
      expect(findIssue(board, 'LP-5')!.period).toBe('TL-2');
    });

    it('carries what is open into the next sprint, and only that', () => {
      const paths = overrun();
      run(paths, planCarryOver(viewOf(paths), 'TL-2'));
      const board = reload(paths);
      expect(findIssue(board, 'LP-6')!.period).toBe('TL-3');
      // Finished work stays where it was delivered — that is the record.
      expect(findIssue(board, 'LP-5')!.period).toBe('TL-2');
      expect(findIssue(board, 'LP-6')!.status).not.toBe('done');
    });

    it('piles up in the last sprint, because no period is invented', () => {
      const paths = overrun();
      run(paths, planCarryOver(viewOf(paths), 'TL-2'));
      run(paths, planCarryOver(viewOf(paths), 'TL-3'));
      expect(findIssue(reload(paths), 'LP-6')!.period).toBe('TL-4');

      // TL-4 is the last one: there is nowhere further to push, and the plan
      // says so rather than quietly unscheduling somebody's work.
      const plan = planCarryOver(viewOf(paths), 'TL-4');
      expect(plan.ok).toBe(false);
      expect(!plan.ok && plan.error).toMatch(/no period after/i);
    });

    it('is nothing at all when everything in the period is finished', () => {
      const paths = overrun();
      run(paths, planCompletePeriod(viewOf(paths), 'TL-2'));
      const plan = planCompletePeriod(viewOf(paths), 'TL-2');
      expect(plan.ok && plan.changes).toEqual([]);
    });

    it('refuses an id that is not a period', () => {
      const paths = overrun();
      expect(planCompletePeriod(viewOf(paths), 'LP-5').ok).toBe(false);
      expect(planCarryOver(viewOf(paths), 'LP-5').ok).toBe(false);
    });
  });
});
