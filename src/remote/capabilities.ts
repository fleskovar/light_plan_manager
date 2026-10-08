/**
 * What a provider can actually hold, declared as data — and the probe that
 * answers the few facts only a live remote knows (LP-274).
 *
 * A provider declares its capabilities as a *record* with one cell per aspect
 * the sync layer needs to decide how to degrade (LP-255): hierarchy depth,
 * native types, status mechanism, edge kinds, custom-field types, provisioning,
 * periods, comments, incremental read and where the remote vocabulary comes
 * from. Each cell is either a literal value
 * (a static fact about the platform) or a probe marker naming a connector probe
 * that answers it against the live remote.
 *
 * The split exists because static-only capabilities age badly: sub-issues,
 * Projects v2 fields and Jira's hierarchy levels all vary by plan and rollout.
 * A version constant would be wrong within a quarter, so those cells are
 * `{ probe: "<name>" }` and the connector's `probe(name)` answers them once per
 * remote, cached in `.lpm/remotes/<name>/capabilities.json` so a dry-run, a
 * preflight and a real sync all read the same resolved table without re-probing
 * on every call.
 *
 * The cache is a cache: a corrupt file is reported, not repaired (delete it to
 * re-probe), and a stale entry is re-probed the next time `resolveCapabilities`
 * runs. `DEFAULT_PROBE_MAX_AGE_MS` is the freshness window when the caller does
 * not pass one.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BoardError } from '../core/errors.js';
import type { BoardPaths } from '../core/storage/paths.js';
import type { HierarchyAnchor } from './hierarchy.js';

// ---------------------------------------------------------------------------
// The capability record
// ---------------------------------------------------------------------------

/** How a provider represents workflow state remotely. */
export type StatusMechanism =
  /** A binary open/closed pair — GitHub issues. */
  | { kind: 'binary'; open: string; closed: string }
  /** A named set of workflow states — Linear team states, Projects v2 status. */
  | { kind: 'states' }
  /** Transition-mediated states — Jira. */
  | { kind: 'transitions' };

/** Which dependency edge kinds the provider holds natively. */
export interface EdgeKinds {
  dependsOn: boolean;
  relatesTo: boolean;
}

/**
 * The custom-field value types the provider can be given (and, where
 * `provisioning.customFields` is true, created). `valueTypes` uses the
 * provider's own names (`text`, `number`, `single_select`, ...) — the mapping
 * engine is the only reader and never invents a type.
 */
export interface CustomFieldTypes {
  valueTypes: readonly string[];
}

/** What the provider can create through its API, which a push does before it
 * files anything (`src/remote/prerequisites.ts`). */
export interface Provisioning {
  customFields: boolean;
  periods: boolean;
  /** Whether the provider's label list is creatable by a push. */
  labels: boolean;
}

/** Native period containers — a milestone, sprint, cycle or iteration. */
export interface PeriodSupport {
  /** True when the provider holds a native period container. */
  native: boolean;
  /** True when the provider can create containers through its API. */
  creatable: boolean;
}

/**
 * What a provider can do with comments, beyond merely holding them (LP-278).
 *
 * The degradation ladder's rung 5 needs only "comments exist" (`native`); the
 * managed-comment fallback needs the other two. A comment that cannot be
 * edited but can be deleted is updated by delete-then-repost; one that can do
 * neither can only ever be posted once, so a change to it is refused rather
 * than silently dropped.
 */
export interface CommentSupport {
  /** True when the provider holds comments at all (rung 5 is reachable). */
  native: boolean;
  /** True when a posted comment can be edited in place. */
  editable: boolean;
  /** True when a posted comment can be deleted (needed for delete-then-repost). */
  deletable: boolean;
}

/**
 * Who decides what the remote's type and status names *are* (LP-369's gap).
 *
 * `fixed` — the platform's own vocabulary pre-exists and can only be
 * discovered by asking it: Jira's issue types and workflow statuses, Linear's
 * team states. A scaffold cannot name one of these without a live remote, so
 * it asks a person instead of guessing a real-looking value that would fail at
 * the first sync.
 *
 * `open` — the vocabulary is whatever light-plan writes, because light-plan
 * owns the store. `jsonfile` is the case: the tracker file does not exist
 * until the first sync creates it, and its `type` and `status` fields hold the
 * strings we put there. There is nothing to ask about, so a scaffold names
 * them after the board's own types and statuses and leaves no marker behind.
 */
