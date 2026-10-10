import { readFileSync } from 'node:fs';
import { planningOf } from '../config/lookup.js';
import { parseConfigText } from '../config/schema.js';
import { BoardError } from '../errors.js';
import type { PlanningMode } from '../model/types.js';
import { PLANNING_MODES, hasPeriods } from '../model/types.js';
import { writeFileAtomic } from '../storage/atomic.js';
import type { BoardPaths } from '../storage/paths.js';
import { CONFIG_FILE, LPM_DIR } from '../storage/paths.js';
import { withBoardWrite } from './git-sync.js';

/**
 * Switching a board between planning with its periods and working it as one
 * continuous queue.
 *
 * Queue mode is the omni periods (`docs/periods.md`) taken to their end: the
 * whole board reads as one increment holding one sprint holding everything, so
 * the queue orders work by priority, column and the dependency graph alone.
 * It is a reading, never a rewrite. The one thing this writes is the
 * `planning:` key in `.lpm/config.yml` — no document is touched, every
 * `period:` stays where somebody put it, and switching back hands the plan back
 * exactly as it was.
 *
 * The config is edited as text, not through the `yaml` document `editConfig`
 * uses: that re-renders the whole file, and the shipped configs mix flow styles
 * (`[a, b]` beside `{ remote: epic }`) that no single setting reproduces. So
 * queue mode appends one commented line and periods mode removes exactly that
 * line, which is what makes the round trip byte-identical.
 *
 * It is board truth, not a preference: `lpm task next`, MCP `next_tasks`,
 * `lpm queue agent` and the web queue all read it, so the whole team works the
 * same queue. On a board shared through git the change is committed and pushed
 * like any other write.
 */

export interface SetPlanningResult {
  /** The mode in force afterwards. */
  planning: PlanningMode;
  /** The mode in force before. */
  previous: PlanningMode;
  /** False when the board was already in that mode and nothing was written. */
  changed: boolean;
}

/** The block queue mode appends, comment included, so it can be removed whole. */
const QUEUE_BLOCK =
  '\n# Work the board as one continuous queue: every period is ignored until\n' +
  '# this line is removed (`lpm planning periods`). Documents keep their period.\n' +
  'planning: queue\n';

/** A top-level `planning:` line, however it was written. */
const PLANNING_LINE = /^planning:[^\n]*\n?/m;

/** Read a mode somebody typed, accepting the words people use for the calendar. */
export function parsePlanningMode(value: string): PlanningMode {
  const word = value.trim().toLowerCase();
  if (['periods', 'period', 'pi', 'sprints', 'sprint', 'calendar'].includes(word)) return 'periods';
  if (word === 'queue') return 'queue';
  throw new BoardError(`Unknown planning mode "${value}"`, [
    `Expected one of: ${PLANNING_MODES.join(', ')}.`,
  ]);
}

/**
 * The config text in `planning` mode, touching nothing but the planning line.
 * Exported for `initBoard`, which starts a new board in queue mode with the
 * same block, so `lpm planning periods` removes exactly what `lpm init` wrote.
 */
export function configWithPlanning(text: string, planning: PlanningMode): string {
  if (planning === 'periods') {
    // Ours comes out whole, comment and blank line too; a line somebody wrote
    // by hand comes out alone, because their comments are theirs.
    if (text.includes(QUEUE_BLOCK)) return text.replace(QUEUE_BLOCK, '');
    return text.replace(PLANNING_LINE, '');
  }
  if (PLANNING_LINE.test(text)) return text.replace(PLANNING_LINE, 'planning: queue\n');
  return `${text}${text.endsWith('\n') ? '' : '\n'}${QUEUE_BLOCK}`;
}

/** Switch the board's planning mode. A no-op, reported as such, when it is already there. */
export function setPlanning(paths: BoardPaths, planning: PlanningMode): SetPlanningResult {
  const text = readFileSync(paths.configPath, 'utf8');
  const loaded = parseConfigText(text);
  if (!loaded.config) throw new BoardError('The board config does not validate', loaded.errors);
  const config = loaded.config;
  const previous = planningOf(config);

  if (planning === 'periods' && !hasPeriods(config)) {
    throw new BoardError('This board has no period types, so it can only be worked as a queue', [
      'Add period_types, period_hierarchy and period_prefix to .lpm/config.yml to plan with sprints.',
    ]);
  }
  if (previous === planning) return { planning, previous, changed: false };

  withBoardWrite(
    paths,
    planning === 'queue' ? 'plan as one continuous queue' : 'plan with periods again',
    () => {
      const next = configWithPlanning(readFileSync(paths.configPath, 'utf8'), planning);
      const parsed = parseConfigText(next);
      if (!parsed.config || planningOf(parsed.config) !== planning) {
        throw new BoardError(`${LPM_DIR}/${CONFIG_FILE} would not validate`, [
          ...parsed.errors,
          'Check the `planning:` line in .lpm/config.yml by hand.',
        ]);
      }
      writeFileAtomic(paths.configPath, next);
    },
    config,
  );
  return { planning, previous, changed: true };
}
