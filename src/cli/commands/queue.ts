import { parseArgs } from 'node:util';
import type {
  LoadedBoard,
  QueueSimulation,
  ResolvedScope,
  Resource,
  SimulationSkip,
  SimulationStep,
} from '../../core/index.js';
import {
  BoardError,
  currentScope,
  currentUser,
  describeScope,
  findResource,
  flagLabel,
  fullScope,
  hasPeriods,
  hasResources,
  ignoresPeriods,
  isGenericResource,
  requireCurrentUser,
  simulateQueue,
} from '../../core/index.js';
import { requireBoard } from '../context.js';
import { createAgentView } from '../agent-view.js';
import { bold, cyan, dim, err, green, out, pad, plural, red, yellow } from '../ui.js';
import {
  AGENT_EFFORTS,
  COMMIT_MODES,
  DEFAULT_COMMAND_TIMEOUT,
  createGitDriver,
  loadAgentConfig,
  runAgentQueue,
} from '../../runner/index.js';
import type { AgentConfig, AgentEffort, CommitMode, LoopOptions, RunReport } from '../../runner/index.js';

export const help = `Work the queue through as one person: predict the order, or run it with an agent.

Usage
  lpm queue simulate [options]
  lpm queue agent [options]

Simulate options
      --user <id|name>   Simulate a person on the roster
      --role <id|name>   Simulate a pool (a generic resource), e.g. "jr. developer"
      --team             Simulate the whole team as one contributor: every open
                         work unit, whoever holds it (the web queue's "Everyone")
      --unassigned       Also pick up work nobody is assigned to
      --parked           Also work through periods somebody switched off
      --limit <n>        Stop after this many steps
      --skipped          List the open work the run never reached, and why

Agent options (drains the queue with the pi coding agent, one fresh run per task)
      --user <id|name>   Route the queue to this person (default: \`lpm me\`)
      --max-tasks <n>    Stop after this many tasks are picked up
      --model <spec>     Pi model, as provider:model — any pi provider works, e.g.
                         anthropic:claude-opus-4-5, deepseek:deepseek-v4-pro,
                         openai:gpt-5. Set the provider's key in the environment
                         (ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, OPENAI_API_KEY, ...)
      --effort <level>   Thinking level: ${AGENT_EFFORTS.join(' | ')}
      --commit <mode>    ${COMMIT_MODES.join(' | ')} — none leaves changes for review,
                         task commits after each finished task, parent commits once
                         all work under a task's parent is done
      --unassigned       Also pick up work nobody is assigned to
      --parked           Also work through periods somebody switched off
      --timeout <secs>   Per-task wall-clock cap
      --command-timeout <secs>
                         Kill any single shell command after this long
                         (default ${DEFAULT_COMMAND_TIMEOUT}s)
      --plain            Log one line per event instead of the live view
      --file <path>      Read all of the above from a YAML file (CLI flags win)
      --dry-run          Pick and brief the next task, but run and write nothing

The agent claims each task, hands it the same brief \`lpm instructions\` prints,
and marks it done or flags it for help from what the agent reports — logging a
comment and a full JSON run log under .lpm/runs/. It works the same queue
\`lpm task next\` offers, and finishes all the work under one parent before moving
on. It is experimental, and its pi packages are not installed with light-plan
(Node 22.19+): \`npm install -g @earendil-works/pi-coding-agent @earendil-works/pi-ai\`
beside a global install, or the same without -g in a project.

On a terminal the run draws a live pane on stderr: the task, the stage it is in,
the tool running now, and the tail of what the agent is saying and doing.
↑/↓ and PgUp/PgDn scroll back through it, Ctrl+C stops the run (the task stays
in progress, and the next run resumes it). Redirect the output, or pass --plain,
and it logs one line per event instead.

Nobody is watching the run, so the agent's shell is made non-interactive: pagers
print and exit, editors return at once, tools that ask questions are told not to,
and a command that would open a file in another program (start, open, code, less,
vim, ...) is refused with an explanation the agent can act on. Whatever gets past
that is killed at --command-timeout. This is a guard against a stuck run, not a
sandbox: the agent still has a real shell in your project.

Work a previous run claimed and did not finish is picked back up first: the
queue does not offer what is already in progress, so nothing else would ever
return to it and everything waiting on it would stay blocked.

A flagged task is the exception and is never re-offered, so a run can stop with
work still on the board: everything left is waiting on issues this person holds,
and those have stopped. The run lists what they are holding and which of it is
flagged, so an early stop always says why. Clear a flag with
\`lpm flag clear <id> -m "..."\` and the next run carries on with it.

Commits target the project repo, not the .lpm board — commit the board yourself.

How simulate works

With neither --user nor --role, it simulates you (\`lpm me\`). --team simulates
everybody at once, which is the sequence the web queue panel numbers its cards by.

On a board planning by queue (\`lpm planning queue\`) every period is ignored:
no sprint ranks ahead of another, none is switched off, and no squad owns one.
The whole board is one continuous run.

The run takes the top of \`lpm task next\`, marks it finished in memory, and asks
again -- until nothing is left that this person could pick up. Work already in
progress goes first, because the queue does not offer what has already been
picked up, and ignoring it would leave everything waiting on it blocked forever.
\`lpm queue agent\` resumes that same work through the same rule, so this is a
prediction of the run and not a different reading of the board.

Flagged work is the exception: a flag says the work has stopped and needs a
person, and there is nobody else in this run to clear it, so the run does not
start from it. It is listed by --skipped and counted under the run -- which is
what makes this agree with \`lpm queue agent\` on a stalled board instead of
predicting a sequence the agent will never work.

Nothing is written and no clock moves: this reports the order the board would
offer work in, not when any of it happens. It does not know how long a task
takes, so it adds up effort and stops there.

Every rule about what may be picked up -- routing, pools, work units, blockers,
your profile's scope, periods somebody switched off -- comes from the same
engine \`lpm task next\` uses. This is that queue replayed, not a second opinion
about it, so a developer stepping through \`lpm task next\` gets this sequence.

Work in a period somebody switched off is therefore not offered here either;
--parked considers it, exactly as \`lpm task next --parked\` does.

What the run never reaches is the other half of the answer. Since nobody else
is contributing, work held by someone else is never finished and anything
waiting on it waits forever -- \`--skipped\` is where that shows up.

If you use a profile, its scope narrows the simulation of *you*, because that is
the queue you are actually offered. Simulating somebody else uses the whole
board: you do not hold their profile.

Examples
  lpm queue simulate
  lpm queue simulate --user alice
  lpm queue simulate --team
  lpm queue simulate --role "jr. software developer" --unassigned
  lpm queue simulate --user RS-2 --skipped
  lpm queue simulate --user RS-2 --parked
  lpm queue agent --user alice --max-tasks 3
  lpm queue agent --model anthropic:claude-opus-4-5 --effort high --commit task
  lpm queue agent --file agent.yml --dry-run`;