export type VocabularySource = 'fixed' | 'open';

/** How the provider supports incremental listing of changes. */
export type IncrementalRead =
  /** A server-side `since` / `updatedAt` timestamp. */
  | { kind: 'since' }
  /** An opaque page token / relay cursor. */
  | { kind: 'cursor' }
  /** No incremental listing; every pull is a full scan. */
  | { kind: 'none' };

/**
 * One capability cell: either a literal value (a static fact) or a probe
 * marker naming a connector probe that answers it against the live remote —
 * a plan tier, a permission, an API that may be disabled.
 */
export type Probeable<T> = T | { probe: string };

/**
 * What a provider can actually hold, as a table. Ten cells, matching the
 * ladder's needs (LP-255); every cell may be static or probed.
 */
export interface Capabilities {
  /** How many native parent levels the provider holds (0 = flat). */
  hierarchyDepth: Probeable<number>;
  /**
   * Which end of the *board* those levels are spent on (`HierarchyAnchor`).
   * Omitted means `root`, which is right for a type-blind parent edge like
   * GitHub's sub-issues. A provider whose hierarchy is defined from the bottom
   * up — Jira's `Subtask` < standard < `Epic` — declares `leaf`, or the native
   * edge lands at the levels it refuses. Static: it is a property of the
   * platform's model, not of one project.
   */
  hierarchyAnchor?: HierarchyAnchor;
  /** Whether the provider holds a native issue-type field. */
  nativeTypes: Probeable<boolean>;
  /** How workflow state is represented. */
  status: Probeable<StatusMechanism>;
  /** Which dependency edge kinds are native. */
  edges: Probeable<EdgeKinds>;
  /** The custom-field value types available, or null when there are none. */
  customFields: Probeable<CustomFieldTypes | null>;
  /** What can be created through the API. */
  provisioning: Probeable<Provisioning>;
  /** Native period containers. */
  periods: Probeable<PeriodSupport>;
  /** What comments can do: held at all, editable, deletable. */
  comments: Probeable<CommentSupport>;
  /** Incremental listing. */
  incrementalRead: Probeable<IncrementalRead>;
  /** Who decides the remote type / status names: the platform, or us. */
  vocabulary: Probeable<VocabularySource>;
}

/** `Capabilities` with every probe answered: all cells are concrete values. */
export type ResolvedCapabilities = {
  // A probed cell resolves to its answer; a plain one (the hierarchy anchor,
  // which is a property of the platform's model and never probed) is carried
  // through as declared.
  [K in keyof Capabilities]: Capabilities[K] extends Probeable<infer T>
    ? T
    : Capabilities[K];
};

/** True when a capability cell is a probe marker rather than a literal value. */
export function isProbe<T>(value: Probeable<T>): value is { probe: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'probe' in value &&
    typeof (value as { probe?: unknown }).probe === 'string'
  );
}

/**
 * A capability record with every cell a static literal — the "holds nothing"
 * baseline a test double or a hypothetical flat provider starts from.
 */
export function emptyCapabilities(): Capabilities {
  return {
    hierarchyDepth: 0,
    nativeTypes: false,
    status: { kind: 'binary', open: 'open', closed: 'closed' },
    edges: { dependsOn: false, relatesTo: false },
    customFields: null,
    provisioning: { customFields: false, periods: false, labels: false },
    periods: { native: false, creatable: false },
    comments: { native: false, editable: false, deletable: false },
    incrementalRead: { kind: 'none' },
    vocabulary: 'fixed',
  };
}

/**
 * The best a mapping scaffold can say about a provider with no live remote to
 * ask — `lpm remote add`, before any credential exists or a connector has
 * ever been built. Every literal cell in the declared table is kept exactly
 * as the provider states it (GitHub's binary `status`, Jira's native
 * `nativeTypes` — neither of those varies by plan or rollout, so there is
 * nothing to be conservative about). Every *probed* cell — a fact that does
 * vary (a plan tier, a rollout, a permission) and can only be answered live —
 * is resolved to the reading that assumes the *least* capable platform:
 * `false`/`null`/"no native container" rather than a guess that could
 * overclaim a feature the remote turns out not to have.
 *
 * The point is not to be right — it is to never be *wrongly specific*. An
 * overclaimed capability would draft a mapping that names a real-looking
 * field the platform does not have, which fails at the first sync in a
 * confusing way; an underclaimed one drafts a mapping that rides a label or
 * asks a `TODO:` question instead, which is always safe to fill in by hand.
 * `lpm remote setup` — and the first real sync — is what confirms the live
 * answer; this is only ever a starting point.
 */
