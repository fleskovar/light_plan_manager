import { appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import {
  BoardError,
  checkBoard,
  createIssue,
  createPeriod,
  createResource,
  createSquad,
  findIssue,
  findPeriod,
  linkIssue,
  moveNode,
  nextTasks,
  parsePlanningMode,
  planningOf,
  setPlanning,
  simulateQueue,
  updateNode,
} from '../src/core/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

const TODAY = '2026-08-10';

/**
 * A running sprint (TL-2) and a later one (TL-3) inside an increment, a parked
 * sprint (TL-4) and a sprint owned by Bob's squad (TL-5). Alice and Bob on the
 * roster. One story in each place, so every period rule has something to hold.
 *
 *   LP-4  in the running sprint, low priority
 *   LP-5  in the later sprint, critical
 *   LP-6  in the parked sprint, Alice
 *   LP-7  in Bob's squad's sprint, Alice
 */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  // Scrum ships no squads; a board that has them is the one the squad gate needs.
  appendFileSync(
    paths.configPath,
    [
      '',
      'squad_prefix: SQ',
      'squad_types:',
      '  squad:',
      '    label: Squad',
      '    attributes: {}',
      '    body: ""',
      'squad_hierarchy:',
      '  - squad',
      '',
    ].join('\n'),
  );
  createResource(reload(paths), { type: 'person', title: 'Alice' });
  createResource(reload(paths), { type: 'person', title: 'Bob' });
  const squad = createSquad(reload(paths), { type: 'squad', title: 'Platform', members: ['RS-2'] });

  createPeriod(reload(paths), { type: 'increment', title: 'PI', starts: '2026-08-03', ends: '2026-09-25' });
  createPeriod(reload(paths), {
    type: 'sprint',
    title: 'Running',
    parentId: 'TL-1',
    starts: '2026-08-03',
    ends: '2026-08-14',
  });
  createPeriod(reload(paths), {
    type: 'sprint',
    title: 'Later',
    parentId: 'TL-1',
    starts: '2026-08-17',
    ends: '2026-08-28',
  });
  createPeriod(reload(paths), {
    type: 'sprint',
    title: 'Parked',
    parentId: 'TL-1',
    starts: '2026-08-31',
    ends: '2026-09-11',
  });
  updateNode(reload(paths), findPeriod(reload(paths), 'TL-4')!, { active: false });
  createPeriod(reload(paths), {
    type: 'sprint',
    title: 'Platform sprint',
    parentId: 'TL-1',
    starts: '2026-09-14',
    ends: '2026-09-25',
    squad: squad.id,
  });

  createIssue(reload(paths), { type: 'program', title: 'P' });
  createIssue(reload(paths), { type: 'epic', title: 'E', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'F', parentId: 'LP-2' });
  const story = (title: string, period: string, priority: string, assignee = 'RS-1') =>
    createIssue(reload(paths), {
      type: 'user_story',
      title,
      parentId: 'LP-3',
      period,
      assignee,
      attributes: { priority },
    });
  story('Now, low', 'TL-2', 'low');
  story('Later, critical', 'TL-3', 'critical');
  story('Parked', 'TL-4', 'medium');
  story('Squad-owned', 'TL-5', 'medium');
  return paths;
}

const ids = (candidates: { issue: { id: string } }[]): string[] =>
  candidates.map((candidate) => candidate.issue.id);

/** Every file under the board folder, path -> contents: what "touched no document" means. */
function documents(paths: BoardPaths): Map<string, string> {
  const found = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.md')) found.set(full, readFileSync(full, 'utf8'));
    }
  };
  walk(paths.boardDir);
  return found;
}

