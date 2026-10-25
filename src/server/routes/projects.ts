import path from 'node:path';
import type { BoardBackup, BoardPaths, ProjectEntry } from '../../core/index.js';
import {
  LPM_DIR,
  backupBoardAsync,
  backupNamed,
  backupsDir,
  boardPathsAt,
  centralStorePath,
  findBackup,
  isCentralBoard,
  listBackups,
  listProjects,
  recordProjectQuietly,
  relocateBoardAsync,
  restoreBackupAsync,
  restoreTarget,
  samePath,
} from '../../core/index.js';
import type { BackupListDto, BoardBackupDto, BoardStoreInfoDto, ProjectEntryDto } from '../../shared/index.js';
import { listViews } from '../views/store.js';
import type { DesktopLauncher } from '../desktop.js';
import { onDesktop } from '../desktop.js';
import { HttpError, readJson, sendJson } from '../http/respond.js';
import type { Router } from '../http/router.js';
import { followMovedBoard, storeJobs } from '../jobs.js';
import type { BoardLauncher } from '../launcher.js';

/**
 * The project index over HTTP, on a board server and on the hub:
 *
 * | Route | Body | Answer |
 * | --- | --- | --- |
 * | `GET /api/projects` | — | `ProjectEntryDto[]`, from `listProjects` |
 * | `POST /api/projects/open` | `{ lpmDir }` | `{ url }` of a server for that board |
 * | `POST /api/projects/reveal` | `{ lpmDir }` | Shows `<root>/.lpm` in the file manager |
 * | `POST /api/projects/views` | `{ lpmDir }` | `ViewSummary[]`: the views in `<lpmDir>/views`, newest save first |
 * | `GET /api/projects/backups` | — | `BackupListDto`, from `listBackups` |
 * | `GET /api/projects/jobs` | — | `StoreJobDto[]`: the background jobs of this process |
 * | `POST /api/projects/move` | `{ lpmDir, to }` | 202 and the job that moves the board to `to` (`local` or `central`) |
 * | `POST /api/projects/backup` | `{ lpmDir, confirm? }` | 202 and the job that backs the board up |
 * | `POST /api/projects/restore` | `{ name, confirm }` | 202 and the job that restores the backup `name` |
 * | `GET /api/projects/self` | — | `BoardStoreInfoDto` of the board of this server. A board server only. |
 *
 * A request names a project by its board folder, and the route looks the
 * folder up in the current list. The path that the route uses comes from the
 * list, never from the request, so no request can open, reveal, move or back
 * up a folder that is not a recorded board (404). A restore names the backup
 * by its folder name in `.lpm_backups`, and the route looks the name up in the
 * list of backups.
 *
 * A backup that replaces an existing backup needs `confirm: "backup"`, and a
 * restore always needs `confirm: "restore"`. The web app sends the word that
 * the person typed in the confirmation dialog. Without the word, a backup
 * answers 409 and a restore answers 400.
 */
export interface ProjectRoutesOptions {
  launcher: BoardLauncher;
  desktopLauncher?: DesktopLauncher;
  /** The board of this server, which `open` answers with this server's own URL. Null on the hub. */
  self: BoardPaths | null;
}

/** The word that a backup over an existing backup needs. */
export const CONFIRM_BACKUP = 'backup';
/** The word that a restore needs. */
export const CONFIRM_RESTORE = 'restore';

function toDto(entry: ProjectEntry): ProjectEntryDto {
  return { ...entry };
}

function backupDto(backup: BoardBackup): BoardBackupDto {
  return { ...backup };
}

async function entryOf(body: { lpmDir?: unknown }): Promise<ProjectEntry> {
  const lpmDir = typeof body.lpmDir === 'string' ? body.lpmDir : '';
  const entry = lpmDir ? listProjects().find((candidate) => samePath(candidate.lpmDir, lpmDir)) : undefined;
  if (!entry) throw new HttpError(404, 'No recorded project has this board folder', ['`lpm projects` lists them.']);
  return entry;
}

/** The board of a project that a move or a backup can work on: its folder must be where the list says. */
function boardOf(entry: ProjectEntry): BoardPaths {
  if (entry.state !== 'ok' || entry.root === null) {
    throw new HttpError(409, `The board of ${entry.name} is not at its recorded place, or its project folder is not known`, [
      'Open the "All projects" page again to see where the board is now.',
    ]);
  }
  return boardPathsAt(entry.lpmDir, { root: entry.root });
}

function refuseWhenBusy(root: string): void {
  const busy = storeJobs.running(root);
  if (busy) {
    throw new HttpError(409, `The board of ${root} is busy with a ${busy.kind}`, ['Wait until it is done, then try again.']);
  }
}

