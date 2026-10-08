/**
 * Linear's conventional vocabulary — what a board status is called on a Linear
 * team nobody has looked at yet.
 *
 * Linear declares no `typeFor`, and that absence is the interesting half: Linear
 * has **no issue types at all**, so a board type rides a label whose name is the
 * board's own word (`capabilities.nativeTypes` is false, so the scaffold never
 * asks). Only the workflow states are Linear's own vocabulary, and only they
 * need a convention.
 *
 * A Linear team ships with six states, each carrying a *type*: `Backlog`
 * (backlog), `Todo` (unstarted), `In Progress` (started), `In Review` (started),
 * `Done` (completed), `Canceled` (canceled). That is the closest of the three
 * platforms to a Scrum board's own columns, so the convention below maps the
 * shipped Scrum template one-for-one and needs no correction on a default team.
 *
 * The `In Review` case is why `label` is part of the role rather than just the
 * flags. Two of Linear's default states are `started`, and the board's own
 * `active` flag cannot tell them apart — but the *name* can, and a board that
 * calls a column "In Review" means Linear's In Review. Matching on the word is
 * a convention, not a rule: a team that deleted the state gets it corrected by
 * `lpm remote setup`, or reported by the preflight before any write.
 */

import type { BoardStatusRole, StandardVocabulary } from '../../vocabulary.js';
import { normalizeWord } from '../../vocabulary.js';

/** The conventional Linear workflow state for one board status. */
export function linearStatusFor(role: BoardStatusRole): string {
  if (role.terminal) return 'Done';
  const word = normalizeWord(role.label);
  if (role.active) return word.includes('review') ? 'In Review' : 'In Progress';
  if (word.includes('cancel')) return 'Canceled';
  // A board's first column is its backlog; a later unstarted column is work
  // that has been picked out of it, which is what Linear's `Todo` means.
  return role.index === 0 ? 'Backlog' : 'Todo';
}

export const linearVocabulary: StandardVocabulary = {
  statusFor: linearStatusFor,
  describe:
    "a Linear team's default workflow states (Backlog / Todo / In Progress / In Review / Done)",
};