describe('setPlanning', () => {
  it('writes planning: queue into the config, and nothing else', () => {
    const paths = seed();
    const before = documents(paths);

    const result = setPlanning(paths, 'queue');
    expect(result).toEqual({ planning: 'queue', previous: 'periods', changed: true });
    expect(readFileSync(paths.configPath, 'utf8')).toMatch(/^planning: queue$/m);
    expect(planningOf(reload(paths).config)).toBe('queue');
    expect(documents(paths)).toEqual(before);
  });

  it('is reversible to the byte: switching back removes the line it added', () => {
    const paths = seed();
    const original = readFileSync(paths.configPath, 'utf8');

    setPlanning(paths, 'queue');
    setPlanning(paths, 'periods');
    expect(readFileSync(paths.configPath, 'utf8')).toBe(original);
  });

  it('edits a planning line somebody wrote by hand in place, never adding a second', () => {
    const paths = seed();
    const original = readFileSync(paths.configPath, 'utf8');
    writeFileSync(paths.configPath, `planning: periods\n${original}`);

    setPlanning(paths, 'queue');
    const queued = readFileSync(paths.configPath, 'utf8');
    expect(queued.match(/^planning:/gm)).toHaveLength(1);
    expect(queued.startsWith('planning: queue\n')).toBe(true);

    setPlanning(paths, 'periods');
    expect(readFileSync(paths.configPath, 'utf8')).toBe(original);
  });

  it('says so and writes nothing when the board is already in that mode', () => {
    const paths = seed();
    const original = readFileSync(paths.configPath, 'utf8');
    expect(setPlanning(paths, 'periods').changed).toBe(false);
    expect(readFileSync(paths.configPath, 'utf8')).toBe(original);
  });

  it('is always the queue on a board with no period types, and refuses periods there', () => {
    const paths = makeBoard('blank', 'LP');
    expect(planningOf(reload(paths).config)).toBe('queue');
    expect(() => setPlanning(paths, 'periods')).toThrow(BoardError);
    expect(setPlanning(paths, 'queue').changed).toBe(false);
  });

  it('reads the words people use for the calendar', () => {
    expect(parsePlanningMode('PI')).toBe('periods');
    expect(parsePlanningMode('sprints')).toBe('periods');
    expect(parsePlanningMode(' Queue ')).toBe('queue');
    expect(() => parsePlanningMode('kanban')).toThrow(/Unknown planning mode/);
  });
});

describe('the queue in queue mode', () => {
  it('drops the schedule rank: priority decides instead of the sprint', () => {
    const paths = seed();
    const before = ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }));
    expect(before.slice(0, 2)).toEqual(['LP-4', 'LP-5']);

    setPlanning(paths, 'queue');
    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))[0]).toBe('LP-5');
  });

  it('offers work a switched-off period held back, and work in a sprint another squad owns', () => {
    const paths = seed();
    const before = ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }));
    expect(before).not.toContain('LP-6');
    expect(before).not.toContain('LP-7');

    setPlanning(paths, 'queue');
    const after = ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }));
    expect(after).toEqual(expect.arrayContaining(['LP-6', 'LP-7']));
  });

  it('names no period on what it offers, while every document keeps its own', () => {
    const paths = seed();
    setPlanning(paths, 'queue');
    const board = reload(paths);
    expect(nextTasks(board, 'RS-1', { today: TODAY }).every((task) => task.period === null)).toBe(true);
    expect(findIssue(board, 'LP-6')!.period).toBe('TL-4');
  });

  it('gives the plan back exactly when switched back', () => {
    const paths = seed();
    const before = ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }));
    setPlanning(paths, 'queue');
    setPlanning(paths, 'periods');
    expect(ids(nextTasks(reload(paths), 'RS-1', { today: TODAY }))).toEqual(before);
  });

  it('stops warning about work scheduled before what it waits on', () => {
    const paths = seed();
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, { dependsOn: ['LP-5'] });
    const warns = () =>
      checkBoard(reload(paths)).filter((problem) => problem.message.includes('scheduled later'));
    expect(warns()).toHaveLength(1);
    setPlanning(paths, 'queue');
    expect(warns()).toHaveLength(0);
  });
});

