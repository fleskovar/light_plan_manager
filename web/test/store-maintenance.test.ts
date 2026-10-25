import { describe, expect, it } from 'vitest';
import type { BackupListDto, BoardBackupDto, BoardStoreInfoDto, ProjectEntryDto, StoreJobDto } from '$shared';
import type { Confirmation } from '$lib/app/shell.svelte.js';
import { StoragePanel } from '$features/config/storage.svelte.js';
import { StoreJobWatcher } from '$features/projects/jobs.svelte.js';
import {
  CONFIRM_BACKUP,
  CONFIRM_RESTORE,
  ageInDays,
  ageText,
  backupConfirmation,
  jobPercent,
  jobText,
  restoreConfirmation,
  sizeText,
} from '$features/projects/maintenance.js';
import type { ProjectsApi } from '$features/projects/projects.svelte.js';
import { ProjectsPage } from '$features/projects/projects.svelte.js';

/**
 * Moving a board between its project and the central store, backing it up and
 * restoring it, from the "All projects" page and from the Storage tab of the
 * board configuration. The server side has its own tests in
 * `test/server-store-jobs.test.ts`.
 */

const NOW = new Date('2026-10-25T12:00:00.000Z');

function entry(name: string, overrides: Partial<ProjectEntryDto> = {}): ProjectEntryDto {
  return {
    name,
    root: `/work/${name}`,
    lpmDir: `/work/${name}/.lpm`,
    store: 'local',
    keyPrefix: 'SH',
    lastUsed: '2026-10-24T10:00:00.000Z',
    state: 'ok',
    ...overrides,
  };
}

function backup(name: string, overrides: Partial<BoardBackupDto> = {}): BoardBackupDto {
  return {
    name: `${name}_backup`,
    dir: `/boards/.lpm_backups/${name}_backup`,
    projectPath: `/work/${name}`,
    createdAt: '2026-10-13T09:30:00.000Z',
    source: 'local',
    sourceDir: `/work/${name}/.lpm`,
    keyPrefix: 'SH',
    files: 12,
    bytes: 20_480,
    ...overrides,
  };
}

function job(overrides: Partial<StoreJobDto> = {}): StoreJobDto {
  return {
    id: 'j1',
    kind: 'move',
    root: '/work/shop',
    to: 'central',
    state: 'running',
    step: null,
    phase: null,
    stepIndex: 0,
    stepCount: 0,
    done: 0,
    total: 0,
    message: null,
    notes: [],
    startedAt: '2026-10-25T12:00:00.000Z',
    finishedAt: null,
    ...overrides,
  };
}

/** A timer that the test runs by hand. */
function manualSchedule() {
  const pending: (() => void)[] = [];
  return {
    schedule: (callback: () => void) => {
      pending.push(callback);
      return { cancel: () => pending.splice(pending.indexOf(callback), 1) };
    },
    pending,
    runNext: () => pending.shift()?.(),
  };
}

/** A server with one list of jobs, which the test changes between two polls. */
function fakeServer(projects: ProjectEntryDto[], list: BackupListDto) {
  const calls: string[] = [];
  let jobs: StoreJobDto[] = [];
  let loads = 0;
  const api: ProjectsApi = {
    list: async () => {
      loads++;
      return projects;
    },
    open: async () => ({ url: '' }),
    reveal: async () => {},
    backups: async () => list,
    jobs: async () => jobs,
    move: async (lpmDir, to) => {
      calls.push(`move ${lpmDir} ${to}`);
      jobs = [job({ to })];
      return jobs[0]!;
    },
    backup: async (lpmDir, confirm) => {
      calls.push(`backup ${lpmDir} ${confirm ?? '-'}`);
      jobs = [job({ kind: 'backup', to: null })];
      return jobs[0]!;
    },
    restore: async (name, confirm) => {
      calls.push(`restore ${name} ${confirm}`);
      jobs = [job({ kind: 'restore', to: null })];
      return jobs[0]!;
    },
  };
  return {
    api,
    calls,
    setJobs: (next: StoreJobDto[]) => {
      jobs = next;
    },
    loads: () => loads,
  };
}

const STORE: BackupListDto = { store: '/boards', backupsDir: '/boards/.lpm_backups', backups: [] };

describe('the age and size of a backup', () => {
  it('counts whole days, and says "1 day" for one', () => {
    expect(ageInDays('2026-10-13T09:30:00.000Z', NOW)).toBe(12);
    expect(ageInDays('2026-10-25T11:00:00.000Z', NOW)).toBe(0);
    expect(ageInDays('2026-10-24T11:00:00.000Z', NOW)).toBe(1);
    expect([ageText(0), ageText(1), ageText(12)]).toEqual(['0 days', '1 day', '12 days']);
  });

  it('gives a size with a unit', () => {
    expect([sizeText(512), sizeText(20_480), sizeText(3 * 1024 * 1024)]).toEqual(['512 B', '20.0 KB', '3.0 MB']);
  });
});

