/**
 * The push and pull planners — pure functions from a board to a plan.
 *
 *   planPush(board, links, remote) → PushPlan             (LP-280, this file)
 *   planPull(board, links, remote, options) → PullPlan    (LP-281, this file)
 *
 * Both take a `BoardView` DTO rather than a `LoadedBoard`, so neither needs a
 * filesystem handle and the plan is a plain data structure a dry-run can render
 * and an executor can walk.  Neither touches the disk or the network: the push
 * plan is handed to the executor (`LP-490`), the pull plan to `applyChanges`
 * from `src/sync`.
 *
 * ## Why a push plan exists at all
 *
 * A push is a list of *remote operations*, not a batch write.  The remote is a
 * separate system with its own ids, its own workflow and its own idea of a
 * parent, so the plan has to say, in order:
 *
 *   1. what to create, parents before children (a parent must exist before its
 *      children are filed under it);
 *   2. what to update / transition / close, for documents that already have a
 *      twin;
 *   3. what to link and unlink, after every endpoint exists.
 *
 * Two rules make the order load-bearing.  A `create` op carries no remote id —
 * it is referenced by a **placeholder** (`new:1`) until the executor resolves
 * it against the response — and an edge (`link` / `unlink`) is emitted only
 * once both endpoints exist, so a document created in this same push can be an
 * endpoint.  That is the held-back-link trick `src/sync/patch.ts` uses for
 * `depends_on`, expressed here as a rule about op order rather than a deferred
 * patch: every edge is placed after every create and update, and it references
 * its endpoints through a `RemoteRef` that is either a recorded twin or a
 * placeholder.
 *
 * ## What this file deliberately does not do
 *
 * - **Conflict detection on the push side** (both sides edited a field) is
 *   `LP-257`'s; `planPush` diffs a document against its base and pushes what
 *   changed locally — it never consults the remote side for a pushed field.
 *   The pull planner *does* detect a both-sides edit: a field both sides
 *   changed is reported in `PullPlan.fieldConflicts` rather than written.
 * - **Existence and shape** (the twin was deleted, moved or converted) is
 *   `LP-361`'s; `remote.issues` is part of the input so that story and the pull
 *   planner can read it, but this planner does not yet act on it.
 * - **The mapping** is the translator's job at execution time.  The planner
 *   decides *what* changed against the base snapshot and *in what order* it is
 *   pushed; it never turns a board status into a remote state.
 * - **`relates_to`** is a non-gating edge: it is linked / unlinked natively
 *   only where the provider declares a native relate edge (Jira, LP-325), and
 *   rides the managed block everywhere else (LP-314).
 */

import type { RemoteDirection, RemoteOnDelete } from '../core/model/types.js';
import type { RemoteCommentsMode } from '../core/model/types.js';
import type { Change, NodePatch } from '../shared/changes.js';
import { tempId } from '../shared/changes.js';
import type { IssueDto } from '../shared/model.js';
import { counterFactory } from '../shared/plans/reading.js';
import type { BoardView } from '../shared/plans/reading.js';
import { subtreeIds } from '../shared/plans/reading.js';
import { anchorResolver } from './anchor.js';
import { parentIsNative, carrierChanged } from './hierarchy.js';
import type { ResolvedHierarchy } from './hierarchy.js';
import { getSyncedCommentIndexes, getSyncedRemoteCommentIds, getTombstone, hashBody, isManagedComment } from './links.js';
import type { LinkStore } from './links.js';
import { mergeValues, NO_BASE, valuesEqual } from './merge.js';
import type { ManagedBlockEntry, ManagedBlockLinks } from './managed-block.js';
import { planCommentPull, planCommentPush, renderCommentForRemote, type LocalComment } from './comments.js';
import type { BoardFields, BoardFieldsPatch, LinkKind, RemoteComment, RemoteRecord } from './provider.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * The remote as a planner sees it: how it is declared to sync, plus the
 * remote-side issue state the executor captured before planning.
 *
 * `direction` and `scope` come from the remote's declaration; `issues` is the
 * live listing (remote id → raw record).  The push planner reads the first two
 * and leaves `issues` to the pull planner and the lifecycle/conflict stories;
 * it is carried here so one snapshot serves both directions.
 */
export interface RemoteSnapshot {
  /** The remote's declared direction; a pull-only remote plans nothing. */
  direction: RemoteDirection;
  /** The scope root id; absent means the whole board is in scope. */
  scope?: string;
  /**
   * Act on only these documents this run (`lpm remote push LP-12`), leaving
   * every other document exactly as it stands.
   *
   * **Selection is not scope, and the difference is load-bearing.** Scope says
   * which documents this remote *owns*, so a linked document outside it has
   * left the mirror and the `on_delete` policy applies — a decouple, a close,
   * a delete. Selection says which documents this run is *about*. Narrowing
   * the scope to say "just push this one" would tell the planner that every
   * other twin on the board had gone away, and a selective push would file one
   * story and decouple the other two hundred. So `only` filters what is
   * created, updated, reparented, edged and commented, and the gone pass never
   * consults it. Absent means the whole scope.
   *
   * Reference resolution (`refOf`) does not consult it either: a selected
   * child whose parent is already linked still names that parent, which is
   * what lets a plan be filed a piece at a time and still come out the right
   * shape.
   */
  only?: ReadonlySet<string>;
  /**
   * Documents another remote already mirrors (`src/remote/ledger.ts`), local
   * id → the key they hold there. A document is mirrored by one remote at a
   * time, so these are never created a second time: they are reported in
   * `skipped` with the reason `owned_elsewhere`, the same channel a
   * deliberately decoupled document is reported through.
   */
  ownedElsewhere?: ReadonlyMap<string, string>;
  /** Remote issues keyed by remote id, as the provider returned them. */
  issues: ReadonlyMap<string, RemoteRecord>;
  /**
   * The listing is **not exhaustive** — it is one issue somebody named
   * (`lpm remote pull PAY-31`), not everything the remote holds. The pull
   * planner then never infers a deletion from absence: a twin missing from a
   * partial listing was not looked for, and answering that with the
   * `on_delete` policy would close or delete the rest of the board's twins on
   * every targeted pull.
   */
  partial?: boolean;
  /** What to do when a linked twin is absent from `issues`. Defaults to `unlink`. */
  onDelete?: RemoteOnDelete;
  /**
   * Set by the caller (LP-364) when the remote could not be seen this run —
   * the reachability probe failed, or the bulk guard tripped. The pull
   * planner then plans **nothing**, so an expired credential can never become
   * a wave of deletions. The caller derives it from
   * `resolveLifecycle(...).runUnreachable`.
   */
  unreachable?: boolean;
  /**
   * The resolved hierarchy encoding (LP-309), computed by the caller from the
   * resolved capability table (`resolveHierarchyEncoding`). Absent means the
   * planners fall back to the pre-encoding behaviour: every parent is carried
   * natively. Present, a document whose parent is beyond the native depth has
   * its parent carried in the managed block instead (`blockParent`).
   */
  hierarchy?: ResolvedHierarchy;
  /**
   * Which dependency edge kinds the remote holds natively (LP-314, LP-325).
   * Absent defaults to "native `depends_on`, no native `relates_to`" — the
   * pre-edge-carrier behaviour, so a snapshot that does not know its
   * capabilities still plans `link` / `unlink` ops.  A provider with no native
   * blocking edge carries `depends_on` in the managed block instead (an
   * `edges` op); `relates_to` rides the block unless `relatesTo` is true, in
   * which case it is linked and unlinked natively.
   */
  edges?: { dependsOn: boolean; relatesTo: boolean };
  /**
   * How user comments sync (LP-316): `push` (the default) or `both`.  The push
   * planner posts unsynced local comments whenever it runs; the pull planner
   * appends remote comments only when this is `both`.  Absent means `push`.
   */
  commentsMode?: RemoteCommentsMode;
  /**
   * Remote comments per remote issue id, fetched by the caller before planning
   * (LP-316).  The pull planner reads this map and emits append ops for every
   * comment not already recorded in the link store.  Absent means no comments
   * were fetched, which is the caller's way of saying comment pull is
   * unavailable this run.
   */
  remoteComments?: ReadonlyMap<string, readonly RemoteComment[]>;
  /**
   * A board body as it will read after a round trip through the remote's own
   * body format (`Translator.normalizeBody`), for a provider whose bodies are
   * not markdown.
   *
   * The base records the body the remote echoed back, so the comparison is
   * only honest if the board's body is put through the same conversion first.
   * Jira's ADF has no source line breaks, so without this every hard-wrapped
   * document is permanently ahead and each push rewrites the lot. Absent for a
   * provider whose bodies are markdown already, where the round trip is the
   * identity.
   */
  normalizeBody?: (markdown: string) => string;
}

// ---------------------------------------------------------------------------
// Remote operations
// ---------------------------------------------------------------------------

/** A document that already has a twin on the remote. */
export interface LinkedRef {
  kind: 'linked';
  localId: string;
  remoteId: string;
}

/** A document this same plan creates, referenced by its placeholder. */
export interface CreatedRef {
  kind: 'created';
  localId: string;
  /** The `create` op's placeholder, resolved by the executor when it lands. */
  placeholder: string;
}

/**
 * A remote issue an op points at.  Either a twin that already exists, or a
 * document the plan creates — which has no remote id yet, so it is referenced
 * by its placeholder until execution resolves it.
 */
export type RemoteRef = LinkedRef | CreatedRef;

