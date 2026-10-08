import type { LoadedBoard } from '../board/load.js';
import { findResource, isGenericResource } from '../board/query.js';
import { BoardError } from '../errors.js';
import type { Resource } from '../model/types.js';
import { hasResources } from '../model/types.js';
import { profileUserRef } from '../profile/current.js';
import { USER_ENV_VAR, readLocal, writeLocal } from '../storage/local.js';

/**
 * Who is driving the CLI. Stored per checkout in `.lpm/local.json` (never
 * committed) and overridable with `LPM_USER`, because the answer belongs to the
 * machine, not to the board.
 */
export interface CurrentUser {
  /** What was stored or passed in the environment, verbatim. */
  ref: string;
  /** The roster entry it resolves to, or null when it matches nothing. */
  resource: Resource | null;
  /** Which of the three answers won. */
  source: UserSource;
}

/**
 * Most specific first: an environment variable is set for one command, a
 * profile is the file this developer was handed, and `local.json` is what
 * `lpm me` wrote. `lpm me` therefore reports which one is talking, because a
 * profile that quietly overrode it would be a confusing way to be someone else.
 */
export type UserSource = 'env' | 'profile' | 'local';

export function currentUser(board: LoadedBoard): CurrentUser | null {
  const found = ((): { ref: string; source: UserSource } | null => {
    const fromEnv = process.env[USER_ENV_VAR]?.trim();
    if (fromEnv) return { ref: fromEnv, source: 'env' };
    const fromProfile = profileUserRef(board.paths);
    if (fromProfile) return { ref: fromProfile, source: 'profile' };
    const stored = readLocal(board.paths).user;
    return stored ? { ref: stored, source: 'local' } : null;
  })();

  if (!found) return null;
  return { ref: found.ref, resource: findResource(board, found.ref), source: found.source };
}

/** The current user, or a `BoardError` explaining how to set one. */
export function requireCurrentUser(board: LoadedBoard): Resource {
  if (!hasResources(board.config)) {
    throw new BoardError('This board has no team roster', [
      'Add resource_types, resource_hierarchy and resource_prefix to .lpm/config.yml.',
    ]);
  }
  const user = currentUser(board);
  if (!user) {
    throw new BoardError('No current user set', [
      'Run `lpm me <id or name>` to say who you are.',
    ]);
  }
  if (!user.resource) {
    throw new BoardError(`Current user "${user.ref}" is not in the roster`, [
      user.source === 'profile'
        ? 'It came from your profile; fix its `user:` or run `lpm profile --clear`.'
        : 'Run `lpm me <id or name>` to pick someone who is.',
    ]);
  }
  return user.resource;
}

export function setCurrentUser(board: LoadedBoard, idOrName: string): Resource {
  if (!hasResources(board.config)) {
    throw new BoardError('This board has no team roster', [
      'Add resource_types, resource_hierarchy and resource_prefix to .lpm/config.yml.',
    ]);
  }
  const resource = findResource(board, idOrName);
  if (!resource) {
    throw new BoardError(`No resource with id or name "${idOrName}"`, [
      board.resources.length
        ? `Roster: ${board.resources.map((entry) => `${entry.id} (${entry.title})`).join(', ')}`
        : 'The roster is empty; create someone with `lpm new <type> -t "Your name"`.',
    ]);
  }
  if (isGenericResource(board, resource)) {
    throw new BoardError(`${resource.id} (${resource.title}) is a pool, not a person`, [
      'The current user has to be a named resource.',
    ]);
  }

  writeLocal(board.paths, { ...readLocal(board.paths), user: resource.id });
  return resource;
}

export function clearCurrentUser(board: LoadedBoard): void {
  writeLocal(board.paths, { ...readLocal(board.paths), user: null });
}
