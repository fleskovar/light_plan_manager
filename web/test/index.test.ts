import { afterEach, describe, expect, test } from 'vitest';
import { buildIndex } from '$lib/board/index.js';
import type { NodeIndexImpl } from '$lib/board/index.js';
import type { NodeIndex } from '$lib/board/index.js';
import {
  ancestorsOf,
  childrenOf,
  dependentsIndex,
  hasChildren,
  isWorkUnit,
  rootsOf,
  subtreeIds,
} from '$lib/board/selectors.js';
import { applyChange, baseline } from '$lib/board/working.js';
import type { WorkingNodes } from '$lib/board/working.js';
import type { Change, ConfigDto, IssueDto } from '$shared';
import { atomicConfig, board, config, issue, sampleBoard } from './fixtures.js';

/** Assert two arrays have the same elements regardless of order. */
function sameIds(actual: string[], expected: string[]): void {
  expect(new Set(actual)).toEqual(new Set(expected));
}

function sorted(ids: string[]): string[] {
  return [...ids].sort();
}

describe('NodeIndex', () => {
  // ── Build helpers ──────────────────────────────────────────────

  function build(nodes: WorkingNodes): NodeIndexImpl {
    return buildIndex(nodes);
  }

  // ── childrenOf ─────────────────────────────────────────────────

  describe('childrenOf', () => {
    test('agrees with selectors on the sample board', () => {
      const nodes = sampleBoard();
      const idx = build(nodes);
      const all = Object.values(nodes);
      for (const node of all) {
        expect(sorted(idx.childrenOf(node.id).map((c) => c.id))).toEqual(
          sorted(childrenOf(nodes, node.id).map((c) => c.id)),
        );
      }
    });

    test('roots (null parent) agree', () => {
      const nodes = sampleBoard();
      const idx = build(nodes);
      expect(sorted(idx.childrenOf(null).map((c) => c.id))).toEqual(
        sorted(rootsOf(nodes, 'issue').map((c) => c.id)),
      );
    });

    test('empty board returns []', () => {
      const idx = build({});
      expect(idx.childrenOf('anything')).toEqual([]);
      expect(idx.childrenOf(null)).toEqual([]);
    });

    test('returns [] for an id with no children', () => {
      const nodes = board(issue('S1', 'user_story', 'E'));
      const idx = build(nodes);
      expect(idx.childrenOf('S1')).toEqual([]);
    });
  });

  // ── rootsOf ────────────────────────────────────────────────────

  describe('rootsOf', () => {
    test('agrees with selectors', () => {
      const nodes = sampleBoard();
      const idx = build(nodes);
      const got = sorted(idx.rootsOf('issue').map((n) => n.id));
      const want = sorted(rootsOf(nodes, 'issue').map((n) => n.id));
      expect(got).toEqual(want);
    });

    test('empty board returns []', () => {
      const idx = build({});
      expect(idx.rootsOf('issue')).toEqual([]);
      expect(idx.rootsOf('period')).toEqual([]);
    });

    test('mixed kinds split correctly', () => {
      const nodes = board(
        issue('I1', 'user_story', null),
        { ...issue('P1', 'user_story', null), kind: 'period' as const, starts: '', ends: '', squad: null },
      );
      const idx = build(nodes);
      expect(idx.rootsOf('issue').map((n) => n.id)).toEqual(['I1']);
      expect(idx.rootsOf('period').map((n) => n.id)).toEqual(['P1']);
    });
  });

  // ── subtreeIds ─────────────────────────────────────────────────

  describe('subtreeIds', () => {
    test('agrees with selectors', () => {
      const nodes = sampleBoard();
      const idx = build(nodes);
      expect(sorted(idx.subtreeIds('P'))).toEqual(sorted(subtreeIds(nodes, 'P')));
      expect(sorted(idx.subtreeIds('E'))).toEqual(sorted(subtreeIds(nodes, 'E')));
      expect(sorted(idx.subtreeIds('F1'))).toEqual(sorted(subtreeIds(nodes, 'F1')));
    });

    test('leaf returns only itself', () => {
      const nodes = sampleBoard();
      const idx = build(nodes);
      expect(idx.subtreeIds('S1')).toEqual(['S1']);
    });

    test('unknown id returns only itself', () => {
      const idx = build({});
      expect(idx.subtreeIds('nope')).toEqual(['nope']);
    });
  });

  // ── hasChildren ────────────────────────────────────────────────

  describe('hasChildren', () => {
    test('agrees with selectors', () => {
      const nodes = sampleBoard();
      const idx = build(nodes);
      for (const node of Object.values(nodes)) {
        expect(idx.hasChildren(node.id)).toBe(hasChildren(nodes, node.id));
      }
    });

    test('empty board', () => {
      const idx = build({});
      expect(idx.hasChildren('anything')).toBe(false);
    });

    test('orphaned parent — the child exists but the parent is counted', () => {
      const nodes = board(issue('C', 'user_story', 'missing'));
      const idx = build(nodes);
      // C has no children of its own
      expect(idx.hasChildren('C')).toBe(false);
      // 'missing' is referenced as parentId but is not in the nodes record,
      // so it still shows up in the child count
      expect(idx.hasChildren('missing')).toBe(true);
    });
  });

  // ── dependentsOf ───────────────────────────────────────────────

  describe('dependentsOf', () => {
    test('agrees with dependentsIndex', () => {
      const nodes = sampleBoard();
      const idx = build(nodes);
      const di = dependentsIndex(nodes);
      for (const node of Object.values(nodes)) {
        expect(sorted(idx.dependentsOf(node.id))).toEqual(sorted(di[node.id] ?? []));
      }
    });

    test('empty board', () => {
      const idx = build({});
      expect(idx.dependentsOf('anything')).toEqual([]);
    });
  });

  // ── ancestorsOf ────────────────────────────────────────────────

  describe('ancestorsOf', () => {
    test('agrees with selectors', () => {
      const nodes = sampleBoard();
      const idx = build(nodes);
      for (const node of Object.values(nodes)) {
        expect(idx.ancestorsOf(node.id).map((n) => n.id)).toEqual(
          ancestorsOf(nodes, node.id).map((n) => n.id),
        );
      }
    });

    test('root has no ancestors', () => {
      const nodes = sampleBoard();
      const idx = build(nodes);
      expect(idx.ancestorsOf('P')).toEqual([]);
    });

    test('deep leaf returns chain nearest-first', () => {
      const nodes = sampleBoard();
      const idx = build(nodes);
      const got = idx.ancestorsOf('S1').map((n) => n.id);
      expect(got).toEqual(['F1', 'E', 'P']);
    });
  });

  // ── isWorkUnit parity ──────────────────────────────────────────

  describe('isWorkUnit parity', () => {
    /** Index-backed isWorkUnit: uses hasChildren + ancestorsOf instead of scans. */
    function isWorkUnitIndexed(
      idx: NodeIndex,
      nodes: WorkingNodes,
      cfg: typeof config,
      id: string,
    ): boolean {
      const node = nodes[id];
      if (!node || node.kind !== 'issue') return false;
      // Atomic ancestor check — walk ancestors via the index
      if (idx.ancestorsOf(id).some((a) => cfg.types[a.type]?.atomic)) return false;
      if (cfg.types[node.type]?.atomic) return true;
      return !idx.hasChildren(id);
    }

    test('agrees with current isWorkUnit on sample board', () => {
      const nodes = sampleBoard();
      const cfg = atomicConfig(); // no atomic types
      const idx = build(nodes);
      for (const node of Object.values(nodes)) {
        if (node.kind !== 'issue') continue;
        const want = isWorkUnit(nodes, cfg, node);
        const got = isWorkUnitIndexed(idx, nodes, cfg, node.id);
        expect(got).toBe(want);
      }
    });

    test('agrees when a type is atomic', () => {
      // user_story is atomic — stories with sub-tasks are still work units
      const nodes = board(
        issue('P', 'program', null),
        issue('E', 'epic', 'P'),
        issue('ST', 'user_story', 'E', { attributes: { story_points: 5 } }),
        issue('T1', 'sub_task', 'ST'),
        issue('T2', 'sub_task', 'ST'),
      );
      const cfg = atomicConfig('user_story');
      const idx = build(nodes);
      for (const node of Object.values(nodes)) {
        if (node.kind !== 'issue') continue;
        const want = isWorkUnit(nodes, cfg, node);
        const got = isWorkUnitIndexed(idx, nodes, cfg, node.id);
        expect(got).toBe(want);
      }
    });

    test('node inside an atomic ancestor is never a unit', () => {
      const nodes = board(
        issue('ST', 'user_story', null, { attributes: { story_points: 3 } }),
        issue('T1', 'sub_task', 'ST'),
      );
      const cfg = atomicConfig('user_story');
      const idx = build(nodes);
      // T1 is inside the atomic story — not a unit
      expect(isWorkUnitIndexed(idx, nodes, cfg, 'T1')).toBe(false);
      expect(isWorkUnit(nodes, cfg, nodes['T1']! as any)).toBe(false);
      // ST is a unit (atomic type)
      expect(isWorkUnitIndexed(idx, nodes, cfg, 'ST')).toBe(true);
      expect(isWorkUnit(nodes, cfg, nodes['ST']! as any)).toBe(true);
    });
  });

  // ── One-pass vs incremental shape ──────────────────────────────

  describe('structure', () => {
    test('building from an empty board does not throw', () => {
      const idx = build({});
      expect(idx.rootsOf('issue')).toEqual([]);
      expect(idx.childrenOf(null)).toEqual([]);
    });

    test('a node whose parentId references nothing still lands in children', () => {
      const nodes = board(issue('orphan', 'user_story', 'ghost'));
      const idx = build(nodes);
      expect(idx.rootsOf('issue')).toEqual([]);
      expect(idx.childrenOf('ghost').map((n) => n.id)).toEqual(['orphan']);
      expect(idx.hasChildren('ghost')).toBe(true);
    });
  });

  // ── Incremental maintenance ────────────────────────────────────

  describe('incremental', () => {
    /** Build from-scratch index from the same nodes for comparison. */
    function scratch(nodes: WorkingNodes): NodeIndexImpl {
      return buildIndex(nodes);
    }

    test('incremental create == from-scratch', () => {
      const nodes = sampleBoard();
      const idx = build({});
      for (const node of Object.values(nodes)) idx.add(node);

      const want = scratch(nodes);
      for (const node of Object.values(nodes)) {
        expect(sorted(idx.childrenOf(node.id).map((c) => c.id))).toEqual(
          sorted(want.childrenOf(node.id).map((c) => c.id)),
        );
        expect(sorted(idx.subtreeIds(node.id))).toEqual(sorted(want.subtreeIds(node.id)));
        expect(idx.hasChildren(node.id)).toBe(want.hasChildren(node.id));
        expect(sorted(idx.dependentsOf(node.id))).toEqual(sorted(want.dependentsOf(node.id)));
        expect(idx.ancestorsOf(node.id).map((n) => n.id)).toEqual(
          want.ancestorsOf(node.id).map((n) => n.id),
        );
      }
    });

    test('incremental delete == from-scratch', () => {
      const nodes = sampleBoard();
      const idx = build(nodes);
      const toRemove = new Set(['S2', 'S3']);
      idx.remove(toRemove);

      const remaining: WorkingNodes = {};
      for (const [id, node] of Object.entries(nodes)) {
        if (!toRemove.has(id)) remaining[id] = node;
      }
      const want = scratch(remaining);
      for (const node of Object.values(remaining)) {
        expect(sorted(idx.childrenOf(node.id).map((c) => c.id))).toEqual(
          sorted(want.childrenOf(node.id).map((c) => c.id)),
        );
        expect(idx.hasChildren(node.id)).toBe(want.hasChildren(node.id));
        expect(sorted(idx.dependentsOf(node.id))).toEqual(sorted(want.dependentsOf(node.id)));
        // S2 was a parent of things, check it's gone
        expect(idx.childrenOf('S2')).toEqual([]);
        expect(idx.hasChildren('S2')).toBe(false);
      }
    });

    test('remove purges dependents entries for deleted nodes', () => {
      const nodes = sampleBoard();
      // S1 depends on no one, S2 depends on S1 → dependents['S1'] = ['S2']
      const idx = build(nodes);
      expect(sorted(idx.dependentsOf('S1'))).toEqual(['S2']);

      // Delete S2
      idx.remove(new Set(['S2']));
      // dependents['S1'] should no longer reference S2
      expect(idx.dependentsOf('S1')).toEqual([]);
      // dependents['S2'] should be gone entirely
      expect(idx.dependentsOf('S2')).toEqual([]);
    });

    test('remove purges the gone id from all dependents entries', () => {
      const nodes = sampleBoard();
      const idx = build(nodes);
      // S2 depends on S1, S3 depends on S2 → dependents['S2'] = ['S3']
      expect(sorted(idx.dependentsOf('S2'))).toContain('S3');

      // Delete S3 — its id should vanish from dependents['S2']
      idx.remove(new Set(['S3']));
      expect(idx.dependentsOf('S2')).not.toContain('S3');
    });

    test('applyChange delete keeps index equal to rebuild', () => {
      // Build a working copy with dependencies
      const base = sampleBoard();
      const nodes: WorkingNodes = {};
      for (const [id, node] of Object.entries(base)) nodes[id] = { ...node };

      const idx = build(nodes);

      // Delete S2 through applyChange — this path calls index.remove then detach
      const subIds = new Set([...idx.subtreeIds('S2'), 'S2']);
      applyChange(nodes, {
        kind: 'delete',
        id: 'S2',
        nodeKind: 'issue',
      }, config, idx);

      const want = scratch(nodes);
      for (const node of Object.values(nodes)) {
        expect(sorted(idx.childrenOf(node.id).map((c) => c.id))).toEqual(
          sorted(want.childrenOf(node.id).map((c) => c.id)),
        );
        expect(idx.hasChildren(node.id)).toBe(want.hasChildren(node.id));
        expect(sorted(idx.dependentsOf(node.id))).toEqual(sorted(want.dependentsOf(node.id)));
      }
    });

    test('incremental reparent == from-scratch', () => {
      const nodes = sampleBoard();
      const idx = build(nodes);
      // Move S2 from F1 to F2's children
      const id = 'S2';
      const oldParent = nodes[id]!.parentId; // F1
      const newParent = 'F2';
      idx.reparent(id, oldParent, newParent);

      // Apply the same to a cloned WorkingNodes
      const moved = { ...nodes, [id]: { ...nodes[id]!, parentId: newParent } };
      const want = scratch(moved);
      for (const node of Object.values(moved)) {
        expect(sorted(idx.childrenOf(node.id).map((c) => c.id))).toEqual(
          sorted(want.childrenOf(node.id).map((c) => c.id)),
        );
      }
      // After the move, both F1 and F2 should agree with a fresh index
      expect(idx.hasChildren('F1')).toBe(want.hasChildren('F1'));
      expect(idx.hasChildren('F2')).toBe(want.hasChildren('F2'));
    });

    test('incremental setDependsOn == from-scratch', () => {
      const nodes = sampleBoard();
      const idx = build(nodes);
      // S2 originally depends on S1; make it depend on S4 instead
      idx.setDependsOn('S2', ['S1'], ['S4']);

      const changed = {
        ...nodes,
        S2: { ...nodes['S2']!, dependsOn: ['S4'] },
      };
      const want = scratch(changed);
      for (const node of Object.values(changed)) {
        expect(sorted(idx.dependentsOf(node.id))).toEqual(sorted(want.dependentsOf(node.id)));
      }
      expect(idx.dependentsOf('S1')).toEqual([]);
      expect(idx.dependentsOf('S4')).toEqual(['S2']);
    });

    test('title-only update touches no index entry', () => {
      const nodes = sampleBoard();
      const idx = build(nodes);
      // Snapshot the children-of map before the edit
      const before = new Map<string | null, string[]>();
      for (const node of Object.values(nodes)) {
        before.set(node.id, sorted(idx.childrenOf(node.id).map((c) => c.id)));
      }
      before.set(null, sorted(idx.childrenOf(null).map((c) => c.id)));

      // Apply a title-only change directly to the working copy — the index
      // is not touched because the caller sees a non-structural update and
      // skips index maintenance.
      const working = { ...nodes };
      applyChange(working, {
        kind: 'update',
        id: 'S1',
        nodeKind: 'issue',
        patch: { title: 'new title' },
      }, config);
      // Build a fresh index from the changed nodes — it must match the original
      const after = build(working);
      for (const node of Object.values(nodes)) {
        expect(sorted(after.childrenOf(node.id).map((c) => c.id))).toEqual(
          before.get(node.id) ?? [],
        );
        expect(after.hasChildren(node.id)).toBe(idx.hasChildren(node.id));
        expect(sorted(after.dependentsOf(node.id))).toEqual(sorted(idx.dependentsOf(node.id)));
      }
    });

    test('random change sequence: incremental == from-scratch at every step', () => {
      // Build a starting board
      const initial = sampleBoard();
      let nodes: WorkingNodes = {};
      for (const [id, node] of Object.entries(initial)) nodes[id] = { ...node };
      const idx = build(nodes);

      const steps = [
        // Create a new story under F1
        () => {
          const node = issue('S5', 'user_story', 'F1', { dependsOn: ['S1'] });
          nodes['S5'] = node;
          idx.add(node);
        },
        // Reparent F2 under P directly
        () => {
          const old = nodes['F2']!.parentId;
          nodes['F2'] = { ...nodes['F2']!, parentId: 'P' };
          idx.reparent('F2', old, 'P');
        },
        // Change S2 dependsOn
        () => {
          const issue = nodes['S2'] as IssueDto;
          const was = [...issue.dependsOn];
          nodes['S2'] = { ...issue, dependsOn: ['S4'] };
          idx.setDependsOn('S2', was, ['S4']);
        },
        // Delete S3
        () => {
          const gone = new Set(['S3']);
          delete nodes['S3'];
          idx.remove(gone);
          // Also detach references
          for (const node of Object.values(nodes)) {
            if (node.kind !== 'issue') continue;
            const issue = node as IssueDto;
            if (issue.dependsOn.includes('S3'))
              issue.dependsOn = issue.dependsOn.filter((d) => d !== 'S3');
          }
        },
      ];

      for (const step of steps) {
        step();
        const want = scratch(nodes);
        for (const node of Object.values(nodes)) {
          expect(
            sorted(idx.childrenOf(node.id).map((c) => c.id)),
            `childrenOf ${node.id} after step`,
          ).toEqual(sorted(want.childrenOf(node.id).map((c) => c.id)));
          expect(idx.hasChildren(node.id), `hasChildren ${node.id}`).toBe(
            want.hasChildren(node.id),
          );
          expect(
            sorted(idx.dependentsOf(node.id)),
            `dependentsOf ${node.id}`,
          ).toEqual(sorted(want.dependentsOf(node.id)));
        }
        // Roots
        expect(sorted(idx.rootsOf('issue').map((n) => n.id))).toEqual(
          sorted(want.rootsOf('issue').map((n) => n.id)),
        );
      }
    });
  });
});