export function staticCapabilities(declared: Capabilities): ResolvedCapabilities {
  function settle<T>(value: Probeable<T>, conservative: T): T {
    return isProbe(value) ? conservative : value;
  }
  return {
    hierarchyDepth: settle(declared.hierarchyDepth, 0),
    ...(declared.hierarchyAnchor !== undefined ? { hierarchyAnchor: declared.hierarchyAnchor } : {}),
    nativeTypes: settle(declared.nativeTypes, false),
    status: settle(declared.status, { kind: 'states' }),
    edges: settle(declared.edges, { dependsOn: false, relatesTo: false }),
    customFields: settle(declared.customFields, null),
    provisioning: settle(declared.provisioning, { customFields: false, periods: false, labels: false }),
    periods: settle(declared.periods, { native: false, creatable: false }),
    comments: settle(declared.comments, { native: false, editable: false, deletable: false }),
    incrementalRead: settle(declared.incrementalRead, { kind: 'none' }),
    vocabulary: settle(declared.vocabulary, 'fixed'),
  };
}

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

/**
 * The connector surface a probe may use. A fake connector in a test supplies
 * `probe` answers directly, so nothing that resolves capabilities ever needs
 * the network — the live connector is the only implementation that reaches it.
 */
export interface ProbeConnector {
  readonly name: string;
  /** Answer a provider-specific capability probe by name. */
  probe?(probeName: string): Promise<unknown>;
}

/** How long a cached probe answer stays fresh, when the caller passes no age. */
export const DEFAULT_PROBE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // one day

/** Options for `resolveCapabilities`. */
export interface ResolveOptions {
  /** Re-run every probe regardless of its cached age. */
  refresh?: boolean;
  /** A cached probe older than this (ms) is re-run. Defaults to `DEFAULT_PROBE_MAX_AGE_MS`. */
  maxAgeMs?: number;
  /** Clock, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** What `resolveCapabilities` returns. */
export interface ResolveResult {
  /** The declared table with every probe answered. */
  capabilities: ResolvedCapabilities;
  /** The cache with fresh answers merged in — persist with `saveCapabilityCache`. */
  cache: CapabilityCache;
  /** Probe names (re)run by this call, in declaration order. */
  refreshed: string[];
}

/**
 * Answer every probe cell in a declared `Capabilities` record against one
 * remote, using the cache when an entry is fresh and the connector when it is
 * not (or `refresh` is set). Pure in the sense that it touches neither disk nor
 * network itself — the cache and the connector are both handed in.
 */
export async function resolveCapabilities(
  declared: Capabilities,
  connector: ProbeConnector,
  cache: CapabilityCache,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_PROBE_MAX_AGE_MS;
  const now = opts.now ?? Date.now;
  const refreshed: string[] = [];
  const probes = new Map(cache.probes);

  async function answer<T>(value: Probeable<T>): Promise<T> {
    if (!isProbe(value)) return value;

    const probeName = value.probe;
    const cached = probes.get(probeName);
    if (cached && !opts.refresh) {
      const probedAt = Date.parse(cached.probedAt);
      if (!Number.isNaN(probedAt) && now() - probedAt <= maxAgeMs) {
        return cached.value as T;
      }
    }

    if (typeof connector.probe !== 'function') {
      throw new BoardError(
        `Provider "${connector.name}" declares a probe "${probeName}" but its connector does not answer probes`,
      );
    }
    const probedValue = await connector.probe(probeName);
    probes.set(probeName, { probedAt: new Date(now()).toISOString(), value: probedValue });
    refreshed.push(probeName);
    return probedValue as T;
  }

  const capabilities: ResolvedCapabilities = {
    hierarchyDepth: await answer(declared.hierarchyDepth),
    ...(declared.hierarchyAnchor !== undefined ? { hierarchyAnchor: declared.hierarchyAnchor } : {}),
    nativeTypes: await answer(declared.nativeTypes),
    status: await answer(declared.status),
    edges: await answer(declared.edges),
    customFields: await answer(declared.customFields),
    provisioning: await answer(declared.provisioning),
    periods: await answer(declared.periods),
    comments: await answer(declared.comments),
    incrementalRead: await answer(declared.incrementalRead),
    vocabulary: await answer(declared.vocabulary),
  };

  return { capabilities, cache: { version: cache.version, probes }, refreshed };
}

// ---------------------------------------------------------------------------
// The cache on disk
// ---------------------------------------------------------------------------

/** One probe's cached answer. */
export interface CachedProbe {
  /** ISO-8601 timestamp of when the probe last ran. */
  probedAt: string;
  /** The probe's answer — the concrete capability cell value. */
  value: unknown;
}

/** What lives on disk inside `.lpm/remotes/<name>/capabilities.json`. */
export interface CapabilityCacheFile {
  version: 1;
  /** Cached probe answers, keyed by probe name. Written in sorted key order. */
  probes: Record<string, CachedProbe>;
}

/** The capability cache in memory. */
export interface CapabilityCache {
  version: number;
  /** Probe name → cached answer. */
  probes: Map<string, CachedProbe>;
}

/** The path to one remote's capability cache. */
export function capabilitiesPath(paths: BoardPaths, remoteName: string): string {
  return path.join(paths.remotesDir, remoteName, 'capabilities.json');
}

/** An empty cache — the state before the first probe has run. */
function emptyCache(): CapabilityCache {
  return { version: 1, probes: new Map() };
}

/**
 * Read the capability cache from disk. A missing file is a valid empty cache —
 * the first `resolveCapabilities` populates it. A file that exists but cannot
 * be parsed (or is the wrong version) is a `BoardError` naming the path; delete
 * it to re-probe the remote.
 */
export function loadCapabilityCache(paths: BoardPaths, remoteName: string): CapabilityCache {
  const file = capabilitiesPath(paths, remoteName);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return emptyCache();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new BoardError(`Cannot parse capability cache: ${file}`, [
      (error as Error).message,
      'Delete it to re-probe the remote, or repair the JSON.',
    ]);
  }

