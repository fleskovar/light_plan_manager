import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { BoardError, experimentalOf, findBoardPaths, loadConfig } from '../../core/index.js';
import { DEFAULT_HOST, DEFAULT_PORT, startBoardServer } from '../../server/index.js';
import { noBoardFound } from '../context.js';
import { bold, dim, out, reportError } from '../ui.js';

export const help = `Open the board in a web browser.

Usage
  lpm ui [options]

Options
      --port <n>        Port to listen on (default ${DEFAULT_PORT}; 0 picks a free one)
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

The server is local-only and edits this checkout's .lpm folder. Stop it with
Ctrl-C. The app writes each edit to the board about 1.5 seconds after you make
it. On a board with no view, the app creates .lpm/views/default.json.`;

/** A bind address as somebody would type it into a browser. */
function displayHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

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

  const paths = findBoardPaths();
  if (!paths) throw noBoardFound();

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new BoardError(`Invalid port "${values.port}"`);
  }
  const apiOnly = values['api-only'] === true;
  const host = values.host ?? DEFAULT_HOST;
  // The flag turns the features on for one run. The key `experimental` in
  // .lpm/config.yml, which `lpm experimental on` writes, turns them on for
  // every run. A config that does not validate counts as off here: the server
  // reports the config error to the app.
  const config = loadConfig(paths).config;
  const fromConfig = config !== null && experimentalOf(config);
  const experimental = values.experimental === true || fromConfig;

  void startBoardServer(paths, {
    port,
    host,
    serveApp: !apiOnly,
    experimental,
  })
    .then(({ url }) => {
      out(`${bold('light-plan')} ${dim(paths.root)}`);
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
      // `reportError` and sets the exit code itself.
      const taken = error.code === 'EADDRINUSE';
      reportError(
        new BoardError(
          taken ? `Port ${port} is already in use` : `Could not start the server: ${error.message}`,
          taken
            ? [
                'Pass --port <n> to use a different port.',
                // Nearly always another `lpm ui` on the same checkout, and the
                // useful thing then is the address rather than a second server.
                `If that is another \`lpm ui\`, it is already serving http://${displayHost(host)}:${port}`,
              ]
            : ['Pass --port <n> to use a different port.'],
        ),
      );
      process.exitCode = 1;
    });

  // The process stays alive on the listening socket until Ctrl-C.
  return 0;
}
