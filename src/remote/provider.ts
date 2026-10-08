/**
 * The shape every provider adapter conforms to.
 *
 * A provider is looked up by name in `registry.ts`. It exposes four members,
 * plus one optional descriptor:
 *
 *   - `config`       a zod schema validating the provider's own slice of a
 *                    remote declaration — its `connection` and `mapping`
 *                    blocks. Core validates only the frame; this validates the
 *                    contents, when the remote is opened (LP-259).
 *   - `capabilities` what the platform can natively hold (capabilities.ts).
 *   - `translator`   the two-way vocabulary mapping: a board op becomes a
 *                    request description, a remote record becomes board fields.
 *   - `connector`    a factory that turns a validated connection block into a
 *                    connector the executor (LP-490) can drive.
 *   - `credentials`  (optional) which connection keys hold secrets and each
 *                    one's conventional env var, for the resolver (LP-295).
 *
 * The op / request / record vocabularies here are the *shape* of the sync; the
 * push planner (LP-280) emits the ops, the pull planner (LP-281) consumes the
 * records, and the executor (LP-490) walks the requests through a connector.
 * Those stories may refine these types — a provider adapter exposes the four
 * members (plus the optional `credentials` descriptor) and nothing else, so supporting a fourth platform is a folder plus a
 * line in the registry, never an edit to the planners or to core.
 */

import type { z } from 'zod';
import type { AdfDocument } from '../shared/adf.js';
import type { AttributeDef } from '../core/model/types.js';
import type { Roster, ResourceGap, UnknownAccount } from './accounts.js';
import type { AttributeProblem } from './attributes.js';
import type { LabelClaim } from './labels.js';
import type { Capabilities } from './capabilities.js';
import type { StandardVocabulary } from './vocabulary.js';
import type { RemoteVocabulary } from './reconcile.js';
import type { DegradedPeriod, PeriodContainer, PeriodGap, PeriodIndex, PeriodPull } from './periods.js';

/**
 * A board-side operation the push planner emits for one document, in board
 * vocabulary. The translator turns it into a `RemoteRequest` the connector can
 * execute. `localId` is the board id; `remoteId` appears on update/delete,
 * where a twin already exists.
 */
export type BoardOp =
  | { kind: 'create'; localId: string; fields: BoardFields }
  | { kind: 'update'; localId: string; remoteId: string; fields: BoardFields }
  | { kind: 'delete'; localId: string; remoteId: string };

/**
 * The board-vocabulary fields a document carries, as the translator sees them.
 * Only the fields a remote can mirror are here — no ids, no local-only state.
 *
 * `title` and `body` are optional because an `update` op may carry only the
 * fields that changed since the base snapshot — the executor passes `undefined`
 * for an unchanged one so the request omits it rather than re-sending it
 * (LP-307). `type` and `status` stay required: the translator derives the
 * labels and workflow state from them, and a push always sends the full
 * document for those.
 */
export interface BoardFields {
  title?: string;
  body?: string;
  /** Board type name, e.g. `user_story`. */
  type: string;
  /** Board status id, e.g. `in_progress`. */
  status: string;
  /** Board resource id, or null when unassigned. */
  assignee?: string | null;
  /** Board period id the issue is scheduled into, or null when unscheduled. */
  period?: string | null;
  /** Config-declared attributes, keyed by attribute name. */
  attributes?: Record<string, unknown>;
}

/**
 * A provider-agnostic description of the request to make against the remote.
 * The translator fills it in; the connector turns it into the platform's own
 * call. Fields the provider cannot hold are simply absent — the degradation
 * ladder (LP-255) decides what gets encoded before the translator runs.
 */
