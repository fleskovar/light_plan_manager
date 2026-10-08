import { statSync } from 'node:fs';
import { typesFor } from '../config/lookup.js';
import type { AnyNode, BoardConfig } from '../model/types.js';
import { writeFileAtomic } from './atomic.js';
import { stringifyFrontmatter } from './frontmatter.js';

/**
 * Render a document to markdown. Frontmatter key order is stable: reserved
 * fields first, then attributes in the order the config declares them, then any
 * extra keys the user added by hand (preserved rather than dropped).
 */
export function serializeNode(node: AnyNode, config: BoardConfig): string {
  const data: Record<string, unknown> = { id: node.id };
  // An unresolved type is left out rather than written as an empty string, so
  // `check` keeps reporting it instead of the file gaining a bogus value.
  if (node.type) data.type = node.type;
  data.title = node.title;

  if (node.kind === 'issue') {
    data.status = node.status;
    data.assignee = node.assignee;
    data.period = node.period;
    // Only written once somebody has raised one. An absent key is the ordinary
    // case, and `flag: null` on every issue on the board would bury the few
    // that are actually asking for something.
    if (node.flag) data.flag = node.flag;
    data.depends_on = node.depends_on;
    data.relates_to = node.relates_to;
    data.related_files = node.related_files;
  } else if (node.kind === 'period') {
    if (node.starts !== undefined) data.starts = node.starts;
    if (node.ends !== undefined) data.ends = node.ends;
    // Only written once somebody has held the switch: an absent key is what
    // says "the dates decide", and writing `active: null` would blur that.
    if (node.active !== undefined) data.active = node.active;
    data.squad = node.squad;
  } else if (node.kind === 'resource') {
    data.capacity = node.capacity;
    data.covers = node.covers;
  } else if (node.kind === 'template') {
    data.description = node.description;
    // Only a root declares parameters, and only when it has any: `params: {}`
    // on every folder in the registry would bury the templates that ask for
    // something. @see src/shared/template-params.ts
    if (Object.keys(node.params).length) data.params = node.params;
    data.depends_on = node.depends_on;
    data.relates_to = node.relates_to;
    data.related_files = node.related_files;
  } else {
    data.members = node.members;
  }

  if (node.created) data.created = node.created;
  if (node.updated) data.updated = node.updated;
  if (node.author) data.author = node.author;

  const types = typesFor(config, node.kind);
  const declared = Object.keys(types[node.type]?.attributes ?? {});
  for (const key of declared) {
    if (key in node.attributes) data[key] = node.attributes[key];
  }
  for (const [key, value] of Object.entries(node.attributes)) {
    if (!declared.includes(key)) data[key] = value;
  }

  return stringifyFrontmatter(data, node.body);
}

/**
 * Write a document. Atomically, because another process may be reading this
 * very file: half a YAML frontmatter block reads as a corrupt board, and a
 * board is read far more often than it is written.
 */
export function writeNode(node: AnyNode, config: BoardConfig): void {
  writeFileAtomic(node.file, serializeNode(node, config));
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** File mtime, used as a last-resort `created` timestamp. */
export function fileTimestamp(file: string): string {
  try {
    const stats = statSync(file);
    return (stats.birthtimeMs > 0 ? stats.birthtime : stats.mtime).toISOString();
  } catch {
    return new Date().toISOString();
  }
}
