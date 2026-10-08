/**
 * Platform-standard vocabulary — the convention a provider names when nobody
 * has told it anything about the remote yet.
 *
 * `capabilities.vocabulary` answers *who names the words*: `open` means the
 * store is ours and the board's own words are the answer (`jsonfile`), `fixed`
 * means the platform's words pre-exist and only the platform can list them
 * (Jira's issue types, Linear's workflow states). For `fixed` the scaffold used
 * to write a `TODO:` marker per word and refuse to open the remote until a
 * person answered every one — fourteen hand-edits in `config.yml` before the
 * Scrum template could reach Jira at all, each of them a question whose answer
 * is the same on the overwhelming majority of projects, because a Jira Scrum
 * project has Epic / Story / Task / Bug / Sub-task and To Do / In Progress /
 * Done, and a Linear team has Backlog / Todo / In Progress / In Review / Done.
 *
 * So a provider may declare what those conventional words are. The scaffold
 * writes them, the remote opens, and nothing is guessed *silently*: the push
 * preflight validates the mapping against the live project before any write —
 * a type the project does not have is an error naming the types it does have —
 * and `lpm remote setup` replaces the conventions with the remote's real words
 * the moment a credential exists. A convention that is wrong therefore costs
 * one command; a marker cost fourteen edits whether it was wrong or not.
 *
 * Two rules keep this honest, and both are the reason this is a *convention*
 * rather than a guess:
 *
 *   - **It is a function of the board's shape, not a table of board words.** A
 *     board's types are whatever its config declares, so a provider is handed
 *     each type's *role* — its name and where it sits in the hierarchy — and
 *     answers from that. `feature` on a five-level board and `feature` on a
 *     two-level board are not the same question.
 *   - **It never claims a capability.** A convention names a *word*, never a
 *     carrier: whether that word lands in a native field or on a label is
 *     still `capabilities`' answer, and `staticCapabilities` still resolves
 *     every probed cell to the least capable reading.
 *
 * Pure: no disk, no network, no board handle — the scaffold passes roles in and
 * gets names out, which is what makes `test/remote-vocabulary.test.ts` a table.
 */

/**
 * A board issue type as a provider sees it when choosing a conventional name.
 *
 * The three flags below the name are what let a convention answer for a board
 * it has never seen, and they are the board's *own* vocabulary rather than a
 * guess about it:
 *
 *   - **`atomic`** is the board saying "this is the smallest unit of work the
 *     queue hands out" (`atomic: true` in the config). That is the level a
 *     tracker calls a story or a task.
 *   - **`insideUnit`** is a level *below* an atomic one — a checklist item
 *     inside one job, which is exactly what a tracker's sub-task is.
 *   - **`leaf`** is the deepest declared level, which is the work unit on a
 *     board that never declared one.
 *
 * Depth alone cannot answer this. On `epic › feature › story` the deepest level
 * is the work; on `… › user_story › sub_task` it is a checklist. The two boards
 * have the same shape and different meanings, and `atomic` is where the
 * difference is written down.
 */
export interface BoardTypeRole {
  /** The board's own type name, e.g. `user_story`. */
  name: string;
  /** 0-based index in the board's `hierarchy`. */
  depth: number;
  /** How many levels the board's `hierarchy` has. */
  depthCount: number;
  /** The board declares this type `atomic` — one job, taken whole. */
  atomic: boolean;
  /** Some level above this one is atomic, so this type is inside one job. */
  insideUnit: boolean;
  /** This type sits at the deepest declared level. */
  leaf: boolean;
}

/**
 * A board status as a provider sees it when choosing a conventional name.
 *
 * `terminal` and `active` are the two flags the engine itself reads, so they
 * are the two a convention may lean on; `index`/`count` place the status in
 * board order, which is what tells a first column from a middle one.
 */
export interface BoardStatusRole {
  /** The board's status id, e.g. `in_review`. */
  id: string;
  /** The board's label for it, e.g. `In Review`. */
  label: string;
  /** 0-based index in the board's `statuses` list. */
  index: number;
  /** How many statuses the board declares. */
  count: number;
  /** The board's `terminal` flag — what "finished" means here. */
  terminal: boolean;
  /** The board's `active` flag — work in progress. */
  active: boolean;
}

/**
 * What a provider declares about its platform's conventional words.
 *
 * Both members are optional because the two questions are independent: Linear
 * has no issue types at all (a board type is a label, which needs no
 * convention) but does have named workflow states; a platform could be the
 * other way round.
 */
export interface StandardVocabulary {
  /** The conventional remote issue type for a board type in this role. */
  typeFor?(role: BoardTypeRole): string;
  /** The conventional remote workflow state for a board status in this role. */
  statusFor?(role: BoardStatusRole): string;
  /**
   * One line naming the convention, for `lpm remote add` to print — so a person
   * reading the output knows a convention was applied and against what.
   */
  describe: string;
}

/**
 * Normalize a board word for matching against a synonym table: lowercased, and
 * every run of non-alphanumerics folded away. `Sub-task`, `sub_task` and
 * `subTask` are one word; so are `user_story` and `User Story`.
 */
export function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Look a normalized board word up in a synonym table.
 *
 * The table is keyed by normalized word, so a provider writes
 * `{ userstory: 'Story' }` and both `user_story` and `User Story` find it.
 */
export function synonymFor(
  table: Readonly<Record<string, string>>,
  word: string,
): string | undefined {
  return table[normalizeWord(word)];
}
