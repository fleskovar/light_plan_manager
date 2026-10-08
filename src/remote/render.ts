/**
 * The plan renderer — a plan as a diff, for `--dry-run` and the web preview.
 *
 * `renderPlan` turns a plan into two things at once:
 *
 *   - a **structure** (sections grouped by operation kind, per-document field
 *     detail, and a conflict section) that the web preview renders;
 *   - a **text** form that the CLI prints.
 *
 * Both are produced from the *same input*, so `lpm remote push --dry-run` and
 * the web preview cannot disagree about what is about to happen. That is the
 * whole point: a dry-run is not a separate estimate, it is the plan rendered
 * instead of executed (LP-256).
 *
 * ## Inputs
 *
 * The renderer takes the plan the executor would walk — the `RemoteOp[]` from
 * `planPush`, or the `PullPlan` from `planPull` — plus the context it needs to
 * fill in the "remote" column of each diff:
 *
 *   - `links` supplies the base snapshot a push diffs against: for an `update`,
 *     the "remote value" of a field is the value the link store recorded at
 *     the last successful sync, not a value re-read from the network. The base
 *     stores the body as a hash, so a changed body renders its hash on the
 *     remote side — the honest reading of "what did the remote last have".
 *   - `board` supplies titles, and the terminal status a `close` writes (the
 *     op carries no status of its own).
 *   - `conflicts` is fed by the conflict-detection story (LP-257); the renderer
 *     only displays them, each with both values and the policy that resolves it.
 *   - `secrets` are values that must never appear in the rendering; any of them
 *     found in a field value or title is replaced with `***`.
 *
 * ## Purity
 *
 * Like the planners, the renderer is browser-compatible: every import is
 * type-only, so nothing here pulls `node:` modules into a web bundle. It reads
 * no disk and makes no request; the CLI and the web app hand it the same data
 * and get the same text.
 */

import type { RemoteConflictPolicy } from '../core/model/types.js';
import type { NodePatch } from '../shared/changes.js';
import type { BoardView } from '../shared/plans/reading.js';
import type { LinkStore } from './links.js';
import type { PullPlan, PushSkip, RemoteOp } from './plan.js';
import type { BoardFields } from './provider.js';
import { redactValue } from './redact.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The plan to render, in either direction. */
export type PlanForRender =
  | { direction: 'push'; ops: readonly RemoteOp[]; skipped?: readonly PushSkip[] }
  | { direction: 'pull'; plan: PullPlan };

/**
 * A document whose two sides disagree — the input `planConflicts` (LP-257)
 * produces and the renderer shows in its own section, never merged into the
 * per-kind sections, because a conflict is a *question*, not an operation.
 */
export interface ConflictEntry {
  /** The local document id. */
  localId: string;
  /** The board field that diverged (a canonical field or an attribute name). */
  field: string;
  /** The local (board) value. */
  local: unknown;
  /** The remote value. */
  remote: unknown;
  /** The policy that would resolve it, from the remote's config. */
  policy: RemoteConflictPolicy;
}

export interface RenderPlanOptions {
  /** Board view, for titles and the status a `close` writes. */
  board?: BoardView;
  /** Link store, for the base values a push renders as its "remote" column. */
  links?: LinkStore;
  /** Conflicts to render in their own section. */
  conflicts?: readonly ConflictEntry[];
  /** Secret values to redact wherever they appear in the rendering. */
  secrets?: readonly string[];
}

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

/** One field's detail: what the board has, what the remote has, what happens. */
export interface RenderedField {
  /** Display name (`title`, `status`, `attributes.story_points`, `depends_on`…). */
  field: string;
  /** The local (board) value. `null` means "absent on the board". */
  local: unknown;
  /** The remote value — the base snapshot, or `null` when the remote has none. */
  remote: unknown;
  /** What the operation does to this field: `created`, `updated`, `closed`, … */
  outcome: string;
}

/** One document's detail in a section. */
export interface RenderedDocument {
  /** The local id the operation names. */
  localId: string;
  /** The document's title, when the board was provided. */
  title?: string;
  /** The remote id of the twin, when the operation names one. */
  remoteId?: string;
  /** The operation kind this document appears under. */
  kind: string;
  /** Per-field detail. */
  fields: RenderedField[];
}