/** File a new remote issue for a local document with no twin. */
export interface RemoteCreateOp {
  kind: 'create';
  /** Placeholder the executor resolves to a remote id when this create lands. */
  placeholder: string;
  localId: string;
  /** The issue's fields in board vocabulary (the translator's input). */
  fields: BoardFields;
  /** The created issue's native parent, when it is in scope; absent = remote root. */
  parent?: RemoteRef;
  /** The created issue's degraded parent (LP-309): carried in the managed block, never a native edge. */
  blockParent?: RemoteRef;
}

/** Change non-status fields of an existing twin. */
export interface RemoteUpdateOp {
  kind: 'update';
  localId: string;
  ref: LinkedRef;
  /** Only the fields that changed since the base snapshot. */
  fields: Partial<BoardFields>;
  /**
   * The degraded parent (LP-314): carried in the managed block when the
   * document nests beyond the native depth.  The executor re-applies it
   * whenever it rewrites the body, so a prose edit never strips the block.
   */
  blockParent?: RemoteRef;
}

/** Move an existing twin to a non-terminal status. */
export interface RemoteTransitionOp {
  kind: 'transition';
  localId: string;
  ref: LinkedRef;
  /** The new board status id; the translator maps it to a remote state. */
  status: string;
}

/**
 * Move an existing twin's parent, in place (LP-493). Covers both a local
 * reparent (`lpm move` on a linked document) and a hierarchy-encoding switch,
 * which moves the *same* parent between the two carriers. Exactly one of
 * `parent` / `blockParent` is set while the new parent sits within / beyond
 * the native depth; both are absent when the document moves to the root. The
 * twin keeps its remote id — it is never re-created.
 */
export interface RemoteReparentOp {
  kind: 'reparent';
  localId: string;
  ref: LinkedRef;
  /** The twin's native parent (the sub-issues edge), within the native depth. */
  parent?: RemoteRef;
  /** The twin's degraded parent (the block's `parent` row), beyond it. */
  blockParent?: RemoteRef;
}

/** Close an existing twin (a terminal status reached). */
export interface RemoteCloseOp {
  kind: 'close';
  localId: string;
  ref: LinkedRef;
  /**
   * A comment to post on the twin before closing, explaining why (the
   * push-side `on_delete: close` policy). Only ever set when the close is a
   * policy close for a document that went away — never for a terminal status
   * the board reached on its own, which needs no explanation.
   */
  note?: string;
}

/**
 * Delete an existing twin (`on_delete: delete`, LP-351).
 *
 * The connector decides what delete means on its platform — Jira and Linear
 * hard-delete (or trash), GitHub cannot hard-delete and closes instead, which
 * its adapter documents. The op carries only the twin to remove; the executor
 * drops the link (or decouples, when the local document still exists) after
 * the delete lands, so a failed delete leaves the link in place and the next
 * sync retries it.
 */
export interface RemoteDeleteOp {
  kind: 'delete';
  localId: string;
  ref: LinkedRef;
}

/** Add an edge between two in-scope issues. */
export interface RemoteLinkOp {
  kind: 'link';
  /**
   * The edge kind: `depends` (the gating `depends_on` edge, the default) or
   * `relates` (the non-gating `relates_to` edge, LP-325). For `depends`,
   * `dependent` waits on `dependency`; for `relates` the two are
   * interchangeable.
   */
  linkKind: LinkKind;
  /** The issue that waits (or, for relates, the local side of the edge). */
  dependent: RemoteRef;
  /** The issue it waits on (or, for relates, the other side of the edge). */
  dependency: RemoteRef;
}

/** Remove an edge that no longer exists locally. */
export interface RemoteUnlinkOp {
  kind: 'unlink';
  /** The edge kind, exactly as `RemoteLinkOp.linkKind`. */
  linkKind: LinkKind;
  dependent: LinkedRef;
  dependency: LinkedRef;
}

/**
 * Write the dependency / relate edges into the managed block of a twin whose
 * remote holds no native edge (LP-314).
 *
 * The block is authoritative: the op carries the **complete** current set of
 * edges, not a diff, so the executor rewrites the block idempotently.  A
 * dependency referenced by a create that did not land is simply omitted (the
 * executor cannot resolve its remote id), and the next push re-plans it — a
 * reference is never written as a dangling local id (AC #2).
 */
export interface RemoteEdgesOp {
  kind: 'edges';
  localId: string;
  /** The twin carrying the block — an existing twin, or the create this same push files. */
  ref: RemoteRef;
  /** The degraded parent (block carrier), when the document nests beyond the native depth. */
  parent?: RemoteRef;
  /** The issues this document waits on, resolved to remote ids by the executor. */
  dependsOn: RemoteRef[];
  /** The issues this document is related to, resolved to remote ids by the executor. */
  relatesTo: RemoteRef[];
}

/**
 * Post a local work-log comment upstream (LP-316).  Carries the comment's
 * 1-based index so the executor can record `commentIds[index] = remote id`
 * once it lands — which is what makes re-posting impossible.  `body` is the
 * rendered comment (`renderCommentForRemote`), already naming the local author
 * for a platform that cannot set the comment author itself.
 */
export interface RemoteCommentOp {
  kind: 'comment';
  /** The twin the comment hangs off — an existing twin, or the create this same push files. */
  ref: RemoteRef;
  /** 1-based index of the local comment in `_comments.md`. */
  index: number;
  /** The local author, for the report. */
  author: string;
  /** The rendered comment body posted upstream. */
  body: string;
}

/**
 * Write (or update) the managed comment holding a twin's degraded fields.
 *
 * The op carries the *entries* rather than a rendered body, so the executor
 * renders them through the codec (byte-stable, sorted) and can tell "nothing
 * to write" from "something to write" — the former removes the comment.  The
 * executor derives the id links from the link store; `links` is the pure
 * override a test or a dry-run supplies when there is no store to read.
 */
export interface RemoteManagedCommentOp {
  kind: 'managedComment';
  localId: string;
  ref: LinkedRef;
  /** The degraded fields the comment carries, as block entries. */
  entries: readonly ManagedBlockEntry[];
  /** Local id → remote URL, for rendering id cells as clickable links. */
  links?: ManagedBlockLinks;
}

/** Detach a local document from its twin without touching the remote. */
export interface RemoteUnlinkLocalOp {
  kind: 'unlinkLocal';
  localId: string;
}

/**
 * Decouple a local document from its twin, recording a tombstone so no later
 * sync re-files it (LP-366).  Unlike `unlinkLocal`, which just drops the link,
 * a decouple *remembers*: the last known remote key, the reason, and when it
 * happened.  The remote twin is left alone — decoupling never deletes or closes
 * anything upstream.
 */
export interface RemoteDecoupleOp {
  kind: 'decouple';
  localId: string;
  /** Why the link was dropped: `manual` (a human) or `out_of_scope`. */
  reason: string;
}

/**
 * Re-file a vanished twin upstream (`on_delete: restore`, LP-365).
 *
 * A restore is a push of a document that already has history: the remote issue
 * was deleted, so this re-creates it from local state under a **new** remote id
 * and the link is repointed at that id, the base snapshot rewritten from the
 * response.  It is deliberately not a `create` — a `create` says "this
 * document has no twin", a restore says "the twin is gone and we are filing a
 * replacement", and the report must say so rather than imply a true undelete.
 */
export interface RemoteRestoreOp {
  kind: 'restore';
  /** Placeholder the executor resolves to the new remote id when this lands. */
  placeholder: string;
  localId: string;
  /** The remote id that vanished — carried for the report, not the request. */
  oldRemoteId: string;
  /** The issue's fields in board vocabulary (the translator's input). */
  fields: BoardFields;
  /** The re-filed issue's native parent, when it is in scope; absent = remote root. */
  parent?: RemoteRef;
  /** The re-filed issue's degraded parent (LP-309): carried in the managed block. */
  blockParent?: RemoteRef;
}

/**
 * The push plan.  Mirrors `Change` (`create` / `update` / `delete` there;
 * `create` / `update` / `transition` / `link` / `unlink` / `comment` / `close`
 * / `unlinkLocal` here).  Providers implement the operations; they never see a
 * `LoadedBoard`.
 */
export type RemoteOp =
  | RemoteCreateOp
  | RemoteUpdateOp
  | RemoteTransitionOp
  | RemoteReparentOp
  | RemoteCloseOp
  | RemoteDeleteOp
  | RemoteLinkOp
  | RemoteUnlinkOp
  | RemoteEdgesOp
  | RemoteCommentOp
  | RemoteManagedCommentOp
  | RemoteUnlinkLocalOp
  | RemoteDecoupleOp
  | RemoteRestoreOp;

/**
 * A document a push deliberately left out, with why.  A decoupled document is
 * skipped — never created — and the reason names the tombstone's own reason
 * plus the last known remote key, so the operator can tell "deliberately
 * dropped" from "never pushed".
 */
export interface PushSkip {
  localId: string;
  /** The tombstone's reason: `manual`, `out_of_scope`, or a policy reason. */
  reason: string;
  /** The last known remote key, kept by the tombstone; empty when none. */
  remoteKey: string;
}

/** A push, planned: the operations to run, plus what was deliberately left out. */
export interface PushPlan {
  ops: RemoteOp[];
  skipped: PushSkip[];
}

// ---------------------------------------------------------------------------
// Pull planning
// ---------------------------------------------------------------------------

