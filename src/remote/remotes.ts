/**
 * Opening a remote — the one place a raw declaration becomes a validated,
 * typed one.
 *
 * Core validated the *frame* of a remote (name, provider string, scope,
 * direction, both policies) and carried `connection` and `mapping` through as
 * opaque records. This file owns the contents: it resolves the provider and
 * runs the provider's own zod schema over those two blocks, exactly as
 * `storage/views.ts` owns a view file's contents while core owns the file.
 *
 * Nothing downstream sees the raw record form. A caller of `openRemote` gets
 * the validated connection and mapping, and the provider's connector receives
 * the same object — no provider ever re-parses raw YAML.
 */

import { remoteNamed, remoteNames } from '../core/config/lookup.js';
import { BoardError } from '../core/errors.js';
import type { BoardConfig, RemoteConfig, RemoteDirection } from '../core/model/types.js';
import { hasPeriods } from '../core/model/types.js';
import { formatZodIssues } from '../core/model/zod.js';
import type { BoardPaths } from '../core/storage/paths.js';
import { resolveConnectionSecrets } from './credentials.js';
import {
  missingStatusMappings,
  normalizeStatusMappings,
} from './mapping.js';
import { isProbe } from './capabilities.js';
import { normalizePeriodMapping, resolvePeriodContainer } from './periods.js';
import type { Connector, Provider } from './provider.js';
import { redactor } from './redact.js';
import { lookupProvider } from './registry.js';
import { findMarkers, MARKER_PREFIX } from './scaffold.js';

/**
 * One remote, opened: the frame core validated, plus the provider-specific
 * `connection` and `mapping` validated by the provider's own schema. `scope`
 * is absent when the remote mirrors the whole board.
 */
export interface OpenedRemote {
  name: string;
  provider: Provider;
  scope?: string;
  direction: RemoteConfig['direction'];
  on_delete: RemoteConfig['on_delete'];
  conflict: RemoteConfig['conflict'];
  /**
   * The bulk guard fraction (LP-364): a run where more than this fraction of
   * linked twins is missing at once is treated as unreachable. Absent when not
   * configured; the resolver applies its default (0.5).
   */
  bulk_guard?: number;
  /**
   * The write threshold (LP-350): a push whose plan creates or closes more
   * than this many issues stops and requires `--yes`. Absent when not
   * configured; the resolver applies its default (25).
   */
  write_threshold?: number;
  /**
   * Per-field conflict overrides, keyed by board field name → owner. A field
   * present here never conflicts; the named side simply wins (LP-286).
   */
  fields: RemoteConfig['fields'];
  /**
   * Where degraded fields are encoded: `block` (the body) or `comment` (the
   * managed comment, when the body is not writable). Defaults to `block`.
   */
  encoding: RemoteConfig['encoding'];
  /** How user comments sync: `push` (default) or `both` (LP-316). */
  comments: RemoteConfig['comments'];
  /** The provider's validated connection block (defaults applied). */
  connection: Record<string, unknown>;
  /** The provider's validated mapping block (defaults applied). */
  mapping: Record<string, unknown>;
}

/**
 * Resolve and validate one declared remote.
 *
 * The provider is looked up by the `provider` string core stored, and its zod
 * schema is run over `connection` and `mapping`. A missing required key (say a
 * GitHub remote with no `repo`) surfaces here as a `BoardError` naming the
 * remote, the offending key, and its path under `remotes:` in the config —
 * never as a raw zod dump, and never where the file was read.
 *
 * Throws `BoardError` when the remote is not declared, the provider is
 * unknown, or the provider's schema rejects the block.
 */
