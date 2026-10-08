import path from 'node:path';
import type { LoadedBoard } from '../board/load.js';
import { isActiveStatus, isGenericType, isTerminalStatus, typesFor } from '../config/lookup.js';
import type { AnyNode, Issue, NodeKind } from '../model/types.js';
import { flagLabel } from '../model/types.js';
import type { Comment } from '../storage/comments.js';
import { readComments } from '../storage/comments.js';
import { displayPath } from '../storage/paths.js';
import { HELPER_NAMES } from './template.js';

/**
 * What a context template can see.
 *
 * One shape for all three collections, because a template author should not
 * have to learn three. Every document is a `NodeView`; the relations between
 * them are `NodeView`s too, so `<%= issue.parent.title %>` and
 * `<% for (const c of issue.children) { %>` work the same way everywhere.
 *
 * The views are built once and then wired to each other, which is what makes
 * `view.parent.children` cheap and cycle-free — nothing is computed while a
 * template runs.
 */
/** One attribute of a document, ready to print. */
export interface AttributeView {
  name: string;
  /** `story_points` -> `Story points`. */
  label: string;
  value: unknown;
  /** The declared attribute type, or `unknown` for a key the config never named. */
  type: string;
  description: string;
}

export interface NodeView {
  id: string;
  kind: NodeKind;
  /** Type name as the config spells it, e.g. `user_story`. */
  type: string;
  /** The type's human label, e.g. `User Story`. */
  type_label: string;
  title: string;
  body: string;
  /** Config-declared attributes plus any extra frontmatter keys. */
  attributes: Record<string, unknown>;
  /**
   * The same attributes as a list, in the order the config declares them, with
   * the labels a person would read. `<% for %>` walks lists, not maps, so this
   * is how a template that does not know the board's attribute names can still
   * print them.
   */
  attribute_list: AttributeView[];
  created: string;
  updated: string;
  author: string;
  /** The document's folder, relative to the project root. */
  path: string;
  depth: number;

  parent: NodeView | null;
  /** Every ancestor, outermost first. */
  ancestors: NodeView[];
  children: NodeView[];
  /** Every descendant, parents before their children. */
  descendants: NodeView[];
  /** Documents with the same parent, this one excluded. */
  siblings: NodeView[];

  /** Issues only; empty elsewhere. */
  status: string;
  status_label: string;
  done: boolean;
  active: boolean;
  /**
   * Why work on this issue has stopped: `blocked`, `paused`, `help`, or an
   * empty string when it has not. Empty rather than null so `<% if (issue.flag)
   * %>` reads the way an author expects.
   */
  flag: string;
  /** `Blocked`, `Paused`, `Needs help` — the flag as a person reads it. */
  flag_label: string;
  blocked_by: NodeView[];
  blocks: NodeView[];
  relates_to: NodeView[];
  /**
   * Files this issue names: the requirement it came from, the source that has
   * to change. Plain strings exactly as they were written — a path from the
   * project root, sometimes with a line range — never resolved or checked, so
   * a template prints them and the reader opens them.
   */
  related_files: string[];
  period: NodeView | null;
  assignee: NodeView | null;

  /** Periods only. */
  starts: string;
  ends: string;

  /** Resources only. */
  capacity: number | null;
  generic: boolean;
  covers: NodeView[];

  /**
   * The work log. Read on demand and only for the document a brief is about —
   * every other view carries an empty list, because opening a `_comments.md`
   * for the whole ancestry to render one heading is not worth the reads.
   */
  comments: Comment[];

  /** Marks the one document the brief was asked for. */
  is_target: boolean;

  /** `issue.epic` — the nearest ancestor of that type, or this node itself. */
  [typeName: string]: unknown;
}

/**
 * Everything a context template is rendered against.
 *
 * The issue is `issue`, not `this`: Eta puts the data in scope with `with`,
 * which rebinds *identifiers* and not the `this` keyword — so a `this` here
 * would be shadowed by the engine's own and unreachable. `analyze.ts` refuses
 * `this` in a template for the same reason, which turns the habit into an
 * error message rather than a mystery.
 */
