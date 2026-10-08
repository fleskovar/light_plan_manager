import { existsSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import type { LoadedBoard } from '../board/load.js';
import { DEFAULT_CAPACITY, isUnassigned, loadBoard } from '../board/load.js';
import { nodesOf } from '../board/query.js';
import { boardFlagRollups } from '../board/flag-rollup.js';
import { boardRollups } from '../board/rollup.js';
import { hierarchyFor, prefixFor, statusIds } from '../config/lookup.js';
import { initialValueFor, isEmpty } from '../model/attributes.js';
import type { AnyNode, NodeKind } from '../model/types.js';
import { fileTimestamp, nowIso } from '../storage/document.js';
import { gitFileCreationDate, gitIdentity } from '../storage/git.js';
import { writeBoardIndex } from '../operations/board-index.js';
import { boardWrite, writeDocument } from '../operations/shared.js';
import { writeFlagRollups, writeRollups } from '../operations/rollup.js';
import { ensureLocalIgnored } from '../storage/local.js';
import { displayPath, nodeDirName } from '../storage/paths.js';
import { allocateIds, counterFor, numberOf, readState, writeState } from '../storage/state.js';
import { KINDS, RETIRED_LINK_FIELD, allNodes, at, retiredLink, typesOf } from './shared.js';

/**
 * Drop duplicates, keeping order. `self` is the id a list may not name — a link
 * list cannot point at its own document. Lists that are not links (a file
 * reference is text, not an id) pass nothing and only lose repeats.
 */
function dedupe(ids: string[], self?: string): { ids: string[]; changed: boolean } {
  const out: string[] = [];
  for (const id of ids) {
    if (id !== self && !out.includes(id)) out.push(id);
  }
  return { ids: out, changed: out.length !== ids.length };
}

/** The index as it stands, or null when there is none to compare against. */
function readIndex(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function fixCollection(board: LoadedBoard, kind: NodeKind, actions: string[]): void {
  const nodes = nodesOf(board, kind);
  if (!nodes.length) return;

  const { config, paths } = board;
  const types = typesOf(board, kind);
  const levels = hierarchyFor(config, kind);
  const validStatuses = statusIds(config);

  const unassigned = nodes.filter((node) => isUnassigned(node.id));
  const taken = new Set(allNodes(board).map((node) => node.id));
  const freshIds = unassigned.length
    ? allocateIds(paths, counterFor(kind), prefixFor(config, kind), unassigned.length, taken)
    : [];
  const assignedId = new Map<string, string>(
    unassigned.map((node, index) => [node.dir, freshIds[index]!]),
  );

  let identity: string | null = null;
  const author = (): string => (identity ??= gitIdentity(paths.lpmDir));
  const renames: Array<{ from: string; to: string }> = [];

  for (const original of nodes) {
    const where = at(board, original);
    const changes: string[] = [];
    const derived = board.derived.get(original.dir) ?? [];
    const node: AnyNode = {
      ...(original as AnyNode),
      attributes: { ...original.attributes },
    };

    if (isUnassigned(node.id)) {
      node.id = assignedId.get(original.dir)!;
      changes.push(`id=${node.id}`);
    } else if (derived.includes('id')) {
      changes.push(`id=${node.id}`);
    }

    if (!node.type) {
      const candidates = levels[node.depth] ?? [];
      if (candidates.length === 1) {
        node.type = candidates[0]!;
        changes.push(`type=${node.type}`);
      }
    } else if (derived.includes('type')) {
      changes.push(`type=${node.type}`);
    }

    if (derived.includes('title')) changes.push(`title="${node.title}"`);

    if (node.kind === 'issue') {
      if (!validStatuses.includes(node.status)) {
        node.status = config.default_status;
        changes.push(`status=${node.status}`);
      } else if (derived.includes('status')) {
        changes.push(`status=${node.status}`);
      }

      // `informed_by` gated the queue exactly as `depends_on` does, so merging
      // the ids in keeps the ordering the plan already recorded; the key itself
      // then goes, and with it the second name for one relationship.
      const retired = retiredLink(node);
      if (retired) {
        if (retired.length) node.depends_on = [...node.depends_on, ...retired];
        delete node.attributes[RETIRED_LINK_FIELD];
        changes.push(retired.length ? `${RETIRED_LINK_FIELD} -> depends_on` : `${RETIRED_LINK_FIELD} dropped`);
      }

      const depends = dedupe(node.depends_on, node.id);
      if (depends.changed) {
        node.depends_on = depends.ids;
        changes.push('depends_on deduped');
      }
      const relates = dedupe(node.relates_to, node.id);
      if (relates.changed) {
        node.relates_to = relates.ids;
        changes.push('relates_to deduped');
      }
      const files = dedupe(node.related_files);
      if (files.changed) {
        node.related_files = files.ids;
        changes.push('related_files deduped');
      }
    }

    if (node.kind === 'resource') {
      if (derived.includes('capacity')) {
        node.capacity = DEFAULT_CAPACITY;
        changes.push(`capacity=${node.capacity}`);
      }
      const covers = dedupe(node.covers, node.id);
      if (covers.changed) {
        node.covers = covers.ids;
        changes.push('covers deduped');
      }
    }

    if (node.kind === 'template') {
      const depends = dedupe(node.depends_on, node.id);
      if (depends.changed) {
        node.depends_on = depends.ids;
        changes.push('depends_on deduped');
      }
      const relates = dedupe(node.relates_to, node.id);
      if (relates.changed) {
        node.relates_to = relates.ids;
        changes.push('relates_to deduped');
      }
      const files = dedupe(node.related_files);
      if (files.changed) {
        node.related_files = files.ids;
        changes.push('related_files deduped');
      }
    }

    if (node.kind === 'squad') {
      const members = dedupe(node.members, node.id);
      if (members.changed) {
        node.members = members.ids;
        changes.push('members deduped');
      }
    }

    if (!node.created) {
      node.created = gitFileCreationDate(original.file) ?? fileTimestamp(original.file);
      changes.push('created');
    }
    if (!node.author) {
      node.author = author();
      changes.push('author');
    }

    const typeDef = types[node.type];
    if (typeDef) {
      const filled: string[] = [];
      for (const [name, def] of Object.entries(typeDef.attributes)) {
        if (!(name in node.attributes)) {
          node.attributes[name] = initialValueFor(def);
          filled.push(name);
        } else if (isEmpty(node.attributes[name]) && def.required && def.default !== undefined) {
          node.attributes[name] = def.default;
          filled.push(name);
        }
      }
      if (filled.length) changes.push(`attributes: ${filled.join(', ')}`);
    }

    if (changes.length) {
      node.updated = nowIso();
      writeDocument(board, node);
      actions.push(`${where}: ${changes.join('; ')}`);
    } else if (!node.updated) {
      node.updated = node.created ?? nowIso();
      writeDocument(board, node);
      actions.push(`${where}: updated`);
    }

    if (!isUnassigned(node.id)) {
      const expected = nodeDirName(node.id);
      if (path.basename(node.dir) !== expected) {
        renames.push({ from: node.dir, to: path.join(path.dirname(node.dir), expected) });
      }
    }
  }

  // Deepest first, so renaming a parent carries already-renamed children along.
  renames.sort((a, b) => b.from.split(path.sep).length - a.from.split(path.sep).length);
  for (const { from, to } of renames) {
    if (existsSync(to)) {
      actions.push(`${displayPath(paths, from)}: skipped rename, ${path.basename(to)} exists`);
      continue;
    }
    renameSync(from, to);
    actions.push(`${displayPath(paths, from)}: renamed to ${path.basename(to)}`);
  }
}

/**
 * Repair everything `checkBoard` marks fixable: fill in missing metadata,
 * allocate ids, tidy link lists, rename folders to match, and resync the id
 * counters. Returns a log of what changed. Reload the board afterwards.
 */
export function applyFixes(board: LoadedBoard): string[] {
  // One lock for the whole repair, not one per document. It renames folders,
  // resyncs the id counters and reloads twice; a writer let in between any two
  // of those would be working from a board that is half repaired. Deliberately
  // no `requireUnchanged` here either — this is the tool for a board that is
  // already out of step, and stopping half way through to report that somebody
  // touched a file would leave it worse than it started.
  return boardWrite(board, 'repair the board', () => fixUnderLock(board));
}

function fixUnderLock(board: LoadedBoard): string[] {
  const actions: string[] = [];
  for (const kind of KINDS) fixCollection(board, kind, actions);

  // `.lpm/.gitignore` keeps per-checkout state out of the shared repo. Boards
  // created before `credentials.json` existed are missing the entry; the
  // check reports it and this heals it, exactly as `writeLocal` / `init` do.
  if (ensureLocalIgnored(board.paths)) {
    actions.push(
      `${displayPath(board.paths, path.join(board.paths.lpmDir, '.gitignore'))}: added missing ignore entries`,
    );
  }

  const state = readState(board.paths);
  const next = { ...state };
  for (const kind of KINDS) {
    const prefix = prefixFor(board.config, kind);
    if (!prefix) continue;
    const highest = nodesOf(board, kind).reduce((max, node) => {
      const id = isUnassigned(node.id) ? '' : node.id;
      return Math.max(max, numberOf(id, prefix));
    }, 0);
    const field = counterFor(kind);
    if (next[field] < highest) {
      next[field] = highest;
      actions.push(
        `${displayPath(board.paths, board.paths.statePath)}: ${kind} counter synced to ${highest}`,
      );
    }
  }
  if (KINDS.some((kind) => next[counterFor(kind)] !== state[counterFor(kind)])) {
    writeState(board.paths, next);
  }

  // From disk: the fixes above rewrite ids, titles, folder names and statuses,
  // which is everything the index is made of and everything the roll-up reads.
  // Reloading is the honest way to work from what actually landed, and `--fix`
  // is not the hot path.
  const before = readIndex(board.paths.indexPath);
  const after = loadBoard(board.paths);

  // A container's status is derived from the work inside it, so a board where
  // the last story was closed by hand has features and epics still claiming to
  // be open. Deepest first, so one pass carries a closed story all the way up.
  for (const rollup of writeRollups(after, boardRollups(after))) {
    actions.push(`${at(after, rollup.issue)}: status=${rollup.to} (rolled up from its contents)`);
  }

  // And the same for flags: a container stands in front of stopped work while
  // anything inside it is flagged. Read from a board that already has the
  // statuses above, because closing a container takes its flag off.
  const flagged = loadBoard(board.paths);
  for (const rollup of writeFlagRollups(flagged, boardFlagRollups(flagged))) {
    actions.push(
      `${at(flagged, rollup.issue)}: ${rollup.to ? `flag=${rollup.to} (stopped work inside it)` : 'flag cleared (nothing inside it is stopped)'}`,
    );
  }

  writeBoardIndex(after);
  if (readIndex(board.paths.indexPath) !== before) {
    actions.push(`${displayPath(board.paths, board.paths.indexPath)}: index rewritten`);
  }

  return actions;
}