export interface RemoteRequest {
  kind: 'create' | 'update' | 'delete';
  /** Native issue type, where the provider has one. */
  type?: string;
  title?: string;
  /**
   * The body to write. For a text-body remote (GitHub) this is markdown; for a
   * structured-body remote (Jira) the translator hands the connector an ADF
   * document, which is the shape the platform's `description` field holds.
   */
  body?: string | AdfDocument;
  /** Native labels / tags. */
  labels?: string[];
  /**
   * Which labels this request's `labels` list claims — the exact labels and
   * prefixes the mapping writes. A connector reconciles labels against it, so
   * only the claimed ones are added or removed and a human's triage labels
   * survive (LP-308). Absent means the connector may replace the list, the
   * pre-reconciliation behaviour.
   */
  labelClaim?: LabelClaim;
  /** Native workflow state (`open` / `closed` for GitHub, the workflow-state
   * name for Linear, the native status name for jsonfile). */
  state?: string;
  /**
   * The issue's estimate, where the provider holds a native estimate field
   * (Linear's `estimate`, the rung-1 home for the board's effort attribute —
   * LP-333). A number sets it, `null` clears it, `undefined` leaves the remote
   * side untouched.
   */
  estimate?: number | null;
  /**
   * The account to assign the issue to, when the provider holds assignees:
   * a non-empty string assigns it, `null` unassigns it, and `undefined` leaves
   * the remote side untouched.
   */
  assignee?: string | null;
  /**
   * The period container to schedule the issue into, when the mapping resolved
   * one. Carried as a name plus dates; the connector resolves the name to the
   * platform's own id (and provisions it when absent, where the provider can),
   * then writes it to the configured carrier — a milestone or a Project
   * iteration field (LP-313).
   */
  period?: PeriodContainer | null;
  /**
   * The degraded period levels (the ones above the mapped level), carried in
   * the managed block rather than a native container (LP-313). The executor
   * composes them into the body block; the connector never sees them.
   */
  degradedPeriods?: DegradedPeriod[];
  /**
   * The remote id of the created issue's parent, when the provider holds a
   * native hierarchy and the plan placed the new issue under one. Set by the
   * executor after the parent's placeholder is resolved; absent at the remote
   * root. A provider without native hierarchy ignores it (its nesting is
   * carried by the degradation ladder instead).
   */
  parent?: string;
  /**
   * The remote status value to write to a Project single-select status column
   * (LP-312), when the mapping carries the board's status in one
   * (`mapping.fields.status`). It is the remote status label, the same value
   * the translator also writes as a status label; the connector resolves it
   * to an option id via the cached Project ids and sets it after the issue
   * write — adding the issue to the Project first when it is not already an
   * item. The executor asks for this only on a status-affecting write
   * (create / transition / close), never a plain field update.
   */
  projectStatus?: string;
}

/**
 * A raw issue exactly as the remote returned it, keyed by the remote's own
 * field names. Provider-specific; the translator is the only reader.
 */
export type RemoteRecord = Record<string, unknown>;

/**
 * The board fields recovered from a remote record. Only fields the remote
 * actually carries are present — nothing is invented, so a caller applies
 * exactly what it finds and nothing more.
 */
export interface BoardFieldsPatch {
  title?: string;
  body?: string;
  /** Board type name, when the mapping resolves it unambiguously. */
  type?: string;
  /** Board status id, when the mapping resolves it. */
  status?: string;
  assignee?: string | null;
  /** Board period id, when the mapping resolves it. */
  period?: string | null;
  attributes?: Record<string, unknown>;
}

/**
 * A disagreement between two remote signals that both spoke for one board
 * status (LP-312). Two signals is inherent to some providers — GitHub's issue
 * `state` and its Project single-select column are the worked example — so the
 * pull reports the disagreement rather than silently choosing a winner.
 */
export interface StatusDiscrepancy {
  /** Which signal won, in the provider's own vocabulary (`issue` | `project`). */
  took: string;
  /** The board status the *losing* signal would have produced, when it named one. */
  otherStatus?: string;
  /** The losing signal's raw values, so a report can name what was overridden. */
  column?: string;
  state?: string;
}

/**
 * The board's config-declared attribute definitions, keyed by attribute name —
 * what the coercion (LP-270) needs to know what a value *is* on each side of
 * the wire. Passed per call, exactly like `mapping`, because the translator is
 * pure and has no board handle of its own.
 */
export type AttributeDefs = Record<string, AttributeDef>;

/** `describeRequest`'s result: the request, plus everything that could not be mapped. */
export interface DescribeResult {
  request: RemoteRequest;
  /** Coercion failures on the way out; the planner reports them before writing. */
  problems: AttributeProblem[];
  /** People whose account could not be resolved — reported once per person. */
  resourceGaps: ResourceGap[];
  /** A period id not on the timeline — reported rather than dropped. */
  periodGaps: PeriodGap[];
}

