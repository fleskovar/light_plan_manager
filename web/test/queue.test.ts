import { describe, expect, it } from 'vitest';
import {
  completeView,
  emptyView,
  type IssueDto,
  type SquadDto,
  type ViewDocument,
} from '$shared';
import {
  audienceOptions,
  buildQueue,
  claimantFor,
  laneStatus,
  queueSections,
  wouldRelease,
} from '$features/queue/queue.js';
import { atomicConfig, board, config, issue, period, resource } from './fixtures.js';

/**
 * A feature with four stories in a chain, plus one nobody is waiting on.
 *
 *   S1 (done) -> S2 (in progress) -> S3 -> S4
 *   S5, unblocked and unstarted, low priority
 */
const sample = () =>
  board(
    issue('F', 'feature', null),
    issue('S1', 'user_story', 'F', { status: 'done' }),
    issue('S2', 'user_story', 'F', { status: 'in_progress', dependsOn: ['S1'] }),
    issue('S3', 'user_story', 'F', { dependsOn: ['S2'], attributes: { priority: 'high' } }),
    issue('S4', 'user_story', 'F', { dependsOn: ['S3'] }),
    issue('S5', 'user_story', 'F', { attributes: { priority: 'medium' } }),
  );

const ids = (cards: { issue: { id: string } }[]): string[] => cards.map((card) => card.issue.id);

describe('buildQueue', () => {
  it('offers what nothing is blocking, and nothing else', () => {
    const queue = buildQueue(sample(), config);
    expect(ids(queue.ready)).toEqual(['S5']);
    expect(ids(queue.active)).toEqual(['S2']);
    expect(ids(queue.blocked)).toEqual(['S3', 'S4']);
    expect(ids(queue.done)).toEqual(['S1']);
  });

  it('never offers a parent: a feature is the name of its stories', () => {
    const queue = buildQueue(sample(), config);
    expect([...ids(queue.ready), ...ids(queue.active), ...ids(queue.blocked)]).not.toContain('F');
  });

  it('offers an atomic story whole, and never the sub-tasks inside it', () => {
    const nodes = board(
      issue('F', 'feature', null),
      issue('S1', 'user_story', 'F'),
      issue('T1', 'sub_task', 'S1'),
      issue('T2', 'sub_task', 'S1'),
      issue('S2', 'user_story', 'F'),
    );

    // Without the flag the story disappears behind its sub-tasks...
    expect(ids(buildQueue(nodes, config).ready)).toEqual(['T1', 'T2', 'S2']);
    // ...and with it, the story is the card and its sub-tasks are its checklist.
    const queue = buildQueue(nodes, atomicConfig('user_story'));
    expect(ids(queue.ready)).toEqual(['S1', 'S2']);
    expect(queue.total).toBe(2);
  });

  it('says what each blocked card is waiting on', () => {
    const queue = buildQueue(sample(), config);
    const s3 = queue.blocked.find((card) => card.issue.id === 'S3')!;
    expect(s3.blockedBy.map((entry) => entry.id)).toEqual(['S2']);
  });

  it('ranks by priority first, then by how much finishing one releases', () => {
    const nodes = board(
      issue('LOW', 'user_story', null, { attributes: { priority: 'medium' } }),
      issue('HIGH', 'user_story', null, { attributes: { priority: 'high' } }),
      issue('HUB', 'user_story', null, { attributes: { priority: 'medium' } }),
      issue('A', 'user_story', null, { dependsOn: ['HUB'] }),
      issue('B', 'user_story', null, { dependsOn: ['HUB'] }),
    );
    const queue = buildQueue(nodes, config);
    // HIGH outranks both; HUB comes next because two issues wait on it. A and
    // B are waiting on HUB, so the queue does not offer them at all.
    expect(ids(queue.ready)).toEqual(['HIGH', 'HUB', 'LOW']);
    expect(ids(queue.blocked)).toEqual(['A', 'B']);
  });

  it('stays inside the feature that is already under way', () => {
    const nodes = board(
      issue('F1', 'feature', null),
      issue('F1-DONE', 'user_story', 'F1', { status: 'done' }),
      issue('F2', 'feature', null),
      issue('F2-A', 'user_story', 'F2'),
      issue('F2-B', 'user_story', 'F2'),
      issue('F1-REST', 'user_story', 'F1'),
    );

    // The rest of the half-built feature leads, even though it was written
    // last: the queue and `lpm task next` agree about not opening a second
    // front while the first one is half done.
    expect(ids(buildQueue(nodes, config).ready)).toEqual(['F1-REST', 'F2-A', 'F2-B']);
  });

  it('prefers the feature somebody is inside right now', () => {
    const nodes = board(
      issue('F1', 'feature', null),
      issue('F1-DONE', 'user_story', 'F1', { status: 'done' }),
      issue('F1-REST', 'user_story', 'F1'),
      issue('F2', 'feature', null),
      issue('F2-DOING', 'user_story', 'F2', { status: 'in_progress' }),
      issue('F2-REST', 'user_story', 'F2'),
    );

    expect(ids(buildQueue(nodes, config).ready)).toEqual(['F2-REST', 'F1-REST']);
  });

  it('leaves a priority somebody set by hand above it', () => {
    const nodes = board(
      issue('F1', 'feature', null),
      issue('F1-DONE', 'user_story', 'F1', { status: 'done' }),
      issue('F1-REST', 'user_story', 'F1', { attributes: { priority: 'medium' } }),
      issue('F2', 'feature', null),
      issue('F2-HIGH', 'user_story', 'F2', { attributes: { priority: 'high' } }),
    );

    expect(ids(buildQueue(nodes, config).ready)).toEqual(['F2-HIGH', 'F1-REST']);
  });

  it('counts what waits on a card, so the number means something', () => {
    const queue = buildQueue(sample(), config);
    expect(queue.active.find((card) => card.issue.id === 'S2')!.unblocks).toBe(1);
    expect(queue.ready.find((card) => card.issue.id === 'S5')!.unblocks).toBe(0);
  });

  it('narrows to a search without changing the lanes', () => {
    const queue = buildQueue(sample(), config, { search: 's3' });
    expect(ids(queue.blocked)).toEqual(['S3']);
    expect(queue.ready).toEqual([]);
    // The total is the board's, not the search's.
    expect(queue.total).toBe(5);
  });

  it('keeps only the tail of what is finished', () => {
    const nodes = board(
      ...Array.from({ length: 12 }, (_, index) =>
        issue(`D${index}`, 'user_story', null, {
          status: 'done',
          updated: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        }),
      ),
    );
    const queue = buildQueue(nodes, config, { doneLimit: 3 });
    // Newest first.
    expect(ids(queue.done)).toEqual(['D11', 'D10', 'D9']);
  });
});

