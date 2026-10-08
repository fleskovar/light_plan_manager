import { isMap, isScalar } from 'yaml';
import type { Document, Pair, YAMLMap } from 'yaml';
import { BoardError } from '../errors.js';

/**
 * Moving a remote's declaration between `remotes:` and `remotes_off:` in a
 * config.yml document — the edit behind turning a tracker off and on
 * (`operations/remotes-off.ts`) and behind the swap `lpm git setup
 * --turn-off-remotes` / `lpm git off --turn-on-remotes` makes. Pure over the
 * `yaml` document, so it keeps comments and key order; the caller validates
 * and writes the result once.
 */

type Block = 'remotes' | 'remotes_off';

function pairNamed(items: Pair[], name: string): Pair | undefined {
  return items.find((pair) => (isScalar(pair.key) ? pair.key.value : pair.key) === name);
}

/**
 * Move remote declarations from one block of a config document to the other,
 * keeping each one's comments, and drop a block left empty. Pure over the
 * document; the caller writes it (and validates it) once.
 */
export function moveRemoteBlocks(doc: Document, names: string[], from: Block, to: Block): void {
  const root = doc.contents;
  if (!isMap(root)) throw new BoardError('config.yml is not a YAML mapping');
  const source = root.get(from, true);
  const pairs = names.map((name) => {
    const pair = isMap(source) ? pairNamed(source.items as Pair[], name) : undefined;
    if (!pair) throw new BoardError(`config.yml has no remote "${name}" under ${from}:`);
    return pair;
  });
  if (!pairs.length || !isMap(source)) return;

  const existing: unknown = root.get(to, true);
  let target: YAMLMap;
  if (isMap(existing)) {
    target = existing;
  } else {
    target = doc.createNode({}) as YAMLMap;
    root.set(to, target);
  }
  for (const pair of pairs) {
    // `yaml` hangs a comment above the *first* entry of a block on the block
    // itself rather than on that entry's key. Sitting directly above the
    // remote, it is about the remote, so it moves with it.
    if (source.items[0] === pair && source.commentBefore && isScalar(pair.key)) {
      pair.key.commentBefore = [source.commentBefore, pair.key.commentBefore].filter(Boolean).join('\n');
      source.commentBefore = undefined;
    }
    source.items.splice(source.items.indexOf(pair), 1);
    target.items.push(pair);
  }
  if (source.items.length === 0) root.delete(from);
}