/** `fieldsFromRecord`'s result: the recovered fields, plus everything that could not be mapped back. */
export interface FieldsFromRecordResult {
  patch: BoardFieldsPatch;
  /** Coercion failures on the way in; the failed attribute is left alone. */
  problems: AttributeProblem[];
  /** Remote assignees nobody on the roster matches — reported, never invented. */
  unknownAccounts: UnknownAccount[];
  /**
   * The period recovered from the remote container — the resolved local period
   * id (mirrored in `patch.period`), the observed dates for the planner to
   * reconcile, and any degraded-level names read back out of labels. Absent
   * when the remote carries no container or the board has no period mapping.
   */
  period?: PeriodPull;
  /**
   * A disagreement between the two signals that both spoke for the status
   * (LP-312) — the issue state and the Project column. Absent when the two
   * agree or when only one resolves. A caller reports it rather than hiding
   * the overridden signal.
   */
  statusDiscrepancy?: StatusDiscrepancy;
}

/**
 * The two native edge kinds a provider may hold (LP-325). `depends` is the
 * gating `depends_on` edge (`blocks` / `is blocked by` on Jira); `relates` is
 * the non-gating `relates_to` edge (`relates to`). A provider that holds
 * neither carries both through the managed block instead.
 */
export type LinkKind = 'depends' | 'relates';

/**
 * A provider's two-way vocabulary translation. Pure: no I/O. `mapping` is the
 * remote's validated `mapping` block and `attributes` the board's declared
 * attribute definitions, both passed per call so one translator serves every
 * remote of that provider.
 */
export interface Translator {
  /** Push: a board op plus the mapping becomes a request description. */
  describeRequest(
    op: BoardOp,
    mapping: Record<string, unknown>,
    attributes: AttributeDefs,
    roster?: Roster,
    periods?: PeriodIndex,
  ): DescribeResult;
  /** Pull: a remote record plus the mapping becomes board fields. */
  fieldsFromRecord(
    record: RemoteRecord,
    mapping: Record<string, unknown>,
    attributes: AttributeDefs,
    roster?: Roster,
    periods?: PeriodIndex,
  ): FieldsFromRecordResult;
  /**
   * The value a board person's `accounts.via` attribute should hold so this
   * remote assigns work to `user`, or `undefined` when the remote user cannot
   * answer that attribute at all.
   *
   * `via` names a *board* attribute (`email`, `jira_account_id`, `github`) and
   * only the provider knows which of a remote user's fields satisfies it —
   * Jira assigns by account id and resolves an email by search, GitHub assigns
   * by login. Absent on a provider with no accounts, in which case the
   * readiness check can report a gap but never offer to close it.
   */
  accountValue?(user: RemoteUser, via: string): string | undefined;
  /**
   * A board body as it will read *after* a round trip through the remote's own
   * format — for a provider whose body format is not markdown.
   *
   * The base snapshot records the body the remote echoed back, and the push
   * compares the board's body against it. When the two formats are not
   * isomorphic that comparison never settles: Jira's description is ADF, which
   * has paragraphs but no source line breaks, so a body hard-wrapped at 80
   * columns comes back as one long line and *every* document is permanently
   * ahead — the push rewrites all of them, and the next push does it again.
   *
   * Declaring this makes the comparison like-for-like: the board's body is put
   * through the same round trip before hashing, so formatting the remote cannot
   * hold stops counting as a change while a real edit on either side still
   * does. Absent on a provider whose body is markdown already (GitHub, Linear,
   * jsonfile), where the round trip is the identity.
   */
  normalizeBody?(markdown: string): string;
}

/**
 * One connection key a part of the mapping needs, and why.
 */
export interface ConditionalConnectionKey {
  /** The `connection` key (`board`). */
  key: string;
  /** The `mapping` block whose presence makes the key necessary (`periods`). */
  needs: string;
  /** One line saying what breaks without it — printed as the remedy. */
  why: string;
}

/**
 * A value the remote can supply for a connection key the config has not got —
 * the answer to "which Agile board?" asked of Jira rather than of the person.
 */
export interface ConnectionCandidate {
  /** The connection key this answers (`board`). */
  key: string;
  /** The value to write into `connection`. */
  value: string;
  /** How to name it when there is more than one to choose between. */
  label: string;
}

/**
 * What a connector returns after a successful create / update / delete, so the
 * executor can record the link and its base snapshot.
 */
