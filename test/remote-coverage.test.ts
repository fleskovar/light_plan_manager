import { describe, expect, it } from 'vitest';
import { planCoverage } from '../src/remote/coverage.js';
import type { IssueDto, PeriodDto } from '../src/shared/model.js';
import type { BoardView } from '../src/shared/plans/reading.js';
import { gapsAround, summarizeCoverage } from '../src/shared/remote-coverage.js';

/**
 * Coverage — what the mirror is missing *around* what it holds.
 *
 * Pure, like `remote-status.test.ts`: DTOs in, a report out, no board on disk
 * and no tracker. The cases are the ones a person actually hits — a feature
 * pushed without its stories, a story pushed without the epic above it, an
 * issue filed without the sprint it is scheduled into, a dependency whose far
 * end was never filed — plus the two that keep the list honest: a decoupled
 * document and one outside the remote's scope are *reported*, never offered.
 */

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function issue(id: string, over: Partial<IssueDto> = {}): IssueDto {
  return {
    kind: 'issue',
    id,
    type: over.type ?? 'user_story',
    title: over.title ?? id,
    body: '',
    parentId: over.parentId ?? null,
    depth: 0,
    attributes: {},
    status: over.status ?? 'backlog',
    assignee: null,
    period: over.period ?? null,
    flag: null,
    dependsOn: over.dependsOn ?? [],
    relatesTo: [],
    relatedFiles: [],
  };
}

function period(id: string, type = 'sprint'): PeriodDto {
  return {
    kind: 'period',
    id,
    type,
    title: id,
    body: '',
    parentId: null,
    depth: 0,
    attributes: {},
    squad: null,
  };
}

function viewOf(nodes: Array<IssueDto | PeriodDto>): BoardView {
  return {
    config: {} as BoardView['config'],
    nodes: Object.fromEntries(nodes.map((node) => [node.id, node])),
  };
}

const HEADER = { name: 'jira', provider: 'jira', target: 'PAY' };

function plan(
  nodes: Array<IssueDto | PeriodDto>,
  mirrored: string[],
  options: {
    tombstoned?: string[];
    scope?: string;
    periodContainer?: string;
  } = {},
) {
  return planCoverage({
    board: viewOf(nodes),
    mirrored: new Set(mirrored),
    tombstoned: new Set(options.tombstoned ?? []),
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(options.periodContainer !== undefined ? { periodContainer: options.periodContainer } : {}),
    remote: HEADER,
  });
}

/** A three-level board: one epic, one feature in it, two stories in that. */
function tree(): IssueDto[] {
  return [
    issue('LP-1', { type: 'epic' }),
    issue('LP-2', { type: 'feature', parentId: 'LP-1' }),
    issue('LP-3', { parentId: 'LP-2' }),
    issue('LP-4', { parentId: 'LP-2' }),
  ];
}

// ---------------------------------------------------------------------------

