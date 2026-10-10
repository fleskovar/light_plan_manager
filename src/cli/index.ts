#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { BoardError } from '../core/index.js';
import * as agent from './commands/agent/index.js';
import * as check from './commands/check.js';
import * as comment from './commands/comment.js';
import * as convert from './commands/convert.js';
import * as copy from './commands/copy.js';
import * as exportBoard from './commands/export.js';
import * as flag from './commands/flag.js';
import * as git from './commands/git.js';
import * as hcm from './commands/hcm/index.js';
import * as insert from './commands/insert.js';
import * as init from './commands/init.js';
import * as instructions from './commands/instructions.js';
import * as link from './commands/link.js';
import * as mcp from './commands/mcp/index.js';
import * as me from './commands/me.js';
import * as move from './commands/move.js';
import * as newIssue from './commands/new.js';
import * as open from './commands/open.js';
import * as period from './commands/period.js';
import * as planning from './commands/planning.js';
import * as profile from './commands/profile.js';
import * as queue from './commands/queue.js';
import * as remote from './commands/remote.js';
import * as rm from './commands/rm.js';
import * as set from './commands/set.js';
import * as split from './commands/split.js';
import * as task from './commands/task.js';
import * as team from './commands/team.js';
import * as template from './commands/template.js';
import * as ui from './commands/ui.js';
import * as upstream from './commands/upstream.js';
import { bold, dim, err, out, pad, red, reportError } from './ui.js';

interface Command {
  help: string;
  run(args: string[]): number;
}

const commands: Record<string, Command> = {
  init,
  new: newIssue,
  set,
  move,
  convert,
  link,
  insert,
  split,
  copy,
  rm,
  comment,
  flag,
  open,
  me,
  profile,
  task,
  upstream,
  period,
  planning,
  instructions,
  team,
  template,
  queue,
  remote,
  git,
  check,
  ui,
  export: exportBoard,
  mcp,
  agent,
  hcm,
};
const aliases: Record<string, string> = {
  publish: 'export',
  edit: 'open',
  whoami: 'me',
  user: 'profile',
  tasks: 'task',
  blockers: 'upstream',
  prerequisites: 'upstream',
  sprint: 'period',
  periods: 'period',
  mode: 'planning',
  brief: 'instructions',
  context: 'instructions',
  roster: 'team',
  web: 'ui',
  update: 'set',
  breakdown: 'split',
  duplicate: 'copy',
  templates: 'template',
  registry: 'template',
  delete: 'rm',
  remove: 'rm',
  note: 'comment',
  // Deliberately no `unflag` alias: `lpm unflag LP-3` would read as "clear it"
  // and would in fact raise one, because the id is the first positional.
  block: 'flag',
};

const summaries: Record<string, string> = {
  init: 'Create a board (.lpm) in this folder',
  new: 'Create an issue, period (sprint, ...) or resource (person, pool)',
  set: "Edit a document's title, body or attributes",
  move: "Change an issue's status, parent, period or assignee",
  convert: "Change a document's type, moving it if the type belongs elsewhere",
  link: 'Record a dependency between issues, or what a resource covers',
  insert: 'Put an issue in the middle of a dependency',
  split: 'Break an issue into smaller ones, keeping the graph wired up',
  copy: 'Duplicate documents and everything nested under them',
  rm: 'Delete a document and everything nested under it',
  comment: 'Write down how the work is going, and read what others wrote',
  flag: 'Say that work has stopped and why; clear it when it can resume',
  open: 'Open an issue, period or resource in your editor',
  me: 'Show or set who is using this checkout',
  profile: 'Use a profile: who you are, and which part of the board is yours',
  task: 'What to work on next, and pick it up',
  upstream: 'Everything that must be finished before an issue can be; schedule it',
  period: 'Switch a sprint or increment on or off, restart it, correct an overrun',
  planning: 'Plan with sprints and increments, or work the board as one queue',
  instructions: 'Print the working brief for an issue: the context to start it',
  team: 'Show the roster and how loaded everyone is',
  template: 'Reusable pieces of plan: the registry, and putting one on the board',
  queue: 'Predict the work queue, or drain it with the pi coding agent',
  remote: 'Push and pull a board\'s remotes, and settle sync conflicts',
  git: 'Share the board through git: pull before every change, push after',
  check: 'Validate the board; --fix repairs what it can',
  ui: 'Open the board in a web browser',
  export: 'Publish the board as a static site anyone can open',
  mcp: 'Serve the board to AI agents over MCP',
  agent: 'Install the light-plan agents and skills into a project',
  hcm: 'Register the agents and skills as hcm bundles, for every project',
};

function version(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function usage(): void {
  out(`${bold('lpm')} ${dim('— light-plan, a file-based issue tracker')}`);
  out();
  out(bold('Usage'));
  out('  lpm <command> [options]');
  out();
  out(bold('Commands'));
  for (const [name, summary] of Object.entries(summaries)) {
    out(`  ${pad(name, 14)}${summary}`);
  }
  out();
  out(bold('Environment'));
  out(`  ${pad('LPM_BOARD_PATH', 16)}The .lpm folder to work on, from any directory`);
  out(`  ${pad('LPM_USER', 16)}Act as this resource for one command`);
  out(`  ${pad('LPM_PROFILE', 16)}Profile file to use for one shell`);
  out(`  ${pad('LPM_GIT_OFFLINE', 16)}Work without the board's git remote; push later`);
  out();
  out(dim('Run `lpm <command> --help` for command options.'));
}

function main(): number {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (!first) {
    usage();
    return 1;
  }
  if (first === '--version' || first === '-V') {
    out(version());
    return 0;
  }
  if (first === '--help' || first === '-h') {
    usage();
    return 0;
  }
  if (first === 'help') {
    const target = argv[1] ? (aliases[argv[1]] ?? argv[1]) : null;
    const command = target ? commands[target] : null;
    if (command) out(command.help);
    else usage();
    return 0;
  }

  const name = aliases[first] ?? first;
  const command = commands[name];
  if (!command) {
    err(`${red('error')} unknown command "${first}"`);
    err(dim(`Known commands: ${Object.keys(summaries).join(', ')}`));
    return 1;
  }

  const rest = argv.slice(1);
  if (rest.includes('--help') || rest.includes('-h')) {
    out(command.help);
    return 0;
  }

  try {
    return command.run(rest);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? '';
    if (code.startsWith('ERR_PARSE_ARGS')) {
      err(`${red('error')} ${(error as Error).message}`);
      err(dim(`Run \`lpm ${name} --help\` for usage.`));
      return 1;
    }
    throw error;
  }
}

try {
  process.exitCode = main();
} catch (error) {
  reportError(error);
  process.exitCode = 1;
}