export interface ConnectorResult {
  /**
   * Fields the remote would not take, named the way the base snapshot names
   * them (`period`).
   *
   * A write is not all-or-nothing on every platform, and one case is ordinary
   * rather than exceptional: an issue scheduled into a sprint the tracker does
   * not have yet. Refusing the whole issue for it would make the board's
   * timeline a precondition of filing any work at all — so the connector files
   * the issue without the field and says which one it dropped, and the
   * executor records that field as **unset** in the base. The next push sees
   * the board's value against an empty base and writes it, the moment the
   * sprint exists. Same shape as a parent that arrives later: file now, repair
   * when the other half turns up.
   */
  unwritten?: readonly string[];
  /** The remote system's opaque id for this issue. */
  remoteId: string;
  /** A human-readable key, e.g. `acme/payments#418`. */
  remoteKey: string;
  /** Full URL to the remote issue. */
  remoteUrl: string;
  /** The remote's revision marker — a timestamp, a hash, whatever it supplies. */
  remoteRev: string;
  /**
   * The remote id of the comment a comment method created, so the executor can
   * record it as the managed comment id and edit it on the next push rather
   * than posting a duplicate. Absent for issue methods.
   */
  commentId?: string;
  /**
   * The issue exactly as it stands **after** the write, in the provider's own
   * record shape (the same shape `get` / `list` return). The executor
   * translates this back to board vocabulary and records the base snapshot
   * from it, so a remote that normalises markdown, reorders labels or rejects
   * part of an update is absorbed into the base rather than coming back as a
   * remote change on the next pull (LP-288).
   *
   * A connector whose write response does not echo the issue back should
   * `get()` it before returning, or omit this field — in which case the
   * executor falls back to the local document's fields as the best available
   * record of the write.
   */
  record?: RemoteRecord;
  /**
   * The remote's GraphQL node id, where the platform exposes one (GitHub's
   * `node_id`). Distinct from `remoteId`, which is the address the connector's
   * own calls use (GitHub's issue number); the node id is the stable
   * GraphQL-side identifier later stories (sub-issues, Projects v2) address.
   * The executor records it on the link (LP-307); absent on a platform without
   * one.
   */
  nodeId?: string;
}

/**
 * Progress through a listing's internal pages, so a caller can show movement.
 *
 * A listing of a large project is a handful of requests inside one `list` call,
 * and before this the whole thing was one opaque await — which on the Sync tab
 * read as a hang. Called once per page with the running record count; the total
 * is unknown until the remote stops handing out pages, so it is a count rather
 * than a percentage.
 */
export type ListProgress = (progress: { page: number; records: number }) => void;

/** One page of remote records, plus the cursor for the next pull. */
export interface RemotePage {
  records: RemoteRecord[];
  /** Server-supplied cursor, or null when there are no more changes. */
  cursor: string | null;
}

/**
 * A user comment exactly as the remote holds it, for the pull side of comment
 * sync (LP-316). The comment's own id is what the link store records so a
 * later pull never appends the same comment twice; `author` and `createdAt`
 * are the remote's report, written into the `_comments.md` heading verbatim.
 */
export interface RemoteComment {
  /** The remote system's opaque id for this comment. */
  id: string;
  /** The comment author's name, as the remote reports it. */
  author: string;
  /** ISO-8601 timestamp of when the comment was written. */
  createdAt: string;
  /** The comment body text (markdown). */
  body: string;
}

/**
 * One issue type in a provider's type scheme, as the preflight reads it
 * (LP-324). A connector that holds native issue types exposes them through
 * `issueTypes()`; the preflight validates the board's `mapping.types` against
 * this list — a mapped type the project does not have is an error, and a
 * sub-task type is a type that must always be created with a parent.
 */
export interface IssueTypeSchemeEntry {
  /** The issue type name, e.g. "Story", "Epic", "Sub-task". */
  name: string;
  /** True for sub-task types — they must be created with a parent. */
  subtask?: boolean;
  /** The hierarchy level: -1 sub-task, 0 standard, 1 epic, 2+ above. */
  hierarchyLevel?: number;
}

/**
 * The reachability probe's answer (LP-364): can the remote be seen at all, and
 * why. `reachable` is false when the connector could not confirm the remote's
 * existence or its own access to it — a permission loss, a deleted repo or a
 * network failure — and `evidence` is the request and answer that produced the
 * verdict, so a surprising classification can be argued with.
 */
export interface ReachabilityResult {
  /** True when the remote answered its probe healthy (repo/project/team reachable). */
  reachable: boolean;
  /** Human-readable evidence: the request made and what it answered. */
  evidence: string;
}

