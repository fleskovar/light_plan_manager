/**
 * Coverage: which documents the mirror is missing, and what each one costs.
 *
 * The offline twin of `report.ts`. `computeRemoteStatus` asks the tracker
 * about every twin it holds; this asks nothing of anybody — the board and the
 * link store already say which documents are mirrored, and the board says how
 * they relate to the ones that are not. So it is fast on a large board, it
 * works without a credential, and it can be re-read after every push without
 * costing a request.
 *
 * `planCoverage` is pure (a `BoardView` and two id sets in, a report out), and
 * `computeRemoteCoverage` is the adapter that opens a declared remote and
 * feeds it. The classification rules are all in one place because they are
 * easy to get subtly wrong:
 *
 *   - **A gap is only a gap when something mirrored points at it.** Every
 *     unpushed document is already reported by the status report's `unlinked`
 *     bucket, and on a board that mirrors one feature that bucket is the whole
 *     backlog. What is worth a person's attention is the document the mirror
 *     itself implies: the container of a filed issue, the sprint it was filed
 *     without, the blocker its dependency edge was dropped for.
 *   - **A tombstone and an out-of-scope document are not gaps.** Both were
 *     decided, and offering them for pushing would undo the decision. They are
 *     reported separately so a short list is explainable, which is the same
 *     rule `describeScope` follows everywhere else.
 *   - **A period is only a gap where periods are filed at all.** A remote
 *     whose mapping carries no `periods` block rides the schedule in the
 *     managed block, so there is no twin for a sprint to be missing.
 */

import type { LoadedBoard } from '../core/board/load.js';
import { remoteNamed } from '../core/config/lookup.js';
import type { IssueDto, NodeDto, PeriodDto } from '../shared/model.js';
import type { BoardView } from '../shared/plans/reading.js';
import { subtreeIds } from '../shared/plans/reading.js';
import {
  COVERAGE_ANCHOR_LIMIT,
  COVERAGE_RELATIONS,
  type CoverageGap,
  type CoverageGroup,
  type CoverageReason,
  type CoverageRelation,
  type RemoteCoverageReport,
} from '../shared/remote-coverage.js';
import { toSnapshot } from '../sync/dto.js';
import { describeTarget } from './config-file.js';
import { loadLinkStore } from './links.js';
import { normalizePeriodMapping } from './periods.js';
import { openRemote } from './remotes.js';

/** What `planCoverage` needs: the board, who is mirrored, and what is filed. */
export interface CoverageInputs {
  board: BoardView;
  /** Local ids the remote holds a twin of. */
  mirrored: ReadonlySet<string>;
  /** Local ids carrying a tombstone — decoupled on purpose. */
  tombstoned: ReadonlySet<string>;
  /** The remote's scope root; absent means the whole board. */
  scope?: string;
  /**
   * The period *type* this remote files as a container (`sprint`), or absent
   * when it files no periods. Only periods of that type can be gaps: a level
   * above it degrades into the managed block and has no twin either way.
   */
  periodContainer?: string;
  remote: RemoteCoverageReport['remote'];
}

/** A mutable gap while it is being assembled. */
interface Draft {
  node: NodeDto;
  anchors: Map<CoverageRelation, string[]>;
}

/** Ids read the way a person reads them: `LP-9` before `LP-10`. */
function byId(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true });
}

function isIssue(node: NodeDto | undefined): node is IssueDto {
  return node?.kind === 'issue';
}

/**
 * Classify the board against one remote's mirror.
 *
 * Pure: no disk, no network, no clock. Every rule it applies is in this
 * function, so "why is this in the list?" has one place to look.
 */