describe('coverage', () => {
  it('reports nothing when the whole board is mirrored', () => {
    const report = plan(tree(), ['LP-1', 'LP-2', 'LP-3', 'LP-4']);
    expect(report.gaps).toEqual([]);
    expect(report.groups).toEqual([]);
    expect(report.mirrored).toBe(4);
    expect(report.total).toBe(4);
    expect(summarizeCoverage(report)).toBe('4 of 4 mirrored · nothing missing');
  });

  it('reports the work inside a container that was pushed alone', () => {
    const report = plan(tree(), ['LP-2']);
    const child = report.groups.find((group) => group.relation === 'child');
    expect(child?.ids).toEqual(['LP-3', 'LP-4']);
    // Anchored at the container that is actually filed, so the panel can say
    // which mirrored document looks empty.
    const gap = report.gaps.find((entry) => entry.id === 'LP-3')!;
    expect(gap.reasons.find((reason) => reason.relation === 'child')?.anchors).toEqual(['LP-2']);
  });

  it('anchors a child at the *nearest* mirrored ancestor', () => {
    // Epic and feature both mirrored: the story belongs to the feature.
    const report = plan(tree(), ['LP-1', 'LP-2']);
    const gap = report.gaps.find((entry) => entry.id === 'LP-3')!;
    expect(gap.reasons.find((reason) => reason.relation === 'child')?.anchors).toEqual(['LP-2']);
  });

  it('reports the containers above mirrored work, up to the first mirrored one', () => {
    const report = plan(tree(), ['LP-3']);
    const parents = report.groups.find((group) => group.relation === 'parent');
    expect(parents?.ids).toEqual(['LP-1', 'LP-2']);
  });

  it('stops walking up at a mirrored ancestor', () => {
    // The epic is filed, so the feature is the only broken link in the chain.
    const report = plan(tree(), ['LP-1', 'LP-3']);
    const parents = report.groups.find((group) => group.relation === 'parent');
    expect(parents?.ids).toEqual(['LP-2']);
  });

  it('ranks a missing container ahead of missing work inside one', () => {
    const report = plan(tree(), ['LP-3', 'LP-4']);
    // LP-1 and LP-2 are containers of mirrored work; nothing else is a gap.
    expect(report.gaps.map((gap) => gap.id)).toEqual(['LP-1', 'LP-2']);
  });

  it('reports a period a mirrored issue was filed without', () => {
    const nodes = [...tree(), period('TL-3')];
    nodes[2] = issue('LP-3', { parentId: 'LP-2', period: 'TL-3' });
    const report = plan(nodes, ['LP-2', 'LP-3'], { periodContainer: 'sprint' });
    const gap = report.gaps.find((entry) => entry.id === 'TL-3')!;
    expect(gap.kind).toBe('period');
    expect(gap.reasons[0]).toEqual({ relation: 'period', anchors: ['LP-3'], count: 1 });
    expect(report.filesPeriods).toBe(true);
  });

  it('never reports a period when the remote files no periods', () => {
    const nodes = [...tree(), period('TL-3')];
    nodes[2] = issue('LP-3', { parentId: 'LP-2', period: 'TL-3' });
    const report = plan(nodes, ['LP-2', 'LP-3']);
    // The schedule rides the managed block: there is no twin to be missing.
    expect(report.gaps.map((gap) => gap.id)).not.toContain('TL-3');
    expect(report.filesPeriods).toBe(false);
  });

  it('never reports a period level the remote degrades', () => {
    const nodes = [...tree(), period('TL-1', 'increment')];
    nodes[2] = issue('LP-3', { parentId: 'LP-2', period: 'TL-1' });
    const report = plan(nodes, ['LP-2', 'LP-3'], { periodContainer: 'sprint' });
    expect(report.gaps.map((gap) => gap.id)).not.toContain('TL-1');
  });

  it('reports both ends of a dependency edge that could not be written', () => {
    const nodes = [
      issue('LP-3', { dependsOn: ['LP-9'] }),
      issue('LP-9'),
      issue('LP-10', { dependsOn: ['LP-3'] }),
    ];
    const report = plan(nodes, ['LP-3']);
    const blocker = report.gaps.find((gap) => gap.id === 'LP-9')!;
    expect(blocker.reasons[0]).toEqual({ relation: 'blocker', anchors: ['LP-3'], count: 1 });
    const blocked = report.gaps.find((gap) => gap.id === 'LP-10')!;
    expect(blocked.reasons[0]!.relation).toBe('blocked');
  });

  it('gives one gap every reason it has', () => {
    // A feature inside a mirrored epic, holding a mirrored story, and blocking
    // one: three reasons, in the table's order.
    const nodes = [
      issue('LP-1', { type: 'epic' }),
      issue('LP-2', { type: 'feature', parentId: 'LP-1' }),
      issue('LP-3', { parentId: 'LP-2' }),
      issue('LP-8', { dependsOn: ['LP-2'] }),
    ];
    const report = plan(nodes, ['LP-1', 'LP-3', 'LP-8']);
    const gap = report.gaps.find((entry) => entry.id === 'LP-2')!;
    expect(gap.reasons.map((reason) => reason.relation)).toEqual(['parent', 'child', 'blocker']);
  });

  it('reports a decoupled document rather than offering it', () => {
    const report = plan(tree(), ['LP-2'], { tombstoned: ['LP-3'] });
    expect(report.decoupled).toEqual(['LP-3']);
    // LP-1 is the container above the mirrored feature; LP-4 the story inside
    // it. LP-3 is neither, because somebody decided it.
    expect(report.gaps.map((gap) => gap.id)).toEqual(['LP-1', 'LP-4']);
  });

  it('reports a related document outside the scope rather than offering it', () => {
    // The remote owns LP-2 and what is under it; LP-9 is elsewhere on the board.
    const nodes = [...tree(), issue('LP-9', { dependsOn: ['LP-3'] })];
    const report = plan(nodes, ['LP-2', 'LP-3'], { scope: 'LP-2' });
    expect(report.outOfScope).toEqual(['LP-9']);
    expect(report.gaps.map((gap) => gap.id)).toEqual(['LP-4']);
    // And the denominator is the scope, not the board.
    expect(report.total).toBe(3);
  });

  it('does not report the containers above a scope root', () => {
    // LP-1 is the epic above the scope root. It is not a gap and not an
    // out-of-scope surprise: nobody ever asked this remote to file it.
    const report = plan(tree(), ['LP-2', 'LP-3', 'LP-4'], { scope: 'LP-2' });
    expect(report.gaps).toEqual([]);
    expect(report.outOfScope).toEqual([]);
  });

  it('never reports a document the remote already holds', () => {
    const report = plan(tree(), ['LP-1', 'LP-2', 'LP-3']);
    expect(report.gaps.map((gap) => gap.id)).toEqual(['LP-4']);
  });

  it('survives a parent cycle a hand edit produced', () => {
    const nodes = [
      issue('LP-1', { parentId: 'LP-2' }),
      issue('LP-2', { parentId: 'LP-1' }),
      issue('LP-3', { parentId: 'LP-1' }),
    ];
    expect(() => plan(nodes, ['LP-3'])).not.toThrow();
  });

  it('samples the anchors of a gap many documents point at', () => {
    const sprint = period('TL-3');
    const issues = Array.from({ length: 9 }, (_, index) =>
      issue(`LP-${index + 1}`, { period: 'TL-3' }),
    );
    const report = plan([...issues, sprint], issues.map((entry) => entry.id), {
      periodContainer: 'sprint',
    });
    const reason = report.gaps.find((gap) => gap.id === 'TL-3')!.reasons[0]!;
    expect(reason.count).toBe(9);
    expect(reason.anchors).toHaveLength(5);
  });

  it('answers what is missing around one mirrored document', () => {
    const nodes = [...tree(), period('TL-3')];
    nodes[2] = issue('LP-3', { parentId: 'LP-2', period: 'TL-3' });
    const report = plan(nodes, ['LP-2', 'LP-3'], { periodContainer: 'sprint' });
    // Around the feature: the story that is not filed, and the epic above it.
    expect(gapsAround(report, 'LP-2').map((gap) => gap.id)).toEqual(['LP-1', 'LP-4']);
    // Around the story: the sprint it was filed without.
    expect(gapsAround(report, 'LP-3').map((gap) => gap.id)).toEqual(['TL-3']);
  });
});