describe('laneStatus', () => {
  it('is the board’s own vocabulary, not a hard-coded one', () => {
    expect(laneStatus(config, 'active')).toBe('in_progress');
    expect(laneStatus(config, 'done')).toBe('done');
    expect(laneStatus(config, 'ready')).toBe('backlog');
  });
});

describe('wouldRelease', () => {
  it('is what finishing this one actually unblocks', () => {
    const nodes = sample();
    // S3 waits on S2 alone, so finishing S2 releases it.
    expect(wouldRelease(nodes, config, nodes.S2 as IssueDto).map((entry) => entry.id)).toEqual(['S3']);
    // S4 waits on S3, which is still unfinished, so S2 releases nothing there.
    expect(wouldRelease(nodes, config, nodes.S3 as IssueDto).map((entry) => entry.id)).toEqual(['S4']);
  });
});

describe('dependencies between parents', () => {
  /** Two features, the second waiting on the first, two stories in each. */
  const twoFeatures = () =>
    board(
      issue('F1', 'feature', null),
      issue('A1', 'user_story', 'F1'),
      issue('A2', 'user_story', 'F1'),
      issue('F2', 'feature', null, { dependsOn: ['F1'] }),
      issue('B1', 'user_story', 'F2'),
      issue('B2', 'user_story', 'F2'),
    );

  it('holds back a story whose feature waits on another feature', () => {
    const queue = buildQueue(twoFeatures(), config);
    expect(ids(queue.ready)).toEqual(['A1', 'A2']);
    expect(ids(queue.blocked)).toEqual(['B1', 'B2']);
    // Named as the plan writes it: the feature, not the stories inside it.
    expect(queue.blocked[0]!.blockedBy.map((entry) => entry.id)).toEqual(['F1']);
  });

  it('clears the inherited dependency when the work inside the blocker is done', () => {
    const nodes = twoFeatures();
    // Nobody moves F1 itself — a feature is the name of the stories under it.
    (nodes.A1 as IssueDto).status = 'done';
    (nodes.A2 as IssueDto).status = 'done';

    const queue = buildQueue(nodes, config);
    expect((nodes.F1 as IssueDto).status).toBe('backlog');
    expect(ids(queue.ready)).toEqual(['B1', 'B2']);
    expect(queue.blocked).toEqual([]);
  });

  it('agrees with the engine that an ancestor edge is not a self-block', () => {
    const nodes = board(
      issue('F1', 'feature', null),
      issue('A1', 'user_story', 'F1', { dependsOn: ['F1'] }),
    );
    expect(ids(buildQueue(nodes, config).ready)).toEqual(['A1']);
  });
});

