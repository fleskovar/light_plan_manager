import { describe, expect, it } from 'vitest';
import {
  GitState,
  describeSync,
  defaultBranch,
  effectiveBranch,
  emptyGitDraft,
  gitDraftProblem,
  gitSummary,
  nameList,
  panelMode,
  setupRequestOf,
  withWhere,
  type GitApi,
  type GitStateHost,
} from '$features/drawer/remote/git.svelte.js';
import type { GitDisableRequest, GitSetupRequest, GitSyncStatusDto, GitUrlCheckDto } from '$shared';

/**
 * The Git panel's decisions, without a DOM or a server: which panel the Sync
 * tab holds, what the setup form sends, and what the status card says.
 */

const GITHUB = {
  id: 'github' as const,
  label: 'GitHub',
  examples: ['https://github.com/<owner>/<repo>.git'],
  create: 'https://github.com/new',
  credentials: 'Git Credential Manager',
};

function status(over: Partial<GitSyncStatusDto> = {}): GitSyncStatusDto {
  return {
    enabled: true,
    problem: null,
    trackers: [],
    remotesOff: [],
    remote: 'origin',
    branch: 'main',
    url: 'https://github.com/acme/board.git',
    host: GITHUB,
    usesProjectRepository: false,
    project: null,
    repository: true,
    committed: true,
    published: true,
    ahead: 0,
    behind: 0,
    uncommitted: [],
    conflict: null,
    offline: false,
    lastFetch: { at: '2026-10-05T10:00:00.000Z', error: null },
    hosts: [GITHUB],
    projectBranch: '_lpm_board_remote',
    ...over,
  };
}

const PROJECT = { remote: 'origin', url: 'git@github.com:acme/app.git', host: GITHUB };

describe('which panel the Sync tab holds', () => {
  it('is the git panel whenever git sync is on', () => {
    expect(panelMode(status(), 0)).toBe('git');
  });

  it('is the tracker panel while trackers are declared, and empty when nothing is', () => {
    expect(panelMode(status({ enabled: false }), 2)).toBe('trackers');
    expect(panelMode(null, 0)).toBe('empty');
  });
});

describe('the setup form', () => {
  it("defaults to the project's own repository when there is one", () => {
    expect(emptyGitDraft(status({ enabled: false, project: PROJECT })).where).toBe('project');
    expect(emptyGitDraft(status({ enabled: false })).where).toBe('url');
  });

  it('opens with the branch filled in: the board branch in the project repository, else main', () => {
    expect(emptyGitDraft(status({ enabled: false, project: PROJECT })).branch).toBe('_lpm_board_remote');
    expect(emptyGitDraft(status({ enabled: false })).branch).toBe('main');
    expect(defaultBranch('project', null)).toBe('_lpm_board_remote');
  });

  it('moves the filled-in branch with the choice of repository, and keeps a branch that was typed', () => {
    const off = status({ enabled: false, project: PROJECT });
    const opened = emptyGitDraft(off);

    const separate = withWhere(opened, 'url', off);
    expect(separate).toMatchObject({ where: 'url', branch: 'main' });
    expect(withWhere(separate, 'project', off).branch).toBe('_lpm_board_remote');

    expect(withWhere({ ...opened, branch: '' }, 'url', off).branch).toBe('main');
    expect(withWhere({ ...opened, branch: 'plan' }, 'url', off).branch).toBe('plan');
  });

  it("uses the project's board branch, else main, unless one is typed", () => {
    const off = status({ enabled: false, project: PROJECT });
    expect(effectiveBranch({ where: 'project', url: '', branch: '' }, off)).toBe('_lpm_board_remote');
    expect(effectiveBranch({ where: 'url', url: 'x', branch: '' }, off)).toBe('main');
    expect(effectiveBranch({ where: 'url', url: 'x', branch: 'board' }, off)).toBe('board');
  });

  it('lets the form be filled in while trackers are declared — Share asks about them instead', () => {
    const problem = gitDraftProblem(
      { where: 'url', url: 'https://github.com/acme/board.git', branch: '' },
      status({ enabled: false, trackers: ['jira'] }),
    );
    expect(problem).toBeNull();
  });

  it('names the trackers the way a sentence would', () => {
    expect(nameList(['jira'])).toBe('jira');
    expect(nameList(['jira', 'github'])).toBe('jira and github');
    expect(nameList(['jira', 'github', 'linear'])).toBe('jira, github and linear');
  });

  it('asks for a URL, and rejects one that cannot be one', () => {
    const off = status({ enabled: false });
    expect(gitDraftProblem({ where: 'url', url: '  ', branch: '' }, off)).toMatch(/URL/);
    expect(gitDraftProblem({ where: 'url', url: '--upload-pack=x', branch: '' }, off)).toMatch(/Not a valid/);
    expect(gitDraftProblem({ where: 'url', url: 'https://x/y.git', branch: 'a b' }, off)).toMatch(/branch/);
    expect(gitDraftProblem({ where: 'url', url: 'https://x/y.git', branch: '' }, off)).toBeNull();
  });

  it('sends the project flag or the URL, never both', () => {
    expect(setupRequestOf({ where: 'project', url: 'ignored', branch: '' })).toEqual({ project: true, branch: undefined });
    expect(setupRequestOf({ where: 'url', url: ' https://x/y.git ', branch: 'b' })).toEqual({
      url: 'https://x/y.git',
      branch: 'b',
    });
  });
});

