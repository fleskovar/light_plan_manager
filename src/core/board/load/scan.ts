import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { hierarchyFor, prefixFor, typesFor } from '../../config/lookup.js';
import type { BoardConfig, NodeKind, Problem, TypeDef } from '../../model/types.js';
import { reservedFieldsFor } from '../../model/types.js';
import type { DocStamp } from '../../storage/atomic.js';
import { stampOf } from '../../storage/atomic.js';
import { parseFrontmatter } from '../../storage/frontmatter.js';
import type { BoardPaths } from '../../storage/paths.js';
import { collectionDir, displayPath, documentFileName } from '../../storage/paths.js';
import type { DocumentCache } from './cache.js';

/** Everything needed to read one collection of documents off the filesystem. */
export interface CollectionSpec {
  kind: NodeKind;
  root: string;
  fileName: string;
  prefix: string;
  types: Record<string, TypeDef>;
  hierarchy: string[][];
  reserved: readonly string[];
}

export function specFor(paths: BoardPaths, config: BoardConfig, kind: NodeKind): CollectionSpec {
  return {
    kind,
    root: collectionDir(paths, kind),
    fileName: documentFileName(kind),
    prefix: prefixFor(config, kind),
    types: typesFor(config, kind),
    hierarchy: hierarchyFor(config, kind),
    reserved: reservedFieldsFor(kind),
  };
}

export interface RawNode {
  dir: string;
  dirName: string;
  file: string;
  depth: number;
  parentDir: string | null;
  data: Record<string, unknown>;
  body: string;
}

export interface LoadContext {
  paths: BoardPaths;
  config: BoardConfig;
  problems: Problem[];
  derived: Map<string, string[]>;
  extras: Map<string, string[]>;
  /**
   * Document file -> its identity when this load read it, so an operation can
   * refuse to write over a change it never saw.
   * @see src/core/operations/shared.ts `requireUnchanged`
   */
  stamps: Map<string, DocStamp>;
  cache?: DocumentCache;
}

export function scanDir(
  dir: string,
  depth: number,
  parentDir: string | null,
  spec: CollectionSpec,
  ctx: LoadContext,
  raws: RawNode[],
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    ctx.problems.push({
      level: 'error',
      path: displayPath(ctx.paths, dir),
      message: `cannot read folder: ${(error as Error).message}`,
    });
    return;
  }

  const folders = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of folders) {
    const nodeDir = path.join(dir, entry.name);
    const file = path.join(nodeDir, spec.fileName);

    // Taken *before* the read, deliberately. A write landing between the two
    // leaves a stamp that looks older than the content we hold, so a later write
    // through this handle is refused — which is the safe way round. The other
    // order would let a lost update through.
    const stamp = stampOf(file);
    if (stamp) ctx.stamps.set(file, stamp);

    let parsed;
    const cached = ctx.cache?.get(file);
    if (cached) {
      parsed = { data: cached.data, body: cached.body, hadFrontmatter: true };
    } else {
      let raw: string;
      try {
        raw = readFileSync(file, 'utf8');
      } catch {
        ctx.problems.push({
          level: 'error',
          path: displayPath(ctx.paths, nodeDir),
          message: `folder has no ${spec.fileName}; every folder here must be a ${spec.kind}`,
        });
        continue;
      }

      try {
        parsed = parseFrontmatter(raw);
      } catch (error) {
        ctx.problems.push({
          level: 'error',
          path: displayPath(ctx.paths, file),
          message: `invalid YAML frontmatter: ${(error as Error).message}`,
        });
        continue;
      }

      ctx.cache?.set(file, { data: parsed.data, body: parsed.body });
    }

    raws.push({
      dir: nodeDir,
      dirName: entry.name,
      file,
      depth,
      parentDir,
      data: parsed.data,
      body: parsed.body,
    });
    scanDir(nodeDir, depth + 1, nodeDir, spec, ctx, raws);
  }
}
