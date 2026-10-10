import type { BoardTemplatesDto, ConfigDto, ConfigEdit, ConfigEditResultDto, NodeDto } from '$shared';
import { allNodes } from '$shared';
import { ApiError, api } from '$lib/api/client.js';
import type { Workspace } from '$lib/workspace/workspace.svelte.js';

/**
 * The state of the board configuration dialog: one request at a time, the last
 * refusal, the last result and the list of board templates.
 *
 * The dialog writes each edit straight through, as the planning switch does.
 * Before an edit, `apply` pushes the pending changes of every open tab,
 * because a pending change can name a type or a status that the edit renames.
 * After an edit, every open tab reads the board again, so each surface draws
 * the new vocabulary.
 */

/** The parts of the API client that the editor calls. A test passes a fake. */
export type ConfigClient = Pick<
  typeof api,
  'editConfig' | 'boardTemplates' | 'saveBoardTemplate' | 'setDefaultBoardTemplate' | 'removeBoardTemplate'
>;

export interface EditorHost {
  /** The workspace of the active tab. The dialog reads the board from it. */
  workspace: Workspace;
  /** The workspace of every open tab, the active one included. */
  workspaces(): Workspace[];
}

export interface Problem {
  message: string;
  details: string[];
}

export class ConfigEditor {
  /** True while a request runs. Every control is disabled meanwhile. */
  busy = $state(false);
  /** Why the last action was refused, or null. */
  problem = $state<Problem | null>(null);
  /** What the last edit did, with the notes of the server, or null. */
  done = $state<{ message: string; notes: string[] } | null>(null);
  /** The board templates of the user folder, or null before the first answer. */
  templates = $state.raw<BoardTemplatesDto | null>(null);

  readonly #host: EditorHost;
  readonly #client: ConfigClient;

  constructor(host: EditorHost, client: ConfigClient = api) {
    this.#host = host;
    this.#client = client;
  }

  get config(): ConfigDto {
    return this.#host.workspace.config;
  }

  /** The documents of the board as the server read them last, without unpushed changes. */
  get nodes(): NodeDto[] {
    const snapshot = this.#host.workspace.snapshot;
    return snapshot ? allNodes(snapshot) : [];
  }

  /**
   * Send the edits. `summary` says what the edits did, for the line that the
   * dialog shows afterwards. Returns false when the edits were refused.
   */
  async apply(edits: ConfigEdit[], summary: string): Promise<boolean> {
    return this.#run(async () => {
      const open = this.#host.workspaces().filter((workspace) => workspace.ready);
      for (const workspace of open) {
        await workspace.flush();
        if (!workspace.dirty) continue;
        this.problem = {
          message: `The view "${workspace.doc.name}" holds ${workspace.pending.length} unpushed change${workspace.pending.length === 1 ? '' : 's'}`,
          details: [
            'An unpushed change can name a type, a status or an attribute that this edit renames.',
            'Fix the changes that the board refused, then try again.',
          ],
        };
        return false;
      }

      const result: ConfigEditResultDto = await this.#client.editConfig(edits);
      for (const workspace of open) {
        workspace.renameTypes(result.renamedTypes);
        await workspace.pull(true);
      }
      const rewritten =
        result.rewritten > 0
          ? ` ${result.rewritten} document${result.rewritten === 1 ? ' was' : 's were'} rewritten.`
          : '';
      this.done = { message: `${summary}${rewritten}`, notes: result.notes };
      return true;
    });
  }

  /**
   * Read the board templates. The read does not wait for `busy`, because it
   * changes nothing and the Templates tab can open while an edit runs.
   */
  async loadTemplates(): Promise<void> {
    try {
      this.templates = await this.#client.boardTemplates();
    } catch (error) {
      this.problem = problemOf(error);
    }
  }

  async saveTemplate(name: string, overwrite: boolean): Promise<boolean> {
    return this.#run(async () => {
      this.templates = await this.#client.saveBoardTemplate(name, overwrite);
      this.done = {
        message: `Saved the configuration of this board as the template "${name}".`,
        notes: [`Start a board from it with: lpm init --template ${name}`],
      };
      return true;
    });
  }

  async setDefault(name: string): Promise<boolean> {
    return this.#run(async () => {
      this.templates = await this.#client.setDefaultBoardTemplate(name);
      this.done = { message: `New boards now start from the template "${name}".`, notes: [] };
      return true;
    });
  }

  async removeTemplate(name: string): Promise<boolean> {
    return this.#run(async () => {
      this.templates = await this.#client.removeBoardTemplate(name);
      this.done = { message: `Deleted the template "${name}".`, notes: [] };
      return true;
    });
  }

  /** Run one request at a time, and keep a refusal for the dialog to show. */
  async #run(action: () => Promise<boolean>): Promise<boolean> {
    if (this.busy) return false;
    this.busy = true;
    this.problem = null;
    this.done = null;
    try {
      return await action();
    } catch (error) {
      this.problem = problemOf(error);
      return false;
    } finally {
      this.busy = false;
    }
  }
}

function problemOf(error: unknown): Problem {
  return error instanceof ApiError
    ? { message: error.message, details: error.details }
    : { message: error instanceof Error ? error.message : String(error), details: [] };
}