export function openRemote(config: BoardConfig, name: string): OpenedRemote {
  const declared = remoteNamed(config, name);
  if (!declared) {
    const names = remoteNames(config);
    throw new BoardError(`No remote named "${name}"`, [
      names.length > 0 ? `Declared remotes: ${names.join(', ')}` : 'This board declares no remotes',
    ]);
  }

  // Refuse a mapping that still carries a scaffold marker (LP-369): a `TODO:`
  // value is a decision nobody has made, and opening the remote would treat it
  // as a real mapping — filing against a placeholder.  The scan runs on the
  // *raw* mapping core stored, before the provider schema, so a marker in a
  // key the schema would strip is still caught rather than silently dropped.
  const markers = findMarkers(declared.mapping);
  if (markers.length > 0) {
    throw new BoardError(
      `Remote "${name}" cannot be opened: the mapping scaffold has unresolved markers`,
      markers.map(
        (entry) =>
          `remotes.${name}.mapping.${entry.path}: ${MARKER_PREFIX} ${entry.question}`,
      ),
    );
  }

  const provider = lookupProvider(declared.provider);

  const parsed = provider.config.safeParse({
    connection: declared.connection,
    mapping: declared.mapping,
  });
  if (!parsed.success) {
    throw new BoardError(
      `Remote "${name}" (${declared.provider}) is not configured correctly`,
      formatZodIssues(parsed.error).map((line) => `remotes.${name}.${line}`),
    );
  }

  const data = parsed.data as {
    connection: Record<string, unknown>;
    mapping: Record<string, unknown>;
  };

  // Refuse to open a remote whose status mapping is not total (LP-269): a
  // board status with no remote counterpart cannot be mirrored in either
  // direction — a push would drop it and a pull could not recover it.  This
  // is the "remote refuses to open" gate, and it lives here rather than in
  // core, which never knows what a status mapping is.
  const statusMappings = normalizeStatusMappings(
    (data.mapping['statuses'] as Record<string, unknown> | undefined) ?? {},
  );
  const missing = missingStatusMappings(
    statusMappings,
    config.statuses.map((status) => status.id),
  );
  if (missing.length > 0) {
    throw new BoardError(
      `Remote "${name}" cannot be opened: not every board status is mapped`,
      missing.map((id) => `remotes.${name}.mapping.statuses: status "${id}" is not mapped`),
    );
  }

  // Refuse to open a remote on a board that uses periods but maps no level to
  // the remote's container (LP-272): an issue scheduled in a sprint could not
  // be mirrored — a push would drop its period and the remote's board would sit
  // empty while the local Gantt is full.  A board with no periods has no period
  // mapping and nothing here is required (the story's fourth criterion).
  //
  // The gate asks the *provider* first, because the demand only makes sense
  // against a native container. A provider whose `capabilities.periods.native`
  // is false has nothing to map a level *to* — the period rides the managed
  // block (rung 4) like every other field the platform cannot hold — and its
  // schema declares no `periods` key at all, so a mapping written by hand is
  // stripped by the schema and the demand can never be satisfied. That is what
  // made `jsonfile` unopenable on any board declaring period types: the one
  // provider that needs no account could not be used on the boards most likely
  // to try it (LP-531).
  // A `periods` cell declared as a probe cannot be answered here — `openRemote`
  // has no connector yet — so an unresolved cell keeps the conservative demand.
  const periodsCell = provider.capabilities.periods;
  const nativePeriods = isProbe(periodsCell) ? true : periodsCell.native;
  if (hasPeriods(config) && nativePeriods) {
    const periodMapping = normalizePeriodMapping(data.mapping['periods']);
    if (!periodMapping) {
      throw new BoardError(
        `Remote "${name}" cannot be opened: the board uses periods but no period level is mapped`,
        [
          `remotes.${name}.mapping.periods: set "container" to the period type that maps to the remote's container, or write \`periods: milestones\` / \`periods: iteration\``,
        ],
      );
    }
    // The shorthand (`periods: milestones` / `periods: iteration`) names no
    // container; the deepest level is the natural one, exactly as the scaffold
    // picks it.  The resolved form is written back so nothing downstream sees
    // an empty container.
    const resolved = resolvePeriodContainer(periodMapping, config.period_hierarchy);
    data.mapping['periods'] = { container: resolved.container, carrier: resolved.carrier };
    const declared = new Set(config.period_hierarchy.flat());
    if (!declared.has(resolved.container)) {
      throw new BoardError(
        `Remote "${name}" cannot be opened: mapping.periods.container names no period type`,
        [
          `remotes.${name}.mapping.periods.container: "${resolved.container}" is not a declared period type (declared: ${[...declared].sort().join(', ')})`,
        ],
      );
    }
    // The iteration carrier needs a Project iteration field to write to
    // (LP-313): `mapping.fields.period` names it, exactly as
    // `mapping.fields.status` names the status column.
    if (resolved.carrier === 'iteration') {
      const fields = (data.mapping['fields'] as Record<string, unknown> | undefined) ?? {};
      if (typeof fields['period'] !== 'string' || fields['period'] === '') {
        throw new BoardError(
          `Remote "${name}" cannot be opened: the iteration carrier has no Project field`,
          [
            `remotes.${name}.mapping.fields.period: set it to the Project iteration field name (e.g. \`period: Sprint\`)`,
          ],
        );
      }
    }
  }

  return {
    name,
    provider,
    scope: declared.scope,
    direction: declared.direction,
    on_delete: declared.on_delete,
    conflict: declared.conflict,
    bulk_guard: declared.bulk_guard,
    write_threshold: declared.write_threshold,
    fields: declared.fields,
    encoding: declared.encoding,
    comments: declared.comments,
    connection: data.connection,
    mapping: data.mapping,
  };
}

/**
 * True when a remote of this direction runs the pull planner.
 *
 * `direction: push` makes this false — the pull plans **nothing**, and the
 * caller must say so rather than reporting "up to date". "Up to date" is a
 * pull that ran and found nothing changed; a remote pinned to push-only did
 * not even look, and pretending otherwise would tell the operator the two
 * sides agree when they were never compared.
 */
export function pulls(direction: RemoteDirection): boolean {
  return direction === 'both' || direction === 'pull';
}

/** True when a remote of this direction runs the push planner. */
export function pushes(direction: RemoteDirection): boolean {
  return direction === 'both' || direction === 'push';
}

/**
 * Build a live connector for a remote, resolving its credentials first.
 *
 * This is the one place a connector is built from a validated remote, so the
 * credential resolution (LP-295) cannot be skipped: `${VAR}` is read from the
 * environment, an omitted secret is looked up in `.lpm/credentials.json` and
 * then the platform's conventional env var, and a literal secret is refused.
 * Every caller that needs to talk to the remote goes through here rather than
 * calling `provider.connector(connection, mapping)` with the unresolved block.
 */
export function buildConnector(remote: OpenedRemote, paths: BoardPaths): Connector {
  const secrets = remote.provider.credentials?.secrets ?? {};
  const connection = resolveConnectionSecrets(remote.name, remote.connection, secrets, paths);
  // Register every resolved secret with the process-wide redactor, so the
  // output sink redacts it from anything this run prints — including the
  // failure of the very request about to be made (LP-296).
  for (const key of Object.keys(secrets)) {
    const value = connection[key];
    if (typeof value === 'string') redactor.register(value);
  }
  return remote.provider.connector(connection, remote.mapping, {
    paths,
    remoteName: remote.name,
  });
}
