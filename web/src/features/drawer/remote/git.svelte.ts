import { getContext, setContext } from 'svelte';
import type {
  GitDisableRequest,
  GitSetupRequest,
  GitSyncRequest,
  GitSyncResponse,
  GitSyncStatusDto,
  GitUrlCheckDto,
} from '$shared';

/**
 * Sharing the board through its own git repository, from the Sync tab: the
 * state machine behind the Git panel and its setup dialog, kept out of the
 * components so they stay presentational and the tests stay DOM-free.
 *
 * Git sync and tracker remotes are exclusive — a board does one or the other —
 * so `panelMode` decides which panel the tab shows at all, and the two never
 * appear together.
 *
 * Nothing here holds a credential. git authenticates with whatever it already
 * uses for the code, and the server never prompts, so an unreachable URL comes
 * back as a check result with the host's hint rather than as a password box.
 */

// ---------------------------------------------------------------------------
// Seams

export interface GitApi {
  gitStatus(fetch?: boolean): Promise<GitSyncStatusDto>;
  checkGitUrl(body: { url?: string; branch?: string }): Promise<GitUrlCheckDto>;
  setupGit(body: GitSetupRequest): Promise<GitSyncStatusDto>;
  syncGit(body: GitSyncRequest): Promise<GitSyncResponse>;
  disableGit(body?: GitDisableRequest): Promise<GitSyncStatusDto>;
  /** Turn one turned-off tracker back on (`lpm ui --experimental` only). */
  turnRemoteOn(name: string): Promise<{ name: string }>;
}

