import { existsSync } from 'node:fs';
import { normalizeAttributeValue } from '../../model/attributes.js';
import type { BaseNode } from '../../model/types.js';
import { firstHeading } from '../../storage/frontmatter.js';
import { idFromDirName, titleFromDirName } from '../../storage/paths.js';
import { UNASSIGNED_PREFIX } from '../load.js';
import { readString } from './fields.js';
import type { CollectionSpec, LoadContext, RawNode } from './scan.js';
import { scanDir } from './scan.js';

function buildBase(
  raw: RawNode,
  spec: CollectionSpec,
  parentId: string | null,
  derived: string[],
): BaseNode {
  let id = readString(raw.data, 'id');
  if (!id) {
    id = idFromDirName(raw.dirName, spec.prefix);
    if (id) derived.push('id');
  }
  if (!id) {
    id = `${UNASSIGNED_PREFIX}${raw.dir}`;
    derived.push('id');
  }

  let type = readString(raw.data, 'type');
  if (!type) {
    const candidates = spec.hierarchy[raw.depth] ?? [];
    if (candidates.length === 1) {
      type = candidates[0]!;
      derived.push('type');
    } else {
      type = '';
      derived.push('type');
    }
  }

  let title = readString(raw.data, 'title');
  if (!title) {
    title = firstHeading(raw.body) ?? titleFromDirName(raw.dirName, spec.prefix);
    derived.push('title');
  }

  const created = readString(raw.data, 'created');
  if (!created) derived.push('created');
  const author = readString(raw.data, 'author');
  if (!author) derived.push('author');

  const typeDef = type ? spec.types[type] : undefined;
  const attributes: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw.data)) {
    if (spec.reserved.includes(key)) continue;
    const def = typeDef?.attributes[key];
    attributes[key] = def ? normalizeAttributeValue(def, value) : value;
  }

  return {
    kind: spec.kind,
    id,
    type,
    title,
    created: created ?? undefined,
    updated: readString(raw.data, 'updated') ?? undefined,
    author: author ?? undefined,
    attributes,
    body: raw.body,
    dir: raw.dir,
    file: raw.file,
    parentId,
    depth: raw.depth,
  };
}

export function loadCollection<T extends BaseNode>(
  spec: CollectionSpec,
  ctx: LoadContext,
  finish: (base: BaseNode, raw: RawNode, derived: string[]) => T,
): { nodes: T[]; raws: RawNode[] } {
  const raws: RawNode[] = [];
  if (existsSync(spec.root)) scanDir(spec.root, 0, null, spec, ctx, raws);

  const nodes: T[] = [];
  const idByDir = new Map<string, string>();

  // scanDir is pre-order, so a parent is always built before its children.
  for (const raw of raws) {
    const fields: string[] = [];
    const parentId = raw.parentDir ? (idByDir.get(raw.parentDir) ?? null) : null;
    const node = finish(buildBase(raw, spec, parentId, fields), raw, fields);
    idByDir.set(raw.dir, node.id);
    if (fields.length) ctx.derived.set(node.dir, fields);

    const typeDef = spec.types[node.type];
    if (typeDef) {
      const unknown = Object.keys(node.attributes).filter((key) => !typeDef.attributes[key]);
      if (unknown.length) ctx.extras.set(node.dir, unknown);
    }
    nodes.push(node);
  }

  return { nodes, raws };
}

export function buildTree<T extends BaseNode, N extends T & { children: N[] }>(
  nodes: T[],
  raws: RawNode[],
): N[] {
  const byDir = new Map<string, N>();
  for (const node of nodes) byDir.set(node.dir, { ...node, children: [] } as unknown as N);
  const roots: N[] = [];
  for (const raw of raws) {
    const node = byDir.get(raw.dir);
    if (!node) continue;
    const parent = raw.parentDir ? byDir.get(raw.parentDir) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
}

export function indexById<T extends BaseNode>(nodes: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const node of nodes) if (!map.has(node.id)) map.set(node.id, node);
  return map;
}