describe('the progress of a job', () => {
  it('splits each step into the copy and the comparison', () => {
    const backingUp = job({ step: 'backup', phase: 'copy', stepIndex: 1, stepCount: 2, done: 50, total: 100 });
    const comparing = job({ step: 'copy', phase: 'compare', stepIndex: 2, stepCount: 2, done: 100, total: 100 });
    expect(jobPercent(backingUp)).toBe(13);
    expect(jobPercent(comparing)).toBe(100);
    expect(jobText(backingUp)).toBe('Step 1 of 2: Backing up (13%)');
    expect(jobText(job({ step: 'copy', phase: 'compare', stepIndex: 2, stepCount: 2, done: 0, total: 100 }))).toBe(
      'Step 2 of 2: Copying the board, checking the copy (75%)',
    );
  });

  it('shows the result of a finished job', () => {
    expect(jobText(job({ state: 'done', message: 'Moved shop to the central store' }))).toBe('Moved shop to the central store');
    expect(jobText(job({ state: 'failed', message: 'disk full' }))).toBe('Failed: disk full');
  });
});

describe('the confirmations', () => {
  it('asks for no typed word for a first backup, and for "backup" when one exists', () => {
    const first = backupConfirmation({ name: 'shop', backup: null, now: NOW, onConfirm: () => {} });
    const replace = backupConfirmation({ name: 'shop', backup: backup('shop'), now: NOW, onConfirm: () => {} });
    expect(first.typeToConfirm).toBeUndefined();
    expect(replace.typeToConfirm).toBe(CONFIRM_BACKUP);
    expect(replace.details?.join(' ')).toContain('12 days old');
  });

  it('always asks for "restore" before a restore', () => {
    const confirmation = restoreConfirmation({ backup: backup('shop'), now: NOW, onConfirm: () => {} });
    expect(confirmation.typeToConfirm).toBe(CONFIRM_RESTORE);
    expect(confirmation.danger).toBe(true);
    expect(confirmation.message).toContain('overwrites');
  });
});

describe('the "All projects" page', () => {
  it('moves a board after the confirmation, shows the progress and reloads when the job ends', async () => {
    const server = fakeServer([entry('shop')], STORE);
    const timer = manualSchedule();
    const page = new ProjectsPage(server.api, () => {}, { now: () => NOW, schedule: timer.schedule });
    await page.load();

    expect(page.rows[0]).toMatchObject({ moveLabel: 'Move to central', canMove: true, canBackup: true });
    page.requestMove('/work/shop/.lpm');
    expect(page.confirmation?.title).toBe('Move shop to the central store?');
    expect(server.calls).toEqual([]);

    page.resolveConfirmation(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(server.calls).toEqual(['move /work/shop/.lpm central']);
    expect(page.rows[0]!.job?.state).toBe('running');
    expect(page.rows[0]!.canMove).toBe(false);

    server.setJobs([job({ state: 'done', message: 'Moved shop', finishedAt: '2026-10-25T12:01:00.000Z' })]);
    const before = server.loads();
    timer.runNext();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.notice).toEqual({ kind: 'done', message: 'Moved shop', notes: [] });
    expect(server.loads()).toBe(before + 1);
    expect(timer.pending).toHaveLength(0);
  });

  it('does nothing when the confirmation is cancelled', async () => {
    const server = fakeServer([entry('shop')], STORE);
    const page = new ProjectsPage(server.api, () => {}, { now: () => NOW, schedule: manualSchedule().schedule });
    await page.load();
    page.requestBackup('/work/shop/.lpm');
    page.resolveConfirmation(false);
    await Promise.resolve();
    expect(server.calls).toEqual([]);
  });

  it('sends the word "backup" when it replaces a backup', async () => {
    const server = fakeServer([entry('shop')], { ...STORE, backups: [backup('shop')] });
    const page = new ProjectsPage(server.api, () => {}, { now: () => NOW, schedule: manualSchedule().schedule });
    await page.load();
    page.requestBackup('/work/shop/.lpm');
    expect(page.confirmation?.typeToConfirm).toBe('backup');
    page.resolveConfirmation(true);
    await Promise.resolve();
    expect(server.calls).toEqual(['backup /work/shop/.lpm backup']);
  });

  it('lists the backups with date and age, and restores one with the word "restore"', async () => {
    const server = fakeServer([entry('shop')], { ...STORE, backups: [backup('shop')] });
    const page = new ProjectsPage(server.api, () => {}, { now: () => NOW, schedule: manualSchedule().schedule });
    await page.load();
    expect(page.backupRows.map((row) => [row.projectName, row.ageDays, row.ageText, row.sizeText])).toEqual([
      ['shop', 12, '12 days', '20.0 KB'],
    ]);
    expect(page.backupRows[0]!.dateText).toMatch(/^2026-10-13 \d\d:\d\d$/);

    page.requestRestore('shop_backup');
    page.resolveConfirmation(true);
    await Promise.resolve();
    expect(server.calls).toEqual(['restore shop_backup restore']);
  });

  it('turns the move to central off without a central store', async () => {
    const server = fakeServer([entry('shop'), entry('blog', { store: 'central', lpmDir: '/old/.lpm_central/blog' })], {
      store: null,
      backupsDir: null,
      backups: [],
    });
    const page = new ProjectsPage(server.api, () => {}, { now: () => NOW, schedule: manualSchedule().schedule });
    await page.load();
    expect(page.rows.map((row) => [row.name, row.moveLabel, row.canMove, row.canBackup])).toEqual([
      ['shop', 'Move to central', false, false],
      ['blog', 'Move to project', true, true],
    ]);
    expect(page.rows[0]!.moveTitle).toContain('No central store');
    expect(page.backupsEmptyText).toContain('No central store');
  });
});

