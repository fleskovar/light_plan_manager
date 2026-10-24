import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { BoardError, centralStorePath, experimentalOf, findBoardPaths, loadConfig } from '../../core/index.js';
import { serveHub } from '../../server/hub.js';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PORT_ATTEMPTS,
  displayHost,
  serveBoard,
} from '../../server/index.js';
import type { TakenPort } from '../../server/index.js';
import { noBoardFound } from '../context.js';
import { bold, dim, out, reportError } from '../ui.js';

export const help = `Open the board in a web browser.

Usage
  lpm ui [options]

Options
      --port <n>        Port to listen on. 0 lets the system pick a free port.
                        Without --port, the server takes the first free port
                        from ${DEFAULT_PORT} to ${DEFAULT_PORT + DEFAULT_PORT_ATTEMPTS - 1}.
      --host <address>  Address to bind (default ${DEFAULT_HOST})
      --no-open         Do not launch a browser
      --api-only        Serve the API without the web app
      --experimental    Also offer features that are not finished yet, for this
                        run: mirroring the board onto Jira, GitHub or Linear
                        (the Sync tab's tracker panel, its dialogs and the
                        per-issue remote controls).

The experimental features are also on when the key \`experimental\` in
.lpm/config.yml holds \`true\`. \`lpm experimental on\` writes the key and
installs the packages that the features need. With the key absent and no
--experimental, the Sync tab offers git sharing only.

Each board in its own \`lpm ui\` gets its own port, so you can open several
boards at the same time. When an \`lpm ui\` on one of those ports already serves
this board, the command opens that server and starts no second one.

In a folder without a board, \`lpm ui\` opens the central store when the key
\`central_store\` is set (\`lpm config set central_store <dir>\`). The page lists
each board in <central_store>/.lpm_central with its key prefix and its project
folder. Open starts that board in this process, on the next free port. Reveal
shows the project's .lpm folder in the file manager. Without the key, \`lpm ui\`
needs a board, as before.

The server is local-only and edits this checkout's .lpm folder. Stop it with
Ctrl-C. The app writes each edit to the board about 1.5 seconds after you make
it. On a board with no view, the app creates .lpm/views/default.json.`;

/** Ask the desktop to open a URL, ignoring the failure when there is no desktop. */
function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const child = spawn(command!, args as string[], { stdio: 'ignore', detached: true });
  child.on('error', () => {
    /* No browser here — the URL is printed anyway. */
  });
  child.unref();
}

export function run(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      host: { type: 'string' },
      'no-open': { type: 'boolean' },
      'api-only': { type: 'boolean' },
      experimental: { type: 'boolean' },
    },
  });

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new BoardError(`Invalid port "${values.port}"`);
  }
  // A port that the user names is the only port to try. Without --port, the
  // server searches upward, so each board in its own `lpm ui` gets a port.
  const portAttempts = values.port === undefined ? DEFAULT_PORT_ATTEMPTS : 1;
  const apiOnly = values['api-only'] === true;
  const host = values.host ?? DEFAULT_HOST;

  const paths = findBoardPaths();
  if (!paths) {
    // Outside a board, a central store gives the hub: the list of its boards.
    if (centralStorePath() === null) throw noBoardFound();
    return runHub({ port, portAttempts, host, apiOnly, open: !values['no-open'], experimental: values.experimental === true });
  }
  // The flag turns the features on for one run. The key `experimental` in
  // .lpm/config.yml, which `lpm experimental on` writes, turns them on for
  // every run. A config that does not validate counts as off here: the server
  // reports the config error to the app.
  const config = loadConfig(paths).config;
  const fromConfig = config !== null && experimentalOf(config);
  const experimental = values.experimental === true || fromConfig;

  void serveBoard(paths, {
    port,
    portAttempts,
    host,
    serveApp: !apiOnly,
    experimental,
  })
    .then((outcome) => {
      if (outcome.kind === 'taken') {
        reportError(portsTaken(outcome.taken, host, values.port !== undefined));
        process.exitCode = 1;
        return;
      }
      const { url } = outcome;
      out(`${bold('light-plan')} ${dim(paths.root)}`);
      if (outcome.kind === 'running') {
        // No socket is left open, so the process exits after this message.
        out(`  ${url}`);
        out(dim('  Another `lpm ui` already serves this board. No second server started.'));
        if (!values['no-open'] && !apiOnly) openBrowser(url);
        return;
      }
      out(`  ${url}`);
      if (experimental) {
        out(
          dim(
            `  experimental features on (${values.experimental === true ? '--experimental' : 'the key `experimental` in .lpm/config.yml'}): tracker remotes (Jira, GitHub, Linear)`,
          ),
        );
      }
      out(dim('  Ctrl-C to stop'));
      if (!values['no-open'] && !apiOnly) openBrowser(url);
    })
    .catch((error: NodeJS.ErrnoException) => {
      // **Reported, never thrown.** `run` has already returned by the time the
      // socket answers, so a throw here lands in a promise nobody is holding:
      // Node printed the `BoardError` as an unhandled rejection, stack and all,
      // which reads as a crash for what is an ordinary answer ("something else
      // is on that port"). Everything async in the CLI reports through
      // `reportError` and sets the exit code itself. A taken port does not
      // arrive here: `serveBoard` returns it as the outcome `taken`.
      reportError(
        new BoardError(`Could not start the server: ${error.message}`, [
          'Pass --port <n> to use a different port.',
        ]),
      );
      process.exitCode = 1;
    });

  // The process stays alive on the listening socket until Ctrl-C.
  return 0;
}