/**
 * One correspondence effect a pull performs on the link store, *alongside* the
 * `Change[]` that lands on the board.
 *
 * The pull plan is two lists on purpose. `Change` is the board-document
 * protocol (`create` / `update` / `delete`) and it has no word for a link
 * store entry, which is the remote layer's own state — so the correspondence
 * moves are carried here and applied by `applyPull` as the changes land.
 */
export type PullLinkOp =
  /** After a `create` lands, record its twin (real id → remote id). */
  | { kind: 'record'; tempId: string; remoteId: string }
  /** The twin is gone upstream; drop the correspondence for this local id. */
  | { kind: 'unlink'; localId: string }
  /** Drop the link and record a tombstone, so the next push never re-files it. */
  | { kind: 'decouple'; localId: string; reason: string };

/**
 * A pull-side existence decision left for a human (LP-365).  Neither side has
 * moved: `on_delete: manual` leaves a vanished twin unresolved, and a
 * `delete` that would orphan a linked child is refused.  The sync reports each
 * one and exits non-zero; `lpm remote resolve` (LP-287) settles it.
 */
export interface PullConflict {
  localId: string;
  /** The remote id that vanished. */
  remoteId: string;
  /** Why neither side moved — the policy, or the child a delete would orphan. */
  reason: string;
  /** The linked child a delete would have orphaned, when that was the refusal. */
  childId?: string;
}

/**
 * Append one remote comment to a document's `_comments.md` (LP-316).  Carried
 * separately from `Change[]` because a comment is not board state and is
 * written straight through, exactly the way the web app writes one.  `targetId`
 * is the local document — its temporary id when the issue is also new in this
 * pull, its real id otherwise — so `applyPull` resolves it the same way it
 * resolves a `record` link op.
 */
export interface PullCommentOp {
  kind: 'append';
  /** Temp id (new create) or real local id (twin) of the target document. */
  targetId: string;
  /** The remote comment id, recorded so the next pull never appends it twice. */
  remoteId: string;
  /** The remote author's name, written into the `_comments.md` heading. */
  author: string;
  /** The remote timestamp, written into the `_comments.md` heading. */
  at: string;
  /** The comment body text. */
  body: string;
}

/**
 * A field-level conflict on a linked twin still present on both sides (LP-257
 * AC #2).  Both sides edited the same field since the base snapshot, so
 * neither value is derived from the other: the field is left untouched on both
 * sides and reported — a question, not an operation, exactly like an
 * existence conflict.
 */
export interface PullFieldConflict {
  localId: string;
  remoteId: string;
  /** The board field that diverged: `title`, `body`, `status`, `assignee`, `period`, or an attribute name. */
  field: string;
  /** The local (board) value. Body is the raw text. */
  local: unknown;
  /** The remote value, translated back to board vocabulary. Body is the raw text. */
  remote: unknown;
}

/**
 * A reference a managed block carried that the pull could not resolve to a
 * local document (LP-314).  Reported, never silently dropped: a cross-repo
 * reference is out of scope, an unknown token is a human edit or a mangled
 * row.
 */
export interface PullEdgeWarning {
  /** The remote id of the record whose block carried the reference. */
  remoteId: string;
  /** `depends_on` or `relates_to` — the row the reference came from. */
  field: 'depends_on' | 'relates_to';
  /** The raw reference: `owner/repo#12`, a bare local id, or free text. */
  reference: string;
  /** `cross_repo` (out of scope), `unknown` (unresolvable) or `cycle` (refused). */
  kind: 'cross_repo' | 'unknown' | 'cycle';
  /** The cycle the edge would close, named member → member → member (kind: `cycle` only). */
  cycle?: string;
}

/**
 * The edge references a record's managed block carries (LP-314), split by
 * resolvability.  Same-repo references come back as bare remote ids and are
 * resolved through the link store exactly like a native edge; cross-repo and
 * unknown references are reported by the planner rather than resolved.
 */
export interface BlockEdges {
  dependsOn: string[];
  relatesTo: string[];
  /** Cross-repo references (`owner/repo#12`) — out of scope, never resolved. */
  crossRepo: Array<{ field: 'depends_on' | 'relates_to'; reference: string }>;
  /** References that are neither a `#ref` nor a cross-repo reference. */
  unknown: Array<{ field: 'depends_on' | 'relates_to'; reference: string }>;
}

/**
 * A pull, planned: the board-document changes to apply, plus the link-store
 * effects that travel with them.
 *
 * `changes` is a plain `Change[]` from `src/shared/changes.ts`, handed to
 * `applyChanges` from `src/sync` — the one applier every front end shares.  A
 * create carries a temporary id from a fresh counter (never one derived from a
 * view's pending list), and its parent is referenced by the same temporary id
 * when the parent is also new, which is exactly what `applyChanges`'s
 * hold-back-and-replay handles: the reference decides the order, not the plan.
 *
 * `restore` carries the push-side operations for `on_delete: restore` — a pull
 * discovers the deletion, but the remedy is a re-file upstream, so the plan
 * holds `RemoteOp[]` rather than `Change[]`.  `conflicts` carries the documents
 * a policy left for a human.  Both are absent when empty, so an up-to-date pull
 * is still exactly `{ changes: [], links: [] }`.
 */
export interface PullPlan {
  changes: Change[];
  links: PullLinkOp[];
  /** Remote comments to append to `_comments.md`, absent when there are none. */
  comments?: PullCommentOp[];
  restore?: RemoteRestoreOp[];
  conflicts?: PullConflict[];
  /** Field conflicts on twins still present on both sides, absent when empty. */
  fieldConflicts?: PullFieldConflict[];
  /** Edge references a managed block carried that could not be resolved, absent when empty. */
  edgeWarnings?: PullEdgeWarning[];
}

/**
 * The translation seams `planPull` needs, which are pure by construction so the
 * planner stays browser-compatible and free of the disk and the network.
 *
 * `toPatch` turns one remote record into the board fields a `create` writes; it
 * receives the issue's hierarchy depth so the type can be resolved exactly as
 * `mapTypeFromRemote` wants it.  It is a callback rather than a `Translator`
 * plus mapping so the planner never learns a provider's vocabulary.  When it
 * returns no `type`, the create falls back to the deepest declared issue type
 * (LP-315) — a triaged remote issue with no mapped label still becomes a
 * document rather than a failure when it is applied.
 *
 * `parentIdOf` reads the remote id of a record's parent, for providers that
 * hold a native hierarchy.  Omit it for a flat remote (GitHub) and the pull
 * files every issue at the top level.
 *
 * `dependsOnOf` reads the remote ids a record waits on, for providers that
 * hold dependency edges.  Each id is resolved to the local document it names —
 * the dependency's temporary id when it is also new in this pull, its twin
 * otherwise — exactly as `parentIdOf` is.  A dependency naming a remote id
 * with neither a twin nor a pending create is dropped, because there is no
 * local document for the edge to point at.  Omit it for a remote with no
 * edges and every create is filed with no `depends_on`.
 *
 * `relatesToOf` reads the remote ids a record relates to, for providers that
 * hold a native relate edge (LP-325).  Resolved exactly as `dependsOnOf`'s
 * are, and written onto `patch.relatesTo`.
 *
 * `blockEdgesOf` reads the dependency / relate references a record's managed
 * block carries (LP-314), for providers with no native edge.  Same-repo
 * references are returned as bare remote ids and resolved exactly as
 * `dependsOnOf`'s are; cross-repo and unknown references are reported in
 * `PullPlan.edgeWarnings` rather than resolved.  Omit it for a remote that
 * never writes a managed block.
 */
export interface PullOptions {
  toPatch: (record: RemoteRecord, depth: number) => BoardFieldsPatch;
  /**
   * Where a remote issue with no parent of its own lands on the board.
   *
   * A tracker's issues are a flat list; a board's are a tree with rules about
   * what may sit at which level, so an issue pulled in on its own has nowhere
   * to go and the create is refused ("user_story needs a parent issue"). This
   * is the caller's answer to that — `lpm remote pull PAY-31 --parent LP-3` —
   * and it applies only where nothing else does: an issue whose remote parent
   * is already mirrored is filed under that twin, whatever this says.
   */
  underParent?: string;
  parentIdOf?: (record: RemoteRecord) => string | undefined;
  dependsOnOf?: (record: RemoteRecord) => string[];
  relatesToOf?: (record: RemoteRecord) => string[];
  blockEdgesOf?: (record: RemoteRecord) => BlockEdges;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/** The local change a base comparison finds for one issue. */
interface IssueDiff {
  /** Non-status, non-edge fields that changed, holding their full new values. */
  fields: Partial<BoardFields>;
  statusChanged: boolean;
  status: string;
  /** Local ids now depended on that the base did not have. */
  dependsAdded: string[];
  /** Base ids no longer depended on locally. */
  dependsRemoved: string[];
  /** Local ids now related that the base did not have. */
  relatesAdded: string[];
  /** Base ids no longer related locally. */
  relatesRemoved: string[];
}

/** Fields `computeBase` treats as a list, in either of its two spellings. */
const BASE_LIST_KEYS = ['dependsOn', 'depends_on'] as const;
const BASE_RELATES_KEYS = ['relatesTo', 'relates_to'] as const;

/** Read a base's dependency list, whichever spelling it was stored under. */
function baseDepends(base: Record<string, unknown>): string[] {
  for (const key of BASE_LIST_KEYS) {
    const value = base[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === 'string').sort();
    }
  }
  return [];
}

/** Read a base's relates list, whichever spelling it was stored under. */
function baseRelates(base: Record<string, unknown>): string[] {
  for (const key of BASE_RELATES_KEYS) {
    const value = base[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is string => typeof entry === 'string').sort();
    }
  }
  return [];
}

