import type { Server } from 'node:http';
import path from 'node:path';
import type { CentralBoardEntry } from '../core/index.js';
import {
  BoardError,
  LPM_DIR,
  boardPathsAt,
  centralBoardsDir,
  centralStorePath,
  listCentralBoards,
} from '../core/index.js';
import type { CentralBoardDto, HubInfoDto, ServerInfoDto } from '../shared/index.js';
import type { DesktopLauncher } from './desktop.js';
import { onDesktop } from './desktop.js';
import { sendJson } from './http/respond.js';
import { Router } from './http/router.js';
import { DEFAULT_HOST, DEFAULT_PORT, createGuardedServer, displayHost, launcherFor } from './index.js';
import type { BoardLauncher } from './launcher.js';
import { projectRoutes } from './routes/projects.js';

/**
 * The hub: what `lpm ui` serves in a folder without a board when a central
 * store is set. It serves the web app and four routes, and no board:
 *
 * | Route | Answer |
 * | --- | --- |
 * | `GET /api/hub` | `HubInfoDto`. The web app shows the landing page when this answers. |
 * | `GET /api/hub/boards` | `CentralBoardDto[]`, from `listCentralBoards`. |
 * | `POST /api/hub/boards/:name/open` | `{ url }` of a board server for that board. |
 * | `POST /api/hub/boards/:name/reveal` | Shows `<project>/.lpm` in the file manager. |
 * | `/api/projects`, `/api/projects/open`, `/api/projects/reveal` | The project index, as on a board server (`routes/projects.ts`). The landing page uses these. |
 *
 * `open` starts the board server in this process through a `BoardLauncher`, on
 * the first free port from `boardPort` upward, the same search as `lpm ui`. A
 * second `open` of the same board returns the same URL. The board servers stop
 * when the hub stops.
 *
 * A route finds the board by its name in the current list, never by a path
 * from the request. `reveal` takes the path from `project.json`. So no request
 * can name a folder outside `.lpm_central`, and `..` in a name is a name that
 * is not in the list (404).
 */
export interface HubOptions {
  /** The port of the hub. 0 lets the system pick one. Defaults to 4571. */
  port?: number;
  host?: string;
  /** Serve the built web app. On by default. */
  serveApp?: boolean;
  /** Passed to each board server that the hub starts. */
  experimental?: boolean;
  desktopLauncher?: DesktopLauncher;
  /** The first port to try for a board server. Defaults to 4571. 0 lets the system pick one. */
  boardPort?: number;
  /** The number of ports to try for a board server. Defaults to 20. */
  boardPortAttempts?: number;
}

export interface RunningHub {
  server: Server;
  url: string;
  /** Stop the hub and every board server that it started. */
  close(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function toDto(entry: CentralBoardEntry): CentralBoardDto {
  return { ...entry };
}

/** The board called `name` in the current list, or null. */
function entryNamed(name: string): CentralBoardEntry | null {
  return listCentralBoards().find((entry) => entry.name === name) ?? null;
}

export function buildHubRouter(options: HubOptions, launcher: BoardLauncher): Router {
  const router = new Router();

  router.get('/api/health', ({ res }) => {
    const info: ServerInfoDto = {
      ok: true,
      root: centralBoardsDir() ?? '',
      experimental: options.experimental === true,
      hub: true,
    };
    sendJson(res, 200, info);
  });

  router.get('/api/hub', ({ res }) => {
    const store = centralStorePath();
    if (store === null) {
      sendJson(res, 409, { error: 'No central store is set. Name one with `lpm config set central_store <dir>`' });
      return;
    }
    const info: HubInfoDto = { hub: true, store, boardsDir: centralBoardsDir()! };
    sendJson(res, 200, info);
  });

  router.get('/api/hub/boards', ({ res }) => {
    sendJson(res, 200, listCentralBoards().map(toDto));
  });

  router.post('/api/hub/boards/:name/open', async ({ res, params }) => {
    const entry = entryNamed(params.name ?? '');
    if (!entry) {
      sendJson(res, 404, { error: `No central board called "${params.name}"` });
      return;
    }
    // A board whose project is unknown is its own project, as with LPM_BOARD_PATH.
    const paths = boardPathsAt(entry.lpmDir, { root: entry.projectPath ?? entry.lpmDir });
    try {
      sendJson(res, 200, { url: await launcher.open(paths) });
    } catch (error) {
      sendJson(res, 503, { error: (error as Error).message });
    }
  });

  router.post('/api/hub/boards/:name/reveal', async ({ res, params }) => {
    const entry = entryNamed(params.name ?? '');
    if (!entry) {
      sendJson(res, 404, { error: `No central board called "${params.name}"` });
      return;
    }
    if (entry.projectPath === null) {
      sendJson(res, 409, {
        error: `The board ${entry.name} has no project.json, so its project folder is not known`,
      });
      return;
    }
    await onDesktop('reveal', path.join(entry.projectPath, LPM_DIR), options.desktopLauncher);
    sendJson(res, 200, { revealed: path.join(entry.projectPath, LPM_DIR) });
  });

  projectRoutes(router, { launcher, desktopLauncher: options.desktopLauncher, self: null });
  return router;
}

/** Start the hub on `options.port` and resolve once it accepts connections. */
export function startHubServer(options: HubOptions = {}): Promise<RunningHub> {
  if (centralStorePath() === null) {
    return Promise.reject(new BoardError('No central store is set. Name one with `lpm config set central_store <dir>`'));
  }
  const launcher = launcherFor({ ...options, port: undefined });
  const server = createGuardedServer(buildHubRouter(options, launcher), options.serveApp !== false);
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      resolve({
        server,
        url: `http://${displayHost(host)}:${bound}`,
        close: async () => {
          await launcher.close();
          await closeServer(server);
        },
      });
    });
  });
}

export type HubOutcome =
  | { kind: 'started'; hub: RunningHub }
  /** A hub on a taken port already serves this central store. */
  | { kind: 'running'; url: string }
  | { kind: 'taken'; ports: number[] };

/**
 * Start the hub on the first free port from `options.port` upward. A port
 * that answers as a hub already is reused, so a second `lpm ui` outside a
 * board opens the first one.
 */
export async function serveHub(options: HubOptions & { portAttempts?: number } = {}): Promise<HubOutcome> {
  const host = options.host ?? DEFAULT_HOST;
  const first = options.port ?? DEFAULT_PORT;
  const attempts = first === 0 ? 1 : Math.max(1, options.portAttempts ?? 1);
  const taken: number[] = [];
  for (let port = first; port <= Math.min(first + attempts - 1, 65535); port++) {
    try {
      return { kind: 'started', hub: await startHubServer({ ...options, port }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      if (await isHub(host, port)) return { kind: 'running', url: `http://${displayHost(host)}:${port}` };
      taken.push(port);
    }
  }
  return { kind: 'taken', ports: taken };
}

async function isHub(host: string, port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://${displayHost(host)}:${port}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    const info = (await response.json()) as Partial<ServerInfoDto>;
    return info.ok === true && info.hub === true;
  } catch {
    return false;
  }
}
