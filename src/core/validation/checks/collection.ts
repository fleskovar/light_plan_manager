import path from 'node:path';
import type { LoadedBoard } from '../../board/load.js';
import { isUnassigned } from '../../board/load.js';
import { nodesOf } from '../../board/query.js';
import { prefixFor, typesAtDepth } from '../../config/lookup.js';
import { isEmpty, validateAttributeValue } from '../../model/attributes.js';
import type { NodeKind, Problem } from '../../model/types.js';
import { holdsPlaceholder } from '../../../shared/template-params.js';
import { displayPath, nodeDirName } from '../../storage/paths.js';
import { numberOf } from '../../storage/state.js';
import { RETIRED_LINK_FIELD, allNodes, at, typesOf } from '../shared.js';

/** Checks that apply to issues and periods alike. */
export function checkCollection(
  board: LoadedBoard,
  kind: NodeKind,
  problems: Problem[],
): void {
  const nodes = nodesOf(board, kind);
  const prefix = prefixFor(board.config, kind);
  const types = typesOf(board, kind);

  const idCounts = new Map<string, number>();
  for (const node of allNodes(board)) {
    if (isUnassigned(node.id)) continue;
    idCounts.set(node.id, (idCounts.get(node.id) ?? 0) + 1);
  }

  for (const node of nodes) {
    const where = at(board, node);
    const derived = board.derived.get(node.dir) ?? [];

    if (isUnassigned(node.id)) {
      problems.push({ level: 'error', path: where, message: 'missing id', fixable: true });
    } else {
      if ((idCounts.get(node.id) ?? 0) > 1) {
        problems.push({
          level: 'error',
          path: where,
          message: `duplicate id "${node.id}"; assign a unique id by hand`,
        });
      }
      if (numberOf(node.id, prefix) === 0) {
        problems.push({
          level: 'warn',
          path: where,
          message: `id "${node.id}" does not match the ${kind} prefix "${prefix}-<n>"`,
        });
      }
      if (derived.includes('id')) {
        problems.push({
          level: 'warn',
          path: where,
          message: 'id is missing from frontmatter (taken from the folder name)',
          fixable: true,
        });
      }
    }

    const allowedTypes = typesAtDepth(board.config, kind, node.depth);
    if (!node.type) {
      problems.push({
        level: 'error',
        path: where,
        message:
          allowedTypes.length === 1
            ? 'missing type'
            : `missing type; at this level it must be one of [${allowedTypes.join(', ')}]`,
        fixable: allowedTypes.length === 1,
      });
    } else if (!types[node.type]) {
      problems.push({ level: 'error', path: where, message: `unknown ${kind} type "${node.type}"` });
    } else if (!allowedTypes.includes(node.type)) {
      problems.push({
        level: 'error',
        path: where,
        message: `invalid parenting: "${node.type}" cannot sit at level ${node.depth}, which allows [${allowedTypes.join(', ')}]`,
      });
    } else if (derived.includes('type')) {
      problems.push({
        level: 'warn',
        path: where,
        message: 'type is missing from frontmatter (inferred from folder depth)',
        fixable: true,
      });
    }

    if (derived.includes('title')) {
      problems.push({
        level: 'warn',
        path: where,
        message: 'missing title (derived from the folder name)',
        fixable: true,
      });
    }
    for (const field of ['created', 'author'] as const) {
      if (derived.includes(field)) {
        problems.push({ level: 'warn', path: where, message: `missing ${field}`, fixable: true });
      }
    }

    const typeDef = types[node.type];
    if (typeDef) {
      for (const [name, def] of Object.entries(typeDef.attributes)) {
        if (!(name in node.attributes)) {
          problems.push({
            level: 'warn',
            path: where,
            message: `missing attribute "${name}"`,
            fixable: true,
          });
          continue;
        }
        const value = node.attributes[name];
        // A template's attributes are declared by the issue type it produces,
        // so one still waiting for a parameter sits in a field of the wrong
        // type until it is filled in. @see holdsPlaceholder
        if (kind === 'template' && holdsPlaceholder(value)) continue;
        if (isEmpty(value)) {
          if (def.required) {
            problems.push({
              level: 'error',
              path: where,
              message: `required attribute "${name}" is empty`,
              fixable: def.default !== undefined,
            });
          }
          continue;
        }
        const problem = validateAttributeValue(def, value);
        if (problem) {
          problems.push({ level: 'error', path: where, message: `attribute "${name}": ${problem}` });
        }
      }
      for (const name of board.extras.get(node.dir) ?? []) {
        // `checkIssues` owns the retired link field and says what to do about
        // it; reporting it here as well would bury that under the generic one.
        if (name === RETIRED_LINK_FIELD) continue;
        problems.push({
          level: 'warn',
          path: where,
          message: `"${name}" is not declared for type "${node.type}"`,
        });
      }
    }

    if (!isUnassigned(node.id)) {
      const expected = nodeDirName(node.id);
      if (path.basename(node.dir) !== expected) {
        problems.push({
          level: 'warn',
          path: displayPath(board.paths, node.dir),
          message: `folder name should be "${expected}"`,
          fixable: true,
        });
      }
    }
  }
}
