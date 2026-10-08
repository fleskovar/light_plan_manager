/**
 * A developer's profile: who they are, and which part of the board is theirs.
 *
 * A profile is not board truth. It lives in a file outside `.lpm` that one
 * person is handed, and it answers a question the board deliberately does not:
 * of everything on it, what should be *offered* to this person. Nothing in
 * `board/` or `validation/` may read one — a board that validated differently
 * depending on who was looking would not be one board.
 *
 * Every field is optional and an absent field means "no opinion", which is why
 * `under?: string[]` rather than `under: string[]`: a declared-but-empty list
 * ("scope me to these zero epics") is a different claim from an absent one.
 */
export interface ProfileScope {
  /** Only work at or below these documents. */
  under?: string[];
  /** Never these documents, nor anything below them. Wins over `under`. */
  exclude?: string[];
  /** Only issues of these types. */
  types?: string[];
  /** Only work scheduled in these periods, or in a period below one of them. */
  periods?: string[];
}

export interface Profile {
  /** The roster entry this developer acts as: an id or a name. */
  user: string | null;
  scope: ProfileScope;
}

export function emptyProfile(): Profile {
  return { user: null, scope: {} };
}

/** True when a scope declares nothing, so the whole board is in it. */
export function isEmptyScope(scope: ProfileScope): boolean {
  return !scope.under && !scope.exclude && !scope.types && !scope.periods;
}
