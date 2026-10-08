/**
 * The degradation ladder as a report (LP-275): for every board construct a
 * remote must carry, which rung of the ladder it lands on and why the rung
 * above was not available.
 *
 * The ladder (LP-255) is the ordered set of carriers a field may use, best
 * first:
 *
 *   1. native        the remote has a real place for it
 *   2. custom field  the remote can be *given* one (the push creates it)
 *   3. label         a low-fidelity native carrier for enums and types
 *   4. managed block a delimited region in the issue body
 *   5. comment       the same block as a comment, when the body is not writable
 *   6. refuse        a `required` field with none of the above — the sync stops
 *
 * `preflight.ts` collects the *values* one remote cannot carry, per document,
 * offline, as a `Problem[]`. This module is the other half: the *constructs*
 * (hierarchy, type, status, each edge, each attribute, each period level) and
 * their rungs, read from the **resolved** capabilities — probes answered —
 * which is what `preflight.ts` cannot do offline. The two are complementary:
 * the value problems gate the push, the rungs are the report a person reads
 * before deciding whether to fix the tracker or accept the encoding. Nothing
 * prints these rows yet — the module has no caller outside the barrel export.
 *
 * A construct is refused (rung 6) when it is `required` and rungs 1-5 are all
 * unavailable. Only attributes carry `required`, so the bottom rung is theirs.
 * The same attribute without `required` is `dropped` instead — a warning, not
 * a stop. `refusalProblems` turns those two outcomes into the `Problem[]` a
 * sync gates on: a `refused` row is an error (a warning under `--force`), a
 * `dropped` row a warning, and both name the field, the missing capability and
 * (for a refusal) the config change that resolves it (LP-279).
 * The push is named whenever a carrier can be created through the
 * provider's API (`provisioning.customFields` / `provisioning.periods`).
 *
 * Constructs the ladder does not cover, deliberately: `comments` and
 * `incrementalRead` are sync *mechanics*, not fields, and the assignee
 * (`accounts.ts`) has no capability cell of its own — a generic pool's label
 * degradation is LP-271's, not the ladder's. Attributes are never reported
 * `native`: the capability table declares no native attribute fields, and the
 * providers implemented so far have none (GitHub); a provider with native
 * fields (Jira) will add a cell before that rung lights up.
 *
 * Pure: no disk, no network. The board, the opened remote and the resolved
 * capability table are passed in, so a dry-run is this exact code path.
 */

import type { LoadedBoard } from '../core/board/load.js';
import { hierarchyFor } from '../core/config/lookup.js';
import type { AttributeDef, Problem } from '../core/model/types.js';
import { hasPeriods } from '../core/model/types.js';
import { attributeDefsOf } from './preflight.js';
import { normalizePeriodMapping } from './periods.js';
import type { ResolvedCapabilities } from './capabilities.js';
import type { OpenedRemote } from './remotes.js';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * One rung of the degradation ladder, best first — plus `dropped`, the outcome
 * off the bottom of the ladder: a field with no carrier that is *not*
 * `required`, so it is lost with a warning rather than refused.
 */
export type Rung =
  | 'native'
  | 'custom_field'
  | 'label'
  | 'managed_block'
  | 'comment'
  | 'refused'
  | 'dropped';

/** A carrier that does not exist on the remote yet, and is created for you. */
export interface ProvisionHint {
  /** The command that creates it — the push, which does this before it files. */
  command: string;
  /** What that command would create. */
  description: string;
}

/** One construct and where it landed. */
export interface LadderRow {
  /** The construct: `hierarchy`, `type`, `status`, an edge, an attribute, a period type. */
  construct: string;
  /** The board side, human-readable — the chain, the statuses, the mapped carrier. */
  board: string;
  /** The rung the field landed on. */
  rung: Rung;
  /** Why the rung above was not available. */
  reason: string;
  /** Present when the carrier can be created through the API. */
  provision?: ProvisionHint;
}

/** Options for `preflightLadder`. */
export interface LadderOptions {
  /**
   * Whether the remote body can carry a managed block (rung 4). Defaults to
   * true. `encoding: comment` on the remote is the declared spelling of
   * `false` — derive it with `bodyWritableFor(remote)`.
   */
  bodyWritable?: boolean;
}