/** The canonical, non-attribute fields a base snapshot may record. */
const BASE_FIELD_KEYS = new Set([
  'title',
  'body',
  'status',
  'assignee',
  'period',
  'dependsOn',
  'depends_on',
  'relatesTo',
  'relates_to',
  'relatedFiles',
  'related_files',
  // Shape fields (LP-368): recorded in the base so a later sync can tell who
  // moved a document. They are never pushed as `update` fields — reparenting
  // is planned by the shared planners, not by the field diff — so `diffIssue`
  // must ignore them rather than treat them as phantom attributes.
  'parent',
  'type',
]);

/**
 * Compare one issue against its base snapshot.
 *
 * With a base, a field is "changed" only when the base records it and the
 * local value differs — a field the base does not record (a mapping change, a
 * new attribute) is not tracked, so it cannot manufacture a phantom conflict.
 * Without a base (a twin recorded but never confirmed), every field visible
 * locally counts as changed, so the first push converges the twin onto the
 * board's current state.
 */
function diffIssue(
  issue: IssueDto,
  base: Record<string, unknown> | undefined,
  normalizeBody?: (markdown: string) => string,
): IssueDiff {
  if (base === undefined) {
    // No base: push the whole document so the twin converges.
    const fields: Partial<BoardFields> = {
      title: issue.title,
      body: issue.body,
      assignee: issue.assignee ?? null,
      period: issue.period ?? null,
    };
    const attributes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(issue.attributes)) {
      if (value !== null && value !== undefined) attributes[key] = value;
    }
    if (Object.keys(attributes).length > 0) fields.attributes = attributes;
    return {
      fields,
      statusChanged: true,
      status: issue.status,
      dependsAdded: [...issue.dependsOn],
      dependsRemoved: [],
      relatesAdded: [...issue.relatesTo],
      relatesRemoved: [],
    };
  }

  const fields: Partial<BoardFields> = {};

  if ('title' in base && issue.title !== base.title) fields.title = issue.title;

  // The base stores the body as a hash (`hashBody`), so a local edit is a hash
  // mismatch, never a text comparison.
  if ('body' in base && hashBody(issue.body, normalizeBody) !== base.body) fields.body = issue.body;

  if ('assignee' in base && (issue.assignee ?? null) !== base.assignee) {
    fields.assignee = issue.assignee ?? null;
  }

  if ('period' in base && (issue.period ?? null) !== base.period) {
    fields.period = issue.period ?? null;
  }

  // Attributes are the base keys that are not canonical fields — only those
  // are mapped, so only those are compared.  The comparison is canonical
  // (`valuesEqual`), not reference equality: an `array` attribute reloaded
  // from YAML is a fresh array each time, and `!==` would re-push it forever.
  const attributes: Record<string, unknown> = {};
  for (const [key, stored] of Object.entries(base)) {
    if (BASE_FIELD_KEYS.has(key)) continue;
    const local = issue.attributes[key] ?? null;
    if (!valuesEqual(local, stored)) attributes[key] = local;
  }
  if (Object.keys(attributes).length > 0) fields.attributes = attributes;

  const statusChanged = 'status' in base && issue.status !== base.status;

  const localDepends = [...issue.dependsOn].sort();
  const remoteDepends = baseDepends(base);
  const dependsAdded = localDepends.filter((id) => !remoteDepends.includes(id));
  const dependsRemoved = remoteDepends.filter((id) => !localDepends.includes(id));

  const localRelates = [...issue.relatesTo].sort();
  const remoteRelates = baseRelates(base);
  const relatesAdded = localRelates.filter((id) => !remoteRelates.includes(id));
  const relatesRemoved = remoteRelates.filter((id) => !localRelates.includes(id));

  return {
    fields,
    statusChanged,
    status: issue.status,
    dependsAdded,
    dependsRemoved,
    relatesAdded,
    relatesRemoved,
  };
}

/** The issue fields a create carries, in board vocabulary. */
function boardFields(issue: IssueDto): BoardFields {
  return {
    title: issue.title,
    body: issue.body,
    type: issue.type,
    status: issue.status,
    assignee: issue.assignee,
    period: issue.period,
    attributes: issue.attributes,
  };
}

/** The number of ancestors above an issue — the depth creates are ordered by. */
function issueDepth(board: BoardView, issue: IssueDto): number {
  let depth = 0;
  const seen = new Set<string>();
  let parent = issue.parentId;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    depth += 1;
    parent = board.nodes[parent]?.parentId ?? null;
  }
  return depth;
}

/**
 * The parent reference a create / restore writes, split by the hierarchy
 * encoding (LP-309): native `parent` while the document sits within the
 * remote's native depth, `blockParent` beyond it.  With no resolved encoding
 * the parent stays native, the pre-encoding behaviour.
 */
function parentRefFor(
  remote: RemoteSnapshot,
  depth: number,
  parent: RemoteRef | undefined,
): { parent?: RemoteRef; blockParent?: RemoteRef } {
  if (parent === undefined) return {};
  const resolved = remote.hierarchy;
  if (resolved === undefined) return { parent };
  return parentIsNative(depth, resolved) ? { parent } : { blockParent: parent };
}

/**
 * The comment a policy close posts on the twin before closing it (LP-351): who
 * closed it, why, and the local document that went away.  Written for the
 * person reading the remote tracker, who may never have seen the `.lpm` folder.
 */
function pushDeleteNote(localId: string, remoteKey: string, deleted: boolean): string {
  const key = remoteKey !== '' ? ` (${remoteKey})` : '';
  const why = deleted
    ? `the local document ${localId} that tracked it was deleted`
    : `the local document ${localId} that tracked it moved out of this remote's scope`;
  return `Closed by light-plan: ${why}${key}. See the board's \`on_delete\` policy.`;
}

/**
 * Plan a push: the remote operations needed to bring the remote's in-scope
 * issues onto the board's current state, ordered so every reference resolves.
 *
 * Returns an empty `{ ops: [], skipped: [] }` when nothing changed, when the
 * remote is pull-only, or when the scope holds no documents.  The order inside
 * a non-empty plan is:
 *
 *   1. `create` ops, parents before children (by depth);
 *   2. `update` / `transition` / `close` ops for changed twins;
 *   3. `link` / `unlink` ops, after every endpoint exists;
 *   4. the `on_delete` resolution for linked twins whose local document went
 *      away (deleted, or left the scope subtree): `unlink` / `close` / `delete`.
 *
 * In-scope documents carrying a tombstone are never created; they are
 * reported in `skipped` rather than silently omitted (LP-366).
 *
 * A `create` carries no remote id: it is referenced by a `new:` placeholder,
 * which the executor resolves against each create's response before it reaches
 * any op that points at it.
 */
