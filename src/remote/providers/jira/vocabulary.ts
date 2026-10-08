/**
 * Jira's conventional vocabulary — what a board word is called on a Jira
 * project nobody has looked at yet.
 *
 * Jira's issue types and workflow statuses are the project's own, so they can
 * only be *known* by asking (`lpm remote setup`, and the push preflight, which
 * validates the mapping against the live type scheme). What they conventionally
 * *are* is not a mystery: a Jira Scrum project — team-managed or company-managed
 * — ships Epic / Story / Task / Bug / Sub-task and a To Do → In Progress → Done
 * workflow. That convention is what this file states.
 *
 * ## Types: a name Jira itself uses, then the level's role
 *
 * A board word Jira has its own word for is answered by the table, at whatever
 * depth it sits: a board's `bug` is Jira's Bug under a story or at the top.
 * Everything else is answered by what the *level* is for, which the board has
 * already written down as `atomic`:
 *
 *   - a level **inside** an atomic one is a checklist item inside one job, which
 *     is precisely Jira's `Sub-task` (hierarchy level −1);
 *   - the **work level** itself — atomic, or the deepest level on a board that
 *     declared none — is Jira's `Task` (level 0). `Task` rather than `Story`,
 *     because Story is the word for work that *is* a story and the table already
 *     answers that; Task is Jira's generic work item and is present in every
 *     default scheme, Kanban projects included;
 *   - **everything above** the work level is Jira's `Epic` (level 1).
 *
 * Depth alone could not do this. On `epic › feature › story` the deepest level
 * is the work; on `… › user_story › sub_task` it is a checklist. `atomic` is
 * where the board says which.
 *
 * Several board levels collapse onto `Epic` on a board deeper than Jira's three,
 * which is correct rather than lossy: the extra levels ride the managed block
 * (rung 4) whatever they are called, and a *pull* still separates two board
 * types that map to one remote name when they sit at different depths
 * (`resolveBoardType` narrows by depth). What does not separate is two types at
 * the *same* depth — `test` and `review` both becoming Task — and `lpm check`
 * reports that pair rather than leaving it to be found on a pull.
 *
 * ## Statuses: the two flags the engine itself reads
 *
 * `terminal` is the board's own definition of finished and `active` its
 * definition of in flight, so those are the two a convention may lean on. A
 * board's five columns are not five Jira statuses — Jira's default workflow has
 * three — so `Backlog` and `Ready` both become `To Do`. That collapse is a
 * property of Jira's default workflow rather than of this table, and `lpm check`
 * names the pair, because a pull cannot tell two board statuses apart when they
 * share one remote state.
 */

import type { BoardStatusRole, BoardTypeRole, StandardVocabulary } from '../../vocabulary.js';
import { synonymFor } from '../../vocabulary.js';

/**
 * Jira's own issue-type names, keyed by the normalized board word that means
 * them. Deliberately only the words Jira has a *distinct* type for: `task` and
 * `chore` are absent so the level's role decides, which is what turns a Kanban
 * board's `task` under an atomic `story` into a real Jira Sub-task rather than a
 * second top-level Task with its parent in the managed block.
 */
const TYPE_SYNONYMS: Readonly<Record<string, string>> = {
  epic: 'Epic',
  story: 'Story',
  userstory: 'Story',
  bug: 'Bug',
  defect: 'Bug',
  subtask: 'Sub-task',
  subitem: 'Sub-task',
};

/** The conventional Jira issue type for one board type. */
export function jiraTypeFor(role: BoardTypeRole): string {
  const synonym = synonymFor(TYPE_SYNONYMS, role.name);
  if (synonym !== undefined) return synonym;
  if (role.insideUnit) return 'Sub-task';
  if (role.atomic || role.leaf) return 'Task';
  return 'Epic';
}

/** The conventional Jira workflow status for one board status. */
export function jiraStatusFor(role: BoardStatusRole): string {
  if (role.terminal) return 'Done';
  if (role.active) return 'In Progress';
  return 'To Do';
}

export const jiraVocabulary: StandardVocabulary = {
  typeFor: jiraTypeFor,
  statusFor: jiraStatusFor,
  describe:
    "Jira's default Scrum vocabulary (Epic / Story / Task / Bug / Sub-task, To Do → In Progress → Done)",
};