/** The report this module renders, for whatever comes to print it. */
export interface PreflightReport {
  remoteName: string;
  /** Provider name and its coordinates: `github: acme/payments`. */
  connection: string;
  rows: LadderRow[];
  /** Every row landed on rung 1. */
  lossless: boolean;
  /** Some `required` construct reached rung 6 — the sync must stop. */
  refused: boolean;
}

/** The rung's display name. */
const RUNG_LABEL: Record<Rung, string> = {
  native: 'native',
  custom_field: 'custom field',
  label: 'label',
  managed_block: 'managed block',
  comment: 'comment',
  refused: 'refused',
  dropped: 'dropped',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when a remote's `encoding` keeps degraded fields in the body (rung 4).
 * `encoding: comment` is the declared spelling of "the body is not writable"
 * and pushes degraded fields down to the managed comment (rung 5) instead.
 */
export function bodyWritableFor(remote: OpenedRemote): boolean {
  return remote.encoding !== 'comment';
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** A phrase naming the remote's native nesting, for hierarchy reasons. */
function depthPhrase(hierarchyDepth: number): string {
  if (hierarchyDepth === 0) return 'the remote is flat';
  if (hierarchyDepth === 1) return 'one native sub-issue level';
  return `${hierarchyDepth} native sub-issue levels`;
}

/** The hint for a carrier the push creates, when the provider can create fields. */
function customFieldHint(capabilities: ResolvedCapabilities): ProvisionHint | undefined {
  if (!capabilities.provisioning.customFields) return undefined;
  return {
    command: 'lpm remote push',
    description: 'creates the missing fields and options before it files',
  };
}

// ---------------------------------------------------------------------------
// Per-construct decisions
// ---------------------------------------------------------------------------

/** The issue hierarchy chain, for the `board` column. */
function issueChain(board: LoadedBoard): string {
  return hierarchyFor(board.config, 'issue')
    .map((level) => level.join('/'))
    .join(' > ');
}

/**
 * Nesting: native while the board is no deeper than the remote's native depth
 * (`hierarchyDepth` parent edges + the root); the extra levels' parent rides
 * the managed block. The types at those levels are the `type` row's business.
 */
function hierarchyRow(board: LoadedBoard, capabilities: ResolvedCapabilities): LadderRow {
  const hierarchy = hierarchyFor(board.config, 'issue');
  const chain = issueChain(board);
  const nativeDepth = capabilities.hierarchyDepth + 1;
  if (hierarchy.length <= nativeDepth) {
    return {
      construct: 'hierarchy',
      board: chain,
      rung: 'native',
      reason: 'fits within the remote native depth',
    };
  }
  return {
    construct: 'hierarchy',
    board: chain,
    rung: 'managed_block',
    reason: `${depthPhrase(capabilities.hierarchyDepth)}; deeper nesting is carried in the managed block`,
  };
}

/** Issue type: native where the provider has one, else a label. */
function typeRow(board: LoadedBoard, capabilities: ResolvedCapabilities): LadderRow {
  const types = hierarchyFor(board.config, 'issue').flat().join(' ');
  return capabilities.nativeTypes
    ? { construct: 'type', board: types, rung: 'native', reason: 'the remote has native issue types' }
    : { construct: 'type', board: types, rung: 'label', reason: 'no native issue type' };
}

/** Status: named workflow states are native; open/closed degrades to a field or labels. */
function statusRow(board: LoadedBoard, capabilities: ResolvedCapabilities): LadderRow {
  const statuses = board.config.statuses.map((status) => status.id).join(' ');
  if (capabilities.status.kind !== 'binary') {
    return { construct: 'status', board: statuses, rung: 'native', reason: 'native workflow states' };
  }
  const base = { construct: 'status', board: statuses };
  if (capabilities.customFields !== null) {
    return {
      ...base,
      rung: 'custom_field',
      reason: 'only open/closed natively; richer states ride a custom field',
      provision: customFieldHint(capabilities),
    };
  }
  return {
    ...base,
    rung: 'label',
    reason: 'only open/closed natively, and no custom fields — labels carry the state',
  };
}

/** A dependency edge: native where the remote holds one, else the managed block. */
function edgeRow(kind: 'depends_on' | 'relates_to', native: boolean): LadderRow {
  if (native) {
    return {
      construct: kind,
      board: '',
      rung: 'native',
      reason: kind === 'depends_on' ? 'native blocking edge' : 'native relates edge',
    };
  }
  return {
    construct: kind,
    board: '',
    rung: 'managed_block',
    reason:
      kind === 'depends_on'
        ? 'the remote has no blocking edge'
        : 'the remote has no relates edge',
  };
}

/** One declared issue attribute, walked down the ladder. */
function attributeRow(
  name: string,
  def: AttributeDef,
  mappedTo: string | undefined,
  capabilities: ResolvedCapabilities,
  bodyWritable: boolean,
): LadderRow {
  const mapped = mappedTo !== undefined && mappedTo !== '';
  const board = mapped ? `-> "${mappedTo}"` : '';

  // Rung 3: a mapped attribute rides the mapping's carrier, which for the
  // implemented provider (GitHub) is a label prefix. Rung 1 never lights up —
  // no capability cell declares native attribute fields. Rung 2 is skipped
  // because the mapping pinned the carrier to a label.
  if (mapped) {
    return {
      construct: name,
      board,
      rung: 'label',
      reason: 'no native field; the mapping carries attributes as labels',
    };
  }

  // Rung 2: an unmapped attribute can be given a custom field, when the
  // provider holds them.
  if (capabilities.customFields !== null) {
    return {
      construct: name,
      board,
      rung: 'custom_field',
      reason: 'not mapped; carried as a custom field',
      provision: customFieldHint(capabilities),
    };
  }

  // Rungs 4-6: the managed block, its comment fallback, or the stop.
  if (bodyWritable) {
    return {
      construct: name,
      board,
      rung: 'managed_block',
      reason: 'not mapped and no custom fields — carried in the managed block',
    };
  }
  if (capabilities.comments.native) {
    return {
      construct: name,
      board,
      rung: 'comment',
      reason: 'not mapped, and the body is not writable — carried as a managed comment',
    };
  }
  // Rung 6: a `required` field with none of the above is refused — the sync
  // stops rather than dropping it in silence. The same field, not required,
  // is dropped with a warning instead (the `dropped` outcome off the ladder).
  if (def.required === true) {
    return {
      construct: name,
      board,
      rung: 'refused',
      reason: 'required, and no carrier is available (no custom fields, no writable body, no comments)',
    };
  }
  return {
    construct: name,
    board,
    rung: 'dropped',
    reason: 'not required, and no carrier is available (no custom fields, no writable body, no comments)',
  };
}

/** One declared period type: the container level vs the degraded levels. */
function periodContainerRow(
  type: string,
  capabilities: ResolvedCapabilities,
  carrier: string,
): LadderRow {
  if (capabilities.periods.native || capabilities.periods.creatable) {
    const provision = capabilities.periods.native
      ? undefined
      : { command: 'lpm remote push', description: 'creates the period container before it files' };
    return {
      construct: type,
      board: `-> ${carrier}`,
      rung: 'native',
      reason: 'native period container (milestone, sprint, cycle)',
      ...(provision ? { provision } : {}),
    };
  }
  return {
    construct: type,
    board: '',
    rung: 'managed_block',
    reason: 'no native container — carried in the managed block',
  };
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/**
 * Compute the rung every board construct lands on, against one remote's
 * resolved capabilities.
 *
 * The remote must already have been opened (`openRemote`), so `remote.mapping`
 * carries the provider-validated shape; the capabilities must already have
 * been resolved (`resolveCapabilities`), so probes are answered. Both are
 * handed in rather than derived here — this function stays pure and a
 * dry-run is the exact code path a real check runs.
 */
export function preflightLadder(
  board: LoadedBoard,
  remote: OpenedRemote,
  capabilities: ResolvedCapabilities,
  options: LadderOptions = {},
): PreflightReport {
  // `encoding: comment` is the declared spelling of "the body is not
  // writable"; the option overrides it for a caller that probed a runtime
  // fact instead (a body write the remote refused).
  const bodyWritable = options.bodyWritable ?? bodyWritableFor(remote);

  const rows: LadderRow[] = [
    hierarchyRow(board, capabilities),
    typeRow(board, capabilities),
    statusRow(board, capabilities),
    edgeRow('depends_on', capabilities.edges.dependsOn),
    edgeRow('relates_to', capabilities.edges.relatesTo),
  ];

  const defs = attributeDefsOf(board);
  const attributeMapping = asRecord(remote.mapping['attributes']);
  for (const name of Object.keys(defs).sort()) {
    const mappedTo = attributeMapping[name];
    rows.push(
      attributeRow(
        name,
        defs[name]!,
        typeof mappedTo === 'string' ? mappedTo : undefined,
        capabilities,
        bodyWritable,
      ),
    );
  }

  if (hasPeriods(board.config)) {
    const periodMapping = normalizePeriodMapping(remote.mapping['periods']);
    for (const type of board.config.period_hierarchy.flat()) {
      if (periodMapping && type === periodMapping.container) {
        rows.push(periodContainerRow(type, capabilities, periodMapping.carrier));
      } else {
        rows.push({
          construct: type,
          board: '',
          rung: 'managed_block',
          reason: 'not the container level — carried as a `period:<type>` row in the managed block',
        });
      }
    }
  }

  const providerName = board.config.remotes[remote.name]?.provider ?? '';
  const repo = remote.connection['repo'];
  const connection =
    typeof repo === 'string' && repo !== ''
      ? providerName !== ''
        ? `${providerName}: ${repo}`
        : repo
      : providerName;

  return {
    remoteName: remote.name,
    connection,
    rows,
    lossless: rows.every((row) => row.rung === 'native'),
    refused: rows.some((row) => row.rung === 'refused'),
  };
}

// ---------------------------------------------------------------------------
// The text form
// ---------------------------------------------------------------------------

function pad(text: string, width: number): string {
  return text.length >= width ? `${text} ` : text + ' '.repeat(width - text.length);
}

/**
 * Render the report as text. Lossless boards get the short form — a single
 * line saying nothing is degraded (the story's third criterion). Otherwise one
 * row per construct: name, board side, rung, and the reason the rung above was
 * not available, naming the command that creates a carrier where one can be.
 */
export function renderLadderReport(report: PreflightReport): string {
  const header = `Remote "${report.remoteName}" (${report.connection})`;
  if (report.lossless) {
    return `${header} — every field round-trips losslessly.\n`;
  }

  const constructWidth = Math.max(...report.rows.map((row) => row.construct.length));
  const boardWidth = Math.max(0, ...report.rows.map((row) => row.board.length));
  const rungWidth = Math.max(...report.rows.map((row) => RUNG_LABEL[row.rung].length));

  const lines: string[] = [header, ''];
  for (const row of report.rows) {
    const provision = row.provision
      ? ` — ${row.provision.command} (${row.provision.description})`
      : '';
    lines.push(
      `  ${pad(row.construct, constructWidth)}  ${pad(row.board, boardWidth)}  ${pad(RUNG_LABEL[row.rung], rungWidth)}  ${row.reason}${provision}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// The refusal gate
// ---------------------------------------------------------------------------

/** Options for `refusalProblems`. */
export interface RefusalOptions {
  /**
   * When true, a `refused` field is a warning rather than an error — the
   * `--force` escape hatch, which lets the sync proceed once while the caller
   * lists the dropped fields in its summary and audit log.
   */
  force?: boolean;
  /** The config file path each problem is reported against. Defaults to `.lpm/config.yml`. */
  configPath?: string;
}

/**
 * The problems a ladder report raises for the sync gate (LP-279): the bottom
 * of the ladder, where a field has nowhere to go, must never be silent loss.
 *
 * A `refused` row — a `required` attribute with no carrier at all — is an
 * error that stops the sync, unless `force` downgrades it to a warning. A
 * `dropped` row — the same attribute without `required` — is always a warning
 * and the sync proceeds. Both name the field, the capability the remote lacks,
 * and (for a refusal) the concrete config change that resolves it: mapping the
 * attribute to a label, the one carrier every provider has.
 *
 * Pure: it reads the report already computed by `preflightLadder` against
 * resolved capabilities, so a dry-run and a real sync run the exact same code.
 */
export function refusalProblems(
  report: PreflightReport,
  options: RefusalOptions = {},
): Problem[] {
  const force = options.force ?? false;
  const path = options.configPath ?? '.lpm/config.yml';
  const problems: Problem[] = [];

  for (const row of report.rows) {
    if (row.rung !== 'refused' && row.rung !== 'dropped') continue;
    const key = `remotes.${report.remoteName}.mapping.attributes.${row.construct}`;
    if (row.rung === 'refused') {
      problems.push({
        level: force ? 'warn' : 'error',
        path,
        message: `${key}: attribute "${row.construct}" is ${row.reason} — map it to a label so the value is carried: ${key}: "<label>"`,
      });
    } else {
      problems.push({
        level: 'warn',
        path,
        message: `${key}: attribute "${row.construct}" is ${row.reason} — the value will be dropped`,
      });
    }
  }

  return problems;
}
