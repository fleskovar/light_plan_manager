import path from 'node:path';
import type { BoardPaths, ProjectEntry } from '../../core/index.js';
import { LPM_DIR, boardPathsAt, listProjects, samePath } from '../../core/index.js';
import type { ProjectEntryDto } from '../../shared/index.js';
import type { DesktopLauncher } from '../desktop.js';
import { onDesktop } from '../desktop.js';
import { HttpError, readJson, sendJson } from '../http/respond.js';
import type { Router } from '../http/router.js';
import type { BoardLauncher } from '../launcher.js';

/**
 * The project index over HTTP, on a board server and on the hub:
 *
 * | Route | Body | Answer |
 * | --- | --- | --- |
 * | `GET /api/projects` | — | `ProjectEntryDto[]`, from `listProjects` |
 * | `POST /api/projects/open` | `{ lpmDir }` | `{ url }` of a server for that board |
 * | `POST /api/projects/reveal` | `{ lpmDir }` | Shows `<root>/.lpm` in the file manager |
 *
 * A request names a project by its board folder, and the route looks the
 * folder up in the current list. The path that the route uses comes from the
 * list, never from the request, so no request can open or reveal a folder
 * that is not a recorded board (404).
 */
export interface ProjectRoutesOptions {
  launcher: BoardLauncher;
  desktopLauncher?: DesktopLauncher;
  /** The board of this server, which `open` answers with this server's own URL. Null on the hub. */
  self: BoardPaths | null;
}

function toDto(entry: ProjectEntry): ProjectEntryDto {
  return { ...entry };
}

async function entryOf(req: Parameters<typeof readJson>[0]): Promise<ProjectEntry> {
  const body = await readJson<{ lpmDir?: unknown }>(req);
  const lpmDir = typeof body.lpmDir === 'string' ? body.lpmDir : '';
  const entry = lpmDir ? listProjects().find((candidate) => samePath(candidate.lpmDir, lpmDir)) : undefined;
  if (!entry) throw new HttpError(404, 'No recorded project has this board folder', ['`lpm projects` lists them.']);
  return entry;
}

export function projectRoutes(router: Router, options: ProjectRoutesOptions): void {
  router.get('/api/projects', ({ res }) => {
    sendJson(res, 200, listProjects().map(toDto));
  });

  router.post('/api/projects/open', async ({ req, res }) => {
    const entry = await entryOf(req);
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
    const entry = await entryOf(req);
    if (entry.state !== 'ok' || entry.root === null) {
      throw new HttpError(409, `The project folder of ${entry.name} is not known or is gone`);
    }
    const folder = path.join(entry.root, LPM_DIR);
    await onDesktop('reveal', folder, options.desktopLauncher);
    sendJson(res, 200, { revealed: folder });
  });
}
