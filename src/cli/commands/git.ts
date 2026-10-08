import { parseArgs } from 'node:util';
import type { GitSyncStatus, SyncBoardResult } from '../../core/index.js';
import {
  BoardError,
  GIT_HOSTS,
  GIT_OFFLINE_ENV,
  PROJECT_BOARD_BRANCH,
  describeFiles,
  disableGitSync,
  findBoardPaths,
  gitSyncStatus,
  gitTopLevel,
  joinGitSync,
  loadConfig,
  projectRepository,
  remoteNames,
  setupGitSync,
  syncBoard,
} from '../../core/index.js';
import { noBoardFound } from '../context.js';
import { ask, choose, confirm } from '../prompt.js';
import { bold, cyan, dim, green, out, pad, plural, red, yellow } from '../ui.js';

/**
 * `lpm git` — sharing the board through its own git repository.
 *
 * Every branch is a thin printer over `operations/git-sync.ts`. What makes the
 * sharing work is not here at all: once `git_sync` is in the config, every
 * write any front end makes is committed and pushed by the engine, and every
 * command pulls before it reads. This command only sets that up, reports it,
 * syncs on demand and settles a conflict.
 */
export const help = `Share the board through its own git repository: every change pulled before, pushed after.

Usage
  lpm git [status] [--local]          Where the board's git remote stands
  lpm git setup [--url <url>] [--branch <b>] [--remote <name>] [--project] [--turn-off-remotes]
                                      Share this board: push it and turn syncing on for everybody
  lpm git join [--url <url>] [--branch <b>]
                                      Clone a shared board into a project that has none yet
  lpm git sync [--ours | --theirs]    Commit local edits, pull, push — and settle a conflict
  lpm git off [--turn-on-remotes]     Stop sharing (pushed, so it stops for everybody)

Once a board is shared, nothing else changes about how you use it. Every lpm
command — and the web UI, and the MCP server — pulls before it reads the board
and commits and pushes each change it makes, one commit per change
("lpm: claim LP-12"). A change that collides with one somebody else pushed
first is refused and nothing is written, so two people cannot both claim one
issue: the second is told, and \`lpm task start\` again says who has it.

The project's own repository
  When the project folder is a git repository with a remote, \`setup\` uses it
  by default, putting the board on its own branch, ${PROJECT_BOARD_BRANCH}.
  The board's history never mixes with the code's: .lpm is a repository of its
  own and that branch shares no commit with the code. A teammate with a clone
  of the project runs \`lpm git join\` with no arguments.

Any git host
  GitHub, GitLab, Bitbucket, Azure DevOps, or any server or shared folder git
  can push to. light-plan stores no credential: git uses whatever it already
  uses for your code — Git Credential Manager, a keychain, an SSH key. It never
  prompts in the background; if a push needs a password, run \`git ls-remote
  <url>\` once in a terminal.

Options
  --url <url>       The repository (setup, join). Default: the project's remote
  --branch <b>      Default: ${PROJECT_BOARD_BRANCH} in the project's repository, else main
  --remote <name>   The git remote inside .lpm (default origin)
  --project         Use the project's repository even if .lpm points elsewhere
  --local           (status) Do not contact the remote
  --ours            (sync) Settle a conflict keeping this checkout's version
  --theirs          (sync) Settle a conflict taking the remote's version
  --turn-off-remotes
                    (setup) The board mirrors onto a tracker (Jira, GitHub,
                    Linear): turn those mirrors off and share through git
                    instead. At a terminal, setup asks rather than refusing.
  --turn-on-remotes (off) Turn the mirrors setup turned off back on

Environment
  ${GIT_OFFLINE_ENV}=1    Work without the remote: changes are committed locally and
                      pushed by the next \`lpm git sync\`. Without it, a change that
                      cannot be pushed is refused and nothing is written.

A board syncs through git or mirrors onto trackers (\`lpm remote\`), never both.
Swapping one for the other loses nothing: a mirror that is turned off keeps its
declaration (moved to remotes_off: in config.yml), its links and its
credentials, so turning it back on carries on where it stopped.

  lpm git setup --turn-off-remotes    Jira (say) off, git on
  lpm git off --turn-on-remotes       git off, Jira back on
  lpm remote on <name>                One mirror back on, once git is off`;