describe('the whole team’s queue', () => {
  it('offers every open work unit, whoever holds it', () => {
    const paths = seed();
    createIssue(reload(paths), { type: 'user_story', title: 'Bob’s', parentId: 'LP-3', assignee: 'RS-2' });
    createIssue(reload(paths), { type: 'user_story', title: 'Nobody’s', parentId: 'LP-3' });
    setPlanning(paths, 'queue');

    const team = ids(nextTasks(reload(paths), null, { today: TODAY }));
    expect(team.sort()).toEqual(['LP-4', 'LP-5', 'LP-6', 'LP-7', 'LP-8', 'LP-9']);
  });

  it('is a sequence the simulation replays, in-progress work first', () => {
    const paths = seed();
    moveNode(reload(paths), findIssue(reload(paths), 'LP-7')!, { status: 'in_progress' });
    setPlanning(paths, 'queue');

    const run = simulateQueue(reload(paths), null, { today: TODAY });
    expect(run.resource).toBeNull();
    expect(run.steps[0]).toMatchObject({ order: 1, started: true });
    expect(run.steps[0]!.issue.id).toBe('LP-7');
    // Every step is what the team's queue offered at that point: the first
    // one not already started is the top of `nextTasks`.
    expect(run.steps[1]!.issue.id).toBe(ids(nextTasks(reload(paths), null, { today: TODAY }))[0]);
    expect(run.steps.map((step) => step.issue.id).sort()).toEqual(['LP-4', 'LP-5', 'LP-6', 'LP-7']);
  });

  it('still respects the period rules while the board plans with periods', () => {
    const paths = seed();
    const run = simulateQueue(reload(paths), null, { today: TODAY });
    expect(run.steps.map((step) => step.issue.id)).not.toContain('LP-6');
    expect(run.skipped.find((skip) => skip.issue.id === 'LP-6')?.reason).toBe('parked');
    // Nobody in particular is asking, so no squad keeps its sprint from "the team".
    expect(run.steps.map((step) => step.issue.id)).toContain('LP-7');
  });
});

describe('the mode a new board starts in', () => {
  const configOf = (paths: BoardPaths): string => readFileSync(paths.configPath, 'utf8');

  it('is queue: initBoard writes the key planning with the value queue', () => {
    const paths = makeBoard('scrum', 'LP', { planning: 'queue' });
    expect(configOf(paths)).toMatch(/^planning: queue$/m);
    expect(planningOf(reload(paths).config)).toBe('queue');
  });

  it('is removed byte for byte by a switch to periods, and comes back by a switch to queue', () => {
    const paths = makeBoard('scrum', 'LP', { planning: 'queue' });
    const asCreated = configOf(paths);

    setPlanning(paths, 'periods');
    expect(configOf(paths)).not.toMatch(/^planning:/m);
    expect(configOf(paths)).toBe(configOf(makeBoard('scrum', 'LP')));

    setPlanning(paths, 'queue');
    expect(configOf(paths)).toBe(asCreated);
  });

  it('is periods when the caller asks for it, with no key in the config', () => {
    const paths = makeBoard('scrum', 'LP', { planning: 'periods' });
    expect(configOf(paths)).not.toMatch(/^planning:/m);
    expect(planningOf(reload(paths).config)).toBe('periods');
  });

  it('adds no key to a template with no period types', () => {
    const paths = makeBoard('blank', 'LP', { planning: 'queue' });
    expect(configOf(paths)).not.toMatch(/^planning:/m);
    expect(planningOf(reload(paths).config)).toBe('queue');
  });

  it('keeps the omni periods and schedules new issues in them', () => {
    const paths = makeBoard('scrum', 'LP', { planning: 'queue', omni: true });
    const issue = createIssue(reload(paths), { type: 'program', title: 'P' });
    expect(issue.period).toBe('TL-2');
    expect(configOf(paths)).toMatch(/^default_period: TL-2$/m);
  });
});