export interface GitStateHost {
  notify(level: 'info' | 'error', message: string, details?: string[]): void;
  report(error: unknown): void;
  /** The board on disk may have changed: re-read it. */
  boardChanged(): Promise<void>;
  /** The set of remotes may have changed (turning git off frees the tab for trackers). */
  remotesChanged(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure helpers

/** Which panel the Sync tab shows. */
export type PanelMode = 'git' | 'trackers' | 'empty';

export function panelMode(status: GitSyncStatusDto | null, trackerCount: number): PanelMode {
  if (status?.enabled) return 'git';
  return trackerCount > 0 ? 'trackers' : 'empty';
}

/** What the setup form collected. */
export interface GitSetupDraft {
  /** The project's own repository, or a URL of the board's own. */
  where: 'project' | 'url';
  url: string;
  /**
   * The branch. The form opens with `defaultBranch` in this field, so the
   * reader sees the value that Share sends. A blank still means the default.
   */
  branch: string;
}

/**
 * The branch that the form fills in for a choice of repository. In the
 * repository of the project, the board takes the branch that the server
 * reports in `projectBranch`, which is `_lpm_board_remote`. In a repository of
 * its own, the board takes `main`. `lpm git setup` uses the same two defaults.
 */
export function defaultBranch(where: GitSetupDraft['where'], status: GitSyncStatusDto | null): string {
  return where === 'project' ? (status?.projectBranch ?? '_lpm_board_remote') : 'main';
}

export function emptyGitDraft(status: GitSyncStatusDto | null): GitSetupDraft {
  const where = status?.project ? 'project' : 'url';
  return { where, url: '', branch: defaultBranch(where, status) };
}

/**
 * The draft after the reader chose the other repository. The branch follows
 * the choice while the field is blank or still holds the default of the
 * choice before. A branch that the reader typed stays.
 */
export function withWhere(
  draft: GitSetupDraft,
  where: GitSetupDraft['where'],
  status: GitSyncStatusDto | null,
): GitSetupDraft {
  const typed = draft.branch.trim();
  const untouched = typed === '' || typed === defaultBranch(draft.where, status);
  return { ...draft, where, branch: untouched ? defaultBranch(where, status) : draft.branch };
}

/**
 * The trackers sharing through git would turn off — what the warning before
 * Share names. Empty when the board mirrors onto nothing.
 */
export function trackersToTurnOff(status: GitSyncStatusDto | null): string[] {
  return status?.trackers ?? [];
}

/** "jira", "jira and github", "jira, github and linear" — for the warning's sentences. */
export function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * What stops the form being sent, or null.
 *
 * A board that mirrors onto a tracker is deliberately *not* a problem here: it
 * can be shared through git once the tracker is turned off, and that is a
 * question `submitSetup` asks after the form is filled in rather than a red
 * line that blocks it.
 */
export function gitDraftProblem(draft: GitSetupDraft, status: GitSyncStatusDto | null): string | null {
  if (draft.where === 'project' && !status?.project) return "This project has no git remote.";
  if (draft.where === 'url') {
    const url = draft.url.trim();
    if (!url) return 'Enter the repository URL.';
    if (url.startsWith('-')) return 'Not a valid repository URL.';
  }
  if (draft.branch.trim() && !/^(?!-)[A-Za-z0-9._/-]+$/.test(draft.branch.trim())) {
    return 'A branch name may only use letters, digits, ".", "_", "-" and "/".';
  }
  return null;
}

export function setupRequestOf(draft: GitSetupDraft): GitSetupRequest {
  const branch = draft.branch.trim() || undefined;
  return draft.where === 'project' ? { project: true, branch } : { url: draft.url.trim(), branch };
}

/** The branch the form will use, for the hint under the field. */
export function effectiveBranch(draft: GitSetupDraft, status: GitSyncStatusDto | null): string {
  return draft.branch.trim() || defaultBranch(draft.where, status);
}

export type Tone = 'ok' | 'warn' | 'error';

/** The status card's one line: what state the shared board is in. */
export function gitSummary(status: GitSyncStatusDto): { tone: Tone; headline: string; detail: string } {
  if (status.problem) {
    return { tone: 'error', headline: 'Not working', detail: `${status.problem}. Run setup again.` };
  }
  if (status.conflict) {
    const documents = status.conflict.documents.join(', ');
    return status.conflict.reason === 'uncommitted'
      ? {
          tone: 'error',
          headline: 'Uncommitted edits',
          detail: `Incoming changes conflict with uncommitted edits to ${documents}. Sync, then choose a version.`,
        }
      : {
          tone: 'error',
          headline: 'Conflict',
          detail: `Changed here and on the remote: ${documents}.`,
        };
  }
  if (status.lastFetch?.error) {
    return { tone: 'warn', headline: 'Remote unreachable', detail: `${status.lastFetch.error}. Changes are blocked until it's reachable.` };
  }
  if (status.offline) {
    return { tone: 'warn', headline: 'Working offline', detail: 'Changes are pushed on the next sync.' };
  }
  if (!status.published) return { tone: 'warn', headline: 'Not pushed yet', detail: 'Sync to push the board to the remote.' };
  if (status.ahead || status.behind) {
    const parts = [
      status.ahead ? `${status.ahead} commit${status.ahead === 1 ? '' : 's'} to push` : '',
      status.behind ? `${status.behind} commit${status.behind === 1 ? '' : 's'} to pull` : '',
    ].filter(Boolean);
    return { tone: 'warn', headline: 'Out of sync', detail: `${parts.join(', ')}.` };
  }
  return {
    tone: 'ok',
    headline: 'Up to date',
    detail: 'Changes sync automatically.',
  };
}

/** What a sync did, as a notice. */
export function describeSync(response: GitSyncResponse): string {
  if (response.pulled === 'conflict') return 'Sync stopped: conflict';
  if (response.pulled === 'offline') return 'Offline: nothing fetched or pushed';
  const parts = [
    response.saved ? `committed ${response.saved} local edit${response.saved === 1 ? '' : 's'}` : '',
    response.pulled === 'fast-forward' || response.pulled === 'rebased' ? 'pulled' : '',
    response.pushed ? 'pushed' : '',
  ].filter(Boolean);
  return parts.length ? `Synced: ${parts.join(', ')}` : 'Already up to date';
}

// ---------------------------------------------------------------------------
// The state

export type GitBusy = 'loading' | 'checking' | 'sharing' | 'syncing' | 'disabling' | null;

export class GitState {
  status = $state<GitSyncStatusDto | null>(null);
  busy = $state<GitBusy>(null);
  /** The setup form, while it is open. */
  draft = $state<GitSetupDraft | null>(null);
  /** What the last Check said about the draft's URL. */
  check = $state<GitUrlCheckDto | null>(null);
  /**
   * The trackers Share is waiting to turn off, while the warning asking about
   * them is open; null when nothing is being asked. The form stays filled in
   * underneath, so Back returns to it exactly as it was.
   */
  turnOffQuestion = $state<string[] | null>(null);

  readonly #api: GitApi;
  readonly #host: GitStateHost;

  constructor(api: GitApi, host: GitStateHost) {
    this.#api = api;
    this.#host = host;
  }

  /** Read the status; `fetch` asks the remote too, which is slower. */
  async load(fetch = false): Promise<void> {
    this.busy = 'loading';
    try {
      this.status = await this.#api.gitStatus(fetch);
    } catch (error) {
      this.#host.report(error);
    } finally {
      this.busy = null;
    }
  }

  openSetup(): void {
    this.draft = emptyGitDraft(this.status);
    this.check = null;
  }

  closeSetup(): void {
    this.draft = null;
    this.check = null;
    this.turnOffQuestion = null;
  }

  /** Choose the repository. The branch field follows, and the last check no longer applies. */
  chooseWhere(where: GitSetupDraft['where']): void {
    if (!this.draft) return;
    this.draft = withWhere(this.draft, where, this.status);
    this.check = null;
  }

  /** Back out of the warning to the filled-in form. */
  cancelTurnOff(): void {
    this.turnOffQuestion = null;
  }

  /** Ask git whether the draft's repository can be reached, without changing anything. */
  async checkDraft(): Promise<void> {
    const draft = this.draft;
    if (!draft) return;
    this.busy = 'checking';
    try {
      const request = setupRequestOf(draft);
      this.check = await this.#api.checkGitUrl({
        url: request.url,
        branch: effectiveBranch(draft, this.status),
      });
    } catch (error) {
      this.#host.report(error);
    } finally {
      this.busy = null;
    }
  }