export function planPush(
  board: BoardView,
  links: LinkStore,
  remote: RemoteSnapshot,
  localComments?: ReadonlyMap<string, readonly LocalComment[]>,
): PushPlan {
  if (remote.direction === 'pull') return { ops: [], skipped: [] };


  const issues = Object.values(board.nodes)
    .filter((node): node is IssueDto => node.kind === 'issue')
    .sort((a, b) => a.id.localeCompare(b.id));

  const scope = remote.scope ? new Set(subtreeIds(board, remote.scope)) : null;
  const inScope = (id: string): boolean => scope === null || scope.has(id);
  // What this run is about, which is not the same question as what the remote
  // owns — see `only` on RemoteSnapshot. Everything that *writes* asks
  // `acting`; the gone pass and `refOf` ask `inScope`.
  const only = remote.only ?? null;
  const acting = (id: string): boolean => inScope(id) && (only === null || only.has(id));
  const ownedElsewhere = remote.ownedElsewhere ?? null;

  // -- skipped: in-scope documents deliberately decoupled -------------------
  // A tombstoned document is never created, and it is reported rather than
  // silently omitted (LP-366).  Its base snapshot is already gone — the link
  // was dropped when the tombstone was written.
  const skipped: PushSkip[] = [];

  // -- creates: in-scope documents with no twin, parents before children ----
  const toCreate = issues.filter((issue) => {
    if (!acting(issue.id)) return false;
    if (links.links.has(issue.id)) return false;
    const claimed = ownedElsewhere?.get(issue.id);
    if (claimed !== undefined) {
      // One document, one remote. Reported rather than refused: a whole-board
      // push to a second tracker is a normal thing to run on a board whose
      // remotes divide the work between them.
      skipped.push({ localId: issue.id, reason: 'owned_elsewhere', remoteKey: claimed });
      return false;
    }
    const tombstone = getTombstone(links, issue.id);
    if (tombstone !== undefined) {
      skipped.push({
        localId: issue.id,
        reason: tombstone.reason || 'manual',
        remoteKey: tombstone.remoteKey || '',
      });
      return false;
    }
    return true;
  });
  toCreate.sort(
    (a, b) => issueDepth(board, a) - issueDepth(board, b) || a.id.localeCompare(b.id),
  );

  const placeholderOf = new Map<string, string>();
  toCreate.forEach((issue, index) => placeholderOf.set(issue.id, tempId(index + 1)));

  /** The remote reference for a local id, when it is a resolvable endpoint. */
  const refOf = (id: string): RemoteRef | undefined => {
    const placeholder = placeholderOf.get(id);
    if (placeholder !== undefined) return { kind: 'created', localId: id, placeholder };
    const link = links.links.get(id);
    if (link && inScope(id)) return { kind: 'linked', localId: id, remoteId: link.remoteId };
    return undefined;
  };

  const ops: RemoteOp[] = [];

  for (const issue of toCreate) {
    const parent = issue.parentId ? refOf(issue.parentId) : undefined;
    ops.push({
      kind: 'create',
      placeholder: placeholderOf.get(issue.id)!,
      localId: issue.id,
      fields: boardFields(issue),
      ...parentRefFor(remote, issueDepth(board, issue), parent),
    });
  }

  // The diff for every in-scope twin, computed once; absent for a create.
  const diffOf = new Map<string, IssueDiff>();
  for (const issue of issues) {
    if (!inScope(issue.id)) continue;
    const link = links.links.get(issue.id);
    if (link) diffOf.set(issue.id, diffIssue(issue, link.base, remote.normalizeBody));
  }

  // -- updates / transitions / closes for changed twins ---------------------
  for (const issue of issues) {
    if (!acting(issue.id)) continue;
    const link = links.links.get(issue.id);
    if (!link) continue; // already planned as a create

    const diff = diffOf.get(issue.id)!;
    const ref: LinkedRef = { kind: 'linked', localId: issue.id, remoteId: link.remoteId };
    const parent = issue.parentId ? refOf(issue.parentId) : undefined;
    const { blockParent } = parentRefFor(remote, issueDepth(board, issue), parent);

    if (Object.keys(diff.fields).length > 0) {
      ops.push({
        kind: 'update',
        localId: issue.id,
        ref,
        fields: diff.fields,
        ...(blockParent !== undefined ? { blockParent } : {}),
      });
    }
    if (diff.statusChanged) {
      const terminal =
        board.config.statuses.find((status) => status.id === diff.status)?.terminal === true;
      if (terminal) {
        ops.push({ kind: 'close', localId: issue.id, ref });
      } else {
        ops.push({ kind: 'transition', localId: issue.id, ref, status: diff.status });
      }
    }
  }

  // -- reparent: linked twins whose parent moved, switched carrier, or has
  //    only now arrived upstream -------------------------------------------
  // A local reparent (LP-493 gap 2) is detected against the base snapshot's
  // recorded `parent`; a hierarchy-encoding switch (gap 1) against the
  // encoding the link store last recorded. Both emit a `reparent` op that
  // re-writes the twin's parent on whichever carrier the *current* encoding
  // uses — in place, never a re-file. A twin with no parent in either the
  // base or the board is left alone, whatever the encoding.
  //
  // The third case is what makes a plan pushable a piece at a time. A story
  // filed before its feature had a twin was filed at the remote's root, and
  // neither of the first two cases ever fires for it: the local parent never
  // moved and the encoding never changed, so pushing the feature afterwards
  // left the story dangling. `parentRemoteId` on the link is the record of
  // what was actually filed, so "the board says it has a parent, the parent
  // now has a twin, and that is not the twin we filed it under" is a question
  // that can be asked at all. An older link that never recorded one answers
  // `undefined` — unknown, and unknown changes nothing.
  const recordedHierarchy = links.hierarchy;
  for (const issue of issues) {
    if (!acting(issue.id)) continue;
    const link = links.links.get(issue.id);
    if (!link) continue; // planned as a create, whose parent is already placed

    const depth = issueDepth(board, issue);
    const carrierSwitched = carrierChanged(recordedHierarchy, remote.hierarchy, depth);
    const baseRecordsParent = link.base !== undefined && 'parent' in link.base;
    const parentChanged =
      baseRecordsParent &&
      (issue.parentId ?? null) !== ((link.base as Record<string, unknown>)['parent'] ?? null);

    // The twin's filed parent, against the parent it should have now. Only a
    // link that recorded what it filed takes part; `undefined` is "we do not
    // know", never "none".
    const filedParent = link.parentRemoteId;
    const wantedRef = issue.parentId ? refOf(issue.parentId) : undefined;
    const parentArrived =
      filedParent !== undefined &&
      wantedRef !== undefined &&
      // A parent this same push is creating has no remote id to compare yet,
      // so the question is whether this twin was filed at the root — which is
      // exactly the case pushing the parent is meant to repair, and it is
      // repaired in the same run rather than on the one after.
      (wantedRef.kind === 'created' ? filedParent === null : filedParent !== wantedRef.remoteId);

    if (!carrierSwitched && !parentChanged && !parentArrived) continue;

    const parent = issue.parentId ? refOf(issue.parentId) : undefined;
    ops.push({
      kind: 'reparent',
      localId: issue.id,
      ref: { kind: 'linked', localId: issue.id, remoteId: link.remoteId },
      ...parentRefFor(remote, depth, parent),
    });
  }

  // -- edges, after every endpoint exists -----------------------------------
  // A provider with a native blocking edge links/unlinks it directly; one
  // without carries `depends_on` in the managed block. `relates_to` is native
  // only where the provider declares it (Jira, LP-325); otherwise it rides the
  // block (LP-314). The block is authoritative: its op carries the complete
  // current set, and the executor omits any reference it cannot resolve
  // (AC #2).
  const nativeDepends = remote.edges?.dependsOn ?? true;
  const nativeRelates = remote.edges?.relatesTo ?? false;

  const sameIds = (a: readonly string[], b: readonly string[]): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
    return true;
  };

  for (const issue of issues) {
    if (!acting(issue.id)) continue;
    const diff = diffOf.get(issue.id) ?? null;

    // Native link/unlink, for each edge kind the remote holds natively
    // (`depends_on` LP-314, `relates_to` LP-325). A create has no base, so
    // every in-scope edge is a new link; a removal references a twin that
    // must still be linked.
    const nativeKinds: Array<{ linkKind: LinkKind; added: string[]; removed: string[] }> = [];
    if (nativeDepends) {
      nativeKinds.push({
        linkKind: 'depends',
        added: diff ? diff.dependsAdded : issue.dependsOn,
        removed: diff ? diff.dependsRemoved : [],
      });
    }
    if (nativeRelates) {
      nativeKinds.push({
        linkKind: 'relates',
        added: diff ? diff.relatesAdded : issue.relatesTo,
        removed: diff ? diff.relatesRemoved : [],
      });
    }

    for (const { linkKind, added, removed } of nativeKinds) {
      for (const target of removed) {
        const targetRef = refOf(target);
        if (!targetRef || targetRef.kind !== 'linked') continue;
        ops.push({
          kind: 'unlink',
          dependent: { kind: 'linked', localId: issue.id, remoteId: links.links.get(issue.id)!.remoteId },
          dependency: targetRef,
          linkKind,
        });
      }

      const dependentRef = refOf(issue.id);
      if (dependentRef) {
        for (const target of added) {
          const targetRef = refOf(target);
          if (!targetRef) continue;
          ops.push({ kind: 'link', dependent: dependentRef, dependency: targetRef, linkKind });
        }
      }
    }

    // The managed block (LP-314): rewrite the complete edge set when the
    // resolvable set changed.  An out-of-scope dependency is not resolvable
    // and never enters the block, exactly as it never enters a native link.
    const currentDepends = nativeDepends
      ? []
      : [...issue.dependsOn].filter((id) => refOf(id) !== undefined).sort();
    const currentRelates = nativeRelates
      ? []
      : [...issue.relatesTo].filter((id) => refOf(id) !== undefined).sort();
    const base = links.links.get(issue.id)?.base;
    const recordedDepends = nativeDepends ? [] : baseDepends(base ?? {});
    const recordedRelates = nativeRelates ? [] : baseRelates(base ?? {});

    if (sameIds(currentDepends, recordedDepends) && sameIds(currentRelates, recordedRelates)) {
      continue;
    }

    const dependentRef = refOf(issue.id);
    if (!dependentRef) continue;

    const parent = issue.parentId ? refOf(issue.parentId) : undefined;
    const { blockParent } = parentRefFor(remote, issueDepth(board, issue), parent);

    ops.push({
      kind: 'edges',
      localId: issue.id,
      ref: dependentRef,
      ...(blockParent !== undefined ? { parent: blockParent } : {}),
      dependsOn: currentDepends
        .map((id) => refOf(id))
        .filter((r): r is RemoteRef => r !== undefined),
      relatesTo: currentRelates
        .map((id) => refOf(id))
        .filter((r): r is RemoteRef => r !== undefined),
    });
  }

  // -- gone documents: deleted locally, or left the scope subtree -----------
  // A linked twin whose local document no longer exists (removed with `lpm rm`)
  // or that moved out of `scope:` no longer qualifies for a twin.  What happens
  // to the remote side is the remote's `on_delete` policy (LP-351):
  //
  //   - `unlink` (the default) leaves the twin alone and drops the link — a
  //     tombstone for a document that still exists (out of scope), a plain
  //     local unlink for one that is gone;
  //   - `close` closes the twin and posts a comment saying why;
  //   - `delete` deletes the twin (the connector degrades where the platform
  //     cannot hard-delete), with confirmation every run from the consent gate.
  //
  // `restore` and `manual` are pull-side answers to the *remote* going away and
  // have no push meaning, so they fall back to `unlink` — a value meant for the
  // opposite direction can never delete or close upstream by surprise.
  const onDelete = remote.onDelete ?? 'unlink';

  const goneLocalIds: Array<{ id: string; deleted: boolean }> = [];
  for (const [id] of links.links) {
    if (board.nodes[id] === undefined) goneLocalIds.push({ id, deleted: true });
  }
  for (const issue of issues) {
    if (inScope(issue.id)) continue;
    if (links.links.has(issue.id)) goneLocalIds.push({ id: issue.id, deleted: false });
  }
  goneLocalIds.sort((a, b) => a.id.localeCompare(b.id));

  for (const { id, deleted } of goneLocalIds) {
    const link = links.links.get(id);
    if (link === undefined) continue;
    const ref: LinkedRef = { kind: 'linked', localId: id, remoteId: link.remoteId };
    if (onDelete === 'close') {
      ops.push({
        kind: 'close',
        localId: id,
        ref,
        note: pushDeleteNote(id, link.remoteKey, deleted),
      });
    } else if (onDelete === 'delete') {
      ops.push({ kind: 'delete', localId: id, ref });
    } else if (deleted) {
      // `unlink` (and the pull-only restore / manual): drop the dangling link.
      ops.push({ kind: 'unlinkLocal', localId: id });
    } else {
      ops.push({ kind: 'decouple', localId: id, reason: 'out_of_scope' });
    }
  }

  // -- user comments, after every twin exists (LP-316) ----------------------
  // Post the unsynced work-log entries.  A comment references its endpoint the
  // same way an edge does — a `created` placeholder for a document this same
  // push files, a `linked` twin otherwise — so a comment on a brand-new issue
  // is posted once its create lands.  `planCommentPush` drops any entry whose
  // index is already recorded (never posted twice) and any body that is a
  // managed block (never re-posted as a user comment).
  if (localComments) {
    for (const issue of issues) {
      if (!acting(issue.id)) continue;
      const ref = refOf(issue.id);
      if (ref === undefined) continue; // decoupled, or outside the scope subtree
      const local = localComments.get(issue.id);
      if (!local || local.length === 0) continue;
      for (const item of planCommentPush(local, getSyncedCommentIndexes(links, issue.id))) {
        ops.push({
          kind: 'comment',
          ref,
          index: item.index,
          author: item.author,
          body: renderCommentForRemote(item.author, item.body),
        });
      }
    }
  }

  return { ops, skipped };
}