export function projectRoutes(router: Router, options: ProjectRoutesOptions): void {
  router.get('/api/projects', ({ res }) => {
    sendJson(res, 200, listProjects().map(toDto));
  });

  router.post('/api/projects/open', async ({ req, res }) => {
    const entry = await entryOf(await readJson(req));
    if (entry.state === 'missing') {
      throw new HttpError(409, `The board of ${entry.name} is not at ${entry.lpmDir}`, [
        '`lpm projects prune` removes the projects whose board is gone.',
      ]);
    }
    if (options.self && samePath(options.self.lpmDir, entry.lpmDir)) {
      sendJson(res, 200, { url: `http://${req.headers.host ?? '127.0.0.1'}` });
      return;
    }
    const paths = boardPathsAt(entry.lpmDir, { root: entry.root ?? entry.lpmDir });
    try {
      sendJson(res, 200, { url: await options.launcher.open(paths) });
    } catch (error) {
      throw new HttpError(503, (error as Error).message);
    }
  });

  router.post('/api/projects/reveal', async ({ req, res }) => {
    const entry = await entryOf(await readJson(req));
    if (entry.state !== 'ok' || entry.root === null) {
      throw new HttpError(409, `The project folder of ${entry.name} is not known or is gone`);
    }
    const folder = path.join(entry.root, LPM_DIR);
    await onDesktop('reveal', folder, options.desktopLauncher);
    sendJson(res, 200, { revealed: folder });
  });

  // The views of one board, for the collapsible section of a row on the
  // "All projects" page. The route reads the view files only, so it works for
  // a board that no server holds open.
  router.post('/api/projects/views', async ({ req, res }) => {
    const entry = await entryOf(await readJson(req));
    if (entry.state === 'missing') {
      throw new HttpError(409, `The board of ${entry.name} is not at ${entry.lpmDir}`);
    }
    const paths = boardPathsAt(entry.lpmDir, { root: entry.root ?? entry.lpmDir });
    sendJson(res, 200, listViews(paths));
  });

  router.get('/api/projects/backups', ({ res }) => {
    const body: BackupListDto = {
      store: centralStorePath(),
      backupsDir: backupsDir(),
      backups: listBackups().map(backupDto),
    };
    sendJson(res, 200, body);
  });

  router.get('/api/projects/jobs', ({ res }) => {
    sendJson(res, 200, storeJobs.list());
  });

  router.post('/api/projects/move', async ({ req, res }) => {
    const body = await readJson<{ lpmDir?: unknown; to?: unknown }>(req);
    const to = body.to;
    if (to !== 'local' && to !== 'central') {
      throw new HttpError(400, 'The key "to" must hold "local" or "central"');
    }
    const entry = await entryOf(body);
    const paths = boardOf(entry);
    if (entry.store === to) {
      throw new HttpError(409, to === 'central' ? `${entry.name} is in the central store already` : `${entry.name} is in its project already`);
    }
    if (to === 'central' && centralStorePath() === null) {
      throw new HttpError(409, 'No central store is set', ['Name one with `lpm set central_store`.']);
    }
    refuseWhenBusy(paths.root);
    const job = storeJobs.start('move', paths.root, to, async (report) => {
      const result = await relocateBoardAsync(paths, to, { onProgress: report });
      followMovedBoard(result.previousDir, result.paths);
      options.launcher.moved(result.previousDir, result.paths.lpmDir);
      recordProjectQuietly(result.paths);
      const where = to === 'central' ? 'the central store' : 'the project';
      return {
        message: `Moved ${entry.name} to ${where}: ${result.paths.lpmDir}`,
        notes: [...(result.backup ? [`The backup is in ${result.backup.dir}.`] : []), ...result.warnings],
      };
    });
    sendJson(res, 202, job);
  });

  router.post('/api/projects/backup', async ({ req, res }) => {
    const body = await readJson<{ lpmDir?: unknown; confirm?: unknown }>(req);
    const entry = await entryOf(body);
    const paths = boardOf(entry);
    const existing = findBackup(paths.root);
    const replace = body.confirm === CONFIRM_BACKUP;
    if (existing && !replace) {
      throw new HttpError(409, `${entry.name} already has a backup, from ${existing.createdAt}`, [
        `Each board has one backup. Send confirm: "${CONFIRM_BACKUP}" to replace it.`,
      ]);
    }
    refuseWhenBusy(paths.root);
    const job = storeJobs.start('backup', paths.root, null, async (report) => {
      const backup = await backupBoardAsync(paths, { replace, onProgress: report });
      return { message: `Backed up ${entry.name} to ${backup.dir}`, notes: [] };
    });
    sendJson(res, 202, job);
  });

  router.post('/api/projects/restore', async ({ req, res }) => {
    const body = await readJson<{ name?: unknown; confirm?: unknown }>(req);
    const backup = typeof body.name === 'string' ? backupNamed(body.name) : null;
    if (!backup) throw new HttpError(404, 'No backup has this name', ['`lpm store backups` lists them.']);
    if (body.confirm !== CONFIRM_RESTORE) {
      throw new HttpError(400, `A restore overwrites the board. Send confirm: "${CONFIRM_RESTORE}" to run it.`);
    }
    // Throws a BoardError (400) when the project folder is gone.
    restoreTarget(backup);
    refuseWhenBusy(backup.projectPath);
    const job = storeJobs.start('restore', backup.projectPath, null, async (report) => {
      const result = await restoreBackupAsync(backup, { onProgress: report });
      recordProjectQuietly(result.paths);
      return {
        message: `Restored ${path.basename(backup.projectPath)} from the backup of ${backup.createdAt}: ${result.paths.lpmDir}`,
        notes: result.warnings,
      };
    });
    sendJson(res, 202, job);
  });

  const self = options.self;
  if (self) {
    router.get('/api/projects/self', ({ res }) => {
      const backup = findBackup(self.root);
      const info: BoardStoreInfoDto = {
        name: path.basename(self.root),
        root: self.root,
        lpmDir: self.lpmDir,
        store: isCentralBoard(self) ? 'central' : 'local',
        centralStore: centralStorePath(),
        backup: backup ? backupDto(backup) : null,
        job: storeJobs.latest(self.root) ?? null,
      };
      sendJson(res, 200, info);
    });
  }
}
