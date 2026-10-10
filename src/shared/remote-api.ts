/**
 * The wire shapes for the remote routes (`/api/remotes/*`), served by
 * `src/server/routes/remotes.ts` (LP-344).
 *
 * Import-free, like the rest of this folder: the server maps the remote
 * layer's results onto these shapes, and the web app consumes them, neither
 * importing the other.  Credentials never appear here — the server resolves
 * them itself and nothing on either side of the wire carries one.
 */

/** The direction a sync run takes, as the server accepts and reports it. */
export type RemoteSyncDirection = 'push' | 'pull' | 'both';

/** One configured remote, as `GET /api/remotes` lists it. */
export interface RemoteSummaryDto {
  name: string;
  provider: string;
  direction: RemoteSyncDirection;
  /** The connection value that names where the issues live. */
  target: string;
  /** Most recent sync across links, or null when never synced. */
  lastSync: string | null;
}

/** A push-side preflight problem, trimmed to what the panel shows. */
export interface RemotePreflightProblemDto {
  level: 'error' | 'warn';
  message: string;
}

/** One field's detail in a preview document: the two sides and what happens. */
export interface RemotePreviewFieldDto {
  /** Display name (`title`, `status`, `attributes.story_points`, `depends_on`…). */
  field: string;
  /** The local (board) value; null means absent on the board. */
  local: unknown;
  /** The remote value — the base snapshot, or null when the remote has none. */
  remote: unknown;
  /** What the operation does to this field: `created`, `updated`, `closed`, … */
  outcome: string;
}

/** One document's detail in a preview section. */
export interface RemotePreviewDocumentDto {
  /** The local id the operation names. */
  localId: string;
  /** The document's title, when known. */
  title?: string;
  /** The remote id of the twin, when the operation names one. */
  remoteId?: string;
  kind: string;
  fields: RemotePreviewFieldDto[];
}

/** One operation kind, grouped with its count and documents. */
export interface RemotePreviewSectionDto {
  kind: string;
  /** Human label for the kind (`create`, `transition`, `unlink locally`, …). */
  label: string;
  count: number;
  documents: RemotePreviewDocumentDto[];
}

/** One rendered plan step of a preview: the direction, its plain-text diff, and
 * the same plan grouped by operation kind, so the web preview can render the
 * structure `lpm remote push --dry-run` produces rather than re-deriving it. */
export interface RemotePreviewRenderDto {
  direction: 'pull' | 'push';
  /** Total operations in this step. */
  total: number;
  /** One section per operation kind, in the renderer's fixed order. */
  sections: RemotePreviewSectionDto[];
  /** The plain-text form the CLI prints. */
  text: string;
}

/** The preview of a sync: the rendered plan, nothing written to either side. */
export interface RemotePreviewDto {
  remoteName: string;
  direction: RemoteSyncDirection;
  preflight: RemotePreflightProblemDto[];
  /** True when the push was refused because the preflight found error problems. */
  preflightBlocked: boolean;
  /** Why the pull was skipped — the remote could not be reached. */
  unreachable?: string;
  /** The rendered plans, pull first (when pulled) then push. */
  renders: RemotePreviewRenderDto[];
}

/** The body of `POST /api/remotes/:name/sync` and `/preview`. */
export interface RemoteSyncRequestDto {
  direction?: RemoteSyncDirection;
  /** Narrow the run to one subtree (`lpm remote push <id>`). */
  scope?: string;
  /**
   * Act on exactly these documents and no others — the push side's
   * *selection*, `lpm remote push LP-12` with no `--children`.
   *
   * It is not `scope` with one entry, and the difference is the one this
   * layer keeps having to restate: `scope` names a subtree *root* and expands
   * to everything under it, which is right for "push this feature and its
   * stories" and wrong for "push this one document". Neither narrows what the
   * remote *owns*, so the gone pass is untouched by either and a selective run
   * can never decouple the rest of the board.
   */
  only?: string[];
  /**
   * Pull exactly these twins, by **remote** id (`lpm remote pull PAY-31`).
   *
   * A targeted pull is `partial`: it fetches what it was asked for and says
   * nothing whatever about what it did not look for, so no twin's absence is
   * read as a deletion. That is also why it is the right shape for "pull this
   * document" — narrowing a *scope* to one document would leave the bulk guard
   * comparing one missing twin against one expected twin, which is always
   * 100%.
   */
  pullIds?: string[];
  /** At most this many remote write ops on the push side (`--limit`). */
  limit?: number;
  /**
   * Ask the remote only for what changed since the last pull (`--changed`).
   * The default lists everything the remote holds, which is what refreshes
   * every mirrored document and the only listing a deletion is detected from.
   */
  changed?: boolean;
  /** Re-probe capabilities instead of reading the cache (`--refresh`). */
  refresh?: boolean;
  /** Confirm the first write or an oversized plan (`--yes`, LP-350). */
  yes?: boolean;
}