// ---------------------------------------------------------------------------
// Pull planning
// ---------------------------------------------------------------------------

/**
 * The linked descendant of `localId` whose twin would survive a delete of
 * `localId`'s subtree — the child a `delete` must refuse to orphan.  A child
 * that is itself being deleted (its twin vanished too, and the policy is
 * `delete`) is not orphaned, so it is skipped.  Returns undefined when the
 * delete would orphan nothing.
 */
function orphanedLinkedChild(
  board: BoardView,
  links: LinkStore,
  localId: string,
  deleting: ReadonlySet<string>,
): string | undefined {
  const descendants = subtreeIds(board, localId).slice(1);
  for (const id of descendants) {
    if (deleting.has(id)) continue;
    if (links.links.has(id)) return id;
  }
  return undefined;
}

/**
 * The field-diff half of a pull for one linked twin that is still present
 * upstream (LP-257 AC #2, built on LP-284).
 *
 * Returns the `update` patch carrying the fields the remote alone changed, and
 * the conflicts for fields both sides changed.  Fields the board alone changed
 * are deliberately absent — they are `planPush`'s to carry upstream, never
 * pulled here.  A field the base snapshot does not record is skipped, exactly
 * as `diffIssue` skips it on the push side, so a mapping change cannot
 * manufacture a phantom conflict.
 *
 * With no base at all (a twin recorded but never confirmed) every field the
 * remote carries is merged against `NO_BASE`: agreement is `none`, a
 * difference is a conflict — the only honest answer short of clobbering one
 * side.
 */
function pullFieldDiff(
  localId: string,
  remoteId: string,
  doc: IssueDto,
  base: Record<string, unknown> | undefined,
  patch: BoardFieldsPatch,
  normalizeBody?: (markdown: string) => string,
): { update: NodePatch; conflicts: PullFieldConflict[] } {
  const update: NodePatch = {};
  const conflicts: PullFieldConflict[] = [];

  /** The base value for a field: `NO_BASE` when there is no snapshot, otherwise the stored value. */
  const baseOf = (field: string): unknown => (base === undefined ? NO_BASE : base[field]);

  const merge = (
    field: string,
    local: unknown,
    remote: unknown,
    carries: boolean,
    apply: (value: unknown) => void,
  ): void => {
    if (!carries) return;
    const baseValue = baseOf(field);
    if (baseValue === undefined) return; // base exists but records no such field
    const outcome = mergeValues(local, remote, baseValue);
    if (outcome === 'pull') apply(remote);
    else if (outcome === 'conflict') conflicts.push({ localId, remoteId, field, local, remote });
  };

  merge('title', doc.title, patch.title, patch.title !== undefined, (value) => {
    update.title = value as string;
  });

  // The base stores the body as a hash; both sides are hashed so the four-case
  // table compares hash to hash, never raw text.  The conflict carries the raw
  // text so a renderer can show what each side wrote.
  if (patch.body !== undefined) {
    const baseValue = baseOf('body');
    if (baseValue !== undefined) {
      const outcome = mergeValues(hashBody(doc.body, normalizeBody), hashBody(patch.body), baseValue);
      if (outcome === 'pull') update.body = patch.body;
      else if (outcome === 'conflict') {
        conflicts.push({ localId, remoteId, field: 'body', local: doc.body, remote: patch.body });
      }
    }
  }

  merge('status', doc.status, patch.status, patch.status !== undefined, (value) => {
    update.status = value as string;
  });
  merge(
    'assignee',
    doc.assignee ?? null,
    patch.assignee ?? null,
    patch.assignee !== undefined,
    (value) => {
      update.assignee = value as string | null;
    },
  );
  merge('period', doc.period ?? null, patch.period ?? null, patch.period !== undefined, (value) => {
    update.period = value as string | null;
  });

  // Attributes: every name the base records, plus any the remote carries, each
  // merged on its own so one attribute's conflict never holds a sibling back.
  const attrNames = new Set<string>();
  for (const key of Object.keys(base ?? {})) {
    if (!BASE_FIELD_KEYS.has(key)) attrNames.add(key);
  }
  const attrPatch = patch.attributes;
  if (attrPatch !== undefined) {
    for (const key of Object.keys(attrPatch)) attrNames.add(key);
  }
  for (const name of [...attrNames].sort()) {
    const carries = attrPatch !== undefined && name in attrPatch;
    merge(
      name,
      doc.attributes[name] ?? null,
      carries ? (attrPatch as Record<string, unknown>)[name] : null,
      carries,
      (value) => {
        update.attributes = { ...update.attributes, [name]: value };
      },
    );
  }

  return { update, conflicts };
}