  const store = parsed as Partial<CapabilityCacheFile>;
  if (store.version !== 1) {
    const newer = typeof store.version === 'number' && store.version > 1;
    throw new BoardError(
      newer
        ? `Capability cache at ${file} was written by a newer version of light-plan`
        : `Unsupported capability cache version in ${file}`,
      newer
        ? [
            `This file is version ${store.version}; this build of light-plan understands version 1.`,
            'Upgrade light-plan to read this file, or delete it to re-probe the remote.',
          ]
        : [
            `Found version ${JSON.stringify(store.version)}; expected 1.`,
            'Delete it to re-probe the remote, or repair the version field.',
          ],
    );
  }

  const probes = new Map<string, CachedProbe>();
  const rawProbes = store.probes as unknown as Record<string, unknown> | undefined;
  if (rawProbes && typeof rawProbes === 'object') {
    for (const [name, entry] of Object.entries(rawProbes)) {
      if (!entry || typeof entry !== 'object') {
        throw new BoardError(`Invalid capability cache: ${file}`, [
          `Probe "${name}" is not an object (got ${typeof entry}).`,
          'Delete it to re-probe the remote, or repair the entry.',
        ]);
      }
      const cached = entry as Record<string, unknown>;
      if (typeof cached.probedAt !== 'string') {
        throw new BoardError(`Invalid capability cache: ${file}`, [
          `Probe "${name}" is missing a valid probedAt (got ${JSON.stringify(cached.probedAt)}).`,
          'Delete it to re-probe the remote, or provide a valid ISO timestamp.',
        ]);
      }
      probes.set(name, { probedAt: cached.probedAt, value: cached.value });
    }
  }

  return { version: store.version, probes };
}

/**
 * Write the capability cache to disk. Creates the per-remote folder if it does
 * not exist. Keys are written sorted so two syncs probing different facts
 * produce a non-overlapping diff, exactly like the link store.
 */
export function saveCapabilityCache(
  paths: BoardPaths,
  remoteName: string,
  cache: CapabilityCache,
): void {
  const file = capabilitiesPath(paths, remoteName);
  mkdirSync(path.dirname(file), { recursive: true });

  const sorted = [...cache.probes.keys()].sort();
  const probes: Record<string, CachedProbe> = {};
  for (const name of sorted) {
    probes[name] = cache.probes.get(name)!;
  }

  const onDisk: CapabilityCacheFile = { version: 1, probes };
  writeFileSync(file, `${JSON.stringify(onDisk, null, 2)}\n`, 'utf8');
}