/** One push op that was refused or rejected, from the applied summary. */
export interface RemotePushOpDto {
  kind: string;
  localId: string;
  error: string;
}

/** The applied push summary, from the `done` event. */
export interface RemotePushSummaryDto {
  created: number;
  updated: number;
  skipped: number;
  conflicted: number;
  failed: number;
  conflictedOps: RemotePushOpDto[];
  failedOps: RemotePushOpDto[];
  /** Present when the run stopped early — aborted, budget-exhausted, or `--limit`. */
  stopped?: { reason: string; atOp: number; detail: string; deferred?: number };
}

/** A push the consent gate refused (LP-350, LP-351) — nothing was written. */
export interface RemoteConsentRefusalDto {
  reason: 'first_write' | 'threshold' | 'delete';
  target: string;
  creates: number;
  closes: number;
  deletes: number;
  threshold: number;
}

/** The applied pull summary, from the `done` event. */
export interface RemotePullSummaryDto {
  applied: number;
  linked: number;
  unlinked: number;
  decoupled: number;
  appendedComments: number;
  /** One line per failed change, grouped like the CLI's push-failure summary. */
  failures: string[];
}

/** A pull-side existence decision left for `resolve` (LP-365). */
export interface RemotePullConflictDto {
  localId: string;
  remoteId: string;
  reason: string;
  /** The linked child a delete would have orphaned, when that was the refusal. */
  childId?: string;
}

/** A field-level conflict on a linked twin, left for `resolve` (LP-257). */
export interface RemotePullFieldConflictDto {
  localId: string;
  remoteId: string;
  field: string;
  local: unknown;
  remote: unknown;
}

/** The conflicts a pull left for `resolve`, never applied silently. */
export interface RemotePullConflictsDto {
  conflicts: RemotePullConflictDto[];
  fieldConflicts: RemotePullFieldConflictDto[];
}

/** The final result of an applied sync, streamed as the `done` event. */
export interface RemoteSyncResultDto {
  remoteName: string;
  direction: RemoteSyncDirection;
  preflight: RemotePreflightProblemDto[];
  preflightBlocked: boolean;
  unreachable?: string;
  /** Present after a pull ran. */
  pull?: RemotePullSummaryDto;
  /** Present after a push ran. */
  push?: RemotePushSummaryDto;
  pullConflicts: RemotePullConflictsDto;
  /** Present when the push was refused by the consent gate (LP-350). */
  consentRefused?: RemoteConsentRefusalDto;
}

/** A streamed sync event. Every event carries a `type`. */
export type RemoteSyncEventDto =
  | { type: 'progress'; index: number; total: number; kind: string; localId: string }
  | { type: 'done'; result: RemoteSyncResultDto }
  | { type: 'error'; error: string; details?: string[] };

/** Which side of a conflict wins. */
export type RemoteResolveOwner = 'local' | 'remote';

/** The body of `POST /api/remotes/:name/resolve`. */
export interface RemoteResolveRequestDto {
  /** The document to settle. */
  id: string;
  /** Whole-document winner. */
  default?: RemoteResolveOwner;
  /** Per-field winners, most specific first. */
  fields?: Record<string, RemoteResolveOwner>;
}

/** The recorded settlement, as the route returns it. */
export interface RemoteResolveResultDto {
  remoteName: string;
  localId: string;
  default?: RemoteResolveOwner;
  fields: Record<string, RemoteResolveOwner>;
}

/** One conflicted field, with both sides and the pending choice, for the panel. */
export interface RemoteConflictFieldDto {
  /** Display name (`title`, `status`, `attributes.story_points`, …). */
  field: string;
  /** The local (board) value; null means absent on the board. */
  local: unknown;
  /** The remote value, translated back to board vocabulary. */
  remote: unknown;
  /** The pending per-field winner, when one was already recorded. */
  chosen?: RemoteResolveOwner;
}

/** The conflict detail for one document, served to the side panel (LP-346). */
export interface RemoteConflictDto {
  remoteName: string;
  localId: string;
  remoteId: string;
  /** Human-readable key, e.g. `acme/payments#418`. */
  remoteKey: string;
  /** Full URL to the remote issue; empty when the link recorded none. */
  remoteUrl: string;
  /** The fields in conflict, each with both values and the pending choice. */
  fields: RemoteConflictFieldDto[];
  /** A pending whole-document winner, when one was recorded. */
  default?: RemoteResolveOwner;
}