export interface InstructionContext extends Record<string, unknown> {
  issue: NodeView;
  board: { name: string; key_prefix: string; statuses: string[] };
  today: string;
  parent: NodeView | null;
  ancestors: NodeView[];
  children: NodeView[];
  descendants: NodeView[];
  siblings: NodeView[];
  blocked_by: NodeView[];
  blocks: NodeView[];
  relates_to: NodeView[];
  /**
   * The files this issue names, and the files everything it depends on named.
   * Two lists rather than one merged one: what the work before this touched is
   * where a reader looks for how it was done, and conflating that with "what
   * this issue is about" would bury the second in the first.
   */
  related_files: string[];
  upstream_files: FileTrail[];
  period: NodeView | null;
  assignee: NodeView | null;
  comments: Comment[];
}

/** One upstream issue and the files it named. */
export interface FileTrail {
  issue: NodeView;
  files: string[];
}

/**
 * Root keys a board type name may never take over — the fixed vocabulary, plus
 * the helper functions, which are merged into the same scope at render time.
 */
const RESERVED_ROOT_KEYS = new Set([
  ...HELPER_NAMES,
  'issue',
  'it',
  'board',
  'today',
  'parent',
  'ancestors',
  'children',
  'descendants',
  'siblings',
  'blocked_by',
  'blocks',
  'relates_to',
  'related_files',
  'upstream_files',
  'period',
  'assignee',
  'comments',
  'loop',
]);

function labelOf(board: LoadedBoard, node: AnyNode): string {
  return typesFor(board.config, node.kind)[node.type]?.label ?? node.type;
}

function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
}

/**
 * Declared attributes first, in config order, then keys somebody added by hand.
 * Empty values are dropped: a brief listing eight blank fields teaches nothing.
 */
function attributeViews(board: LoadedBoard, node: AnyNode): AttributeView[] {
  const declared = typesFor(board.config, node.kind)[node.type]?.attributes ?? {};
  const names = [
    ...Object.keys(declared),
    ...Object.keys(node.attributes).filter((name) => !declared[name]),
  ];
  return names
    .filter((name) => {
      const value = node.attributes[name];
      return value !== undefined && value !== null && value !== '' &&
        !(Array.isArray(value) && value.length === 0);
    })
    .map((name) => ({
      name,
      label: humanize(name),
      value: node.attributes[name],
      type: declared[name]?.type ?? 'unknown',
      description: declared[name]?.description ?? '',
    }));
}

function baseView(board: LoadedBoard, node: AnyNode): NodeView {
  const issue = node.kind === 'issue' ? node : null;
  const status = issue?.status ?? '';
  return {
    id: node.id,
    kind: node.kind,
    type: node.type,
    type_label: labelOf(board, node),
    title: node.title,
    body: node.body.trim(),
    attributes: node.attributes,
    attribute_list: attributeViews(board, node),
    created: node.created ?? '',
    updated: node.updated ?? '',
    author: node.author ?? '',
    path: displayPath(board.paths, node.dir),
    depth: node.depth,

    parent: null,
    ancestors: [],
    children: [],
    descendants: [],
    siblings: [],

    status,
    status_label: board.config.statuses.find((entry) => entry.id === status)?.label ?? status,
    done: Boolean(issue) && isTerminalStatus(board.config, status),
    active: Boolean(issue) && isActiveStatus(board.config, status),
    flag: issue?.flag ?? '',
    flag_label: issue?.flag ? flagLabel(issue.flag) : '',
    blocked_by: [],
    blocks: [],
    relates_to: [],
    related_files: issue?.related_files ?? [],
    period: null,
    assignee: null,

    starts: node.kind === 'period' ? (node.starts ?? '') : '',
    ends: node.kind === 'period' ? (node.ends ?? '') : '',

    capacity: node.kind === 'resource' ? node.capacity : null,
    generic: node.kind === 'resource' && isGenericType(board.config, node.type),
    covers: [],

    comments: [],
    is_target: false,
  };
}