  /**
   * Share the board. True when it worked and the dialog may close.
   *
   * On a board that mirrors onto a tracker the first call sends nothing: it
   * opens the warning (`turnOffQuestion`), and only the warning's confirm —
   * `submitSetup(true)` — turns the mirror off and shares. Turning a mirror off
   * keeps it whole, but it is still a decision about everybody's board, so it
   * is never made as a side effect of pressing Share.
   */
  async submitSetup(turnOffRemotes = false): Promise<boolean> {
    const draft = this.draft;
    if (!draft || gitDraftProblem(draft, this.status)) return false;
    const trackers = trackersToTurnOff(this.status);
    if (trackers.length && !turnOffRemotes) {
      this.turnOffQuestion = trackers;
      return false;
    }
    this.busy = 'sharing';
    try {
      this.status = await this.#api.setupGit({
        ...setupRequestOf(draft),
        ...(trackers.length ? { turnOffRemotes: true } : {}),
      });
      this.closeSetup();
      this.#host.notify('info', `Shared through ${this.status.url ?? 'git'}`, [
        `Branch ${this.status.branch}.`,
        ...(trackers.length ? [`${nameList(trackers)} turned off.`] : []),
      ]);
      await this.#host.remotesChanged();
      await this.#host.boardChanged();
      return true;
    } catch (error) {
      this.#host.report(error);
      return false;
    } finally {
      this.busy = null;
    }
  }

  async sync(resolve?: 'ours' | 'theirs'): Promise<void> {
    this.busy = 'syncing';
    try {
      const response = await this.#api.syncGit(resolve ? { resolve } : {});
      this.status = response.status;
      this.#host.notify(response.pulled === 'conflict' ? 'error' : 'info', describeSync(response));
      await this.#host.boardChanged();
    } catch (error) {
      this.#host.report(error);
    } finally {
      this.busy = null;
    }
  }

  /** Stop sharing through git; with `turnOnRemotes`, the trackers it turned off come back. */
  async disable(turnOnRemotes = false): Promise<void> {
    const off = this.status?.remotesOff ?? [];
    this.busy = 'disabling';
    try {
      this.status = await this.#api.disableGit(turnOnRemotes ? { turnOnRemotes: true } : {});
      this.#host.notify(
        'info',
        'Git sync turned off',
        turnOnRemotes && off.length ? [`${nameList(off)} turned back on.`] : undefined,
      );
      await this.#host.remotesChanged();
    } catch (error) {
      this.#host.report(error);
    } finally {
      this.busy = null;
    }
  }

  /** Turn one turned-off tracker back on, then re-read where things stand. */
  async turnOn(name: string): Promise<void> {
    this.busy = 'loading';
    try {
      await this.#api.turnRemoteOn(name);
      this.status = await this.#api.gitStatus(false);
      this.#host.notify('info', `${name} turned on`);
      await this.#host.remotesChanged();
    } catch (error) {
      this.#host.report(error);
    } finally {
      this.busy = null;
    }
  }
}

const KEY = Symbol('git-sync');

export function provideGitState(state: GitState): GitState {
  setContext(KEY, state);
  return state;
}

export function useGitState(): GitState {
  return getContext<GitState>(KEY);
}
