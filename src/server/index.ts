import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from '../core/index.js';
import type { ServerInfoDto } from '../shared/index.js';
import { sendError, sendJson } from './http/respond.js';
import { Router } from './http/router.js';
import { staticServer } from './http/static.js';
import type { DesktopLauncher } from './desktop.js';
import { boardRoutes } from './routes/board.js';
import { commentRoutes } from './routes/comments.js';
import { configRoutes } from './routes/config.js';
import { flagRoutes } from './routes/flags.js';
import { meRoutes } from './routes/me.js';
import { planningRoutes } from './routes/planning.js';
import { gitRoutes } from './routes/git.js';
import { remoteRoutes } from './routes/remotes.js';
import { viewRoutes } from './routes/views.js';

/**
 * The local web server behind `lpm ui`.
 *
 * A thin shell over the same core the CLI uses: routes validate and delegate,
 * `dto/` maps the engine's model onto the wire, `sync/` replays a view's pending
 * changes, and `views/` owns the JSON artifacts in `.lpm/views`. It binds to
 * loopback, serves one board, and has no notion of users or sessions.
 *
 * ## The local-only posture, stated and enforced
 *
 * The server binds `127.0.0.1` and has no authentication — anyone who can reach
 * the port can read the board and, through the remote routes, ask the server to
 * make outbound requests to a corporate tracker on their behalf.  The loopback
 * bind alone is not enough: a browser page on any origin can still send a
 * cross-origin request to `http://127.0.0.1:4571`, and a DNS-rebinding name can
 * resolve to loopback while carrying a hostile `Host`.  So every request is
 * refused unless
 *
 *   - its `Host` header is a loopback host (`127.0.0.1`, `localhost`, `::1`),
 *     which defeats DNS rebinding; and
 *   - its `Origin` header, when present, is a loopback origin, which defeats a
 *     cross-origin fetch from a page served elsewhere.
 *
 * A request with no `Origin` (the CLI, curl, the test suite, the editor's own
 * same-origin `fetch`) is allowed — it is not a browser cross-origin request.
 * This is a CSRF/origin *guard*, not a sandbox: it stops a random web page from
 * driving the board, and says so, rather than pretending the bind was a wall.
 */
export interface ServerOptions {
  /** Defaults to 4571; pass 0 to let the OS pick a free port. */
  port?: number;
  host?: string;
  /** Serve the built SPA alongside the API. On by default. */
  serveApp?: boolean;
  /**
   * Serve the features that are not finished yet — today the tracker remotes
   * (Jira, GitHub, Linear). Off by default, so a published `lpm ui` offers git
   * sharing and nothing else; `lpm ui --experimental` turns it on.
   */
  experimental?: boolean;
  /**
   * Starts the program that opens a file or shows it in the file manager. The
   * default starts a real program. A test passes a recorder.
   */
  desktopLauncher?: DesktopLauncher;
}

/** What `buildRouter` needs to know about how the server was started. */
export interface RouterOptions {
  experimental?: boolean;
  desktopLauncher?: DesktopLauncher;
}

export const DEFAULT_PORT = 4571;
export const DEFAULT_HOST = '127.0.0.1';

export function buildRouter(paths: BoardPaths, options: RouterOptions = {}): Router {
  const experimental = options.experimental === true;
  const router = new Router();
  router.get('/api/health', ({ res }) => {
    const info: ServerInfoDto = { ok: true, root: paths.root, experimental };
    sendJson(res, 200, info);
  });
  boardRoutes(router, paths);
  commentRoutes(router, paths);
  flagRoutes(router, paths);
  meRoutes(router, paths);
  planningRoutes(router, paths);
  configRoutes(router, paths, options.desktopLauncher);
  viewRoutes(router, paths);
  // Not registered at all rather than refused per request: the web app hides
  // the tracker surface when `experimental` is false, and a route that is not
  // there cannot be reached by anything that ignores the hint.
  if (experimental) remoteRoutes(router, paths);
  gitRoutes(router, paths);
  return router;
}

/**
 * True when a `Host` header names a loopback host.  The port is stripped, an
 * IPv6 literal keeps its brackets, and an empty host (HTTP/1.0, or a request
 * with no Host at all) is allowed — it is not a browser request.
 */
function isLoopbackHost(hostHeader: string | undefined): boolean {
  const raw = (hostHeader ?? '').trim();
  if (raw === '') return true;
  let host = raw;
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return false;
    host = host.slice(1, end);
  } else {
    host = host.split(':')[0]!;
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/** True when an `Origin` header names a loopback origin (`http(s)://127.0.0.1`, `localhost`, `::1`). */
function isLoopbackOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isLoopbackHost(parsed.host);
}