// ---------------------------------------------------------------------------
// Connecting a remote (the web connect form)
//
// Everything a form draws comes from `GET /api/remote-providers`, which is
// derived from the provider registry — so no front end names a platform, and a
// provider added to the registry appears in the form with nothing else edited.
// Credential values travel *in* only: every response carries where a value
// comes from (`source`), never the value.
// ---------------------------------------------------------------------------

/** One non-secret connection key a provider asks for. */
export interface RemoteConnectionFieldDto {
  name: string;
  type: 'string' | 'boolean';
  /** False for a key the provider defaults for itself. */
  required: boolean;
  /** A worked example, shown beside the field. */
  example?: string;
}

/** One credential key — stored beside the board, never in config.yml. */
export interface RemoteCredentialFieldDto {
  key: string;
  /** The platform's conventional env var, which satisfies the key as well. */
  env?: string;
  /** True when the value may be shown while typed (an account email); otherwise masked. */
  visible: boolean;
}

/** Everything a connect form needs to know about one provider. */
export interface RemoteProviderDto {
  name: string;
  connection: RemoteConnectionFieldDto[];
  credentials: RemoteCredentialFieldDto[];
  /** The page where this credential is created. */
  credentialUrl?: string;
  /** What to create, and with what access. */
  credentialHint?: string;
  /** Keys only part of a mapping needs, and what breaks without them. */
  conditional: Array<{ key: string; needs: string; why: string }>;
}

/** Where one credential key's value comes from. Never the value itself. */
export interface RemoteCredentialStateDto {
  key: string;
  env?: string;
  /** e.g. `.lpm/credentials.json` or `$JIRA_API_TOKEN`; absent when nothing holds a value. */
  source?: string;
  /** The `${VAR}` name config.yml points at, when it points at one. */
  reference?: string;
}

/** `POST /api/remotes` — declare a remote and store its credential. */
export interface RemoteConnectRequestDto {
  name: string;
  provider: string;
  /** Non-secret connection values; a blank is not given. */
  connection?: Record<string, string | boolean>;
  scope?: string;
  /** Credential values; a blank is skipped. */
  credentials?: Record<string, string>;
  /** Replace a remote of the same name — its mapping is drafted again. */
  force?: boolean;
}

export interface RemoteConnectResultDto {
  name: string;
  provider: string;
  target: string;
  replaced: boolean;
  /** Decisions the drafted mapping could not make on its own. */
  markers: Array<{ path: string; question: string }>;
  /** Credential keys stored by this call. */
  stored: string[];
  credentials: RemoteCredentialStateDto[];
}

/** `GET /api/remotes/:name/connection` — a declared remote as an edit form shows it. Holds no secret. */
export interface RemoteConnectionDto {
  name: string;
  provider: string;
  scope: string | null;
  /** Non-secret connection values only. */
  connection: Record<string, string | boolean>;
  credentials: RemoteCredentialStateDto[];
  /** How many documents this remote already mirrors — a remote with twins is not re-pointed. */
  linked: number;
}

/** `PUT /api/remotes/:name/connection`. A blank removes an optional key; `false` removes a switch. */
export interface RemoteConnectionUpdateDto {
  connection: Record<string, string | boolean>;
}

/** `PUT /api/remotes/:name/credentials`. A blank keeps what is there. */
export interface RemoteCredentialsRequestDto {
  credentials: Record<string, string>;
}

export interface RemoteCredentialsResultDto {
  stored: string[];
  credentials: RemoteCredentialStateDto[];
}

/** A value the remote offered for a connection key. */
export interface RemoteCandidateDto {
  key: string;
  value: string;
  label: string;
}

/** A connection key the remote answered in several ways, or not at all. */
export interface RemoteConnectionQuestionDto {
  key: string;
  why: string;
  candidates: RemoteCandidateDto[];
}

export interface RemoteReconcileEntryDto {
  boardKey: string;
  claimed: string;
  resolved?: string;
  verdict: 'ok' | 'renamed' | 'unresolved';
}

export interface RemoteReconcileBlockDto {
  entries: RemoteReconcileEntryDto[];
  /** The remote's own names — the options for an unresolved entry. */
  candidates: string[];
}