describe('the status card', () => {
  it('leads with a conflict over everything else', () => {
    const summary = gitSummary(
      status({ ahead: 2, conflict: { reason: 'diverged', paths: ['board/LP-1/_issue.md'], documents: ['LP-1'] } }),
    );
    expect(summary.tone).toBe('error');
    expect(summary.detail).toContain('LP-1');
  });

  it('says when the remote cannot be reached, and that changes are blocked', () => {
    const summary = gitSummary(status({ lastFetch: { at: '2026-10-05T10:00:00Z', error: 'Could not resolve host' } }));
    expect(summary.tone).toBe('warn');
    expect(summary.detail).toMatch(/blocked/);
  });

  it('counts what is waiting in each direction', () => {
    expect(gitSummary(status({ ahead: 1, behind: 3 })).detail).toBe('1 commit to push, 3 commits to pull.');
    expect(gitSummary(status()).tone).toBe('ok');
  });

  it('describes what a sync did', () => {
    expect(describeSync({ saved: 2, pulled: 'rebased', pushed: true, status: status() })).toBe(
      'Synced: committed 2 local edits, pulled, pushed',
    );
    expect(describeSync({ saved: 0, pulled: 'current', pushed: false, status: status() })).toBe(
      'Already up to date',
    );
  });
});

