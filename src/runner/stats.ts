import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BoardPaths } from '../core/index.js';
import type { RunOutcome } from './types.js';

/**
 * The trail one agent run leaves behind.
 *
 * Two artefacts, both for a human doing QA: a concise comment on the issue (the
 * narrative), and a full JSON file under `.lpm/runs/` (the receipt). The folder
 * holds no documents, so `load.ts` never walks it and `check` never sees it — a
 * run log cannot make a board invalid.
 */

/** Where run logs live, keyed by issue then timestamp. */
export const RUNS_DIR = 'runs';

/** A timestamp safe for a filename on every platform. */
function stamp(at: string): string {
  return at.replace(/[:.]/g, '-');
}

/**
 * Write the full outcome to `.lpm/runs/<id>/<timestamp>.json` and return its
 * path relative to the project root, for linking from the comment.
 */
export function writeRunArtifact(
  paths: BoardPaths,
  issueId: string,
  outcome: RunOutcome,
  at: string = new Date().toISOString(),
): string {
  const dir = path.join(paths.lpmDir, RUNS_DIR, issueId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp(at)}.json`);
  writeFileSync(file, JSON.stringify({ at, issue: issueId, ...outcome }, null, 2), 'utf8');
  return path.relative(paths.root, file).split(path.sep).join('/');
}

function line(label: string, value: string): string {
  return `- ${label}: ${value}`;
}

/** The comment body logged on the issue after a run. */
export function formatRunComment(outcome: RunOutcome, artifact: string | null): string {
  const { stats } = outcome;
  const head = outcome.completed ? '**Agent run — completed**' : '**Agent run — needs attention**';

  const facts: string[] = [];
  facts.push(line('model', stats.model ?? 'default'));
  if (stats.effort) facts.push(line('effort', stats.effort));
  facts.push(line('duration', `${(stats.wallMs / 1000).toFixed(1)}s`));
  if (stats.tokens) {
    facts.push(line('tokens', `${stats.tokens.total} (in ${stats.tokens.input}, out ${stats.tokens.output})`));
  }
  if (stats.cost !== null) facts.push(line('cost', `$${stats.cost.toFixed(4)}`));
  facts.push(
    line(
      'tools',
      stats.tools.length
        ? stats.tools.map((t) => (t.isError ? `${t.name}✗` : t.name)).join(' → ')
        : 'none',
    ),
  );
  if (artifact) facts.push(line('full log', artifact));

  const parts = [head, '', outcome.summary.trim()];
  if (outcome.details?.trim()) parts.push('', outcome.details.trim());
  if (outcome.error) parts.push('', `_Error: ${outcome.error}_`);
  parts.push('', '<details><summary>run stats</summary>', '', facts.join('\n'), '</details>');
  return parts.join('\n');
}