export function run(args: string[]): number {
  const [subcommand, ...rest] = args;
  if (!subcommand || subcommand.startsWith('-')) return status(args);
  if (subcommand === 'status') return status(rest);
  if (subcommand === 'setup') return setup(rest);
  if (subcommand === 'join') return join(rest);
  if (subcommand === 'sync') return sync(rest);
  if (subcommand === 'off') return off(rest);
  throw new BoardError(`Unknown subcommand "${subcommand}"`, ['Use status, setup, join, sync or off.']);
}

function requirePaths() {
  const paths = findBoardPaths();
  if (!paths) throw noBoardFound('Or, to clone a board somebody shared: `lpm git join`.');
  return paths;
}

// -- status -----------------------------------------------------------------

function status(args: string[]): number {
  const { values } = parseArgs({ args, options: { local: { type: 'boolean' } }, allowPositionals: false });
  const paths = requirePaths();
  const loaded = loadConfig(paths);
  if (!loaded.config) throw new BoardError('The board config does not validate', loaded.errors);
  const report = gitSyncStatus(paths, loaded.config, { fetch: !values.local });
  printStatus(report);
  return report.enabled && (report.problem || report.conflict) ? 1 : 0;
}

function printStatus(report: GitSyncStatus): void {
  if (!report.enabled) {
    out(`${bold('git sync')}  ${dim('off — this board is not shared through git')}`);
    if (report.trackers.length) {
      out(dim(`It mirrors onto ${report.trackers.join(', ')} instead; a board does one or the other.`));
      out(`Swap to git: ${cyan('lpm git setup --turn-off-remotes')} ${dim('(the mirrors are kept, turned off)')}`);
      return;
    }
    if (report.remotesOff.length) {
      out(dim(`Turned off: ${report.remotesOff.join(', ')} — \`lpm remote on <name>\` brings one back.`));
    }
    if (report.project) {
      out(`Share it on this project's repository: ${cyan('lpm git setup')}`);
      out(dim(`  ${report.project.url}, branch ${PROJECT_BOARD_BRANCH}`));
    } else {
      out(`Share it: ${cyan('lpm git setup --url <url>')}`);
    }
    return;
  }

  out(`${bold('git sync')}  ${green('on')}${report.offline ? yellow(`  (offline: ${GIT_OFFLINE_ENV} is set)`) : ''}`);
  if (report.problem) {
    out(`${red('broken')}    ${report.problem}`);
    out(dim('Run `lpm git setup` to repair it, or `lpm git join` in a fresh project to clone the board.'));
    return;
  }
  out(`${pad('remote', 10)}${report.remote} → ${report.url}`);
  out(
    `${pad('branch', 10)}${report.branch}${report.usesProjectRepository ? dim("  (the project's own repository)") : ''}`,
  );
  if (report.host) out(`${pad('host', 10)}${report.host.label}`);
  if (report.lastFetch?.error) out(`${pad('fetch', 10)}${red('failed')} ${report.lastFetch.error}`);
  if (report.remotesOff.length) {
    out(`${pad('mirrors', 10)}${report.remotesOff.join(', ')} ${dim('turned off — `lpm git off --turn-on-remotes` swaps back')}`);
  }

  const state = !report.published
    ? yellow('not pushed yet — run `lpm git sync`')
    : report.ahead === 0 && report.behind === 0
      ? green('in step with the remote')
      : [
          report.ahead ? yellow(`${plural(report.ahead, 'commit')} to push`) : '',
          report.behind ? yellow(`${plural(report.behind, 'commit')} to pull`) : '',
        ]
          .filter(Boolean)
          .join(', ');
  out(`${pad('state', 10)}${state}`);

  if (report.uncommitted.length) {
    out(`${pad('local', 10)}${plural(report.uncommitted.length, 'uncommitted file')} ${dim('(committed by `lpm git sync`)')}`);
    for (const file of report.uncommitted.slice(0, 8)) out(dim(`            ${file}`));
    if (report.uncommitted.length > 8) out(dim(`            … and ${report.uncommitted.length - 8} more`));
  }
  if (report.conflict) {
    out();
    out(
      red(
        report.conflict.reason === 'uncommitted'
          ? 'Incoming changes collide with uncommitted edits to:'
          : 'This checkout and the remote both changed:',
      ),
    );
    for (const document of describeFiles(report.conflict.paths)) out(`  ${document}`);
    out(dim('Keep this checkout\'s version: lpm git sync --ours'));
    out(dim("Take the remote's version:     lpm git sync --theirs"));
  }
}