/** Views for every document on the board, wired to each other. */
function buildViews(board: LoadedBoard): Map<string, NodeView> {
  // Loading is forgiving, so two documents can carry the same id; `check`
  // reports that, and here the first one wins, exactly as `board.byId` does.
  // Wiring the second as well would give one view two parents and push it into
  // its children's lists twice.
  const views = new Map<string, NodeView>();
  const all: AnyNode[] = [];
  for (const node of [...board.issues, ...board.periods, ...board.resources]) {
    if (views.has(node.id)) continue;
    views.set(node.id, baseView(board, node));
    all.push(node);
  }

  const view = (id: string | null | undefined): NodeView | null =>
    (id ? (views.get(id) ?? null) : null);
  const list = (ids: readonly string[]): NodeView[] =>
    ids.map((id) => views.get(id)).filter((entry): entry is NodeView => Boolean(entry));

  for (const node of all) {
    const self = views.get(node.id)!;

    self.parent = view(node.parentId);
    if (node.kind === 'issue') {
      self.blocked_by = list(node.depends_on);
      self.blocks = list(board.dependents.get(node.id) ?? []);
      self.relates_to = list(node.relates_to);
      self.period = view(node.period);
      self.assignee = view(node.assignee);
    }
    if (node.kind === 'resource') self.covers = list(node.covers);
  }

  // Parents are built before their children (documents come out of `load.ts`
  // in folder order), so one pass up the chain is enough.
  for (const node of all) {
    const self = views.get(node.id)!;
    const parent = self.parent;
    if (!parent) continue;
    self.ancestors = [...parent.ancestors, parent];
    parent.children.push(self);
  }

  for (const self of views.values()) {
    self.siblings = (self.parent?.children ?? []).filter((other) => other !== self);
    for (const ancestor of self.ancestors) ancestor.descendants.push(self);

    // `{{ epic.title }}` on a story: the nearest ancestor of that type, or the
    // node itself when it *is* one. A type whose name collides with a field of
    // this view keeps the field — the type is still reachable at the root.
    for (const relative of [self, ...[...self.ancestors].reverse()]) {
      if (relative.type && !(relative.type in self)) self[relative.type] = relative;
    }
  }

  return views;
}

export interface ContextOptions {
  /** Today as YYYY-MM-DD. Injectable so a brief is testable. */
  today?: string;
  /** Read the target's `_comments.md`. On by default. */
  includeComments?: boolean;
}

/**
 * The data one issue's brief is rendered against.
 *
 * Read-only and derived entirely from the board plus the config, exactly like
 * `board/tasks.ts` — assembling context is reporting, not planning.
 */
export function buildContext(
  board: LoadedBoard,
  issue: Issue,
  options: ContextOptions = {},
): InstructionContext {
  const views = buildViews(board);
  const target = views.get(issue.id) ?? baseView(board, issue);
  target.is_target = true;
  if (options.includeComments !== false) target.comments = readComments(issue.dir);

  const context: InstructionContext = {
    issue: target,
    board: {
      name: path.basename(board.paths.root),
      key_prefix: board.config.key_prefix,
      statuses: board.config.statuses.map((status) => status.id),
    },
    today: options.today ?? new Date().toISOString().slice(0, 10),
    parent: target.parent,
    ancestors: target.ancestors,
    children: target.children,
    descendants: target.descendants,
    siblings: target.siblings,
    blocked_by: target.blocked_by,
    blocks: target.blocks,
    relates_to: target.relates_to,
    related_files: target.related_files,
    // The work this one comes after, and what it touched. Only issues that
    // named a file appear: an empty entry would be a heading with nothing
    // under it in every brief on a board that does not use the field.
    upstream_files: target.blocked_by
      .filter((view) => view.related_files.length)
      .map((view) => ({ issue: view, files: view.related_files })),
    period: target.period,
    assignee: target.assignee,
    comments: target.comments,
  };

  // Every issue type on the board, so a template can name one that this issue
  // does not happen to have an ancestor of and get nothing rather than a
  // warning — `<% if (epic) { %>` is how a shared template stays honest.
  for (const type of Object.keys(board.config.issue_types)) {
    if (RESERVED_ROOT_KEYS.has(type)) continue;
    const found = [target, ...[...target.ancestors].reverse()].find(
      (view) => view.type === type,
    );
    context[type] = found ?? null;
  }

  return context;
}
