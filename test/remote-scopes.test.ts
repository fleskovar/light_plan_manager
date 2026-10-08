import { afterAll, describe, expect, it } from 'vitest';
import { createIssue } from '../src/core/index.js';
import { checkBoard } from '../src/core/index.js';
import {
  declaredScopes,
  scopeOverlaps,
  staleScopes,
} from '../src/core/board/remote-scopes.js';
import type { Issue } from '../src/core/model/types.js';
import { addRemote } from '../src/remote/index.js';
import { BoardError } from '../src/core/errors.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

/**
 * Two remotes may never claim the same document. `config/schema.ts` refuses
 * the half it can answer from the config alone (an equal scope, or a remote
 * claiming the whole board beside any other); this covers the half that needs
 * the board tree — one scope *nested* inside another — in all three places it
 * is enforced: the pure rule, `lpm check`, and `lpm remote add`.
 */

afterAll(cleanupBoards);

/** A tree of bare issue shapes, enough for the ancestry walk. */
function tree(...rows: Array<[id: string, parentId: string | null]>): Issue[] {
  return rows.map(([id, parentId]) => ({ id, parentId }) as unknown as Issue);
}

describe('scopeOverlaps', () => {
  const issues = tree(['LP-1', null], ['LP-2', 'LP-1'], ['LP-3', 'LP-2'], ['LP-4', 'LP-1']);

  it('reports a scope nested inside another, naming which contains which', () => {
    const overlaps = scopeOverlaps(issues, [
      { name: 'outer', scope: 'LP-1' },
      { name: 'inner', scope: 'LP-3' },
    ]);
    expect(overlaps).toEqual([
      { outer: 'outer', inner: 'inner', outerScope: 'LP-1', innerScope: 'LP-3' },
    ]);
  });

  it('reports it whichever order the two were declared in', () => {
    const overlaps = scopeOverlaps(issues, [
      { name: 'inner', scope: 'LP-3' },
      { name: 'outer', scope: 'LP-1' },
    ]);
    expect(overlaps).toEqual([
      { outer: 'outer', inner: 'inner', outerScope: 'LP-1', innerScope: 'LP-3' },
    ]);
  });

  it('leaves two sibling subtrees alone — they share no document', () => {
    expect(
      scopeOverlaps(issues, [
        { name: 'a', scope: 'LP-2' },
        { name: 'b', scope: 'LP-4' },
      ]),
    ).toEqual([]);
  });

  it('leaves an equal scope to the config check rather than saying it twice', () => {
    expect(
      scopeOverlaps(issues, [
        { name: 'a', scope: 'LP-2' },
        { name: 'b', scope: 'LP-2' },
      ]),
    ).toEqual([]);
  });

  it('ignores a scope naming no document — it claims nothing to overlap', () => {
    expect(
      scopeOverlaps(issues, [
        { name: 'a', scope: 'LP-1' },
        { name: 'gone', scope: 'LP-99' },
      ]),
    ).toEqual([]);
  });

  it('terminates on a parent cycle rather than hanging the check that reports it', () => {
    const looped = tree(['LP-1', 'LP-2'], ['LP-2', 'LP-1']);
    expect(() =>
      scopeOverlaps(looped, [
        { name: 'a', scope: 'LP-1' },
        { name: 'b', scope: 'LP-2' },
      ]),
    ).not.toThrow();
  });
});

describe('staleScopes', () => {
  it('names a scope the board does not have, so an empty sync is explained', () => {
    const issues = tree(['LP-1', null]);
    expect(staleScopes(issues, [{ name: 'gone', scope: 'LP-9' }])).toEqual([
      { name: 'gone', scope: 'LP-9' },
    ]);
    expect(staleScopes(issues, [{ name: 'whole', scope: undefined }])).toEqual([]);
  });
});

describe('declaredScopes', () => {
  it('reads the remotes block in declaration order', () => {
    expect(declaredScopes({ a: { scope: 'LP-1' }, b: {} })).toEqual([
      { name: 'a', scope: 'LP-1' },
      { name: 'b', scope: undefined },
    ]);
  });
});