// -- setup ------------------------------------------------------------------

function setup(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      url: { type: 'string' },
      branch: { type: 'string' },
      remote: { type: 'string' },
      project: { type: 'boolean' },
      'turn-off-remotes': { type: 'boolean' },
    },
    allowPositionals: false,
  });
  const paths = requirePaths();
  let url = values.url;
  let project = values.project === true;
  let turnOffRemotes = values['turn-off-remotes'] === true;

  // The board mirrors onto a tracker: asked before anything else, because the
  // answer decides whether there is any point asking where the board lives.
  // Without a terminal, setup refuses and names the flag.
  const trackers = (() => {
    const config = loadConfig(paths).config;
    return config ? remoteNames(config) : [];
  })();
  if (trackers.length && !turnOffRemotes && process.stdin.isTTY) {
    out(yellow(`This board mirrors onto ${trackers.join(', ')}; a board syncs through git or through trackers, not both.`));
    out(dim('Turning a mirror off keeps its links, mapping and credentials; `lpm git off --turn-on-remotes` swaps back.'));
    if (!confirm(`Turn off ${trackers.join(', ')} and share through git instead?`, false)) {
      out('Nothing was changed.');
      return 1;
    }
    turnOffRemotes = true;
  }

  // The one question setup asks, and only when nothing answered it.
  if (!url && !project && process.stdin.isTTY) {
    const config = loadConfig(paths).config;
    const already = config?.git_sync != null;
    const repo = projectRepository(paths);
    if (!already) {
      const choice = choose(
        'Where should the board live?',
        [
          ...(repo
            ? [
                {
                  value: 'project' as const,
                  label: "This project's repository",
                  detail: `${repo.url} (${repo.host.label}), on its own branch ${PROJECT_BOARD_BRANCH}`,
                },
              ]
            : []),
          {
            value: 'url' as const,
            label: 'A repository of its own',
            detail: 'GitHub, GitLab, Bitbucket, Azure DevOps, or any git server — an empty one',
          },
        ],
        '--url <url> or --project',
      );
      if (choice === 'project') project = true;
      else {
        out();
        out(bold('Repository URL'));
        for (const host of GIT_HOSTS) out(`  ${pad(host.label, 14)}${dim(host.examples[0]!)}`);
        out();
        url = ask('URL: ') ?? undefined;
        if (!url) throw new BoardError('No URL given', ['Pass it as `--url <url>`.']);
      }
    }
  }

  out(dim('Checking the repository…'));
  const result = setupGitSync(paths, {
    url,
    branch: values.branch,
    remote: values.remote,
    project,
    interactive: Boolean(process.stdin.isTTY),
    turnOffRemotes,
  });

  if (result.turnedOff.length) {
    out(`${green('turned off')} ${result.turnedOff.join(', ')} ${dim('(kept in remotes_off: — `lpm git off --turn-on-remotes` swaps back)')}`);
  }
  out(`${green('shared')} ${result.url} ${dim(`(${result.host.label})`)}, branch ${bold(result.branch)}`);
  if (result.initialized) out(dim('  made .lpm a git repository'));
  if (result.saved) out(dim(`  committed ${plural(result.saved, 'file')} that had not been`));
  if (result.remoteAction !== 'kept') out(dim(`  ${result.remoteAction} the git remote "${result.remote}"`));
  if (result.joined) out(dim('  brought in what was already on that branch'));
  out();
  out('Every change is now pulled before and pushed after, for everybody who works this board.');
  out(
    result.usesProjectRepository
      ? `A teammate with a clone of the project runs ${cyan('lpm git join')}.`
      : `A teammate runs ${cyan(`lpm git join --url ${result.url}${result.branch === 'main' ? '' : ` --branch ${result.branch}`}`)} in their project.`,
  );
  return 0;
}