/** The resource the run is about, and how it was named — null for the whole team. */
function subject(board: LoadedBoard, values: Values): Resource | null {
  if ([values.user, values.role, values.team].filter(Boolean).length > 1) {
    throw new BoardError('Pass one of --user, --role or --team', [
      '--user names a person on the roster; --role names a pool; --team is everybody.',
    ]);
  }
  if (values.team) return null;

  const wanted = values.user ?? values.role;
  if (!wanted) return requireCurrentUser(board);

  const resource = findResource(board, wanted);
  if (!resource) {
    throw new BoardError(`No resource matching "${wanted}"`, [
      'Run `lpm team` to see the roster.',
    ]);
  }

  // The two flags are a statement of what you expect to find. Simulating a pool
  // as though it were a person, or the other way round, gives an answer to a
  // question nobody asked, so say which one this is instead of guessing.
  const generic = isGenericResource(board, resource);
  if (values.user && generic) {
    throw new BoardError(`${resource.id} (${resource.title}) is a pool, not a person`, [
      `Use --role "${resource.title}" to simulate somebody working out of it.`,
    ]);
  }
  if (values.role && !generic) {
    throw new BoardError(`${resource.id} (${resource.title}) is a person, not a pool`, [
      `Use --user "${resource.title}".`,
    ]);
  }
  return resource;
}

/**
 * Whose profile applies. Your own scope is the queue you are actually offered,
 * so it belongs in a simulation of you; nobody else's is yours to apply.
 */
function scopeFor(board: LoadedBoard, resource: Resource | null): ResolvedScope {
  const me = currentUser(board)?.resource;
  return me && resource && me.id === resource.id ? currentScope(board) : fullScope();
}

function limitOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BoardError(`Invalid --limit "${value}"`, ['Expected a whole number of 1 or more.']);
  }
  return parsed;
}

const TITLE_WIDTH = 36;
const TYPE_WIDTH = 13;
const NUMBER_WIDTH = 8;

/**
 * `pad` truncates nothing, and a long title must not push the columns apart.
 * The column is one wider than the text it holds, so a clipped title still has
 * a gap after it.
 */
function clip(text: string, width: number): string {
  const room = width - 1;
  return pad(text.length > room ? `${text.slice(0, room - 1)}…` : text, width);
}

function figure(value: number | null): string {
  return (value === null ? '--' : `${value}`).padStart(NUMBER_WIDTH);
}

function header(): string {
  return `  ${pad('', 5)}${pad('id', 8)}${pad('title', TITLE_WIDTH)}${pad('type', TYPE_WIDTH)}${'effort'.padStart(NUMBER_WIDTH)}${'total'.padStart(NUMBER_WIDTH)}`;
}

function stepLine(board: LoadedBoard, step: SimulationStep, showEffort: boolean): string {
  const type = board.config.issue_types[step.issue.type]?.label ?? step.issue.type;
  const numbers = showEffort ? `${figure(step.effort)}${dim(figure(step.cumulative))}` : '';

  const notes: string[] = [];
  if (step.started) notes.push('in progress');
  if (step.period) notes.push(step.period.id);
  if (step.route === 'pool' && step.pool) notes.push(`pool ${step.pool.id}`);
  if (step.route === 'unassigned') notes.push('unassigned');
  if (step.unblocked.length) {
    notes.push(`frees ${step.unblocked.map((issue) => issue.id).join(', ')}`);
  }

  return `  ${dim(pad(`${step.order}.`, 5))}${bold(pad(step.issue.id, 8))}${clip(step.issue.title, TITLE_WIDTH)}${dim(pad(type, TYPE_WIDTH))}${numbers}${notes.length ? `  ${dim(notes.join(' · '))}` : ''}`.trimEnd();
}

/** Why the run never got to something, in the reader's terms. */
function skipLine(skip: SimulationSkip): string {
  const holder = skip.holder ? `${skip.holder.id} (${skip.holder.title})` : 'nobody';
  const period = skip.period ? `${skip.period.id} (${skip.period.title})` : 'its period';
  const because: Record<SimulationSkip['reason'], string> = {
    flagged: `flagged by ${holder} — the work has stopped until somebody clears it`,
    active: `already in progress under ${holder}`,
    scope: 'outside the scope your profile offers',
    routing: skip.holder ? `assigned to ${holder}` : 'assigned to nobody — try --unassigned',
    squad: `${period} is owned by a squad you are not a member of`,
    parked: `${period} is switched off — try --parked`,
    blocked: `waiting on ${skip.blockedBy.map((issue) => issue.id).join(', ')}`,
    ready: 'ready, but the run stopped at --limit',
  };
  return `  ${bold(pad(skip.issue.id, 8))}${clip(skip.issue.title, TITLE_WIDTH)}  ${yellow(because[skip.reason])}`;
}

/**
 * What the switch is holding back, said wherever the run is reported — a short
 * run nobody can explain is worse than a short run, and this is the one reason
 * a reader cannot work out from the steps themselves.
 */
function parkedNotice(run: QueueSimulation): void {
  if (!run.parked) return;
  out(
    dim(`  ${plural(run.parked, 'issue')} left out in switched-off periods — add `) +
      cyan('--parked') +
      dim(' to include them'),
  );
}

/**
 * The other reason a run is short, and the one that looks like a bug when it is
 * not said: this person holds work that has stopped. The run cannot start from
 * it — nobody in a one-person simulation is going to clear the flag — so
 * everything waiting on it stays out of the sequence.
 */
function flaggedNotice(run: QueueSimulation): void {
  if (!run.flagged) return;
  const whose = run.resource ? ' of theirs' : '';
  out(
    dim(`  ${plural(run.flagged, 'issue')}${whose} flagged, so the run cannot start from them — see `) +
      cyan('lpm flag list'),
  );
}

