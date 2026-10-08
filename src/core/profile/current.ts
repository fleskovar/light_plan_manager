import type { LoadedBoard } from '../board/load.js';
import type { ResolvedScope } from '../board/scope.js';
import { fullScope, resolveScope } from '../board/scope.js';
import type { Profile } from '../model/profile.js';
import type { BoardPaths } from '../storage/paths.js';
import type { ProfileSource } from '../storage/local.js';
import { profileRef, resolveProfilePath } from '../storage/local.js';
import { loadProfileFile } from './schema.js';

/**
 * The profile in force for this checkout, and what it means on this board.
 *
 * Read fresh every time rather than cached on the board: the file lives outside
 * `.lpm`, a `LoadedBoard` handle outlives it, and it is a few hundred bytes.
 */
export interface CurrentProfile {
  /** The absolute path it was read from. */
  file: string;
  /** How that path was found. */
  source: ProfileSource;
  /** Null when the file is missing or does not parse; see `errors`. */
  profile: Profile | null;
  /** Why it did not load, or why it should not be trusted. Never thrown. */
  errors: string[];
}

/**
 * A broken profile is reported, never fatal. The alternative is a developer
 * whose every command fails because a file they were handed has a typo in it,
 * which helps nobody — the CLI says so, and carries on unscoped.
 */
export function currentProfile(paths: BoardPaths): CurrentProfile | null {
  const ref = profileRef(paths);
  if (!ref) return null;

  const file = resolveProfilePath(paths, ref.ref);
  const { profile, errors } = loadProfileFile(file);
  return { file, source: ref.source, profile, errors };
}

/** The identity a profile claims, for the precedence chain in `currentUser`. */
export function profileUserRef(paths: BoardPaths): string | null {
  return currentProfile(paths)?.profile?.user ?? null;
}

/**
 * What this developer should be offered, resolved against this board. No
 * profile, an unreadable one, or one that declares no scope all mean the whole
 * board — the scope has to be *stated* to bite.
 */
export function currentScope(board: LoadedBoard): ResolvedScope {
  const current = currentProfile(board.paths);
  const scope = current?.profile?.scope;
  return scope ? resolveScope(board, scope) : fullScope();
}
