/**
 * Remote configuration as a check pass — the "is this remote ready to sync?"
 * half of `lpm check`.
 *
 * Layering, decided deliberately: `src/core/validation/check.ts` may not
 * import `src/remote`, so nothing here runs from core's `checkBoard`. The CLI
 * composes the two: `lpm check` runs `checkBoard` for the board and this
 * module for the remotes. Core's `checkBoard` knows nothing about remotes at
 * all; that is the split, and it is load-bearing.
 *
 * Two kinds of problem, matching the two acceptance criteria:
 *
 *   - configuration errors, reported against the config file with the key path
 *     under `remotes:` — an unknown provider, a dangling `scope`, a status
 *     mapping that is not total (reported via `openRemote`, which refuses to
 *     open), a mapping naming an attribute no type declares, or a connection
 *     the provider's own schema rejects (a missing required key, a missing
 *     credential). All of these are found **offline**: no provider here makes
 *     a request, and a missing credential is a schema fact, not a 401.
 *   - a status whose board `terminal` flag and mapping `closed` flag disagree,
 *     reported as a warning (LP-269): a push would close a non-end column or
 *     leave an end column open.
 *   - a mapping block the provider's schema does not declare, reported as a
 *     warning: the schema strips it, so the block states a mapping that can
 *     never fire (`periods:` under `jsonfile`, which holds no container).
 *   - orphaned links, reported as warnings against the link store file, and
 *     marked `fixable` — a link whose local document is gone. That is the only
 *     thing `lpm check --fix` repairs here; everything ambiguous is reported
 *     and left alone.
 *
 * Scope overlap between two remotes is *not* checked here: core rejects it at
 * parse time, before the board even loads.
 */

import type { LoadedBoard } from '../core/board/load.js';
import type { Problem } from '../core/model/types.js';
import { hasPeriods } from '../core/model/types.js';
import { BoardError } from '../core/errors.js';
import { hasRemotes, remoteNamed, remoteNames } from '../core/config/lookup.js';
import { displayPath } from '../core/storage/paths.js';
import {
  findMissingLinks,
  findMissingTombstones,
  linksPath,
  loadLinkStore,
  pruneMissingLinks,
  pruneMissingTombstones,
  saveLinkStore,
} from './links.js';
import { normalizeAccountMapping } from './accounts.js';
import { mappingKeyNames } from './config-file.js';
import { isLiteralSecret } from './credentials.js';
import {
  normalizeStatusMappings,
  statusClosednessMismatches,
  statusStatesOf,
} from './mapping.js';
import { normalizePeriodMapping } from './periods.js';
import type { OpenedRemote } from './remotes.js';
import { openRemote } from './remotes.js';
import { findProvider } from './registry.js';

/** The mapping's `statuses` / `attributes` blocks, whatever shape they take. */
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

/** Every attribute name declared on some issue type. */
function declaredAttributes(board: LoadedBoard): Set<string> {
  const names = new Set<string>();
  for (const type of Object.values(board.config.issue_types)) {
    for (const name of Object.keys(type.attributes)) names.add(name);
  }
  return names;
}

/** Every resource attribute declared on some resource type, with its type. */
function declaredResourceAttributes(board: LoadedBoard): Map<string, string> {
  const names = new Map<string, string>();
  for (const type of Object.values(board.config.resource_types)) {
    for (const [name, def] of Object.entries(type.attributes)) {
      names.set(name, def.type);
    }
  }
  return names;
}

/**
 * Validate every declared remote against the board, offline.
 *
 * Returns `[]` when the board declares no remotes — a board with no `remotes:`
 * block behaves exactly as it always has, and nothing here is reached.
 */
