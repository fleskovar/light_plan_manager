import type { Server } from 'node:http';
import type { BoardPaths } from '../core/index.js';
import { BoardError, recordProjectQuietly, samePath } from '../core/index.js';
import type { DesktopLauncher } from './desktop.js';
import type { ServeOptions, ServeOutcome } from './index.js';

/**
 * Starting board servers from inside `lpm ui`: the hub and each board server
 * open another board through one launcher per process.
 *
 * `open(paths)` starts a board server for that board on the first free port
 * from `boardPort` upward, or reuses one: a board that this launcher started,
 * or an `lpm ui` on a taken port that already serves the board (`serveBoard`
 * asks it). The servers that it starts get the same launcher, so a board
 * opened from an opened board does not start a second server for a board
 * that runs already. `close()` stops every server that it started.
 *
 * The launcher receives `serve` instead of importing `serveBoard`, so this
 * module and `index.ts` do not import each other.
 */
export type ServeBoard = (paths: BoardPaths, options: ServeOptions) => Promise<ServeOutcome>;

export interface LauncherOptions {
  serve: ServeBoard;
  host: string;
  /** The first port to try. 0 lets the system pick one. */
  boardPort: number;
  boardPortAttempts: number;
  serveApp: boolean;
  experimental: boolean;
  desktopLauncher?: DesktopLauncher;
}

interface Opened {
  lpmDir: string;
  url: string;
  /** Null when another `lpm ui` serves the board: this launcher does not own it. */
  server: Server | null;
}

export class BoardLauncher {
  readonly #options: LauncherOptions;
  readonly #opened: Opened[] = [];

  constructor(options: LauncherOptions) {
    this.#options = options;
  }

  /** Remember that `url` already serves the board in `lpmDir`: the server that owns this launcher. */
  serving(lpmDir: string, url: string): void {
    this.#opened.push({ lpmDir, url, server: null });
  }

  /** Record that the board in `from` moved to `to`, so that `open` finds its server under the new folder. */
  moved(from: string, to: string): void {
    for (const entry of this.#opened) if (samePath(entry.lpmDir, from)) entry.lpmDir = to;
  }

  /** The URL of a server for the board of `paths`. Starts one when none runs. */
  async open(paths: BoardPaths): Promise<string> {
    const known = this.#opened.find((entry) => samePath(entry.lpmDir, paths.lpmDir));
    if (known) return known.url;
    const options = this.#options;
    const outcome = await options.serve(paths, {
      host: options.host,
      port: options.boardPort,
      portAttempts: options.boardPortAttempts,
      serveApp: options.serveApp,
      experimental: options.experimental,
      desktopLauncher: options.desktopLauncher,
      launcher: this,
    });
    if (outcome.kind === 'taken') {
      throw new BoardError(`Every port from ${options.boardPort} upward is taken`, [
        'Stop another `lpm ui` and try again.',
      ]);
    }
    const url = outcome.url;
    this.#opened.push({ lpmDir: paths.lpmDir, url, server: outcome.kind === 'started' ? outcome.server : null });
    recordProjectQuietly(paths);
    return url;
  }

  /** Stop every board server that this launcher started. */
  async close(): Promise<void> {
    const owned = this.#opened.filter((entry) => entry.server !== null);
    this.#opened.length = 0;
    await Promise.all(
      owned.map(
        (entry) =>
          new Promise<void>((resolve) => {
            entry.server!.closeAllConnections?.();
            entry.server!.close(() => resolve());
          }),
      ),
    );
  }
}