export function planCoverage(inputs: CoverageInputs): RemoteCoverageReport {
  const { board, mirrored, tombstoned, periodContainer } = inputs;
  const scopeSet = inputs.scope !== undefined ? new Set(subtreeIds(board, inputs.scope)) : null;
  const inScope = (id: string): boolean => scopeSet === null || scopeSet.has(id);

  const nodes = Object.values(board.nodes);
  const issues = nodes.filter(isIssue);
  /** Periods that could be filed at all — the container level, and no other. */
  const filedPeriods =
    periodContainer === undefined
      ? []
      : nodes.filter(
          (node): node is PeriodDto => node.kind === 'period' && node.type === periodContainer,
        );

  /** Mirrored documents that still exist on the board — the anchors. */
  const anchors = new Set(
    [...mirrored].filter((id) => {
      const node = board.nodes[id];
      return node !== undefined && (node.kind === 'issue' || node.kind === 'period');
    }),
  );

  const drafts = new Map<string, Draft>();
  const note = (id: string, relation: CoverageRelation, anchor: string): void => {
    const node = board.nodes[id];
    if (node === undefined) return;
    if (anchors.has(id)) return; // it is mirrored: not a gap
    let draft = drafts.get(id);
    if (draft === undefined) {
      draft = { node, anchors: new Map() };
      drafts.set(id, draft);
    }
    const list = draft.anchors.get(relation);
    if (list === undefined) draft.anchors.set(relation, [anchor]);
    else if (!list.includes(anchor)) list.push(anchor);
  };

  // -- parent: the containers of mirrored work ------------------------------
  // Walked up from each anchor and stopped at the first mirrored ancestor:
  // above that one, the break in the chain is that ancestor's to explain, not
  // this one's.
  for (const id of anchors) {
    const seen = new Set([id]);
    let current = board.nodes[id]?.parentId ?? null;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      if (anchors.has(current)) break;
      // The walk stops at the scope boundary rather than reporting what it
      // finds above it. A scoped remote's root has a parent by definition, and
      // nobody ever meant to file it — listing it every time is how a report
      // that should be short teaches people to stop reading it. An
      // out-of-scope *dependency* is a different matter and is still reported:
      // there the edge was genuinely dropped.
      if (!inScope(current)) break;
      note(current, 'parent', id);
      current = board.nodes[current]?.parentId ?? null;
    }
  }

  // -- child: unmirrored work inside a mirrored container -------------------
  // Anchored at the *nearest* mirrored ancestor, so a story two levels under a
  // mirrored epic is reported against the epic that is actually filed.
  for (const issue of issues) {
    if (anchors.has(issue.id)) continue;
    const seen = new Set([issue.id]);
    let current = issue.parentId;
    while (current !== null && !seen.has(current)) {
      seen.add(current);
      if (anchors.has(current)) {
        note(issue.id, 'child', current);
        break;
      }
      current = board.nodes[current]?.parentId ?? null;
    }
  }

  // -- period: the sprint a mirrored issue was filed without ----------------
  const filedPeriodIds = new Set(filedPeriods.map((period) => period.id));
  for (const id of anchors) {
    const node = board.nodes[id];
    if (!isIssue(node) || node.period === null) continue;
    if (!filedPeriodIds.has(node.period)) continue; // a degraded level: no twin either way
    note(node.period, 'period', id);
  }

  // -- blocker / blocked: an edge needs both ends ---------------------------
  for (const issue of issues) {
    const mine = anchors.has(issue.id);
    for (const dependency of issue.dependsOn) {
      if (!isIssue(board.nodes[dependency])) continue;
      const theirs = anchors.has(dependency);
      if (mine && !theirs) note(dependency, 'blocker', issue.id);
      else if (!mine && theirs) note(issue.id, 'blocked', dependency);
    }
  }

  // -- split the drafts three ways ------------------------------------------
  const gaps: CoverageGap[] = [];
  const decoupled: string[] = [];
  const outOfScope: string[] = [];
  for (const [id, draft] of drafts) {
    if (tombstoned.has(id)) {
      decoupled.push(id);
      continue;
    }
    if (!inScope(id)) {
      outOfScope.push(id);
      continue;
    }
    gaps.push(toGap(id, draft));
  }
  decoupled.sort(byId);
  outOfScope.sort(byId);

  const groups: CoverageGroup[] = [];
  for (const { relation } of COVERAGE_RELATIONS) {
    const ids = gaps
      .filter((gap) => gap.reasons.some((reason) => reason.relation === relation))
      .map((gap) => gap.id)
      .sort(byId);
    if (ids.length > 0) groups.push({ relation, ids });
  }

  // Worst first: a gap is ranked by its most serious reason, which is the
  // first one `toGap` recorded (the reasons follow the table's order).
  const rank = (gap: CoverageGap): number =>
    COVERAGE_RELATIONS.findIndex((entry) => entry.relation === gap.reasons[0]?.relation);
  gaps.sort((a, b) => rank(a) - rank(b) || byId(a.id, b.id));

  const total =
    issues.filter((issue) => inScope(issue.id)).length +
    filedPeriods.filter((period) => inScope(period.id)).length;

  return {
    remote: inputs.remote,
    mirrored: anchors.size,
    total,
    gaps,
    groups,
    decoupled,
    outOfScope,
    filesPeriods: periodContainer !== undefined,
  };
}

/** One draft as the report carries it: reasons in the table's order, sampled. */
function toGap(id: string, draft: Draft): CoverageGap {
  const reasons: CoverageReason[] = [];
  for (const { relation } of COVERAGE_RELATIONS) {
    const anchors = draft.anchors.get(relation);
    if (anchors === undefined || anchors.length === 0) continue;
    const sorted = [...anchors].sort(byId);
    reasons.push({
      relation,
      anchors: sorted.slice(0, COVERAGE_ANCHOR_LIMIT),
      count: sorted.length,
    });
  }
  return {
    id,
    kind: draft.node.kind === 'period' ? 'period' : 'issue',
    type: draft.node.type,
    title: draft.node.title,
    reasons,
  };
}

/** The board as this layer reads it — the same `BoardView` the planners take. */
function viewOf(board: LoadedBoard): BoardView {
  const snapshot = toSnapshot(board);
  const nodes = Object.fromEntries(
    [...snapshot.issues, ...snapshot.periods, ...snapshot.resources, ...snapshot.templates].map(
      (node) => [node.id, node],
    ),
  );
  return { config: snapshot.config, nodes };
}

/**
 * Compute the coverage report for one declared remote.
 *
 * Offline by construction: it opens the remote to read its mapping and scope,
 * reads the link store, and asks the tracker nothing. A remote with no
 * credential reports exactly as well as one with a valid token — which is the
 * property that lets the web app re-read coverage after every push.
 */
export function computeRemoteCoverage(board: LoadedBoard, name: string): RemoteCoverageReport {
  const remote = openRemote(board.config, name);
  const store = loadLinkStore(board.paths, name);
  const provider = remoteNamed(board.config, name)?.provider ?? name;
  const periodMapping = normalizePeriodMapping(remote.mapping['periods']);

  return planCoverage({
    board: viewOf(board),
    mirrored: new Set(store.links.keys()),
    tombstoned: new Set(store.tombstones.keys()),
    ...(remote.scope !== undefined ? { scope: remote.scope } : {}),
    ...(periodMapping !== undefined ? { periodContainer: periodMapping.container } : {}),
    remote: {
      name,
      provider,
      target: describeTarget(provider, remote.connection),
    },
  });
}