// -- join -------------------------------------------------------------------

function join(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { url: { type: 'string' }, branch: { type: 'string' }, remote: { type: 'string' } },
    allowPositionals: false,
  });
  // The project is the repository you are standing in (from any subfolder of
  // it), else the folder itself.
  const root = findBoardPaths()?.root ?? gitTopLevel(process.cwd()) ?? process.cwd();
  const result = joinGitSync(root, {
    url: values.url,
    branch: values.branch,
    remote: values.remote,
    interactive: Boolean(process.stdin.isTTY),
  });
  out(`${green('joined')} ${result.url} ${dim(`(${result.host.label})`)}, branch ${bold(result.branch)}`);
  out(dim(`  cloned into ${result.paths.lpmDir}`));
  if (result.gitignoreUpdated) out(dim("  added .lpm/ to the project's .gitignore"));
  return 0;
}

// -- sync -------------------------------------------------------------------

function sync(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { ours: { type: 'boolean' }, theirs: { type: 'boolean' } },
    allowPositionals: false,
  });
  if (values.ours && values.theirs) throw new BoardError('Pick one: --ours or --theirs');
  const paths = requirePaths();
  const result = syncBoard(paths, { resolve: values.ours ? 'ours' : values.theirs ? 'theirs' : undefined });
  printSync(result);
  return result.pulled.kind === 'conflict' ? 1 : 0;
}

function printSync(result: SyncBoardResult): void {
  if (result.saved.length) out(`${green('committed')} ${plural(result.saved.length, 'local edit')}`);
  const pulled = result.pulled;
  switch (pulled.kind) {
    case 'offline':
      out(yellow(`offline (${GIT_OFFLINE_ENV}): nothing was fetched or pushed`));
      return;
    case 'conflict':
      out(
        red(
          pulled.reason === 'uncommitted'
            ? 'Incoming changes collide with uncommitted edits to:'
            : 'This checkout and the remote both changed:',
        ),
      );
      for (const document of describeFiles(pulled.paths)) out(`  ${document}`);
      out(dim("Keep this checkout's version: lpm git sync --ours"));
      out(dim("Take the remote's version:     lpm git sync --theirs"));
      return;
    case 'fast-forward':
      out(`${green('pulled')} ${plural(pulled.files.length, 'changed file')}`);
      break;
    case 'rebased':
      out(`${green('pulled')} and laid local work on top ${dim(`(${plural(pulled.files.length, 'file')})`)}`);
      break;
    default:
      break;
  }
  out(result.pushed ? `${green('pushed')}` : dim('nothing to push — in step with the remote'));
}

// -- off --------------------------------------------------------------------

function off(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: { 'turn-on-remotes': { type: 'boolean' } },
    allowPositionals: false,
  });
  const paths = requirePaths();
  const config = loadConfig(paths).config;
  const remotesOff = config ? Object.keys(config.remotes_off).sort() : [];
  let turnOnRemotes = values['turn-on-remotes'] === true;
  if (remotesOff.length && !turnOnRemotes && process.stdin.isTTY) {
    turnOnRemotes = confirm(`Turn ${remotesOff.join(', ')} back on as well?`, false);
  }
  const result = disableGitSync(paths, { turnOnRemotes });
  out(`${green('off')} this board is no longer shared through git ${dim('(pushed, so it is off for everybody)')}`);
  out(dim('The repository and its remote are left as they are; `lpm git setup` turns it back on.'));
  if (result.turnedOn.length) {
    out(`${green('on')}  ${result.turnedOn.join(', ')} ${dim('— mirroring again, from where the last sync stopped')}`);
  }
  if (result.stillOff.length) {
    out(dim(`Still turned off: ${result.stillOff.join(', ')} — \`lpm remote on <name>\` brings one back.`));
  }
  return 0;
}