describe('addRemote scope guard', () => {
  /** A board with LP-1 > LP-2 > LP-3, plus LP-4 beside LP-2. */
  function nestedBoard() {
    const paths = makeBoard();
    createIssue(reload(paths), { type: 'program', title: 'Platform' });
    createIssue(reload(paths), { type: 'epic', title: 'Payments', parentId: 'LP-1' });
    createIssue(reload(paths), { type: 'feature', title: 'Checkout', parentId: 'LP-2' });
    createIssue(reload(paths), { type: 'epic', title: 'Billing', parentId: 'LP-1' });
    return paths;
  }

  it('refuses a scope inside a scope another remote already mirrors', () => {
    const paths = nestedBoard();
    addRemote(paths, { name: 'first', provider: 'jsonfile', connection: {}, scope: 'LP-2' });

    let error: BoardError | undefined;
    try {
      addRemote(paths, { name: 'second', provider: 'jsonfile', connection: {}, scope: 'LP-3' });
    } catch (caught) {
      error = caught as BoardError;
    }
    expect(error).toBeInstanceOf(BoardError);
    expect(error!.message).toContain('overlaps a remote that already exists');
    expect(error!.details.join('\n')).toContain('LP-3 is inside "first"\'s scope (LP-2)');

    // Nothing was written: the refused remote is not in the config.
    expect(reload(paths).config.remotes['second']).toBeUndefined();
  });

  it('refuses a scope that would swallow a remote already inside it', () => {
    const paths = nestedBoard();
    addRemote(paths, { name: 'inner', provider: 'jsonfile', connection: {}, scope: 'LP-3' });
    expect(() =>
      addRemote(paths, { name: 'outer', provider: 'jsonfile', connection: {}, scope: 'LP-1' }),
    ).toThrow(/overlaps a remote that already exists/);
  });

  it('allows two remotes on sibling subtrees', () => {
    const paths = nestedBoard();
    addRemote(paths, { name: 'left', provider: 'jsonfile', connection: {}, scope: 'LP-2' });
    addRemote(paths, { name: 'right', provider: 'jsonfile', connection: {}, scope: 'LP-4' });
    expect(Object.keys(reload(paths).config.remotes).sort()).toEqual(['left', 'right']);
  });
});

describe('checkRemoteScopes', () => {
  it('reports an overlap a reparent created, as an error nobody can auto-fix', () => {
    const paths = makeBoard();
    createIssue(reload(paths), { type: 'program', title: 'Platform' });
    createIssue(reload(paths), { type: 'epic', title: 'Payments', parentId: 'LP-1' });
    createIssue(reload(paths), { type: 'feature', title: 'Checkout', parentId: 'LP-2' });

    // Declared one at a time, each legal when it was written; the overlap is
    // what a later reparent (or a merge of two branches) leaves behind, so it
    // is written straight into the config here.
    addRemote(paths, { name: 'wide', provider: 'jsonfile', connection: {}, scope: 'LP-1' });
    const board = reload(paths);
    board.config.remotes['narrow'] = {
      ...board.config.remotes['wide']!,
      scope: 'LP-3',
    };

    const overlap = checkBoard(board).find((problem) =>
      problem.message.includes('may not mirror the same work'),
    );
    expect(overlap).toBeDefined();
    expect(overlap!.level).toBe('error');
    expect(overlap!.fixable).toBeUndefined();
    expect(overlap!.message).toContain('"narrow" (scope LP-3) is inside "wide" (scope LP-1)');
  });

  it('warns about a scope that names nothing, rather than reporting an empty sync later', () => {
    const paths = makeBoard();
    createIssue(reload(paths), { type: 'program', title: 'Platform' });
    addRemote(paths, { name: 'gone', provider: 'jsonfile', connection: {}, scope: 'LP-1' });

    const board = reload(paths);
    board.config.remotes['gone']!.scope = 'LP-404';

    const stale = checkBoard(board).find((problem) => problem.message.includes('names no document'));
    expect(stale).toBeDefined();
    expect(stale!.level).toBe('warn');
    expect(stale!.message).toContain('remotes.gone.scope');
  });
});
