import type { ProjectEntryDto } from '$shared';

/**
 * The "All projects" page: every project of the project index (`lpm projects`),
 * local and central. Open asks the server for a board server and goes to it.
 * Reveal asks the server to show `<project>/.lpm` in the file manager.
 *
 * The logic is here and `ProjectsPage.svelte` only draws it, so the tests in
 * `web/test/projects-page.test.ts` need no browser.
 */

/** The three project routes. `api` in `$lib/api/client.ts` provides them. */
export interface ProjectsApi {
  list(): Promise<ProjectEntryDto[]>;
  open(lpmDir: string): Promise<{ url: string }>;
  reveal(lpmDir: string): Promise<void>;
}

/** One row of the page. */
export interface ProjectRow extends ProjectEntryDto {
  /** The project folder, or the board folder when the project is not known. */
  folder: string;
  /** The day of the last use (`YYYY-MM-DD`), or "never". */
  lastUsedText: string;
  /** The state to show beside the name, or null for `ok`. */
  label: string | null;
  canOpen: boolean;
  canReveal: boolean;
}

function toRow(entry: ProjectEntryDto): ProjectRow {
  return {
    ...entry,
    folder: entry.root ?? entry.lpmDir,
    lastUsedText: entry.lastUsed ? entry.lastUsed.slice(0, 10) : 'never',
    label: entry.state === 'ok' ? null : entry.state,
    canOpen: entry.state !== 'missing',
    canReveal: entry.state === 'ok' && entry.root !== null,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class ProjectsPage {
  /** Replaced as a whole on each load, so it is not a deep proxy. */
  rows = $state.raw<ProjectRow[]>([]);
  loading = $state(true);
  /** The last failure, for the page to show. Cleared by the next action. */
  error = $state<string | null>(null);
  /** The board folder that an action is running for, or null. */
  busy = $state<string | null>(null);

  readonly #api: ProjectsApi;
  readonly #navigate: (url: string) => void;

  constructor(api: ProjectsApi, navigate: (url: string) => void) {
    this.#api = api;
    this.#navigate = navigate;
  }

  /** The text for an empty list, or null while loading or when projects exist. */
  get emptyText(): string | null {
    if (this.loading || this.rows.length) return null;
    return 'No projects yet. Each lpm command in a project adds it to this list.';
  }

  async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      this.rows = (await this.#api.list()).map(toRow);
    } catch (error) {
      this.error = messageOf(error);
    } finally {
      this.loading = false;
    }
  }

  #row(lpmDir: string): ProjectRow | undefined {
    return this.rows.find((row) => row.lpmDir === lpmDir);
  }

  async open(lpmDir: string): Promise<void> {
    if (!this.#row(lpmDir)?.canOpen) return;
    await this.#run(lpmDir, async () => this.#navigate((await this.#api.open(lpmDir)).url));
  }

  async reveal(lpmDir: string): Promise<void> {
    if (!this.#row(lpmDir)?.canReveal) return;
    await this.#run(lpmDir, () => this.#api.reveal(lpmDir));
  }

  async #run(lpmDir: string, action: () => Promise<void>): Promise<void> {
    this.error = null;
    this.busy = lpmDir;
    try {
      await action();
    } catch (error) {
      this.error = messageOf(error);
    } finally {
      this.busy = null;
    }
  }
}
