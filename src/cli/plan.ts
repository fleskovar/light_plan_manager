import type { AnyNode, LoadedBoard, TypeDef } from '../core/index.js';
import { BoardError, parseAttributeInput, typeDefOf as lookupTypeDefOf } from '../core/index.js';
import type { BoardView, Plan } from '../shared/index.js';
import { applyChanges, toSnapshot } from '../sync/index.js';
import { bold, dim, green, out, plural } from './ui.js';

/**
 * Running a planned edit from the command line.
 *
 * The multi-step operations — split, copy, insert, convert — are planned in
 * `src/shared` so the CLI, the web app and the MCP server rewire a graph the
 * same way, and replayed through `src/sync`, which is the same code path a push
 * from the browser takes. This module is the small amount of glue between them.
 */

/** The board as the planners want it: the config, and the documents by id. */
export function boardView(board: LoadedBoard): BoardView {
  const snapshot = toSnapshot(board);
  const nodes = Object.fromEntries(
    [...snapshot.issues, ...snapshot.periods, ...snapshot.resources, ...snapshot.templates].map(
      (node) => [node.id, node],
    ),
  );
  return { config: snapshot.config, nodes };
}

export interface PlanReport {
  /** Ids the board allocated, in the order the plan created them. */
  created: string[];
}

/**
 * Apply a plan, or turn its refusal into the same `BoardError` every other
 * command throws. A partial failure is reported rather than swallowed: the
 * changes before it are already on disk.
 */
export function runPlan(board: LoadedBoard, plan: Plan, verb: string): PlanReport {
  if (!plan.ok) throw new BoardError(plan.error, plan.details);
  if (!plan.changes.length) {
    out(dim('nothing to do'));
    return { created: [] };
  }

  const result = applyChanges(board.paths, plan.changes);
  if (result.failures.length) {
    throw new BoardError(`${verb} did not finish`, [
      ...result.failures.map((failure) => `${failure.id}: ${failure.error}`),
      result.applied.length
        ? `${plural(result.applied.length, 'change')} did land; run \`lpm check\` to see where things stand.`
        : 'Nothing was written.',
    ]);
  }

  return { created: plan.created.map((temp) => result.idMap[temp] ?? temp) };
}

/** Print the documents a plan produced, in the CLI's usual shape. */
export function printCreated(created: string[], board: LoadedBoard, verb = 'Created'): void {
  const after = toSnapshot(board);
  const byId = new Map(after.issues.map((issue) => [issue.id, issue]));
  for (const id of created) {
    const node = byId.get(id);
    out(`  ${green(verb)} ${bold(id)}  ${node?.title ?? ''}`);
  }
}

/** Parse repeated `--set key=value` into attribute values of the right type. */
export function parseSets(
  typeDef: TypeDef,
  type: string,
  sets: string[] | undefined,
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  for (const entry of sets ?? []) {
    const split = entry.indexOf('=');
    if (split < 1) {
      throw new BoardError(`Invalid --set "${entry}"`, ['Expected the form key=value.']);
    }
    const key = entry.slice(0, split).trim();
    const def = typeDef.attributes[key];
    if (!def) {
      throw new BoardError(`"${key}" is not an attribute of "${type}"`, [
        `Declared attributes: ${Object.keys(typeDef.attributes).join(', ') || '(none)'}`,
      ]);
    }
    const parsed = parseAttributeInput(def, entry.slice(split + 1));
    if (parsed.error) throw new BoardError(`--set ${key}: ${parsed.error}`);
    attributes[key] = parsed.value;
  }
  return attributes;
}

/** The declared type of a document, for `--set` to validate against. */
export function typeDefOf(board: LoadedBoard, node: AnyNode): TypeDef {
  return lookupTypeDefOf(board.config, node.kind, node.type);
}