export function checkRemoteConfiguration(board: LoadedBoard): Problem[] {
  if (!hasRemotes(board.config)) return [];

  const problems: Problem[] = [];
  const configPath = displayPath(board.paths, board.paths.configPath);
  const attributes = declaredAttributes(board);
  const resourceAttributes = declaredResourceAttributes(board);

  for (const name of remoteNames(board.config)) {
    const remote = remoteNamed(board.config, name)!;

    // A dangling scope: the id the remote mirrors no longer exists. Frame-only,
    // so it is reported even when the provider is unknown.
    if (remote.scope !== undefined && !board.byId.has(remote.scope)) {
      problems.push({
        level: 'error',
        path: configPath,
        message: `remotes.${name}.scope: scope "${remote.scope}" does not name an existing issue`,
      });
    }

    // An unknown provider is diagnosed here, where the provider is resolved,
    // never where the config file is read (core does not know what one is).
    const provider = findProvider(remote.provider);
    if (!provider) {
      problems.push({
        level: 'error',
        path: configPath,
        message: `remotes.${name}.provider: unknown provider "${remote.provider}"`,
      });
      continue;
    }

    // Linear names exactly one team (LP-334): states, labels, cycles and
    // estimates are all team-scoped, so a board spanning teams must declare
    // one remote per team rather than asking a single remote to sync several
    // teams' work into one team's cycles and workflow states. A multi-team
    // declaration is refused here with that advice, before the schema's
    // generic "expected a string" rejection.
    if (remote.provider === 'linear') {
      const team = remote.connection['team'];
      if (Array.isArray(team) || (typeof team === 'string' && team.includes(','))) {
        problems.push({
          level: 'error',
          path: configPath,
          message: `remotes.${name}.connection.team: a Linear remote names one team — declare one remote per team`,
        });
        continue;
      }
    }

    // A literal secret in the committed config is the one mistake a shared
    // repo cannot recover from (LP-295): `token: gh_...` travels to every
    // clone. The resolver refuses it too; this reports it before any sync.
    for (const key of Object.keys(provider.credentials?.secrets ?? {})) {
      const value = remote.connection[key];
      if (isLiteralSecret(value)) {
        problems.push({
          level: 'error',
          path: configPath,
          message: `remotes.${name}.connection.${key}: a credential must not be written literally in config.yml — use \${VAR} or lpm remote login`,
        });
      }
    }

    // Open the remote: the provider's own schema validates `connection` and
    // `mapping`. A rejection — a missing repo, a missing token — is reported
    // per key. This is the offline credential check: nothing makes a request.
    let opened: OpenedRemote;
    try {
      opened = openRemote(board.config, name);
    } catch (error) {
      if (error instanceof BoardError) {
        const details = error.details.length ? error.details : [error.message];
        for (const detail of details) {
          problems.push({ level: 'error', path: configPath, message: detail });
        }
      } else {
        throw error;
      }
      continue;
    }

    // A status whose `terminal` flag and mapping `closed` flag disagree: a
    // terminal column must close the remote issue, and a non-terminal one
    // must not — otherwise a push would lie about the card's state.  A
    // warning, not an error: the mapping still round-trips, it just says
    // something different from the board.
    const statusMappings = normalizeStatusMappings(asRecord(opened.mapping['statuses']));
    for (const mismatch of statusClosednessMismatches(statusMappings, board.config.statuses)) {
      problems.push({
        level: 'warn',
        path: configPath,
        message: mismatch.terminal
          ? `remotes.${name}.mapping.statuses.${mismatch.status}: status is terminal on the board but not marked closed on the remote`
          : `remotes.${name}.mapping.statuses.${mismatch.status}: status is marked closed on the remote but not terminal on the board`,
      });
    }

    // Two board statuses claiming one remote state: the push is faithful (both
    // write it), but a pull reading that state back cannot tell which board
    // status it meant, so `mapStatusFromRemote` reports `ambiguous` and the
    // status is left alone. A remote status change that cannot come home is
    // worth saying out loud — and it is the ordinary outcome of a board with
    // more columns than the platform has states, which is why it is a warning
    // and not an error: Jira's default workflow has three, and a five-column
    // board necessarily folds two pairs onto them.
    const byRemoteState = new Map<string, string[]>();
    for (const [statusId, entry] of Object.entries(statusMappings)) {
      for (const state of statusStatesOf(entry)) {
        const sharers = byRemoteState.get(state) ?? [];
        sharers.push(statusId);
        byRemoteState.set(state, sharers);
      }
    }
    for (const [state, sharers] of [...byRemoteState].sort(([a], [b]) => a.localeCompare(b))) {
      if (sharers.length < 2) continue;
      problems.push({
        level: 'warn',
        path: configPath,
        message: `remotes.${name}.mapping.statuses: "${state}" is the remote state for ${sharers
          .sort()
          .join(' and ')} — a pull cannot tell them apart, so a remote move into it is not applied locally`,
      });
    }

    // A mapping key naming an attribute no type declares is a typo that would
    // silently mirror nothing.
    const attributeMap = asRecord(opened.mapping['attributes']);
    for (const attribute of Object.keys(attributeMap)) {
      if (!attributes.has(attribute)) {
        problems.push({
          level: 'error',
          path: configPath,
          message: `remotes.${name}.mapping.attributes.${attribute}: no type declares attribute "${attribute}"`,
        });
      }
    }

    // The effort attribute (Linear's native `estimate` — LP-333) must name a
    // declared attribute, exactly like a mapping.attributes key: a typo would
    // mirror nothing. Naming an attribute that is not the board's own effort
    // attribute is a warning, not an error — the mapping still round-trips, it
    // just files points somewhere the board does not rank by.
    const effort = opened.mapping['effort'] as { attribute?: unknown } | undefined;
    if (effort && typeof effort.attribute === 'string' && effort.attribute !== '') {
      if (!attributes.has(effort.attribute)) {
        problems.push({
          level: 'error',
          path: configPath,
          message: `remotes.${name}.mapping.effort.attribute: no type declares attribute "${effort.attribute}"`,
        });
      } else if (
        board.config.effort_attribute !== '' &&
        board.config.effort_attribute !== effort.attribute
      ) {
        problems.push({
          level: 'warn',
          path: configPath,
          message: `remotes.${name}.mapping.effort.attribute: "${effort.attribute}" is not the board's effort attribute ("${board.config.effort_attribute}")`,
        });
      }
    }

    // The account mapping's `via` must name a string resource attribute — a
    // typo, or an attribute that is not a string, would mirror every
    // assignment as unassigned and report a gap for every person.
    const accounts = normalizeAccountMapping(opened.mapping['accounts']);
    if (accounts) {
      const type = resourceAttributes.get(accounts.via);
      if (type === undefined) {
        problems.push({
          level: 'error',
          path: configPath,
          message: `remotes.${name}.mapping.accounts.via: no resource type declares attribute "${accounts.via}"`,
        });
      } else if (type !== 'string') {
        problems.push({
          level: 'error',
          path: configPath,
          message: `remotes.${name}.mapping.accounts.via: attribute "${accounts.via}" is ${type}, not string — an account must be a string`,
        });
      }
    }

    // A mapping block this provider's schema does not declare is dead config in
    // the other direction: the schema strips the key on the way in (it is not
    // strict, so an older spelling still parses), so the block sits in the file
    // stating a mapping that can never fire. `jsonfile` declares no `accounts`
    // and no `periods` — an assignee and a sprint ride the managed block there —
    // and `lpm remote add` used to draft both for it. Read off the *raw*
    // declaration, because `opened.mapping` is what the schema let through and
    // by definition no longer holds the key.
    const declaredKeys = mappingKeyNames(provider);
    if (declaredKeys.length > 0) {
      for (const key of Object.keys(remote.mapping)) {
        if (declaredKeys.includes(key)) continue;
        problems.push({
          level: 'warn',
          path: configPath,
          message: `remotes.${name}.mapping.${key}: provider "${remote.provider}" has no "${key}" mapping, so this block does nothing (it accepts: ${declaredKeys.join(', ')})`,
        });
      }
    }

    // A period mapping on a board with no periods is dead config — the board
    // has no timeline, so `mapping.periods` can never fire.  (The opposite
    // direction — a board with periods but no mapping — refuses to open above.)
    const periodMapping = normalizePeriodMapping(opened.mapping['periods']);
    if (periodMapping && !hasPeriods(board.config)) {
      problems.push({
        level: 'warn',
        path: configPath,
        message: `remotes.${name}.mapping.periods: the board declares no periods, so this mapping does nothing`,
      });
    }

    // The Jira sprint carrier needs an Agile board id (LP-328): Jira sprints
    // belong to a board, not a project, so without `connection.board` period
    // mapping is unavailable — reported here rather than failing at the first
    // scheduled issue. Linear's `sprint` carrier is a cycle, which belongs to
    // the team already named in `connection.team` (LP-334), so it needs no
    // board id.
    if (periodMapping?.carrier === 'sprint' && remote.provider === 'jira') {
      const boardId = opened.connection['board'];
      if (boardId === undefined || boardId === '') {
        problems.push({
          level: 'error',
          path: configPath,
          message: `remotes.${name}.mapping.periods: sprint mapping needs connection.board — sprints belong to an Agile board, so without a board id period mapping is unavailable`,
        });
      }
    }
  }

  // Orphaned links: a link whose local document is gone. Warn, never error —
  // the remote side is untouched, and the fix is a local prune. A tombstone
  // whose document was deleted is the same shape: dead weight, reported and
  // pruned rather than left to accumulate (LP-366).
  const existingIds = new Set(board.byId.keys());
  for (const name of remoteNames(board.config)) {
    const store = loadLinkStore(board.paths, name);
    for (const localId of findMissingLinks(store, existingIds)) {
      problems.push({
        level: 'warn',
        path: displayPath(board.paths, linksPath(board.paths, name)),
        message: `link "${localId}" has no matching document`,
        fixable: true,
      });
    }
    for (const localId of findMissingTombstones(store, existingIds)) {
      problems.push({
        level: 'warn',
        path: displayPath(board.paths, linksPath(board.paths, name)),
        message: `tombstone "${localId}" has no matching document`,
        fixable: true,
      });
    }
  }

  return problems;
}

