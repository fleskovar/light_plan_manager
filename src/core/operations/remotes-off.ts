import { moveRemoteBlocks } from '../config/remote-blocks.js';
import { gitSyncOf, remoteNames, remotesOffNames } from '../config/lookup.js';
import { loadConfig } from '../config/schema.js';
import { BoardError } from '../errors.js';
import type { BoardConfig } from '../model/types.js';
import type { BoardPaths } from '../storage/paths.js';
import { editConfig, withBoardWrite } from './git-sync.js';

/**
 * Turning a tracker remote off and on again, without losing it.
 *
 * A board syncs through git or mirrors onto trackers, never both, so moving a
 * board from Jira to git used to mean `lpm remote rm` — and coming back meant
 * connecting the tracker again from nothing. Turning a remote off instead moves
 * its declaration, untouched, from `remotes:` to `remotes_off:` in config.yml.
 * Its link store, base snapshots, audit log and credentials under
 * `.lpm/remotes/<name>/` are not touched at all, so turning it back on is the
 * same move the other way and the next sync carries on from where the last
 * one stopped — whatever changed on the board meanwhile is ordinary drift.
 *
 * Every consumer of a remote reads `remotes:`, so a turned-off one needs no
 * special case anywhere: nothing opens it, pushes to it or reports on it.
 */

function requireConfig(paths: BoardPaths): BoardConfig {
  const loaded = loadConfig(paths);
  if (!loaded.config) throw new BoardError('The board config does not validate', loaded.errors);
  return loaded.config;
}

/**
 * Turn tracker remotes off, keeping everything about them. With no names,
 * every remote that is on. Returns the names turned off.
 */
export function turnRemotesOff(paths: BoardPaths, names: string[] = []): string[] {
  const config = requireConfig(paths);
  const on = remoteNames(config);
  const chosen = names.length ? [...new Set(names)] : on;
  for (const name of chosen) {
    if (on.includes(name)) continue;
    throw new BoardError(
      remotesOffNames(config).includes(name)
        ? `The remote "${name}" is already off`
        : `No remote named "${name}"`,
      on.length ? [`Remotes that are on: ${on.join(', ')}.`] : ['No remote is on.'],
    );
  }
  if (!chosen.length) return [];
  withBoardWrite(paths, `turn off remote ${chosen.join(', ')}`, () =>
    editConfig(paths, (doc) => moveRemoteBlocks(doc, chosen, 'remotes', 'remotes_off')),
  );
  return chosen;
}

/**
 * Turn a remote back on exactly as it was turned off. Refused while the board
 * is shared through git — the two are exclusive, and `lpm git off
 * --turn-on-remotes` is the one step that swaps them back.
 */
export function turnRemoteOn(paths: BoardPaths, name: string): void {
  const config = requireConfig(paths);
  if (!remotesOffNames(config).includes(name)) {
    throw new BoardError(
      remoteNames(config).includes(name) ? `The remote "${name}" is already on` : `No turned-off remote named "${name}"`,
      remotesOffNames(config).length
        ? [`Remotes that are off: ${remotesOffNames(config).join(', ')}.`]
        : ['No remote is turned off.'],
    );
  }
  if (gitSyncOf(config)) {
    throw new BoardError(`Cannot turn "${name}" on — this board is shared through git`, [
      'A board syncs through git or mirrors onto trackers, never both.',
      `\`lpm git off --turn-on-remotes\` stops sharing through git and turns ${name} back on in one step.`,
    ]);
  }
  withBoardWrite(paths, `turn on remote ${name}`, () =>
    editConfig(paths, (doc) => moveRemoteBlocks(doc, [name], 'remotes_off', 'remotes')),
  );
}