export function createBoardServer(paths: BoardPaths, options: ServerOptions = {}): Server {
  const router = buildRouter(paths, {
    experimental: options.experimental,
    desktopLauncher: options.desktopLauncher,
  });
  const assets = options.serveApp === false ? null : staticServer();

  return createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    void (async () => {
      try {
        // The local-only guard: a non-loopback Host or Origin is refused before
        // anything reads or writes.  See the contract comment above for why the
        // bind alone is not the defence.
        if (!isLoopbackHost(req.headers.host)) {
          return sendJson(res, 403, {
            error: 'This server is local-only and refused a non-loopback Host header.',
          });
        }
        const origin = req.headers.origin;
        if (origin !== undefined && !isLoopbackOrigin(origin)) {
          return sendJson(res, 403, {
            error: 'This server is local-only and refused a cross-origin request.',
          });
        }

        const route = router.match(req.method ?? 'GET', url.pathname);
        if (route) {
          await route.handler({ req, res, params: route.params, query: url.searchParams });
          return;
        }
        // The SPA falls back to index.html for any path, so an unknown API
        // path — a tracker route on a server started without --experimental,
        // say — must never reach it, or it answers 200 with a page of HTML.
        const api = url.pathname.startsWith('/api/');
        if (req.method === 'GET' && !api && assets?.serve(url.pathname, res)) return;
        sendJson(res, 404, {
          error: api
            ? `No route for ${req.method} ${url.pathname}`
            : 'The web app has not been built. Run `npm run build:web`.',
        });
      } catch (error) {
        sendError(res, error);
      }
    })();
  });
}

export interface RunningServer {
  server: Server;
  url: string;
}

/**
 * The number of ports `lpm ui` tries, from `DEFAULT_PORT` upward, when the
 * command names no port. A second board in a second `lpm ui` takes 4572, a
 * third board takes 4573, and so on up to 4590.
 */
export const DEFAULT_PORT_ATTEMPTS = 20;

/** A bind address as somebody would type it into a browser. */
export function displayHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

/**
 * True when two paths name the same folder. Symbolic links are resolved, and
 * Windows compares without case.
 */
function samePath(a: string, b: string): boolean {
  const real = (target: string): string => {
    try {
      return realpathSync.native(target);
    } catch {
      return path.resolve(target);
    }
  };
  const left = real(a);
  const right = real(b);
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/**
 * The board root that an `lpm ui` on `port` serves, read from its
 * `/api/health`. Returns null when the port answers with something else, or
 * gives no answer within `timeoutMs`.
 */
export async function probeBoardServer(
  host: string,
  port: number,
  timeoutMs = 1000,
): Promise<string | null> {
  try {
    const response = await fetch(`http://${displayHost(host)}:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const info = (await response.json()) as Partial<ServerInfoDto>;
    return info.ok === true && typeof info.root === 'string' ? info.root : null;
  } catch {
    return null;
  }
}

export interface ServeOptions extends ServerOptions {
  /**
   * The number of consecutive ports to try, from `port` upward. Defaults to 1:
   * a taken `port` ends the search. Ignored when `port` is 0.
   */
  portAttempts?: number;
}

/** A taken port, and the board root that an `lpm ui` on it serves, if any. */
export interface TakenPort {
  port: number;
  root: string | null;
}

export type ServeOutcome =
  | { kind: 'started'; server: Server; url: string }
  /** An `lpm ui` on a taken port already serves this board. */
  | { kind: 'running'; url: string }
  /** Every port was taken by something other than this board. */
  | { kind: 'taken'; taken: TakenPort[] };

/**
 * Serve the board on the first free port from `options.port` upward.
 *
 * `serveBoard` tries `options.portAttempts` ports in order. For each taken
 * port, it reads `/api/health` from the process on that port. When that
 * process serves the same board, `serveBoard` returns its URL and starts no
 * second server. Two servers on one board would each hold their own draft.
 */
export async function serveBoard(
  paths: BoardPaths,
  options: ServeOptions = {},
): Promise<ServeOutcome> {
  const host = options.host ?? DEFAULT_HOST;
  const first = options.port ?? DEFAULT_PORT;
  const attempts = first === 0 ? 1 : Math.max(1, options.portAttempts ?? 1);
  const last = Math.min(first + attempts - 1, 65535);
  const taken: TakenPort[] = [];

  for (let port = first; port <= last; port++) {
    try {
      const running = await startBoardServer(paths, { ...options, port });
      return { kind: 'started', ...running };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      const root = await probeBoardServer(host, port);
      if (root !== null && samePath(root, paths.root)) {
        return { kind: 'running', url: `http://${displayHost(host)}:${port}` };
      }
      taken.push({ port, root });
    }
  }
  return { kind: 'taken', taken };
}

/** Start the server and resolve once it is accepting connections. */
export function startBoardServer(
  paths: BoardPaths,
  options: ServerOptions = {},
): Promise<RunningServer> {
  const server = createBoardServer(paths, options);
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      const bound = typeof address === 'object' && address ? address.port : port;
      resolve({ server, url: `http://${host}:${bound}` });
    });
  });
}