interface HubRun {
  port: number;
  portAttempts: number;
  host: string;
  apiOnly: boolean;
  open: boolean;
  experimental: boolean;
}

/**
 * Serve the hub: the landing page that lists the boards of the central store.
 * Each board that the page opens runs in this process, on the next free port.
 */
function runHub(options: HubRun): number {
  void serveHub({
    port: options.port,
    portAttempts: options.portAttempts,
    host: options.host,
    serveApp: !options.apiOnly,
    experimental: options.experimental,
  })
    .then((outcome) => {
      if (outcome.kind === 'taken') {
        reportError(
          new BoardError(`Ports ${outcome.ports[0]} to ${outcome.ports[outcome.ports.length - 1]} are all in use`, [
            'Pass --port <n> to use a different port, or --port 0 to let the system pick one.',
          ]),
        );
        process.exitCode = 1;
        return;
      }
      const url = outcome.kind === 'started' ? outcome.hub.url : outcome.url;
      out(`${bold('light-plan')} ${dim(`central store ${centralStorePath()}`)}`);
      out(`  ${url}`);
      if (outcome.kind === 'running') {
        out(dim('  Another `lpm ui` already serves the central store. No second server started.'));
      } else {
        out(dim('  No board in this folder: the page lists the boards of the central store.'));
        out(dim('  Ctrl-C to stop (it also stops the boards opened from the page)'));
      }
      if (options.open && !options.apiOnly) openBrowser(url);
    })
    .catch((error: Error) => {
      reportError(new BoardError(`Could not start the server: ${error.message}`, ['Pass --port <n> to use a different port.']));
      process.exitCode = 1;
    });
  return 0;
}

/** The error for a search in which every port was taken by something other than this board. */
function portsTaken(taken: TakenPort[], host: string, named: boolean): BoardError {
  const first = taken[0]!;
  const lastPort = taken[taken.length - 1]!.port;
  const others = taken.filter((entry) => entry.root !== null);
  const details = [
    named
      ? `Pass --port <n> to use a different port, or leave out --port to take the first free port from ${DEFAULT_PORT}.`
      : 'Pass --port <n> to use a different port, or --port 0 to let the system pick one.',
    // Each line names the address, so the user can open a board that already runs.
    ...others.map(
      (entry) =>
        `http://${displayHost(host)}:${entry.port} is another \`lpm ui\`. It serves ${entry.root}`,
    ),
  ];
  const message =
    taken.length === 1
      ? `Port ${first.port} is already in use`
      : `Ports ${first.port} to ${lastPort} are all in use`;
  return new BoardError(message, details);
}