function report(board: LoadedBoard, run: QueueSimulation, scope: ResolvedScope, values: Values): void {
  if (run.resource) {
    const kind = isGenericResource(board, run.resource) ? 'pool' : 'person';
    out(
      `${bold('Queue simulation for')} ${bold(run.resource.id)} ${run.resource.title} ${dim(`(${kind})`)}`,
    );
  } else {
    out(`${bold('Queue simulation for the whole team')} ${dim('(every open work unit, whoever holds it)')}`);
  }
  // Said once, because it is why no period appears anywhere below.
  if (hasPeriods(board.config) && ignoresPeriods(board.config)) {
    out(`  ${dim('planning by queue — every period is ignored; see')} ${cyan('lpm planning')}`);
  }
  if (scope.active) {
    out(`  ${dim(`scope ${describeScope(scope)}`)}`);
    if (scope.unknown.length) {
      out(`  ${yellow(`warn this board has nothing named ${scope.unknown.join(', ')}`)}`);
    }
  }
  if (values.unassigned) out(`  ${dim('including work nobody is assigned to')}`);
  if (values.parked) out(`  ${dim('including periods somebody switched off')}`);
  out();

  if (!run.steps.length) {
    out(dim('  nothing this resource could ever pick up'));
    // Especially here: a queue that is empty *because* the team parked
    // everything, or because everything this person holds has stopped, is not
    // the same as a board with nothing left on it.
    flaggedNotice(run);
    parkedNotice(run);
    return;
  }

  const showEffort = Boolean(board.config.effort_attribute);
  if (showEffort) out(dim(header()));
  for (const step of run.steps) out(stepLine(board, step, showEffort));

  out();
  const totals = [plural(run.steps.length, 'task')];
  if (run.effort !== null) {
    totals.push(`${run.effort} ${board.config.effort_attribute}`);
    if (run.unestimated) totals.push(`${run.unestimated} unestimated`);
  }
  out(`${bold('Total')}  ${dim(totals.join('  ·  '))}`);
  if (run.truncated) out(dim('  stopped at --limit; more work was still takeable'));
  flaggedNotice(run);
  parkedNotice(run);
}

interface Values {
  user?: string;
  role?: string;
  team?: boolean;
  unassigned?: boolean;
  parked?: boolean;
  limit?: string;
  skipped?: boolean;
}

function runSimulate(values: Values): number {
  const board = requireBoard();
  // The whole team needs no roster: with nobody on it, every issue is simply
  // unassigned, and the sequence is still the order the board offers work in.
  if (!values.team && !hasResources(board.config)) {
    throw new BoardError('This board has no team roster, so there is nobody to simulate', [
      'Add resource_types, resource_hierarchy and resource_prefix to .lpm/config.yml.',
    ]);
  }

  const resource = subject(board, values);
  const scope = scopeFor(board, resource);
  const run = simulateQueue(board, resource, {
    includeUnassigned: Boolean(values.unassigned),
    includeParked: Boolean(values.parked),
    limit: limitOf(values.limit),
    scope,
  });

  report(board, run, scope, values);

  if (values.skipped) {
    out();
    out(bold('Never reached'));
    if (!run.skipped.length) out(dim('  nothing — this run clears the board'));
    for (const skip of run.skipped) out(skipLine(skip));
  } else if (run.skipped.length) {
    if (run.steps.length) out();
    out(
      `${dim(`${plural(run.skipped.length, 'open issue')} never reached — see why with`)} ${cyan('lpm queue simulate --skipped')}`,
    );
  }
  return 0;
}

function parseSimulateValues(args: string[]): Values {
  const { values } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      user: { type: 'string' },
      role: { type: 'string' },
      team: { type: 'boolean' },
      unassigned: { type: 'boolean' },
      parked: { type: 'boolean' },
      limit: { type: 'string' },
      skipped: { type: 'boolean' },
    },
  });
  return values;
}

// --- agent ---

function parsePositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new BoardError(`Invalid ${flag} "${value}"`, ['Expected a whole number of 1 or more.']);
  }
  return parsed;
}

function parsePositiveNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new BoardError(`Invalid ${flag} "${value}"`, ['Expected a number greater than 0.']);
  }
  return parsed;
}

function validateChoice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw new BoardError(`Invalid ${flag} "${value}"`, [`Expected one of: ${allowed.join(', ')}.`]);
  }
  return value as T;
}

interface AgentCli {
  file?: string;
  dryRun: boolean;
  /** Log one line per event rather than drawing the live pane. */
  plain: boolean;
  overrides: Partial<AgentConfig>;
}