/**
 * A live connector to one remote. The executor (LP-490) drives it; the factory
 * that builds it from a connection block is the provider's `connector`. The
 * `delete` method applies a delete op — a provider that cannot hard-delete
 * (GitHub) closes instead, which the provider documents on its adapter.
 *
 * `link`, `unlink`, `comment`, `editComment` and `deleteComment` are optional
 * because the connector contract (LP-289) does not yet define their wire
 * shape for every provider.
 * The executor skips those ops with a reason when the method is absent rather
 * than pretending the remote edge or comment was written.
 */
export interface Connector {
  /** The provider name, so a report can say which remote it talked to. */
  readonly name: string;
  /**
   * File a new twin.  `signal`, when given, aborts the in-flight request
   * (LP-298): the caller passes its Ctrl-C signal and the connector honours it
   * in whatever it uses for transport — a `fetch` call, a `gh` process.
   */
  create(request: RemoteRequest, signal?: AbortSignal): Promise<ConnectorResult>;
  update(remoteId: string, request: RemoteRequest, signal?: AbortSignal): Promise<ConnectorResult>;
  delete(remoteId: string, signal?: AbortSignal): Promise<ConnectorResult>;
  get(remoteId: string): Promise<RemoteRecord | null>;
  /**
   * The whole listing, exhaustively — a connector pages internally and returns
   * one `RemotePage` holding every record, plus the cursor for the *next* pull.
   *
   * So a caller calls this **once**. `page.cursor` is not a continuation token,
   * and treating it as one asks the remote for the same listing twice.
   */
  list(opts?: { cursor?: string | null; onPage?: ListProgress }): Promise<RemotePage>;
  /**
   * The human-readable key and URL of a **listed** record, with no request.
   *
   * A `RemoteRecord` is opaque above the provider, and every other route to a
   * key goes through a `ConnectorResult` — which only a write or a `get`
   * produces. That was fine while nothing read a listing for anything but its
   * fields, and became a gap the moment the drift report started reporting
   * remote issues the board has never seen: a reader needs something to click
   * and something to recognise, and fetching 40 of them one at a time to learn
   * their own keys would reintroduce the cost the listing exists to avoid.
   *
   * Pure and local — it reads the record it is handed and the connection the
   * connector closed over. Optional: a provider without it falls back to the
   * remote id, which is always available and merely less pleasant to read.
   */
  describe?(record: RemoteRecord): { remoteKey: string; remoteUrl: string };
  /**
   * Answer a `conditionalConnection` key from the remote itself, for every one
   * the config has not got.
   *
   * The setup conversation calls this after the credential resolves: one
   * candidate is written into `config.yml` (nobody should be sent to a URL bar
   * to copy a number a token can read), several become a question, and none is
   * reported with what to do. Absent on a connector with nothing to discover.
   */
  discoverConnection?(signal?: AbortSignal): Promise<ConnectionCandidate[]>;
  /**
   * Resolve a human-readable remote key (e.g. `acme/payments#418`) to the live
   * issue, when the provider can (LP-367). Returns the same shape a create's
   * response would — remote id, key, url, revision and the issue record — so
   * the caller can seed a base snapshot from the remote's current values
   * without writing to either side. `null` means the key names no issue the
   * connector can see. Absent on a connector that cannot resolve a key, in
   * which case the caller must supply the remote id directly.
   */
  resolve?(key: string): Promise<ConnectorResult | null>;
  /**
   * Add an edge between two remote issues, when the provider holds one. `kind`
   * selects the edge: `depends` (the default) links the gating `depends_on`
   * edge, `relates` the non-gating `relates_to` edge. `dependentRemoteId` is
   * the local issue; `dependencyRemoteId` is the issue it points at — for
   * `relates` the two are interchangeable, for `depends` the direction is the
   * provider's own (Jira: `dependent` is blocked by `dependency`).
   */
  link?(dependentRemoteId: string, dependencyRemoteId: string, signal?: AbortSignal, kind?: LinkKind): Promise<ConnectorResult>;
  /**
   * Remove an edge between two remote issues, when the provider holds one.
   * Mirrors `link`'s arguments and `kind`.
   */
  unlink?(dependentRemoteId: string, dependencyRemoteId: string, signal?: AbortSignal, kind?: LinkKind): Promise<ConnectorResult>;
  /**
   * Move an existing issue under a new native parent, or clear its native
   * parent (LP-493). `parentRemoteId` names the new parent; `null` clears the
   * edge. Idempotent: setting the parent an issue already has, or clearing one
   * it does not have, is a no-op that returns the issue unchanged. Absent on a
   * connector that cannot move an existing issue — the executor then skips the
   * native half of a reparent with a reason.
   */
  reparent?(remoteId: string, parentRemoteId: string | null, signal?: AbortSignal): Promise<ConnectorResult>;
  /** Post a comment on a remote issue. The result carries the comment id. */
  comment?(remoteId: string, body: string, signal?: AbortSignal): Promise<ConnectorResult>;
  /**
   * List the user comments on a remote issue, oldest first (LP-316).  The
   * pull appends any not already recorded in the link store to `_comments.md`;
   * the managed comment is excluded by the caller, never by the connector.
   * Absent on a connector that cannot list comments — the pull then reports
   * comment sync as unavailable rather than pretending the thread is empty.
   */
  listComments?(remoteId: string, signal?: AbortSignal): Promise<RemoteComment[]>;
  /**
   * Edit an existing comment in place, when the platform allows it. Absent
   * when comments cannot be edited — the executor then deletes and reposts,
   * when deletion is available (LP-278).
   */
  editComment?(remoteId: string, commentId: string, body: string, signal?: AbortSignal): Promise<ConnectorResult>;
  /**
   * Delete an existing comment, when the platform allows it. Used by the
   * delete-then-repost path for a platform where comments cannot be edited.
   */
  deleteComment?(remoteId: string, commentId: string, signal?: AbortSignal): Promise<ConnectorResult>;
  /**
   * Answer a capability probe by name (LP-274). A provider that declares a
   * probed capability cell implements the matching probe here; a fake
   * connector supplies canned answers in tests. The name and the returned
   * value's shape are the provider's own vocabulary.
   */
  probe?(probeName: string): Promise<unknown>;
  /**
   * List the project's issue types, each with its name, sub-task flag and
   * hierarchy level (LP-324). Absent on a connector without a type scheme. The
   * preflight validates the type mapping against this list; `probe('hierarchy')`
   * reports the same fact as a capability depth.
   */
  issueTypes?(): Promise<IssueTypeSchemeEntry[]>;
  /**
   * The words this target actually has — its issue types and its workflow
   * statuses, as plain names (LP-537). `lpm remote setup` reconciles the
   * drafted mapping against them, so a conventional name the project renamed is
   * corrected once instead of failing at every push.
   *
   * Absent on a connector with no vocabulary to report: `jsonfile` writes
   * whatever the mapping says, and a GitHub board's types and statuses are
   * labels of our own choosing. A key the provider omits means "this platform
   * has no such vocabulary", which is not the same as an empty list — an empty
   * list means the remote reported nothing and every mapped name is unresolved.
   */
  vocabulary?(signal?: AbortSignal): Promise<RemoteVocabulary>;
  /**
   * List the labels the repository already defines, as plain names. Absent on
   * a connector that cannot list labels — the push's prerequisite step
   * then cannot report or create a missing label (LP-308).
   */
  listLabels?(): Promise<string[]>;
  /**
   * Create a label with the given colour — a hex string with no leading `#`,
   * the shape the platform's label API expects. The prerequisite step calls
   * it for each mapped label the repository lacks (LP-308).
   */
  createLabel?(name: string, color: string, signal?: AbortSignal): Promise<void>;
  /**
   * The reachability probe (LP-364): can this remote be seen at all, with the
   * current credentials and scope? The resolver calls it before trusting a 404
   * as a deletion, because a permission loss and a genuine deletion are
   * indistinguishable per issue. Returns a verdict *with evidence*, so a
   * surprising classification can be argued with. Absent on a connector that
   * cannot probe — a missing twin is then classified conservatively.
   */
  reachable?(): Promise<ReachabilityResult>;
  /**
   * Run one GraphQL query against the platform's GraphQL endpoint, where the
   * platform has one (GitHub Projects v2, Linear). Returns the decoded
   * response body — `{ data, errors? }` — so a resolver can read the data it
   * asked for and report a platform-level miss (a missing object, a
   * permission loss) rather than fail. Absent on a connector without a
   * GraphQL API.
   *
   * `variables` carries the query's named variables; the query string is the
   * caller's GraphQL document. The callers today are the Projects v2 id
   * resolver (LP-310) and the status-field read/write (LP-312).
   */
  graphql?(query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /**
   * Set the Project single-select status column for an issue (LP-312), when
   * the provider carries the board's status in a Project field. `value` is
   * the remote status label to write; the connector resolves it to an option
   * id via the cached Project ids, adds the issue to the Project first when
   * it is not already an item, and writes the field value. Absent on a
   * connector without a Project status surface.
   */
  setProjectStatus?(remoteId: string, value: string, signal?: AbortSignal): Promise<void>;
  /**
   * Read the Project single-select status column for an issue (LP-312),
   * returning the option name (a remote status label) or `undefined` when the
   * issue is not an item or the field has no value. Absent on a connector
   * without a Project status surface.
   */
  readProjectStatus?(remoteId: string, signal?: AbortSignal): Promise<string | undefined>;
  /**
   * Read the Project iteration field for an issue (LP-313), returning the
   * iteration title or `undefined` when the issue is not an item or the field
   * has no value. Absent on a connector without a Project iteration surface.
   * The title is what the pull resolves back to a local period.
   */
  readProjectPeriod?(remoteId: string, signal?: AbortSignal): Promise<string | undefined>;
  /**
   * The people this target can actually assign work to.
   *
   * The account mapping resolves a board person to an account *value* offline
   * (`accounts.via`), and the value it finds is a claim about the remote that
   * nothing checks until the write fails: a stale account id, a colleague who
   * left the project, an email a privacy-restricted instance will not resolve.
   * Asking once — the project's assignable users, not every user on the
   * instance — is what lets a push say "this will land unassigned" *before* it
   * files anything, and what gives the roster something to be reconciled
   * against.
   *
   * Absent on a connector with no notion of an account, in which case the
   * readiness check reports what it can work out offline and nothing more.
   */
  listUsers?(signal?: AbortSignal): Promise<RemoteUser[]>;
  /**
   * List the sprints on the configured Agile board (LP-328), when the provider
   * holds native sprints (Jira). Each entry carries the sprint's id, name,
   * state and dates — the list a push matches a period to by name and a
   * closed-sprint guard refuses work into. Absent on a connector without
   * sprints, in which case sprint provision is unavailable.
   */
  listSprints?(signal?: AbortSignal): Promise<NativeSprint[]>;
  /**
   * Create a future sprint on the configured Agile board (LP-328), returning
   * its id. Absent on a connector without sprints.
   */
  createSprint?(
    name: string,
    starts?: string,
    ends?: string,
    signal?: AbortSignal,
  ): Promise<{ id: string }>;
}

/**
 * One person the remote can assign work to.
 *
 * Deliberately three plain fields rather than the platform's own shape: `id`
 * is what the platform addresses them by (a Jira `accountId`, a GitHub login),
 * `name` is what a person reading a list recognises, and `email` is what a
 * board roster most often already holds. Which of them belongs in the board's
 * `accounts.via` attribute is the provider's to say — `Translator.accountValue`
 * — because that is platform knowledge and nothing above the provider may
 * guess at it.
 */
export interface RemoteUser {
  id: string;
  name: string;
  email?: string;
}

/** One native sprint/cycle container a provider lists (LP-328). */
export interface NativeSprint {
  /** The sprint's numeric id. */
  id: string;
  /** The sprint name — what a period title matches. */
  name: string;
  /** The sprint state: `future`, `active` or `closed`. */
  state: string;
  /** `YYYY-MM-DD` start date, when the sprint carries one. */
  starts?: string;
  /** `YYYY-MM-DD` end date, when the sprint carries one. */
  ends?: string;
  /** ISO completion timestamp, when the sprint was closed. */
  completeDate?: string;
}

/**
 * What a connector factory needs beyond the two blocks it already receives,
 * passed through by `buildConnector` (LP-312). Some connectors read committed
 * per-remote caches — the GitHub Projects v2 ids cache — which live on the
 * board's filesystem, so they need the board paths and the remote's name to
 * find them. Absent when a caller builds a connector without a board.
 */
export interface ConnectorContext {
  /** Board paths, for connectors that read committed caches. */
  paths?: import('../core/storage/paths.js').BoardPaths;
  /** The remote's name, for naming per-remote caches. */
  remoteName?: string;
}

/** Builds a connector from a validated connection block, mapping block, and optional board context. */
export type ConnectorFactory = (
  connection: Record<string, unknown>,
  mapping: Record<string, unknown>,
  context?: ConnectorContext,
) => Connector;

/**
 * A zod schema validating `{ connection, mapping }` for one provider. Typed
 * loosely (the exact output shape is the provider's own `z.infer`), because the
 * registry holds many providers behind one interface and only LP-259 calls it.
 */
export type ProviderConfigSchema = z.ZodType;

/**
 * What a provider adapter exposes. Exactly these four members — the shape that
 * makes "adding a provider is a folder and a line" true.
 */
export interface Provider {
  /** Validates the provider-specific `connection` and `mapping` blocks. */
  config: ProviderConfigSchema;
  /** What the platform can natively hold, as a table (LP-274). */
  capabilities: Capabilities;
  /** Board vocabulary ↔ remote vocabulary, both directions. */
  translator: Translator;
  /** Turns a validated connection block into a live connector. */
  connector: ConnectorFactory;
  /**
   * Which connection keys hold secrets, each with the platform's own
   * conventional env var (LP-295). The resolver fills an unset secret from
   * this; the check uses it to refuse a literal secret in the committed
   * config. Absent on a provider with no secrets.
   */
  /**
   * Connection keys that only *part* of a mapping needs, which is why the
   * provider's schema cannot simply mark them required.
   *
   * Jira's Agile board id is the whole of the motivation: a Jira remote that
   * never schedules anything needs no board, and one whose mapping carries
   * `periods` cannot create or find a single sprint without it. The schema
   * sees one remote declaration at a time and has no view of what the push
   * will try to do, so the demand is stated here as data and checked where the
   * two facts meet — the push preflight, which holds the mapping and the
   * connection together and runs before anything is written.
   *
   * Two things read it: `preflightPush`, which turns an unmet one into an
   * error that refuses the push with `why` as the remedy, and the setup
   * conversation, which tries to answer it from the remote itself
   * (`Connector.discoverConnection`) before anybody is asked to go and find it.
   */
  conditionalConnection?: readonly ConditionalConnectionKey[];
  credentials?: {
    /** Secret-bearing connection key → the platform's conventional env var. */
    secrets: Record<string, string>;
    /**
     * Which of those keys are not themselves secret to *look* at, and may be
     * echoed while somebody types them (Jira's account `email`, which is half
     * of the credential and no secret at all). Everything else is read with
     * the terminal's echo off. Absent means every key is hidden, which is the
     * safe default for a provider that declares nothing.
     */
    visible?: readonly string[];
    /**
     * Where a person creates this credential — the page to open, printed by
     * `lpm remote add` and whenever a credential is missing. A person who has
     * just declared a remote needs one thing next, and hunting for the token
     * page is the step nothing in the tool used to help with.
     */
    url?: string;
    /** One line naming what to create and with what access. */
    hint?: string;
  };
  /**
   * The platform's *conventional* words for a board's types and statuses, used
   * when nobody has yet told the tool anything about the remote (LP-537).
   *
   * Only meaningful for a provider whose `capabilities.vocabulary` is `fixed`:
   * a vocabulary that pre-exists remotely and can only be listed by asking. The
   * scaffold writes these instead of a `TODO:` marker, so the remote opens and
   * syncs without a hand-edited mapping; the push preflight still validates
   * every name against the live project before a write, and `lpm remote setup`
   * replaces a convention with the remote's real word as soon as a credential
   * exists. Absent on a provider whose vocabulary is ours to write (`jsonfile`)
   * or that has none (a labels-only GitHub remote).
   */
  standardVocabulary?: StandardVocabulary;
  /**
   * Connection values this provider can work out for itself, given only the
   * remote's name — so `lpm remote add` does not have to ask for them.
   *
   * The worked example is `jsonfile`, whose `file` is a path *this tool*
   * owns: there is no external system to point at, so making a person invent
   * `--file .lpm/remotes/demo/tracker.json` was asking them to name something
   * the tool can name better. A key here is still an ordinary connection key —
   * written into config.yml, validated by the same schema, and overridable by
   * passing the flag explicitly. It is a default, never a lock.
   *
   * Only a value derivable with **no** external knowledge belongs here: a
   * GitHub `repo` or a Jira `site` names somebody else's system and can never
   * be guessed. Must be pure, and its *key set* must not depend on the name it
   * is given — `connectionFlags` calls it to learn which flags are optional.
   */
  defaultConnection?(remoteName: string): Record<string, unknown>;
}
