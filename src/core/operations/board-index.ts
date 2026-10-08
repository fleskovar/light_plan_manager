import path from 'node:path';
import type { LoadedBoard } from '../board/load.js';
import { loadBoard } from '../board/load.js';
import type { AnyNode, BaseNode, NodeKind } from '../model/types.js';
import { sameStamp, stampOf, writeFileAtomic } from '../storage/atomic.js';
import { collectionDir, documentFileName } from '../storage/paths.js';

/**
 * `.lpm/INDEX.md`: every document in the board, with its id, its title and a
 * link to its file, nested exactly the way the folders are.
 *
 * A folder is named after its id and nothing else, so a file tree no longer
 * says what anything is. This is where that went — one generated page a person
 * can read (and a host can render) instead of walking the tree. It is derived
 * state, never board truth: `load` never opens it, and deleting it costs
 * nothing but a `lpm check --fix`.
 *
 * It is rewritten by the operations that can change it rather than on demand,
 * so it is correct on disk the moment an operation returns. Rendering takes the
 * board the operation ran against plus the one thing it did, because a reload
 * costs a great deal more than a render does.
 */

/** What an operation just did, so the stale handle it holds can be corrected. */
export interface IndexChange {
  /** The document as the operation left it — or, when removed, as it was. */
  node: AnyNode;
  /** Its folder before the operation, when the operation moved it. */
  from?: string;
  /** The operation deleted it, and everything nested under it. */
  removed?: boolean;
}

interface Entry {
  id: string;
  title: string;
  dir: string;
}

/** Explorer order: `LP-2` before `LP-10`, which plain string order gets wrong. */
const byName = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function entriesOf(nodes: readonly BaseNode[]): Entry[] {
  return nodes.map((node) => ({ id: node.id, title: node.title, dir: node.dir }));
}

/**
 * Correct a collection's entries for an operation the board handle predates.
 * A folder carries its descendants, so a move rewrites their paths too.
 */
function withChange(entries: Entry[], change: IndexChange | undefined, kind: NodeKind): Entry[] {
  if (!change || change.node.kind !== kind) return entries;
  const { node, from, removed } = change;

  if (removed) {
    const inside = node.dir + path.sep;
    return entries.filter((entry) => entry.dir !== node.dir && !entry.dir.startsWith(inside));
  }

  let out = entries;
  if (from !== undefined && from !== node.dir) {
    const inside = from + path.sep;
    out = out.map((entry) =>
      entry.dir === from
        ? { ...entry, dir: node.dir }
        : entry.dir.startsWith(inside)
          ? { ...entry, dir: node.dir + entry.dir.slice(from.length) }
          : entry,
    );
  }

  const fresh: Entry = { id: node.id, title: node.title, dir: node.dir };
  const at = out.findIndex((entry) => entry.id === node.id);
  return at === -1
    ? [...out, fresh]
    : out.map((entry, index) => (index === at ? fresh : entry));
}

/** A title is one line here whatever the frontmatter said, so a row stays a row. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function link(lpmDir: string, dir: string, kind: NodeKind): string {
  const file = path.join(dir, documentFileName(kind));
  return path.relative(lpmDir, file).split(path.sep).join('/');
}

/**
 * One collection as a nested list. Parenting comes from the paths themselves —
 * a folder whose parent is not a document of this collection is drawn at the
 * top, which is the forgiving reading `load` takes of the same tree.
 */
function renderSection(entries: Entry[], root: string, kind: NodeKind, lpmDir: string): string[] {
  const dirs = new Set(entries.map((entry) => entry.dir));
  const children = new Map<string, Entry[]>();
  for (const entry of entries) {
    const parent = path.dirname(entry.dir);
    const under = dirs.has(parent) ? parent : root;
    const siblings = children.get(under);
    if (siblings) siblings.push(entry);
    else children.set(under, [entry]);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => byName.compare(path.basename(a.dir), path.basename(b.dir)));
  }

  const lines: string[] = [];
  const walk = (under: string, depth: number): void => {
    for (const entry of children.get(under) ?? []) {
      const indent = '  '.repeat(depth);
      lines.push(`${indent}- [${entry.id}](${link(lpmDir, entry.dir, kind)}) — ${oneLine(entry.title)}`);
      walk(entry.dir, depth + 1);
    }
  };
  walk(root, 0);
  return lines;
}

const SECTIONS: { kind: NodeKind; heading: string; of: (board: LoadedBoard) => BaseNode[] }[] = [
  { kind: 'issue', heading: 'Issues', of: (board) => board.issues },
  { kind: 'period', heading: 'Timeline', of: (board) => board.periods },
  { kind: 'resource', heading: 'Team', of: (board) => board.resources },
  { kind: 'squad', heading: 'Squads', of: (board) => board.squads },
  { kind: 'template', heading: 'Registry', of: (board) => board.templates },
];

/**
 * The whole index as markdown. Exported so `check` can tell a stale file from a
 * current one without a second idea of what the file should say.
 */
export function renderBoardIndex(board: LoadedBoard, change?: IndexChange): string {
  const { paths } = board;
  const out: string[] = [
    '# Board index',
    '',
    '<!-- Generated by light-plan. Every document in this board, nested as its',
    '     folders are. Rewritten on every change; edits here are overwritten. -->',
  ];

  for (const section of SECTIONS) {
    const entries = withChange(entriesOf(section.of(board)), change, section.kind);
    if (!entries.length) continue;
    const root = collectionDir(paths, section.kind);
    out.push('', `## ${section.heading}`, '');
    out.push(...renderSection(entries, root, section.kind, paths.lpmDir));
  }

  if (out.length === 4) out.push('', 'This board has no documents yet.');
  return out.join('\n') + '\n';
}

/**
 * Whether the index on disk is the one this handle's contents belong to.
 *
 * The incremental render is "these documents, plus the one thing I did", and
 * that is only the whole truth while nobody else has written since. On a shared
 * checkout somebody may have created three issues in between, and rendering
 * from this handle would drop all three — the index is the one file where a
 * lost update costs the *rest* of the board rather than one document.
 */
function indexIsOurs(board: LoadedBoard): boolean {
  const expected = board.stamps.get(board.paths.indexPath);
  const actual = stampOf(board.paths.indexPath);
  if (!expected) return actual === null;
  return actual !== null && sameStamp(expected, actual);
}

/**
 * Rewrite `.lpm/INDEX.md`. Call it after any write that adds, removes, moves or
 * renames.
 *
 * Normally this renders from the board handle the operation ran against plus
 * the one change it made, because a reload costs a great deal more than a render
 * (~450ms against ~1ms) and the handle is right about everything else. When
 * another process has rewritten the index since that handle was loaded, the
 * cheap path would publish a table of contents missing their work, so this falls
 * back to reading the board — including this operation's own write, which is
 * already on disk by the time it is called, which is why the change is dropped
 * on that path rather than applied twice.
 */
export function writeBoardIndex(board: LoadedBoard, change?: IndexChange): void {
  const { indexPath } = board.paths;
  const [source, applied] = indexIsOurs(board)
    ? [board, change]
    : [loadBoard(board.paths, board.cache ? { cache: board.cache } : undefined), undefined];

  writeFileAtomic(indexPath, renderBoardIndex(source, applied));

  // So a second write in the same operation still takes the cheap path.
  const stamp = stampOf(indexPath);
  if (stamp) board.stamps.set(indexPath, stamp);
}