describe('a dependency on a spike gates the work that waits for it', () => {
  // The fixture config declares no research type; the rule reads the edge, not
  // the type, so a plain story stands in for the spike.
  it('withholds a story until the spike it waits on is finished', () => {
    const nodes = board(
      issue('F', 'feature', null),
      issue('R', 'user_story', 'F'),
      issue('S1', 'user_story', 'F', { dependsOn: ['R'] }),
      issue('S2', 'user_story', 'F'),
    );

    const queue = buildQueue(nodes, config);
    expect(ids(queue.ready)).toEqual(['R', 'S2']);
    expect(ids(queue.blocked)).toEqual(['S1']);
    expect(queue.blocked[0]!.blockedBy.map((entry) => entry.id)).toEqual(['R']);
  });

  it('inherits a dependency written on a parent', () => {
    const nodes = board(
      issue('F1', 'feature', null),
      issue('R', 'user_story', 'F1'),
      issue('F2', 'feature', null, { dependsOn: ['R'] }),
      issue('B1', 'user_story', 'F2'),
    );

    const queue = buildQueue(nodes, config);
    expect(ids(queue.ready)).toEqual(['R']);
    expect(ids(queue.blocked)).toEqual(['B1']);
  });
});

describe('queueSections', () => {
  it('reads top to bottom: what is moving, what is next, what waits, what finished', () => {
    const sections = queueSections(buildQueue(sample(), config));
    expect(sections.map((section) => [section.id, ids(section.cards)])).toEqual([
      ['now', ['S2']],
      ['next', ['S5']],
      ['waiting', ['S3', 'S4']],
      ['done', ['S1']],
    ]);
  });

  it('numbers only the line itself, and folds only the finished tail', () => {
    const sections = queueSections(buildQueue(sample(), config));
    expect(sections.filter((section) => section.numbered).map((section) => section.id)).toEqual(['next']);
    expect(sections.filter((section) => section.folded).map((section) => section.id)).toEqual(['done']);
  });

  it('takes no drop where only the graph decides', () => {
    const sections = queueSections(buildQueue(sample(), config));
    expect(Object.fromEntries(sections.map((section) => [section.id, section.dropsInto]))).toEqual({
      now: 'active',
      next: 'ready',
      waiting: null,
      done: 'done',
    });
  });

  it('tells an empty board from a queue with nothing ready', () => {
    const empty = queueSections(buildQueue(board(), config));
    expect(empty.find((section) => section.id === 'next')?.empty).toBe('No issues yet.');
    const stuck = queueSections(
      buildQueue(board(issue('A', 'user_story', null, { status: 'in_progress' })), config),
    );
    expect(stuck.find((section) => section.id === 'next')?.empty).toBe('Nothing ready.');
  });
});

describe('completeView', () => {
  it('gives a view from a server that predates the queue panel one, open', () => {
    const { queue: _absent, ...older } = emptyView('old', 'Old');
    expect(completeView(older as ViewDocument).queue).toEqual({ open: true, width: 300 });
  });

  it('leaves a queue panel somebody arranged alone', () => {
    const view = { ...emptyView('v', 'V'), queue: { open: false, width: 410 } };
    expect(completeView(view)).toBe(view);
  });
});

