/**
 * The coverage report: what a remote mirrors, and what is missing *around* it.
 *
 * `remote-status.ts` answers "has anything drifted?" for the documents a
 * remote already holds. This answers the question that comes before it — **is
 * what the tracker holds a coherent piece of the plan?** Pushing one feature
 * is an ordinary and supported thing to do (`docs/remote-sync.md` §7f: a plan
 * is filed a piece at a time, and the shape heals), but nothing until now said
 * what the piece was missing: its stories, the epic above it, the sprint it is
 * scheduled into, the work it waits on.
 *
 * The unit is a **gap** — a document the remote does not hold that is related
 * to one it does — and a gap always names *why* it matters, because the reason
 * is what a person is deciding about. A missing container means the work is
 * filed at the tracker's root; a missing sprint means the issues in it were
 * filed unscheduled; a missing blocker means a dependency edge was dropped for
 * want of a second end. Those consequences are not decoration: they are the
 * difference between "63 documents are not pushed" — which is the status
 * report's `unlinked` bucket and tells nobody anything — and "these four are
 * why the tracker's copy of your plan is wrong".
 *
 * Pure data, no imports beyond this folder's own types: the report is computed
 * by `src/remote/coverage.ts` (offline — the board and the link store are all
 * it reads, so no tracker is called and nothing is written), served as JSON,
 * and rendered by the web app. The relation table below travels with it so
 * every reader says the same sentence about the same gap.
 */

/**
 * How an unmirrored document relates to the mirror — the reason it is a gap.
 *
 * Read from the *gap's* point of view: `parent` means this document is the
 * container of something mirrored, `child` that it sits inside something
 * mirrored, `blocker` that mirrored work waits on it.
 */
export type CoverageRelation = 'parent' | 'child' | 'period' | 'blocker' | 'blocked';

/** Anchors are sampled rather than listed in full: one sprint can hold hundreds. */
export const COVERAGE_ANCHOR_LIMIT = 5;

/** One reason a document is a gap, with the mirrored documents behind it. */
export interface CoverageReason {
  relation: CoverageRelation;
  /** Mirrored documents this gap relates to — at most `COVERAGE_ANCHOR_LIMIT`. */
  anchors: string[];
  /** How many there are in all; `anchors` may be a sample of them. */
  count: number;
}

/** One document the remote does not hold, and why that shows. */
export interface CoverageGap {
  id: string;
  kind: 'issue' | 'period';
  type: string;
  title: string;
  /** Every reason this document is a gap, in the table's order. */
  reasons: CoverageReason[];
}

/** The gap ids for one relation, so a reader can offer "select all of these". */
export interface CoverageGroup {
  relation: CoverageRelation;
  ids: string[];
}

/** What a remote mirrors, and what is missing around it. */
export interface RemoteCoverageReport {
  remote: {
    name: string;
    provider: string;
    /** The connection value that names where the issues live. */
    target: string;
  };
  /** Documents this remote holds a twin of. */
  mirrored: number;
  /** Documents in this remote's scope it could hold — the denominator. */
  total: number;
  /** Unmirrored documents related to mirrored ones, worst first. */
  gaps: CoverageGap[];
  /** The same gaps by relation, in the table's order; empty groups are omitted. */
  groups: CoverageGroup[];
  /** Gaps deliberately decoupled — reported, never offered for pushing. */
  decoupled: string[];
  /** Gaps outside this remote's scope — it cannot file them, and says so. */
  outOfScope: string[];
  /**
   * True when this remote files periods as documents of their own. When it is
   * false a period has no twin to be missing: the schedule rides the managed
   * block on the issue, so no `period` gap is ever reported.
   */
  filesPeriods: boolean;
}

/** The heading and the consequence one relation is described by. */
export interface CoverageRelationInfo {
  relation: CoverageRelation;
  /** What these documents are, as a group heading. */
  label: string;
  /** What the tracker's copy of the plan is missing while they are unfiled. */
  consequence: string;
  /** The same thing about one document, for a per-document panel. */
  short: string;
}

/**
 * The relations, in the order a reader should be shown them: the ones that
 * make the filed plan *wrong* first, the ones that make it *incomplete* after.
 *
 * A missing container is first because everything mirrored beneath it is filed
 * at the tracker's root, which is the failure people report as "the stories
 * are not under the features". `blocked` is last because it is the widest — on
 * a board whose foundations are mirrored, a great deal of unstarted work waits
 * on them, and that is ordinary rather than wrong.
 */
export const COVERAGE_RELATIONS: readonly CoverageRelationInfo[] = [
  {
    relation: 'parent',
    label: 'Missing parents',
    consequence: 'Their mirrored children sit at the tracker root until these are pushed.',
    short: 'parent of mirrored work',
  },
  {
    relation: 'child',
    label: 'Missing children',
    consequence: 'Their parent is mirrored without them.',
    short: 'child of a mirrored container',
  },
  {
    relation: 'period',
    label: 'Missing periods',
    consequence: 'Mirrored issues in these periods were pushed without a period.',
    short: 'period of mirrored issues',
  },
  {
    relation: 'blocker',
    label: 'Missing dependencies',
    consequence: 'Mirrored issues depend on these. The dependency is missing on the tracker.',
    short: 'blocks mirrored work',
  },
  {
    relation: 'blocked',
    label: 'Missing dependents',
    consequence: 'These depend on mirrored issues.',
    short: 'waits on mirrored work',
  },
] as const;

/** The table entry for one relation. */
export function coverageRelationInfo(relation: CoverageRelation): CoverageRelationInfo {
  const found = COVERAGE_RELATIONS.find((entry) => entry.relation === relation);
  // Every relation is in the table; the fallback keeps a hand-edited report
  // from blanking a panel.
  return found ?? { relation, label: relation, consequence: '', short: relation };
}

/**
 * The gaps around one document — what the panel shows for the selected node.
 *
 * Read from the report rather than computed again, so the panel and the drawer
 * cannot disagree about what is missing. A document with no gaps around it
 * answers `[]`, which is also the answer for one the report knows nothing
 * about.
 */
export function gapsAround(report: RemoteCoverageReport, id: string): CoverageGap[] {
  return report.gaps.filter((gap) => gap.reasons.some((reason) => reason.anchors.includes(id)));
}

/** One line for a header or a notice: `12 of 74 mirrored · 9 missing`. */
export function summarizeCoverage(report: RemoteCoverageReport): string {
  const missing = report.gaps.length;
  const head = `${report.mirrored} of ${report.total} mirrored`;
  if (missing === 0) return `${head} · nothing missing`;
  return `${head} · ${missing} missing`;
}
