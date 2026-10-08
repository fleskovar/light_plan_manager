/**
 * The JSON-file tracker's storage — a single JSON document holding a flat list
 * of issues, exactly what a "tracker" backed by a local file looks like.
 *
 * This is the *only* I/O surface the connector and the conformance test double
 * share. It is deliberately tiny and deliberately boring: a file is the whole
 * tracker, there is no schema to migrate beyond `version`, and a write is a
 * whole-file rewrite (a demo tracker does not need a journal).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** One user comment, as the file holds it. */
export interface JsonComment {
  id: number;
  body: string;
  author: string;
  created_at: string;
}

/**
 * One issue, in the file's flat shape. Everything the board distinguishes has
 * a *native* home here — `type` and `status` are real fields, `depends_on` a
 * real edge list — which is the point of the provider: it exercises the
 * degradation ladder's rung 1, which no shipped platform does.
 */
export interface JsonIssue {
  /** The remote id, a per-file monotonic number. */
  number: number;
  title: string;
  body: string;
  /** Native status name, e.g. `Done` — the mapping's `statuses.*.remote`. */
  status: string;
  /** Native type name, e.g. `story` — the mapping's `types.*.type`. */
  type: string;
  /** Human and attribute labels; the sync reconciles its claimed ones only. */
  labels: string[];
  /** Native assignee account, or null when unassigned. */
  assignee: string | null;
  /** Native dependency edges — the remote issue numbers this one waits on. */
  depends_on: number[];
  comments: JsonComment[];
  created_at: string;
  updated_at: string;
}

/** The whole store: a version, the issues, and the next issue number. */
export interface JsonStore {
  version: 1;
  issues: JsonIssue[];
  next_number: number;
}

/** The store before anything has been filed. */
export function emptyJsonStore(): JsonStore {
  return { version: 1, issues: [], next_number: 1 };
}

/**
 * Read the store. A missing file is a valid empty store — the first sync
 * creates it. A file that cannot be parsed is thrown, not repaired: a corrupt
 * tracker should fail loudly, the same rule the link store applies.
 */
export function readJsonStore(file: string): JsonStore {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyJsonStore();
    throw error;
  }
  return JSON.parse(raw) as JsonStore;
}

/** Write the store, creating the containing directory when it does not exist. */
export function writeJsonStore(file: string, store: JsonStore): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

/** The next comment id, derived rather than stored so the file stays minimal. */
export function nextCommentId(store: JsonStore): number {
  let max = 0;
  for (const issue of store.issues) {
    for (const comment of issue.comments) if (comment.id > max) max = comment.id;
  }
  return max + 1;
}