describe('a queue for one person or role', () => {
  /**
   *   Alice — person, covers the QA pool       Bob — person
   *   QA    — pool (a role)                     SQ  — squad of Bob alone, owning sprint SP
   *
   *   A1  Alice, ready, 3 points        A2  Alice, in progress     A3  Alice, done
   *   AF  Alice, flagged                Q1  QA pool, 2 points      QS  QA pool, in SP
   *   B1  Bob, ready                    U1  nobody
   */
  const roster = () => {
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
    return board(
      resource('ALICE', 'person', { title: 'Alice', covers: ['QA'], capacity: 4 }),
      resource('BOB', 'person', { title: 'Bob' }),
      resource('QA', 'role', { title: 'QA engineer' }),
      squad,
      { ...period('SP', '2026-10-01', '2026-10-14'), squad: 'SQ' },
      issue('F', 'feature', null),
      issue('A1', 'user_story', 'F', { assignee: 'ALICE', attributes: { story_points: 3 } }),
      issue('A2', 'user_story', 'F', { assignee: 'ALICE', status: 'in_progress', attributes: { story_points: 1 } }),
      issue('A3', 'user_story', 'F', { assignee: 'ALICE', status: 'done' }),
      issue('AF', 'user_story', 'F', { assignee: 'ALICE', flag: 'paused' }),
      issue('Q1', 'user_story', 'F', { assignee: 'QA', attributes: { story_points: 2 } }),
      issue('QS', 'user_story', 'F', { assignee: 'QA', period: 'SP', attributes: { story_points: 5 } }),
      issue('B1', 'user_story', 'F', { assignee: 'BOB', status: 'in_progress' }),
      issue('U1', 'user_story', 'F'),
    );
  };

  const sorted = (cards: { issue: { id: string } }[]): string[] => ids(cards).sort();

  it('offers what routes to them: their own work, and the pools they cover', () => {
    const queue = buildQueue(roster(), config, { resourceId: 'ALICE' });
    expect(sorted(queue.ready)).toEqual(['A1', 'Q1']);
    expect(ids(queue.active)).toEqual(['A2']);
    expect(ids(queue.done)).toEqual(['A3']);
  });

  it("leaves out other people's work, unassigned work, and a sprint their squad does not own", () => {
    const queue = buildQueue(roster(), config, { resourceId: 'ALICE' });
    const shown = [...queue.ready, ...queue.active, ...queue.blocked, ...queue.done].map((card) => card.issue.id);
    expect(shown).not.toContain('B1');
    expect(shown).not.toContain('U1');
    expect(shown).not.toContain('QS');
  });

  it('holds flagged work back as waiting, as the engine does', () => {
    const queue = buildQueue(roster(), config, { resourceId: 'ALICE' });
    expect(ids(queue.blocked)).toEqual(['AF']);
    expect(ids(queue.ready)).not.toContain('AF');
  });

  it('says how each card reaches them', () => {
    const queue = buildQueue(roster(), config, { resourceId: 'ALICE' });
    const byId = Object.fromEntries(queue.ready.map((card) => [card.issue.id, card]));
    expect(byId.A1).toMatchObject({ route: 'direct', pool: null });
    expect(byId.Q1?.route).toBe('pool');
    expect(byId.Q1?.pool?.id).toBe('QA');
  });

  it('weighs assigned and pooled work apart, against capacity', () => {
    const { workload } = buildQueue(roster(), config, { resourceId: 'ALICE' });
    // A1 + A2 + AF are hers (3 + 1 + 0); only Q1 of the pool is hers to take.
    expect(workload).toMatchObject({ assigned: 4, assignedIssues: 3, pooled: 2, pooledIssues: 1, capacity: 4 });
  });

  it('shows a role the work parked in it, inside the sprints it may work in', () => {
    const queue = buildQueue(roster(), config, { resourceId: 'QA' });
    expect(ids(queue.ready)).toEqual(['Q1']);
  });

  it("is everybody's queue with nobody chosen, or somebody the roster no longer has", () => {
    for (const resourceId of [null, 'GONE']) {
      const queue = buildQueue(roster(), config, { resourceId });
      expect(queue.forResource).toBeNull();
      expect(queue.workload).toBeNull();
      expect(sorted(queue.ready)).toEqual(['A1', 'Q1', 'QS', 'U1']);
      expect(queue.ready.every((card) => card.route === null)).toBe(true);
    }
  });

  it('names whose queue is empty', () => {
    const sections = queueSections(buildQueue(roster(), config, { resourceId: 'BOB' }));
    expect(sections.find((section) => section.id === 'next')?.empty).toBe('Nothing ready for Bob.');
  });
});

describe('claimantFor', () => {
  const alice = resource('ALICE', 'person', { covers: ['QA'] });
  const qa = resource('QA', 'role');

  it("makes work started from a person's queue theirs", () => {
    expect(claimantFor(issue('Q1', 'user_story', null, { assignee: 'QA' }), alice)).toBe('ALICE');
  });

  it('leaves the assignee alone where there is nobody new to hand it to', () => {
    expect(claimantFor(issue('A1', 'user_story', null, { assignee: 'ALICE' }), alice)).toBeNull();
    expect(claimantFor(issue('Q1', 'user_story', null, { assignee: 'QA' }), qa)).toBeNull();
    expect(claimantFor(issue('Q1', 'user_story', null, { assignee: 'QA' }), null)).toBeNull();
  });
});

describe('audienceOptions', () => {
  it('offers everyone, then me, then people and roles by name', () => {
    const nodes = board(
      resource('Z', 'person', { title: 'Zoe' }),
      resource('A', 'person', { title: 'Ann' }),
      resource('QA', 'role', { title: 'QA engineer' }),
    );
    expect(audienceOptions(nodes, 'Z').map((option) => [option.group, option.label])).toEqual([
      ['everyone', 'Everyone'],
      ['me', 'Me — Zoe'],
      ['people', 'Ann'],
      ['roles', 'QA engineer'],
    ]);
  });

  it('offers no "me" when the current user names nobody on the roster', () => {
    const nodes = board(resource('A', 'person', { title: 'Ann' }));
    expect(audienceOptions(nodes, 'ELSEWHERE').map((option) => option.group)).toEqual(['everyone', 'people']);
  });
});
