import { afterAll, describe, expect, it } from 'vitest';
import { createIssue, loadConfig, type BoardConfig } from '../src/core/index.js';
import { saveLinkStore, type LinkEntry, type LinkStore } from '../src/remote/links.js';
import {
  buildLedger,
  conflicts,
  idsOwnedElsewhere,
  otherOwner,
  ownerOf,
  requireUnclaimed,
} from '../src/remote/ledger.js';
import { planPush, type RemoteSnapshot } from '../src/remote/plan.js';
import type { BoardView } from '../src/shared/index.js';
import { toSnapshot } from '../src/sync/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';
import { readFileSync, writeFileSync } from 'node:fs';
import type { BoardPaths } from '../src/core/storage/paths.js';
import type { LoadedBoard } from '../src/core/board/load.js';

afterAll(cleanupBoards);

/**
 * The ledger: one document, one remote.
 *
 * A board may mirror onto several trackers, and before this nothing stopped one
 * document being filed onto two of them — after which a status moved on one
 * side, the other kept its own, and the next sync of each wrote a different
 * truth onto the same document. The rule is derived from the link stores
 * themselves rather than kept in a file beside them, so there is no second copy
 * to disagree after a merge.
 */

/** A board declaring two remotes, whose scopes divide it between them. */
function twoRemoteBoard(): { paths: BoardPaths; config: BoardConfig; left: string; right: string } {
  const paths = makeBoard('scrum', 'LP');
  const left = createIssue(reload(paths), { type: 'program', title: 'Left' });
  const right = createIssue(reload(paths), { type: 'program', title: 'Right' });

  const text = `
remotes:
  alpha:
    provider: jsonfile
    on_delete: unlink
    conflict: manual
    scope: ${left.id}
    connection:
      file: .lpm/remotes/alpha/tracker.json
    mapping:
      statuses:
        backlog: Backlog
        ready: Ready
        in_progress: In Progress
        in_review: In Review
        done: { remote: Done, closed: true }
  beta:
    provider: jsonfile
    on_delete: unlink
    conflict: manual
    scope: ${right.id}
    connection:
      file: .lpm/remotes/beta/tracker.json
    mapping:
      statuses:
        backlog: Backlog
        ready: Ready
        in_progress: In Progress
        in_review: In Review
        done: { remote: Done, closed: true }
`;
  writeFileSync(paths.configPath, `${readFileSync(paths.configPath, 'utf8')}${text}`, 'utf8');
  const config = loadConfig(paths).config!;
  return { paths, config, left: left.id, right: right.id };
}

function twin(remoteId: string): LinkEntry {
  return {
    remoteId,
    remoteKey: `#${remoteId}`,
    remoteUrl: `file://tracker#${remoteId}`,
    syncedAt: '2026-09-12T10:00:00Z',
    remoteRev: '2026-09-12T10:00:00Z',
  };
}

function store(entries: Record<string, LinkEntry>): LinkStore {
  const links = new Map(Object.entries(entries));
  const byRemote = new Map<string, string>();
  for (const [localId, entry] of links) byRemote.set(entry.remoteId, localId);
  return { version: 1, cursor: null, links, byRemote, tombstones: new Map() };
}

function view(board: LoadedBoard): BoardView {
  const snapshot = toSnapshot(board);
  const nodes = Object.fromEntries(
    [...snapshot.issues, ...snapshot.periods, ...snapshot.resources, ...snapshot.templates].map(
      (node) => [node.id, node],
    ),
  );
  return { config: snapshot.config, nodes };
}

describe('the ledger', () => {
  it('reads every remote and says where each document is filed', () => {
    const { paths, config, left, right } = twoRemoteBoard();
    saveLinkStore(paths, 'alpha', store({ [left]: twin('1') }));
    saveLinkStore(paths, 'beta', store({ [right]: twin('7') }));

    const ledger = buildLedger(paths, config);

    expect(ownerOf(ledger, left)).toMatchObject({ remote: 'alpha', provider: 'jsonfile', remoteKey: '#1' });
    expect(ownerOf(ledger, right)?.remote).toBe('beta');
    expect(ledger.byRemote.get('alpha')?.map((entry) => entry.localId)).toEqual([left]);
  });

  it('has no opinion about a document nothing mirrors', () => {
    const { paths, config, left } = twoRemoteBoard();
    const ledger = buildLedger(paths, config);
    expect(ownerOf(ledger, left)).toBeUndefined();
    expect(otherOwner(ledger, left, 'alpha')).toBeUndefined();
  });

  it('does not report a document as owned elsewhere by the remote that owns it', () => {
    const { paths, config, left } = twoRemoteBoard();
    saveLinkStore(paths, 'alpha', store({ [left]: twin('1') }));
    const ledger = buildLedger(paths, config);

    expect(otherOwner(ledger, left, 'alpha')).toBeUndefined();
    expect(otherOwner(ledger, left, 'beta')?.remote).toBe('alpha');
    expect([...idsOwnedElsewhere(ledger, 'alpha').keys()]).toEqual([]);
    expect([...idsOwnedElsewhere(ledger, 'beta').keys()]).toEqual([left]);
  });

  it('refuses an explicit second twin, naming the holder and the way out', () => {
    const { paths, config, left } = twoRemoteBoard();
    saveLinkStore(paths, 'alpha', store({ [left]: twin('1') }));
    const ledger = buildLedger(paths, config);

    expect(() => requireUnclaimed(ledger, left, 'beta')).toThrow(/already mirrored on remote "alpha"/);
    try {
      requireUnclaimed(ledger, left, 'beta');
    } catch (error) {
      expect((error as { details: string[] }).details.join(' ')).toContain(`lpm remote decouple ${left}`);
    }
    // The remote that already holds it may of course go on holding it.
    expect(() => requireUnclaimed(ledger, left, 'alpha')).not.toThrow();
  });

  it('reports a document that has ended up in two stores at once', () => {
    // The state the rule exists to prevent, reachable by a hand edit or a merge
    // that took both sides. Reported, never silently resolved: picking a winner
    // is not a read's call.
    const { paths, config, left } = twoRemoteBoard();
    saveLinkStore(paths, 'alpha', store({ [left]: twin('1') }));
    saveLinkStore(paths, 'beta', store({ [left]: twin('9') }));

    const clashes = conflicts(paths, config);
    expect(clashes).toHaveLength(1);
    expect(clashes[0]!.map((entry) => entry.remote).sort()).toEqual(['alpha', 'beta']);
    // The index still answers, deterministically, so nothing downstream crashes.
    expect(ownerOf(buildLedger(paths, config), left)).toBeDefined();
  });
});

describe('planPush and the ledger', () => {
  it('never creates a second twin for a document another remote holds', () => {
    const { paths, config, left } = twoRemoteBoard();
    saveLinkStore(paths, 'alpha', store({ [left]: twin('1') }));
    const board = reload(paths);
    const claimed = idsOwnedElsewhere(buildLedger(paths, config), 'beta');

    const snapshot: RemoteSnapshot = {
      direction: 'both',
      issues: new Map(),
      ownedElsewhere: new Map([...claimed].map(([id, entry]) => [id, entry.remoteKey])),
    };
    const plan = planPush(view(board), store({}), snapshot);

    expect(plan.ops.some((op) => op.kind === 'create' && op.localId === left)).toBe(false);
    expect(plan.skipped).toContainEqual({ localId: left, reason: 'owned_elsewhere', remoteKey: '#1' });
  });
});