/** One operation kind, grouped with its count and documents. */
export interface RenderedSection {
  kind: string;
  /** Human label for the kind (`create`, `transition`, `unlink locally`, …). */
  label: string;
  /** Number of documents in this section. */
  count: number;
  documents: RenderedDocument[];
}

/** A conflict, rendered with both sides and the resolving policy. */
export interface RenderedConflict {
  localId: string;
  title?: string;
  field: string;
  local: unknown;
  remote: unknown;
  /** The policy label: `manual`, `local wins`, or `remote wins`. */
  policy: string;
}

/** The plan as a diff: structured data plus the plain text the CLI prints. */
export interface PlanRender {
  /** Total operations (push ops, or pull changes plus link effects). */
  total: number;
  /** One section per operation kind, in a fixed order; counts first. */
  sections: RenderedSection[];
  /** Conflicts, always present and always last (possibly empty). */
  conflicts: RenderedConflict[];
  /** The plain-text form; the CLI prints it verbatim. */
  text: string;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** The fixed order sections are grouped in, for both directions. */
const KIND_ORDER = [
  'create',
  'restore',
  'update',
  'transition',
  'close',
  'reparent',
  'link',
  'unlink',
  'edges',
  'comment',
  'managedComment',
  'unlinkLocal',
  'decouple',
  'conflicted',
  'skipped',
  'delete',
] as const;

const KIND_LABELS: Record<string, string> = {
  create: 'create',
  restore: 'restore',
  update: 'update',
  transition: 'transition',
  close: 'close',
  reparent: 'reparent',
  link: 'link',
  unlink: 'unlink',
  edges: 'edges',
  comment: 'comment',
  managedComment: 'managed comment',
  unlinkLocal: 'unlink locally',
  decouple: 'decouple',
  conflicted: 'conflicted',
  skipped: 'skipped',
  delete: 'delete',
};

const POLICY_LABELS: Record<RemoteConflictPolicy, string> = {
  manual: 'manual',
  local: 'local wins',
  remote: 'remote wins',
};

// ---------------------------------------------------------------------------
// Field flattening
// ---------------------------------------------------------------------------

/** True when a value carries nothing worth writing on a create. */
function isBlank(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return Array.isArray(value) && value.length === 0;
}

/** The fields a create carries, in a stable display order, blanks omitted. */
function flattenBoardFields(fields: BoardFields | Partial<BoardFields>): Array<{
  field: string;
  value: unknown;
}> {
  const out: Array<{ field: string; value: unknown }> = [];
  const push = (field: string, value: unknown): void => {
    if (value === undefined) return;
    out.push({ field, value });
  };

  push('title', fields.title);
  push('body', fields.body);
  push('type', fields.type);
  push('status', fields.status);
  if (!isBlank(fields.assignee)) push('assignee', fields.assignee);
  if (!isBlank(fields.period)) push('period', fields.period);
  if (fields.attributes) {
    for (const [name, value] of Object.entries(fields.attributes)) {
      // An unset attribute is nothing to create; a blank value is not a diff.
      if (isBlank(value)) continue;
      push(`attributes.${name}`, value);
    }
  }
  return out;
}

/** The field-level diffs an `update` op produces, remote side from the base. */
function updateFields(
  fields: Partial<BoardFields>,
  base: Record<string, unknown> | undefined,
): RenderedField[] {
  const out: RenderedField[] = [];
  const add = (field: string, local: unknown, remote: unknown): void => {
    out.push({ field, local, remote, outcome: 'updated' });
  };

  if (fields.title !== undefined) add('title', fields.title, base?.title ?? null);
  if (fields.body !== undefined) add('body', fields.body, base?.body ?? null);
  if (fields.assignee !== undefined) add('assignee', fields.assignee, base?.assignee ?? null);
  if (fields.period !== undefined) add('period', fields.period, base?.period ?? null);
  if (fields.attributes) {
    for (const [name, value] of Object.entries(fields.attributes)) {
      add(`attributes.${name}`, value, base?.[name] ?? null);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The diff, per operation
// ---------------------------------------------------------------------------

/** The local id an op acts on, for the summary and the base lookup. */
function localIdOf(op: RemoteOp): string {
  switch (op.kind) {
    case 'link':
    case 'unlink':
      return op.dependent.localId;
    case 'comment':
      return op.ref.localId;
    default:
      return op.localId;
  }
}

/** The base snapshot of a document, or undefined when there is none. */
function baseOf(links: LinkStore | undefined, localId: string): Record<string, unknown> | undefined {
  return links?.links.get(localId)?.base;
}

/** One operation, flattened into a document diff. */
interface Diff {
  localId: string;
  title?: string;
  remoteId?: string;
  kind: string;
  fields: RenderedField[];
}

function pushDiff(op: RemoteOp, options: RenderPlanOptions): Diff {
  const localId = localIdOf(op);
  const board = options.board;
  const base = baseOf(options.links, localId);
  const title = board?.nodes[localId]?.title;

  switch (op.kind) {
    case 'create':
      return {
        localId,
        title,
        kind: 'create',
        fields: flattenBoardFields(op.fields).map(({ field, value }) => ({
          field,
          local: value,
          remote: null,
          outcome: 'created',
        })),
      };

    case 'update':
      return {
        localId,
        title,
        remoteId: op.ref.remoteId,
        kind: 'update',
        fields: updateFields(op.fields, base),
      };

    case 'transition':
      return {
        localId,
        title,
        remoteId: op.ref.remoteId,
        kind: 'transition',
        fields: [
          {
            field: 'status',
            local: op.status,
            remote: base?.status ?? null,
            outcome: `transition to ${op.status}`,
          },
        ],
      };

    case 'close': {
      const node = board?.nodes[localId];
      const status = node && node.kind === 'issue' ? node.status : null;
      return {
        localId,
        title,
        remoteId: op.ref.remoteId,
        kind: 'close',
        fields: [
          { field: 'status', local: status, remote: base?.status ?? null, outcome: 'closed' },
          ...(op.note !== undefined
            ? [{ field: 'comment', local: op.note, remote: null, outcome: 'posted — closed by on_delete policy' }]
            : []),
        ],
      };
    }

    case 'delete': {
      return {
        localId,
        title,
        remoteId: op.ref.remoteId,
        kind: 'delete',
        fields: [
          {
            field: 'twin',
            local: null,
            remote: op.ref.remoteId,
            outcome: 'deleted (or closed where the platform cannot hard-delete)',
          },
        ],
      };
    }

    case 'reparent': {
      const parent = op.parent ?? op.blockParent;
      const outcome =
        parent === undefined
          ? 'parent cleared — filed at the root'
          : op.parent !== undefined
            ? `reparent natively under ${parent.localId}`
            : `parent moves to the managed block under ${parent.localId}`;
      return {
        localId,
        title,
        remoteId: op.ref.remoteId,
        kind: 'reparent',
        fields: [
          {
            field: 'parent',
            local: parent?.localId ?? null,
            remote: base?.['parent'] ?? null,
            outcome,
          },
        ],
      };
    }

    case 'link': {
      const relates = op.linkKind === 'relates';
      return {
        localId,
        title,
        remoteId: op.dependent.kind === 'linked' ? op.dependent.remoteId : undefined,
        kind: 'link',
        fields: [
          {
            field: relates ? 'relates_to' : 'depends_on',
            local: op.dependency.localId,
            remote: null,
            outcome: relates
              ? `relates to ${op.dependency.localId}`
              : `depends on ${op.dependency.localId}`,
          },
        ],
      };
    }

    case 'unlink': {
      const relates = op.linkKind === 'relates';
      return {
        localId,
        title,
        remoteId: op.dependent.remoteId,
        kind: 'unlink',
        fields: [
          {
            field: relates ? 'relates_to' : 'depends_on',
            local: null,
            remote: op.dependency.localId,
            outcome: relates
              ? `no longer relates to ${op.dependency.localId}`
              : `no longer depends on ${op.dependency.localId}`,
          },
        ],
      };
    }

    case 'edges':
      return {
        localId,
        title,
        remoteId: op.ref.kind === 'linked' ? op.ref.remoteId : undefined,
        kind: 'edges',
        fields: [
          {
            field: 'managed block',
            local: null,
            remote: null,
            outcome: `depends_on ${op.dependsOn.map((r) => r.localId).join(', ') || '—'}; relates_to ${op.relatesTo.map((r) => r.localId).join(', ') || '—'}`,
          },
        ],
      };

    case 'comment':
      return {
        localId,
        title,
        remoteId: op.ref.kind === 'linked' ? op.ref.remoteId : undefined,
        kind: 'comment',
        fields: [{ field: 'comment', local: op.body, remote: null, outcome: 'posted' }],
      };

    case 'managedComment':
      return {
        localId,
        title,
        remoteId: op.ref.remoteId,
        kind: 'managedComment',
        fields: [
          {
            field: 'managed comment',
            local: op.entries.map((entry) => entry.name).join(', '),
            remote: null,
            outcome: op.entries.length === 0 ? 'removed' : 'written',
          },
        ],
      };

    case 'unlinkLocal':
      return {
        localId,
        title,
        remoteId: options.links?.links.get(localId)?.remoteId,
        kind: 'unlinkLocal',
        fields: [
          {
            field: 'link',
            local: null,
            remote: options.links?.links.get(localId)?.remoteId ?? null,
            outcome: 'detached locally',
          },
        ],
      };

    case 'decouple':
      return {
        localId,
        title,
        remoteId: options.links?.links.get(localId)?.remoteId,
        kind: 'decouple',
        fields: [
          {
            field: 'link',
            local: null,
            remote: options.links?.links.get(localId)?.remoteId ?? null,
            outcome: `decoupled (${op.reason}) — remote left alone`,
          },
        ],
      };

    case 'restore':
      return {
        localId,
        title,
        remoteId: op.oldRemoteId,
        kind: 'restore',
        fields: [
          {
            field: 'twin',
            local: null,
            remote: op.oldRemoteId,
            outcome: 're-filed under a new id — a re-file, not an undelete',
          },
        ],
      };
  }
}

/** A pull change (or link effect), flattened into a document diff. */
function pullDiffs(plan: PullPlan, options: RenderPlanOptions): Diff[] {
  const diffs: Diff[] = [];
  const board = options.board;

  for (const change of plan.changes) {
    const node = board?.nodes[change.id];
    switch (change.kind) {
      case 'create': {
        // A create has no board side yet, so the "remote" column carries the
        // patch and the "local" column is empty.
        diffs.push({
          localId: change.id,
          title: node?.title ?? change.patch.title,
          kind: 'create',
          fields: flattenBoardFields(change.patch).map(({ field, value }) => ({
            field,
            local: null,
            remote: value,
            outcome: 'created',
          })),
        });
        break;
      }
      case 'update': {
        diffs.push({
          localId: change.id,
          title: node?.title,
          kind: 'update',
          fields: patchUpdateFields(change.patch, node, 'updated'),
        });
        break;
      }
      case 'delete': {
        diffs.push({ localId: change.id, title: node?.title, kind: 'delete', fields: [] });
        break;
      }
    }
  }

  // Correspondence effects that travel with the changes: a `record` is implied
  // by its create, but an `unlink` (the twin is gone and the link goes with it)
  // and a `decouple` (a tombstone, so the document is never re-filed) are real
  // effects and are shown rather than silently absorbed.
  for (const op of plan.links) {
    if (op.kind === 'unlink') {
      const remoteId = options.links?.links.get(op.localId)?.remoteId;
      diffs.push({
        localId: op.localId,
        title: board?.nodes[op.localId]?.title,
        remoteId,
        kind: 'unlinkLocal',
        fields: [
          { field: 'link', local: null, remote: remoteId ?? null, outcome: 'twin gone — link dropped' },
        ],
      });
    } else if (op.kind === 'decouple') {
      const remoteId = options.links?.links.get(op.localId)?.remoteId;
      diffs.push({
        localId: op.localId,
        title: board?.nodes[op.localId]?.title,
        remoteId,
        kind: 'decouple',
        fields: [
          {
            field: 'link',
            local: null,
            remote: remoteId ?? null,
            outcome: `decoupled (${op.reason}) — never re-filed`,
          },
        ],
      });
    }
  }

  // `on_delete: restore` is a pull that plans push operations: the vanished
  // twin is re-filed upstream, so those operations render like push ops.
  for (const op of plan.restore ?? []) {
    diffs.push(pushDiff(op, options));
  }

  // Documents left for a human (`on_delete: manual`, a refused delete) are a
  // question, not an operation — their own section, so a dry-run says so.
  for (const conflict of plan.conflicts ?? []) {
    diffs.push({
      localId: conflict.localId,
      title: board?.nodes[conflict.localId]?.title,
      remoteId: conflict.remoteId,
      kind: 'conflicted',
      fields: [
        {
          field: 'existence',
          local: null,
          remote: conflict.remoteId,
          outcome: conflict.reason,
        },
      ],
    });
  }

  // A field both sides edited (LP-257 AC #2) is the same shape of question: a
  // conflict, never an operation, shown with both values and left for a human.
  for (const conflict of plan.fieldConflicts ?? []) {
    diffs.push({
      localId: conflict.localId,
      title: board?.nodes[conflict.localId]?.title,
      remoteId: conflict.remoteId,
      kind: 'conflicted',
      fields: [
        {
          field: conflict.field,
          local: conflict.local,
          remote: conflict.remote,
          outcome: 'conflict — both sides edited',
        },
      ],
    });
  }

  return diffs;
}

/**
 * The field diffs a pull update produces: the board's current value is the
 * "local" side (it is about to change), the patch is the "remote" side (the
 * value the tracker carries).
 */
function patchUpdateFields(
  patch: NodePatch,
  node: BoardView['nodes'][string] | undefined,
  outcome: string,
): RenderedField[] {
  const out: RenderedField[] = [];
  const add = (field: string, remote: unknown, local: unknown): void => {
    if (remote === undefined) return;
    out.push({ field, local, remote, outcome });
  };

  add('title', patch.title, node?.title ?? null);
  add('body', patch.body, node?.body ?? null);
  add('type', patch.type, node?.type ?? null);
  add('status', patch.status, node && node.kind === 'issue' ? node.status : null);
  add('assignee', patch.assignee, node && node.kind === 'issue' ? node.assignee : null);
  add('period', patch.period, node && node.kind === 'issue' ? node.period : null);
  if (patch.attributes) {
    for (const [name, value] of Object.entries(patch.attributes)) {
      add(`attributes.${name}`, value, node?.attributes?.[name] ?? null);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Group diffs into sections, in `KIND_ORDER`, skipping empty kinds. */
function groupSections(diffs: Diff[]): RenderedSection[] {
  const byKind = new Map<string, Diff[]>();
  for (const diff of diffs) {
    const list = byKind.get(diff.kind);
    if (list) list.push(diff);
    else byKind.set(diff.kind, [diff]);
  }

  const sections: RenderedSection[] = [];
  const placed = new Set<string>();
  for (const kind of KIND_ORDER) {
    const list = byKind.get(kind);
    if (!list || list.length === 0) continue;
    placed.add(kind);
    sections.push({
      kind,
      label: KIND_LABELS[kind] ?? kind,
      count: list.length,
      documents: list,
    });
  }
  // A kind not in the fixed order (defensive; every kind is listed above).
  for (const [kind, list] of byKind) {
    if (placed.has(kind)) continue;
    sections.push({ kind, label: KIND_LABELS[kind] ?? kind, count: list.length, documents: list });
  }
  return sections;
}

/**
 * Render a plan as a diff: structured sections plus a plain-text form.
 *
 * The push plan is the `RemoteOp[]` `planPush` returned — the same list the
 * executor walks — and the pull plan is the `PullPlan` `applyPull` consumes, so
 * a `--dry-run` renders exactly what a real run would execute. Conflicts are
 * passed in (`LP-257` produces them) and rendered in their own section, never
 * merged into the operations, because a conflict is a question to answer before
 * any of the plan runs.
 *
 * Pure: no disk, no network, and every import is type-only so the web bundle
 * carries it without Node modules.
 */
export function renderPlan(plan: PlanForRender, options: RenderPlanOptions = {}): PlanRender {
  const secrets = (options.secrets ?? []).filter((secret) => secret.length > 0);
  const redact = (value: unknown): unknown => redactValue(value, secrets);
  const redactTitle = (title: string | undefined): string | undefined =>
    title === undefined ? undefined : (redact(title) as string);

  const diffs = plan.direction === 'push' ? plan.ops.map((op) => pushDiff(op, options)) : pullDiffs(plan.plan, options);

  // A push may also skip documents deliberately: a decoupled one (LP-366) and
  // one another remote already mirrors (the ledger). Both are listed rather
  // than silently omitted — a document missing from a push with no line saying
  // why is the report telling somebody their work did not file, quietly.
  if (plan.direction === 'push' && plan.skipped !== undefined) {
    for (const skip of plan.skipped) {
      const node = options.board?.nodes[skip.localId];
      const elsewhere = skip.reason === 'owned_elsewhere';
      diffs.push({
        localId: skip.localId,
        title: node?.title,
        kind: 'skipped',
        fields: [
          {
            field: elsewhere ? 'mirrored elsewhere' : 'decoupled',
            local: null,
            remote: skip.remoteKey || null,
            outcome: elsewhere
              ? `skipped — already mirrored${skip.remoteKey ? ` as ${skip.remoteKey}` : ''}`
              : `skipped — decoupled (${skip.reason})`,
          },
        ],
      });
    }
  }

  const sections = groupSections(diffs).map((section) => ({
    ...section,
    documents: section.documents.map((doc) => ({
      ...doc,
      title: redactTitle(doc.title),
      fields: doc.fields.map((field) => ({
        ...field,
        local: redact(field.local),
        remote: redact(field.remote),
      })),
    })),
  }));

  const conflicts: RenderedConflict[] = (options.conflicts ?? []).map((conflict) => ({
    localId: conflict.localId,
    title: redactTitle(options.board?.nodes[conflict.localId]?.title),
    field: conflict.field,
    local: redact(conflict.local),
    remote: redact(conflict.remote),
    policy: POLICY_LABELS[conflict.policy] ?? conflict.policy,
  }));

  const total = diffs.length;

  return { total, sections, conflicts, text: renderText(sections, conflicts, total) };
}

// ---------------------------------------------------------------------------
// The text form
// ---------------------------------------------------------------------------

/** Readable single-line form of a value, for the text columns. */
function fmt(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') {
    const flat = value.replace(/\s+/g, ' ').trim();
    const shown = flat.length > 48 ? `${flat.slice(0, 45)}…` : flat;
    return `"${shown}"`;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${value.map(fmt).join(', ')}]`;
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text + ' '.repeat(width - text.length);
}

/** The plain-text diff: counts first, then per-document detail, then conflicts. */
function renderText(
  sections: RenderedSection[],
  conflicts: RenderedConflict[],
  total: number,
): string {
  if (total === 0 && conflicts.length === 0) {
    return 'Nothing to do — the plan is empty.';
  }

  const lines: string[] = [];
  lines.push(`Sync plan — ${total} operation${total === 1 ? '' : 's'}`);
  lines.push('');

  // Counts first.
  for (const section of sections) {
    lines.push(`  ${pad(section.label, 14)}${section.count}`);
  }
  if (conflicts.length > 0) {
    lines.push(`  ${pad('conflicts', 14)}${conflicts.length}`);
  }

  // Per-document detail, grouped by kind.
  for (const section of sections) {
    lines.push('');
    lines.push(section.label);
    for (const doc of section.documents) {
      const title = doc.title !== undefined ? ` ${JSON.stringify(doc.title)}` : '';
      const remote = doc.remoteId ? ` (${doc.remoteId})` : '';
      lines.push(`  ${doc.localId}${title}${remote}`);
      for (const field of doc.fields) {
        lines.push(
          `    ${pad(field.field, 16)} local: ${pad(fmt(field.local), 26)} remote: ${pad(fmt(field.remote), 26)} ${field.outcome}`,
        );
      }
    }
  }

  // Conflicts, in their own section.
  if (conflicts.length > 0) {
    lines.push('');
    lines.push('conflicts');
    for (const conflict of conflicts) {
      const title = conflict.title !== undefined ? ` ${JSON.stringify(conflict.title)}` : '';
      lines.push(`  ${conflict.localId}${title}`);
      lines.push(
        `    ${pad(conflict.field, 16)} local: ${pad(fmt(conflict.local), 26)} remote: ${pad(fmt(conflict.remote), 26)} ${conflict.policy}`,
      );
    }
  }

  return lines.join('\n');
}