describe('the job watcher', () => {
  it('polls only while a job runs, and reports each ended job once', async () => {
    let jobs = [job()];
    const ended: string[] = [];
    const timer = manualSchedule();
    const watcher = new StoreJobWatcher({ jobs: async () => jobs }, (finished) => ended.push(finished.state), {
      schedule: timer.schedule,
    });

    await watcher.poll();
    expect(watcher.busy).toBe(true);
    expect(timer.pending).toHaveLength(1);

    jobs = [job({ state: 'failed', message: 'disk full' })];
    timer.runNext();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ended).toEqual(['failed']);
    expect(timer.pending).toHaveLength(0);

    await watcher.poll();
    expect(ended).toEqual(['failed']);
  });
});

describe('the Storage tab of the board configuration', () => {
  function info(overrides: Partial<BoardStoreInfoDto> = {}): BoardStoreInfoDto {
    return {
      name: 'shop',
      root: '/work/shop',
      lpmDir: '/work/shop/.lpm',
      store: 'local',
      centralStore: '/boards',
      backup: null,
      job: null,
      ...overrides,
    };
  }

  function panelWith(current: BoardStoreInfoDto) {
    const calls: string[] = [];
    const confirmations: Confirmation[] = [];
    const panel = new StoragePanel(
      {
        info: async () => current,
        jobs: async () => [],
        move: async (lpmDir, to) => {
          calls.push(`move ${lpmDir} ${to}`);
          return job({ to });
        },
        backup: async (lpmDir, confirm) => {
          calls.push(`backup ${lpmDir} ${confirm ?? '-'}`);
          return job({ kind: 'backup' });
        },
        restore: async (name, confirm) => {
          calls.push(`restore ${name} ${confirm}`);
          return job({ kind: 'restore' });
        },
      },
      (confirmation) => confirmations.push(confirmation),
      { now: () => NOW, schedule: manualSchedule().schedule },
    );
    return { panel, calls, confirmations };
  }

  it('moves its own board after the confirmation', async () => {
    const { panel, calls, confirmations } = panelWith(info());
    await panel.load();
    expect(panel.moveLabel).toBe('Move to central');
    panel.requestMove();
    expect(confirmations).toHaveLength(1);
    confirmations[0]!.onConfirm(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['move /work/shop/.lpm central']);
    expect(panel.running).toBe(true);
    expect(panel.canMove).toBe(false);
  });

  it('shows the backup with its age, and restores it with the word "restore"', async () => {
    const { panel, calls, confirmations } = panelWith(info({ store: 'central', backup: backup('shop') }));
    await panel.load();
    expect(panel.backupText).toMatch(/^2026-10-13 \d\d:\d\d, 12 days old$/);
    expect(panel.canRestore).toBe(true);
    panel.requestRestore();
    expect(confirmations[0]!.typeToConfirm).toBe('restore');
    confirmations[0]!.onConfirm(false);
    await Promise.resolve();
    expect(calls).toEqual(['restore shop_backup restore']);
  });

  it('has no restore without a backup, and no move to central without a central store', async () => {
    const { panel } = panelWith(info({ centralStore: null }));
    await panel.load();
    expect(panel.canRestore).toBe(false);
    expect(panel.canMove).toBe(false);
    expect(panel.canBackup).toBe(false);
  });
});