function parseAgentArgs(args: string[]): AgentCli {
  const { values } = parseArgs({
    args,
    allowPositionals: false,
    options: {
      user: { type: 'string' },
      'max-tasks': { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      commit: { type: 'string' },
      unassigned: { type: 'boolean' },
      parked: { type: 'boolean' },
      timeout: { type: 'string' },
      'command-timeout': { type: 'string' },
      plain: { type: 'boolean' },
      file: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
  });

  const overrides: Partial<AgentConfig> = {};
  if (values.user !== undefined) overrides.user = values.user;
  const maxTasks = parsePositiveInt(values['max-tasks'], '--max-tasks');
  if (maxTasks !== undefined) overrides.maxTasks = maxTasks;
  if (values.model !== undefined) overrides.model = values.model;
  const effort = validateChoice<AgentEffort>(values.effort, AGENT_EFFORTS, '--effort');
  if (effort !== undefined) overrides.effort = effort;
  const commit = validateChoice<CommitMode>(values.commit, COMMIT_MODES, '--commit');
  if (commit !== undefined) overrides.commit = commit;
  if (values.unassigned) overrides.unassigned = true;
  if (values.parked) overrides.parked = true;
  const timeout = parsePositiveNumber(values.timeout, '--timeout');
  if (timeout !== undefined) overrides.timeout = timeout;
  const commandTimeout = parsePositiveNumber(values['command-timeout'], '--command-timeout');
  if (commandTimeout !== undefined) overrides.commandTimeout = commandTimeout;

  return {
    file: values.file,
    dryRun: Boolean(values['dry-run']),
    plain: Boolean(values.plain),
    overrides,
  };
}

/** The person the agent works as: --user, else `lpm me`; never a pool. */
function agentResource(board: LoadedBoard, userRef: string | undefined): Resource {
  const resource = userRef ? findResource(board, userRef) : requireCurrentUser(board);
  if (!resource) {
    throw new BoardError(`No resource matching "${userRef}"`, ['Run `lpm team` to see the roster.']);
  }
  if (isGenericResource(board, resource)) {
    throw new BoardError(`${resource.id} (${resource.title}) is a pool, not a person`, [
      'Route the agent to a named person on the roster.',
    ]);
  }
  return resource;
}

async function buildRunner(cfg: AgentConfig) {
  const { createPiRunner } = await import('../../runner/pi.js');
  return createPiRunner({
    model: cfg.model,
    effort: cfg.effort,
    timeoutMs: cfg.timeout ? cfg.timeout * 1000 : undefined,
    commandTimeout: cfg.commandTimeout,
    tools: cfg.tools,
    authPath: cfg.authPath,
  });
}

/**
 * Why an empty queue is empty. The queue does not re-offer work somebody has
 * picked up, and never offers flagged work, so a person holding three stalled
 * issues gets "nothing to pick up" from a board that is full of their work.
 * Saying which it was is the difference between a report and a shrug.
 */
function heldNotice(report: RunReport): void {
  if (!report.held.length) return;
  const flagged = report.held.filter((task) => task.flag);
  out();
  out(dim(`  ${plural(report.held.length, 'issue')} already in progress for them:`));
  for (const task of report.held) {
    const mark = task.flag ? yellow(flagLabel(task.flag)) : dim('in progress');
    out(`  ${bold(pad(task.id, 8))}${clip(task.title, TITLE_WIDTH)}${mark}`);
  }
  out();
  out(
    flagged.length
      ? dim('  Flagged work has stopped and needs a person: read the comments with ') +
          cyan('lpm comment <id> --list') +
          dim(', then ') +
          cyan('lpm flag clear <id> -m "..."')
      : dim('  Finish or hand back what is in progress, and the queue will offer more.'),
  );
}

function reportAgent(report: RunReport): void {
  out();
  if (!report.steps.length) {
    out(dim('  nothing to pick up'));
    heldNotice(report);
    return;
  }
  for (const step of report.steps) {
    const mark = step.completed
      ? green('done')
      : report.stopped === 'dry-run'
        ? cyan('preview')
        : yellow(`flagged${step.flagReason ? ` (${step.flagReason})` : ''}`);
    const extra: string[] = [];
    if (step.committed) extra.push(`commit ${step.committed}`);
    if (step.error) extra.push(step.error);
    out(
      `  ${bold(pad(step.id, 8))}${clip(step.title, TITLE_WIDTH)}${mark}${extra.length ? `  ${dim(extra.join(' · '))}` : ''}`,
    );
  }

  if (report.stopped === 'dry-run') return;
  out();
  const done = report.steps.filter((step) => step.completed).length;
  const flagged = report.steps.length - done;
  const parts = [plural(report.steps.length, 'task')];
  if (done) parts.push(`${done} done`);
  if (flagged) parts.push(`${flagged} flagged`);
  out(`${bold('Total')}  ${dim(parts.join('  ·  '))}`);
  if (report.stopped === 'max-tasks') out(dim('  stopped at --max-tasks; more work may remain'));
  // Somebody else on this checkout kept getting to the work first. Nothing is
  // wrong with the board and nothing was lost — the work is being done by
  // whoever won the claims — so this reads as information, not as a warning.
  if (report.stopped === 'contended') {
    out(dim('  stopped: other people or agents on this checkout claimed everything offered'));
  }
  // A run that stopped early because the rest of the queue is stalled behind
  // this person's own flags has to say so, exactly as an empty one does.
  if (report.stopped === 'empty') heldNotice(report);
}

function runAgent(args: string[]): number {
  const cli = parseAgentArgs(args);
  const fileResult = cli.file
    ? loadAgentConfig(cli.file)
    : { config: {} as AgentConfig, errors: [] as string[] };
  if (fileResult.errors.length) {
    throw new BoardError(`Invalid config file "${cli.file}"`, fileResult.errors);
  }
  const cfg: AgentConfig = { ...(fileResult.config ?? {}), ...cli.overrides };

  const board = requireBoard();
  if (!hasResources(board.config)) {
    throw new BoardError('This board has no team roster, so there is nobody to route work to', [
      'Add resource_types, resource_hierarchy and resource_prefix to .lpm/config.yml.',
    ]);
  }

  const resource = agentResource(board, cfg.user);
  const scope = scopeFor(board, resource);
  const options: LoopOptions = {
    maxTasks: cfg.maxTasks ?? Infinity,
    includeUnassigned: Boolean(cfg.unassigned),
    includeParked: Boolean(cfg.parked),
    commit: cfg.commit ?? 'none',
    dryRun: cli.dryRun,
    scope,
  };

  out(`${bold('Agent queue for')} ${bold(resource.id)} ${resource.title}`);
  if (cli.dryRun) {
    out(dim('  dry run — nothing will be run or written'));
  } else {
    out(dim(`  model ${cfg.model ?? 'default'} · effort ${cfg.effort ?? 'default'} · commit ${options.commit}`));
    out(
      dim(
        `  commands are killed after ${cfg.commandTimeout ?? DEFAULT_COMMAND_TIMEOUT}s` +
          (cfg.timeout ? ` · tasks after ${cfg.timeout}s` : ''),
      ),
    );
  }
  if (options.maxTasks !== Infinity) out(dim(`  stopping after ${plural(options.maxTasks, 'task')}`));

  // A dry run prints a brief and stops; there is nothing live to watch, and a
  // pane would only rub the brief off the screen again.
  const view = createAgentView({ plain: cli.plain || cli.dryRun });

  void (async () => {
    try {
      const runner = cli.dryRun ? undefined : await buildRunner(cfg);
      const report = await runAgentQueue(board.paths, resource.id, options, {
        runner,
        git: createGitDriver(),
        emit: (event) => view.feed(event),
      });
      // The pane comes down before the report goes out, so the summary lands in
      // the scrollback rather than under a frame that is about to be erased.
      view.stop();
      reportAgent(report);
    } finally {
      view.stop();
    }
  })().catch((error: unknown) => {
    if (error instanceof BoardError) {
      err(`${red('error')} ${error.message}`);
      for (const detail of error.details) err(`       ${detail}`);
    } else {
      err(`${red('error')} ${(error as Error).message}`);
    }
    process.exitCode = 1;
  });

  return 0;
}

export function run(args: string[]): number {
  const sub = args[0];
  if (!sub || sub.startsWith('-')) {
    out(help);
    return 1;
  }
  const rest = args.slice(1);
  if (sub === 'simulate') return runSimulate(parseSimulateValues(rest));
  if (sub === 'agent') return runAgent(rest);
  throw new BoardError(`Unknown subcommand "${sub}"`, ['Expected: simulate or agent.']);
}