/** `POST /api/remotes/:name/inspect` — what asking the remote about itself found and wrote. */
export interface RemoteInspectDto {
  remoteName: string;
  reachability?: { reachable: boolean; evidence: string };
  /** The remote could not be reached; nothing after reachability was asked. */
  stopped: boolean;
  /** Keys the remote answered with exactly one value — written. */
  found: RemoteCandidateDto[];
  /** Keys the remote offered several values for — a person chooses. */
  choices: RemoteConnectionQuestionDto[];
  /** Keys nobody could answer. */
  needed: RemoteConnectionQuestionDto[];
  vocabulary?: { types?: RemoteReconcileBlockDto; statuses?: RemoteReconcileBlockDto };
  /** True when the provider has no vocabulary to ask about (and the remote was reached). */
  noVocabulary: boolean;
  prerequisites?: { labels: string[]; projectFields: number; sprints: string[]; canListLabels: boolean };
  /** config.yml lines this run changed. */
  written: string[];
  /** Nothing is left for a person to answer. */
  ready: boolean;
}

/** `POST /api/remotes/:name/answers` — what a person chose. */
export interface RemoteInspectAnswersDto {
  /** Discoverable connection keys only. */
  connection?: Record<string, string>;
  types?: Record<string, string>;
  statuses?: Record<string, string>;
}

export interface RemoteInspectAnswersResultDto {
  changed: string[];
}

// ---------------------------------------------------------------------------
// The mapping editor (File ▸ Board configuration ▸ Remote board)
//
// `GET /api/remotes/:name/mapping` answers what the tracker has and what the
// mapping says. `PUT` on the same path writes what a person chose into
// `remotes.<name>.mapping` of `.lpm/config.yml`. `src/remote/mapping-editor.ts`
// builds and applies both shapes.
// ---------------------------------------------------------------------------

/** One issue type of the tracker. */
export interface RemoteTypeItemDto {
  name: string;
  /**
   * The level of the type in the hierarchy of the tracker, when the tracker
   * has one. A higher number is nearer the top. Jira reports -1 for a
   * sub-task, 0 for a standard type and 1 for an epic.
   */
  level?: number;
  /** True for a type that the tracker creates only under a parent. */
  subtask?: boolean;
}

/** One sprint, cycle or milestone that the tracker holds. */
export interface RemotePeriodItemDto {
  name: string;
  /** `future`, `active` or `closed`, in the words of the tracker. */
  state: string;
  starts?: string;
  ends?: string;
}

export interface RemoteMappingDto {
  remoteName: string;
  provider: string;
  /** What the reachability probe answered. Absent when the connector has no probe or could not be built. */
  reachability?: { reachable: boolean; evidence: string };
  types: {
    /**
     * True when the tracker reported its own issue types. False when the type
     * names are light-plan's to choose (the tracker stores a type as a label),
     * or when the tracker could not be asked. `items` then holds the names
     * that the mapping declares.
     */
    fixed: boolean;
    items: RemoteTypeItemDto[];
    /** Board type name to the tracker name. A board type with no entry is not mapped. */
    mapping: Record<string, string>;
  };
  statuses: {
    /** As `types.fixed`, for workflow statuses. */
    fixed: boolean;
    items: string[];
    /** Board status id to the tracker states that mean the status. A push writes the first. */
    mapping: Record<string, string[]>;
  };
  periods: {
    /** True when the tracker has a container of its own for a period. */
    native: boolean;
    /** The container of the tracker: `sprint`, `milestones` or `iteration`. Null when no mapping names one. */
    carrier: string | null;
    /** The board period type that maps to the container, or null. */
    container: string | null;
    /** The containers that the tracker holds now. Null when the tracker could not list them. */
    items: RemotePeriodItemDto[] | null;
  };
  /** How many documents this remote already mirrors. A mapping change needs a re-base when it is not 0. */
  linked: number;
  /** Each question that the tracker did not answer, with the reason. */
  problems: string[];
}

/** The body of `PUT /api/remotes/:name/mapping`. An absent block is not written. */
export interface RemoteMappingUpdateDto {
  /** Board type name to the tracker name. Every issue type of the board must have an entry. */
  types?: Record<string, string>;
  /**
   * Board status id to the tracker states that mean the status. A push writes
   * the first state. Every status of the board must have at least one state.
   */
  statuses?: Record<string, string[]>;
  /** The board period type that maps to the container of the tracker. */
  periodContainer?: string;
}

export interface RemoteMappingUpdateResultDto {
  /** The lines of `.lpm/config.yml` that the call changed, as `<block>.<key>: old → new`. */
  changed: string[];
  mapping: RemoteMappingDto;
}
