import { existsSync } from 'node:fs';
import type { LoadedBoard } from '../board/load.js';
import { BoardError } from '../errors.js';
import type { Profile } from '../model/profile.js';
import { loadProfileFile } from '../profile/schema.js';
import { readLocal, resolveProfilePath, writeLocal } from '../storage/local.js';

/**
 * Remembering which profile this checkout runs under.
 *
 * Only the *path* is stored, in `.lpm/local.json` beside the current user and
 * git-ignored with it: the profile itself belongs to the developer, not to the
 * board, and a board that carried one would be telling every checkout who to be.
 */
export interface ProfileSetting {
  /** The absolute path, for reporting. */
  file: string;
  /** What was recorded — relative when it was given relative. */
  ref: string;
  profile: Profile;
}

/**
 * Point this checkout at a profile. The file has to exist and parse: a typo
 * that is caught now is a message, and one that is caught later is a developer
 * silently working the wrong part of the board.
 */
export function setProfileFile(board: LoadedBoard, ref: string): ProfileSetting {
  const file = resolveProfilePath(board.paths, ref);
  if (!existsSync(file)) {
    throw new BoardError(`No profile file at ${file}`, [
      'Write one with `lpm profile --init <file>`.',
    ]);
  }

  const { profile, errors } = loadProfileFile(file);
  if (!profile) throw new BoardError(`${file} is not a valid profile`, errors);

  writeLocal(board.paths, { ...readLocal(board.paths), profile: ref });
  return { file, ref, profile };
}

export function clearProfileFile(board: LoadedBoard): void {
  writeLocal(board.paths, { ...readLocal(board.paths), profile: null });
}