/** True when two sorted id lists hold the same members in the same order. */
function listEquals(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The path `start` → … → `target` following `depends_on` edges in `graph`, or
 * null when `target` is unreachable. Used to refuse a pulled edge that would
 * close a cycle: adding `from` depends_on `to` closes a loop exactly when `to`
 * already reaches `from`.
 */
function pathFrom(
  graph: Map<string, readonly string[]>,
  start: string,
  target: string,
): string[] | null {
  const previous = new Map<string, string>();
  const queue = [start];
  const seen = new Set([start]);
  while (queue.length > 0) {
    const node = queue.shift()!;
    for (const next of graph.get(node) ?? []) {
      if (next === target) {
        const path = [next];
        let cursor = node;
        while (cursor !== start) {
          path.unshift(cursor);
          cursor = previous.get(cursor)!;
        }
        path.unshift(start);
        return path;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, node);
      queue.push(next);
    }
  }
  return null;
}

/**
 * Plan a pull: the `Change[]` needed to bring the board's in-scope issues into
 * agreement with the remote listing, plus the link-store effects that travel
 * with it.
 *
 * The pull is an *existence* reconciliation, plus a field diff.  A remote
 * issue with no twin is planned as a `create` — carrying its hierarchy parent
 * and its dependency edges, both referenced by temporary ids when the other
 * endpoint is also new in this pull, so the existing hold-back-and-replay
 * wires them.  A linked twin absent from the listing is resolved by the
 * remote's `on_delete` policy (`unlink`, `close`, `delete`, `restore` or
 * `manual`), one document at a time (LP-365).  A linked twin still present on
 * both sides is merged field by field against its base snapshot (LP-284): a
 * field the remote alone changed becomes an `update` pulling the remote value
 * onto the board, a field both sides changed is reported in `fieldConflicts`
 * and left untouched on both sides (LP-257 AC #2), and a field the board alone
 * changed is left for the push planner to carry upstream.
 *
 * The plan is applied by `applyChanges` from `src/sync` — the same applier the
 * web app and the CLI push a view through — so the pull inherits partial
 * application, temporary-id remapping and the hold-back-and-replay of a create
 * whose parent is created later in the same push.  (Naming note: `PushSession`
 * inside `src/sync` is named for pushing a *view* onto the board, which is the
 * same direction a remote **pull** moves — remote → board.)
 *
 * Returns an empty plan for a `direction: push` remote (it never pulls), for a
 * scope that names no documents, and when the listing agrees with the link
 * store.  Pure: no disk, no network.
 */
export function planPull(
  board: BoardView,
  links: LinkStore,
  remote: RemoteSnapshot,
  options: PullOptions,
): PullPlan {
  if (remote.direction === 'push') return { changes: [], links: [] };
  // An unreachable remote plans nothing: the twin may be deleted or merely
  // hidden by a credential that lost scope, and guessing writes a deletion
  // (LP-364). The caller reports the reason and distinguishes the exit code.
  if (remote.unreachable === true) return { changes: [], links: [] };

  const onDelete = remote.onDelete ?? 'unlink';
  const scopeSet = remote.scope ? new Set(subtreeIds(board, remote.scope)) : null;
  const parentOf = options.parentIdOf;
  const dependsOnOf = options.dependsOnOf;
  const relatesToOf = options.relatesToOf;
  const blockEdgesOf = options.blockEdgesOf;
  /** Edge references a managed block carried that could not be resolved (LP-314). */
  const edgeWarnings: PullEdgeWarning[] = [];

  // The local id that anchors a remote issue in the local tree: its own twin
  // when it has one, otherwise the anchor of its remote parent.  A remote with
  // no scope pulls everything; a scoped remote pulls only issues whose anchor
  // sits under the scope root.  The walk is `anchor.ts` because the drift
  // report asks the same question of the same listing — "where would this land?"
  // — and a report that answered it differently would offer work this planner
  // then declined to adopt.
  const anchorOf = anchorResolver(links, remote.issues, parentOf);

  const inScope = (remoteId: string): boolean => {
    if (scopeSet === null) return true;
    const anchored = anchorOf(remoteId);
    return anchored !== undefined && scopeSet.has(anchored);
  };

  // -- creates: remote issues with no twin ----------------------------------
  const newIssues = [...remote.issues.entries()]
    .filter(([remoteId]) => !links.byRemote.has(remoteId) && inScope(remoteId))
    .sort(([a], [b]) => a.localeCompare(b));

  // Temporary ids from a fresh counter, one per new remote issue, so a
  // reference to one (a child's parent, a later edge) names the same temp id
  // the create carries.  Never derived from a view's pending list.
  const nextTemp = counterFactory();
  const tempIdOf = new Map<string, string>();
  for (const [remoteId] of newIssues) tempIdOf.set(remoteId, nextTemp());

  /** The hierarchy depth of a new issue, from its remote parent chain. */
  const depthMemo = new Map<string, number>();
  const underParent = options.underParent;
  /** The depth `underParent` puts an otherwise parentless issue at. */
  const adoptedDepth = underParent ? (board.nodes[underParent]?.depth ?? 0) + 1 : 0;
  const depthOf = (remoteId: string, record: RemoteRecord): number => {
    if (depthMemo.has(remoteId)) return depthMemo.get(remoteId)!;
    depthMemo.set(remoteId, 0); // cycle guard
    const parentRemote = parentOf ? parentOf(record) : undefined;
    if (!parentRemote) return adoptedDepth;
    const linked = links.byRemote.get(parentRemote);
    if (linked !== undefined) {
      const depth = (board.nodes[linked]?.depth ?? 0) + 1;
      depthMemo.set(remoteId, depth);
      return depth;
    }
    const parentRecord = remote.issues.get(parentRemote);
    if (!parentRecord) return adoptedDepth;
    const depth = depthOf(parentRemote, parentRecord) + 1;
    depthMemo.set(remoteId, depth);
    return depth;
  };

  /** The `parentId` a create writes: the parent's temp id, or its twin. */
  const parentRefOf = (record: RemoteRecord): string | null => {
    const parentRemote = parentOf ? parentOf(record) : undefined;
    if (!parentRemote) return underParent ?? null;
    const temp = tempIdOf.get(parentRemote);
    if (temp !== undefined) return temp;
    return links.byRemote.get(parentRemote) ?? underParent ?? null;
  };

  /** The `dependsOn` ids a create writes, each resolved to its local document. */
  const dependsRefsOf = (record: RemoteRecord): string[] => {
    if (!dependsOnOf) return [];
    const refs: string[] = [];
    for (const remoteId of dependsOnOf(record)) {
      const temp = tempIdOf.get(remoteId);
      if (temp !== undefined) refs.push(temp);
      else {
        const linked = links.byRemote.get(remoteId);
        if (linked !== undefined) refs.push(linked);
      }
    }
    return refs;
  };

  /**
   * Resolve a list of same-repo remote ids to local ids: the dependency's
   * temporary id when it is also new in this pull, its twin otherwise.
   * A remote id with neither is dropped — there is no local document for the
   * edge to point at.
   */
  const resolveRemoteIds = (remoteIds: readonly string[]): string[] => {
    const refs: string[] = [];
    for (const remoteId of remoteIds) {
      const temp = tempIdOf.get(remoteId);
      if (temp !== undefined) refs.push(temp);
      else {
        const linked = links.byRemote.get(remoteId);
        if (linked !== undefined) refs.push(linked);
      }
    }
    return refs;
  };

  /** The `relatesTo` ids a create writes, resolved exactly like `dependsRefsOf`. */
  const relatesRefsOf = (record: RemoteRecord): string[] => {
    if (!relatesToOf) return [];
    return resolveRemoteIds(relatesToOf(record));
  };

  /** Temp id → the remote id that created it, for naming a cycle legibly. */
  const tempRemoteOf = new Map<string, string>();
  for (const [remoteId, temp] of tempIdOf) tempRemoteOf.set(temp, remoteId);

  /** A local id named as the remote id it came from, or itself when it has none. */
  const labelOf = (id: string): string =>
    tempRemoteOf.get(id) ?? links.links.get(id)?.remoteId ?? id;

  // The prospective dependency graph: the board's existing edges plus every
  // edge the pull decides to write. A pulled dependency that would close a
  // cycle is refused here and named, rather than handed to `applyChanges` —
  // which would reject the whole change, not the one edge (LP-325 AC #5).
  const prospective = new Map<string, string[]>();
  for (const node of Object.values(board.nodes)) {
    if (node.kind === 'issue' || node.kind === 'template') {
      prospective.set(node.id, [...node.dependsOn]);
    }
  }

  /** The cycle adding `from` depends_on `to` would close, or null when safe.
   *  Returned as a closed loop (`[from, …, from]`), ready to join for naming. */
  const cycleIfLinked = (from: string, to: string): string[] | null => {
    if (from === to) return [from, from];
    const path = pathFrom(prospective, to, from);
    return path === null ? null : [from, ...path];
  };

  const changes: Change[] = [];
  const linkOps: PullLinkOp[] = [];

  // The type a create falls back to when nothing on the remote says otherwise
  // (LP-315): the deepest declared issue type — `hierarchy.flat().at(-1)`, the
  // same "deepest declared level" the period mapping uses for its container.
  // A triaged GitHub issue with no mapped label still lands as the board's most
  // specific type, never a document with no type (which `applyChanges` refuses).
  const deepestType = (board.config.hierarchy.issue ?? []).flat().at(-1);

  for (const [remoteId, record] of newIssues) {
    const temp = tempIdOf.get(remoteId)!;
    const fields = options.toPatch(record, depthOf(remoteId, record));

    const patch: NodePatch = {};
    if (fields.type !== undefined) patch.type = fields.type;
    else if (deepestType !== undefined) patch.type = deepestType;
    if (fields.title !== undefined) patch.title = fields.title;
    if (fields.body !== undefined) patch.body = fields.body;
    if (fields.status !== undefined) patch.status = fields.status;
    if (fields.assignee !== undefined) patch.assignee = fields.assignee;
    if (fields.period !== undefined) patch.period = fields.period;
    if (fields.attributes !== undefined) patch.attributes = fields.attributes;
    const parentRef = parentRefOf(record);
    if (parentRef !== null) patch.parentId = parentRef;
    const dependsRefs = dependsRefsOf(record);
    const relatesRefs = relatesRefsOf(record);

    // Managed-block edges (LP-314): a provider with no native edge reads the
    // `depends_on` / `relates_to` rows back out of the block.  Same-repo
    // references resolve through the link store (or the pending-create map)
    // exactly like a native edge; cross-repo and unknown references are
    // reported in `edgeWarnings`, never resolved.
    const blockEdges = blockEdgesOf ? blockEdgesOf(record) : undefined;
    if (blockEdges !== undefined) {
      dependsRefs.push(...resolveRemoteIds(blockEdges.dependsOn));
      relatesRefs.push(...resolveRemoteIds(blockEdges.relatesTo));
      for (const warning of blockEdges.crossRepo) {
        edgeWarnings.push({ remoteId, ...warning, kind: 'cross_repo' });
      }
      for (const warning of blockEdges.unknown) {
        edgeWarnings.push({ remoteId, ...warning, kind: 'unknown' });
      }
    }

    // A pulled dependency that would close a cycle is refused and the cycle
    // named, the rest of the pull continuing (LP-325 AC #5).  Only the gating
    // `depends_on` edge is checked — a loop of `relates_to` is not a stall.
    const safeDepends: string[] = [];
    for (const dependency of [...new Set(dependsRefs)].sort()) {
      const cycle = cycleIfLinked(temp, dependency);
      if (cycle !== null) {
        edgeWarnings.push({
          remoteId,
          field: 'depends_on',
          reference: labelOf(dependency),
          kind: 'cycle',
          cycle: cycle.map(labelOf).join(' -> '),
        });
        continue;
      }
      safeDepends.push(dependency);
    }
    if (safeDepends.length > 0) patch.dependsOn = safeDepends;
    if (relatesRefs.length > 0) patch.relatesTo = [...new Set(relatesRefs)].sort();
    // Record the create's edges so a later edge is checked against them.
    prospective.set(temp, safeDepends);

    changes.push({ kind: 'create', id: temp, nodeKind: 'issue', patch });
    linkOps.push({ kind: 'record', tempId: temp, remoteId });
  }

  // -- gone twins: linked, in scope, and absent from the listing -------------
  // A partial listing proves nothing about absence — see `partial` on the
  // snapshot — so a targeted pull reconciles no existence at all.
  const goneTwins =
    remote.partial === true
      ? []
      : [...links.links.entries()]
          .filter(
            ([localId, entry]) =>
              (scopeSet === null || scopeSet.has(localId)) && !remote.issues.has(entry.remoteId),
          )
          .map(([localId]) => localId)
          .sort();

  const restore: RemoteRestoreOp[] = [];
  const conflicts: PullConflict[] = [];

  // `delete` removes the document *and its subtree* — the ordinary `remove`
  // operation — so a linked descendant whose twin still exists would be
  // deleted locally while its twin survives, an orphan the board would only
  // notice on the next pull.  Refuse the delete and name the child; the
  // document is left for a human rather than silently reshaped (LP-365).
  const deleting = onDelete === 'delete' ? new Set(goneTwins) : new Set<string>();
  const refused = new Set<string>();
  if (onDelete === 'delete') {
    for (const localId of goneTwins) {
      const child = orphanedLinkedChild(board, links, localId, deleting);
      if (child !== undefined) {
        refused.add(localId);
        conflicts.push({
          localId,
          remoteId: links.links.get(localId)!.remoteId,
          reason: `delete refused — would orphan linked child ${child}`,
          childId: child,
        });
      }
    }
  }

  // `restore` re-files the vanished twin upstream: a re-create with no remote
  // id, referenced by a placeholder the push executor resolves, after which the
  // link is repointed at the new id and the base rewritten from the response.
  // Parents are restored before children, exactly as a push creates them.
  if (onDelete === 'restore') {
    const toRestore = goneTwins
      .filter((localId) => board.nodes[localId]?.kind === 'issue')
      .sort(
        (a, b) =>
          (board.nodes[a]?.depth ?? 0) - (board.nodes[b]?.depth ?? 0) || a.localeCompare(b),
      );
    const placeholderOf = new Map<string, string>();
    toRestore.forEach((localId, index) => placeholderOf.set(localId, tempId(index + 1)));

    const refOf = (id: string): RemoteRef | undefined => {
      const placeholder = placeholderOf.get(id);
      if (placeholder !== undefined) return { kind: 'created', localId: id, placeholder };
      const link = links.links.get(id);
      if (link && (scopeSet === null || scopeSet.has(id))) {
        return { kind: 'linked', localId: id, remoteId: link.remoteId };
      }
      return undefined;
    };

    for (const localId of toRestore) {
      const issue = board.nodes[localId]!;
      const parent = issue.parentId ? refOf(issue.parentId) : undefined;
      restore.push({
        kind: 'restore',
        placeholder: placeholderOf.get(localId)!,
        localId,
        oldRemoteId: links.links.get(localId)!.remoteId,
        fields: boardFields(issue as IssueDto),
        ...parentRefFor(remote, issueDepth(board, issue as IssueDto), parent),
      });
    }
  }

  for (const localId of goneTwins) {
    switch (onDelete) {
      case 'delete': {
        if (refused.has(localId)) continue; // left for a human, above
        changes.push({ kind: 'delete', id: localId, nodeKind: 'issue' });
        // `applyPull` skips the unlink when the `delete` change failed, so the
        // next pull retries the deletion rather than silently dropping it.
        linkOps.push({ kind: 'unlink', localId });
        break;
      }
      case 'close': {
        // Follow the remote by closing the local document.  The status used is
        // the one the board declares terminal — never a hard-coded name — and
        // the document is decoupled so a later push does not re-file a closed
        // document upstream as a brand-new issue.
        const terminal = board.config.statuses.find((status) => status.terminal)?.id;
        if (terminal !== undefined) {
          changes.push({
            kind: 'update',
            id: localId,
            nodeKind: 'issue',
            patch: { status: terminal },
          });
        }
        linkOps.push({ kind: 'decouple', localId, reason: 'remote_deleted' });
        break;
      }
      case 'unlink': {
        // Decouple: the document is untouched, the link is dropped, and a
        // tombstone records the decision so the next push does not re-file it
        // (LP-366's tombstone, LP-365's resolution).
        linkOps.push({ kind: 'decouple', localId, reason: 'remote_deleted' });
        break;
      }
      case 'restore':
        // Handled above: the restore op repoints the link when it lands.
        break;
      case 'manual': {
        conflicts.push({
          localId,
          remoteId: links.links.get(localId)!.remoteId,
          reason: 'on_delete: manual — the twin is gone and a human must choose',
        });
        break;
      }
    }
  }

  // -- field diffs: linked twins still present on both sides -----------------
  // A linked twin still in the listing is merged field by field against its
  // base snapshot (LP-284).  A field the remote alone changed is pulled onto
  // the board as an `update`; a field both sides changed is a conflict, left
  // for a human (LP-257 AC #2) — neither side's value is written for it.
  const fieldConflicts: PullFieldConflict[] = [];
  for (const [localId, link] of [...links.links.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (scopeSet !== null && !scopeSet.has(localId)) continue;
    const record = remote.issues.get(link.remoteId);
    if (record === undefined) continue; // gone twin — the on_delete section handled it
    const doc = board.nodes[localId];
    if (!doc || doc.kind !== 'issue') continue;

    const { update, conflicts: mergedConflicts } = pullFieldDiff(
      localId,
      link.remoteId,
      doc,
      link.base,
      options.toPatch(record, doc.depth),
      remote.normalizeBody,
    );
    fieldConflicts.push(...mergedConflicts);

    // -- native edges (LP-325) ----------------------------------------------
    // An edge changed on the remote alone is pulled onto the board: an edge the
    // remote removed since the base is removed locally, an edge the remote
    // added is added — `depends_on` cycle-checked, `relates_to` never (a loop
    // of associations is not a stall). An edge the board alone changed is left
    // for the push planner, exactly as a scalar field is.
    if (dependsOnOf || relatesToOf) {
      const remoteDepends = dependsOnOf ? new Set(resolveRemoteIds(dependsOnOf(record))) : new Set<string>();
      const remoteRelates = relatesToOf ? new Set(resolveRemoteIds(relatesToOf(record))) : new Set<string>();
      const baseDep = new Set(baseDepends(link.base ?? {}));
      const baseRel = new Set(baseRelates(link.base ?? {}));
      const nextDepends = new Set(doc.dependsOn);
      const nextRelates = new Set(doc.relatesTo);

      for (const id of baseDep) if (!remoteDepends.has(id)) nextDepends.delete(id);
      for (const id of baseRel) if (!remoteRelates.has(id)) nextRelates.delete(id);

      for (const id of remoteDepends) {
        if (baseDep.has(id) || nextDepends.has(id)) continue;
        const cycle = cycleIfLinked(localId, id);
        if (cycle !== null) {
          edgeWarnings.push({
            remoteId: link.remoteId,
            field: 'depends_on',
            reference: labelOf(id),
            kind: 'cycle',
            cycle: cycle.map(labelOf).join(' -> '),
          });
          continue;
        }
        nextDepends.add(id);
      }
      for (const id of remoteRelates) {
        if (baseRel.has(id) || nextRelates.has(id)) continue;
        nextRelates.add(id);
      }

      const sortedDepends = [...nextDepends].sort();
      const sortedRelates = [...nextRelates].sort();
      if (!listEquals(sortedDepends, [...doc.dependsOn].sort())) update.dependsOn = sortedDepends;
      if (!listEquals(sortedRelates, [...doc.relatesTo].sort())) update.relatesTo = sortedRelates;
      // The agreed edges become the graph a later twin's edge is checked
      // against, so a cycle spanning two linked twins is still caught.
      prospective.set(localId, sortedDepends);
    }

    if (Object.keys(update).length > 0) {
      changes.push({ kind: 'update', id: localId, nodeKind: 'issue', patch: update });
    }
  }

  // -- user comments (LP-316) -------------------------------------------------
  // Opt-in (`comments: both`): append remote comments to `_comments.md` for
  // every remote issue in scope, new and existing alike.  A comment already
  // recorded in the link store is skipped, and the managed comment is excluded
  // by id (where the store records it) and by body (where the id was lost).
  // The ops carry a temp id for a new issue, resolved by `applyPull` against
  // `idMap` exactly like a `record` link op.
  const comments: PullCommentOp[] = [];
  if (remote.commentsMode === 'both' && remote.remoteComments) {
    const remoteComments = remote.remoteComments;
    const appendFor = (remoteId: string, targetId: string): void => {
      const list = remoteComments.get(remoteId);
      if (!list || list.length === 0) return;
      const synced = getSyncedRemoteCommentIds(links, targetId);
      const toAppend = planCommentPull(list, synced, (id, body) =>
        isManagedComment(links, targetId, id, body),
      );
      for (const comment of toAppend) {
        comments.push({
          kind: 'append',
          targetId,
          remoteId: comment.id,
          author: comment.author,
          at: comment.createdAt,
          body: comment.body,
        });
      }
    };

    for (const [remoteId] of newIssues) {
      appendFor(remoteId, tempIdOf.get(remoteId)!);
    }
    for (const [localId, link] of [...links.links.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (scopeSet !== null && !scopeSet.has(localId)) continue;
      appendFor(link.remoteId, localId);
    }
  }

  return {
    changes,
    links: linkOps,
    ...(comments.length > 0 ? { comments } : {}),
    ...(restore.length > 0 ? { restore } : {}),
    ...(conflicts.length > 0 ? { conflicts } : {}),
    ...(fieldConflicts.length > 0 ? { fieldConflicts } : {}),
    ...(edgeWarnings.length > 0 ? { edgeWarnings } : {}),
  };
}