/**
 * Repair exactly what `checkRemoteConfiguration` marks `fixable`: prune links
 * whose local document is gone. Anything else it reports is a configuration
 * decision and is left for a human. Returns a log of what changed; reload the
 * board afterwards.
 */
export function fixOrphanedLinks(board: LoadedBoard): string[] {
  if (!hasRemotes(board.config)) return [];

  const actions: string[] = [];
  const existingIds = new Set(board.byId.keys());
  for (const name of remoteNames(board.config)) {
    const store = loadLinkStore(board.paths, name);
    const pruned = pruneMissingLinks(store, existingIds);
    const prunedTombstones = pruneMissingTombstones(store, existingIds);
    if (pruned.length === 0 && prunedTombstones.length === 0) continue;
    saveLinkStore(board.paths, name, store);
    const file = displayPath(board.paths, linksPath(board.paths, name));
    if (pruned.length > 0) {
      actions.push(
        `${file}: pruned ${pruned.length} orphaned ${pruned.length === 1 ? 'link' : 'links'} (${pruned.join(', ')})`,
      );
    }
    if (prunedTombstones.length > 0) {
      actions.push(
        `${file}: pruned ${prunedTombstones.length} orphaned ${prunedTombstones.length === 1 ? 'tombstone' : 'tombstones'} (${prunedTombstones.join(', ')})`,
      );
    }
  }
  return actions;
}