describe('the state machine', () => {
  function fake(over: Partial<GitApi> = {}): { api: GitApi; host: GitStateHost; notes: string[]; changed: string[] } {
    const notes: string[] = [];
    const changed: string[] = [];
    const api: GitApi = {
      gitStatus: async () => status({ enabled: false, project: PROJECT }),
      checkGitUrl: async (body): Promise<GitUrlCheckDto> => ({
        url: body.url ?? PROJECT.url,
        host: GITHUB,
        reachable: true,
        branchExists: false,
        error: null,
      }),
      setupGit: async () => status({ usesProjectRepository: true, branch: '_lpm_board_remote' }),
      syncGit: async () => ({ saved: 0, pulled: 'fast-forward', pushed: false, status: status() }),
      disableGit: async () => status({ enabled: false }),
      turnRemoteOn: async (name) => ({ name }),
      ...over,
    };
    const host: GitStateHost = {
      notify: (_level, message) => notes.push(message),
      report: (error) => notes.push(`error: ${(error as Error).message}`),
      boardChanged: async () => {
        changed.push('board');
      },
      remotesChanged: async () => {
        changed.push('remotes');
      },
    };
    return { api, host, notes, changed };
  }

  it('shares the board and re-reads the board and the remotes', async () => {
    const { api, host, changed } = fake();
    const git = new GitState(api, host);
    await git.load();
    git.openSetup();
    expect(git.draft?.where).toBe('project');
    expect(await git.submitSetup()).toBe(true);
    expect(git.draft).toBeNull();
    expect(git.status?.enabled).toBe(true);
    expect(changed).toEqual(['remotes', 'board']);
  });

  it('asks before turning a tracker off, and only the confirm sends anything', async () => {
    const sent: GitSetupRequest[] = [];
    const { api, host, notes } = fake({
      gitStatus: async () => status({ enabled: false, project: PROJECT, trackers: ['jira'] }),
      setupGit: async (body) => {
        sent.push(body);
        return status({ remotesOff: ['jira'] });
      },
    });
    const git = new GitState(api, host);
    await git.load();
    git.openSetup();

    // Share opens the warning and sends nothing.
    expect(await git.submitSetup()).toBe(false);
    expect(git.turnOffQuestion).toEqual(['jira']);
    expect(sent).toEqual([]);

    // Back returns to the form exactly as it was.
    git.cancelTurnOff();
    expect(git.turnOffQuestion).toBeNull();
    expect(git.draft?.where).toBe('project');

    // Confirming turns the tracker off and shares, in one request.
    expect(await git.submitSetup()).toBe(false);
    expect(await git.submitSetup(true)).toBe(true);
    expect(sent).toEqual([{ project: true, branch: '_lpm_board_remote', turnOffRemotes: true }]);
    expect(git.turnOffQuestion).toBeNull();
    expect(git.draft).toBeNull();
    expect(notes.at(-1)).toMatch(/Shared/);
  });

  it('changes the branch with the repository choice and forgets the last check', async () => {
    const { api, host } = fake({
      gitStatus: async () => status({ enabled: false, project: PROJECT }),
    });
    const git = new GitState(api, host);
    await git.load();
    git.openSetup();
    expect(git.draft?.branch).toBe('_lpm_board_remote');
    await git.checkDraft();
    expect(git.check).not.toBeNull();

    git.chooseWhere('url');

    expect(git.draft).toMatchObject({ where: 'url', branch: 'main' });
    expect(git.check).toBeNull();
  });

  it('never asks to turn anything off on a board with no tracker', async () => {
    const sent: GitSetupRequest[] = [];
    const { api, host } = fake({
      setupGit: async (body) => {
        sent.push(body);
        return status();
      },
    });
    const git = new GitState(api, host);
    await git.load();
    git.openSetup();
    expect(await git.submitSetup()).toBe(true);
    expect(git.turnOffQuestion).toBeNull();
    expect(sent[0]).not.toHaveProperty('turnOffRemotes');
  });

  it('turns git off alone, or with the trackers it turned off back on', async () => {
    const asked: Array<GitDisableRequest | undefined> = [];
    const { api, host, changed } = fake({
      gitStatus: async () => status({ remotesOff: ['jira'] }),
      disableGit: async (body) => {
        asked.push(body);
        return status({ enabled: false, trackers: body?.turnOnRemotes ? ['jira'] : [] });
      },
    });
    const git = new GitState(api, host);
    await git.load();
    await git.disable();
    await git.load();
    await git.disable(true);
    expect(asked).toEqual([{}, { turnOnRemotes: true }]);
    expect(git.status?.trackers).toEqual(['jira']);
    expect(changed).toEqual(['remotes', 'remotes']);
  });

  it('turns one tracker back on and re-reads where things stand', async () => {
    const turned: string[] = [];
    let reads = 0;
    const { api, host, changed } = fake({
      gitStatus: async () => {
        reads += 1;
        return status({ enabled: false, remotesOff: reads === 1 ? ['jira'] : [], trackers: reads === 1 ? [] : ['jira'] });
      },
      turnRemoteOn: async (name) => {
        turned.push(name);
        return { name };
      },
    });
    const git = new GitState(api, host);
    await git.load();
    await git.turnOn('jira');
    expect(turned).toEqual(['jira']);
    expect(git.status?.remotesOff).toEqual([]);
    expect(git.status?.trackers).toEqual(['jira']);
    expect(changed).toEqual(['remotes']);
  });

  it('keeps the form open when sharing fails, and reports why', async () => {
    const { api, host, notes } = fake({
      setupGit: async () => {
        throw new Error('Could not reach the repository');
      },
    });
    const git = new GitState(api, host);
    await git.load();
    git.openSetup();
    expect(await git.submitSetup()).toBe(false);
    expect(git.draft).not.toBeNull();
    expect(notes.at(-1)).toMatch(/Could not reach/);
  });

  it('checks the URL against the branch the form will use', async () => {
    let asked: { url?: string; branch?: string } = {};
    const { api, host } = fake({
      checkGitUrl: async (body) => {
        asked = body;
        return { url: 'u', host: GITHUB, reachable: true, branchExists: false, error: null };
      },
    });
    const git = new GitState(api, host);
    await git.load();
    git.openSetup();
    await git.checkDraft();
    expect(asked).toEqual({ url: undefined, branch: '_lpm_board_remote' });
    expect(git.check?.reachable).toBe(true);
  });

  it('passes a resolution through and re-reads the board after a sync', async () => {
    let resolution: unknown;
    const { api, host, changed } = fake({
      syncGit: async (body) => {
        resolution = body.resolve;
        return { saved: 0, pulled: 'rebased', pushed: true, status: status() };
      },
    });
    const git = new GitState(api, host);
    await git.sync('theirs');
    expect(resolution).toBe('theirs');
    expect(changed).toEqual(['board']);
  });
});
