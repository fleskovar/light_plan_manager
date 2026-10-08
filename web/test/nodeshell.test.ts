import { describe, expect, it } from 'vitest';
import { hasFlagInside, isDriftSync, isRaisedFlag, nodeMinSize } from '$features/canvas/nodes/NodeShell.svelte.js';
import { DERIVED_FLAG } from '$shared';
import type { CanvasNodeData } from '$features/canvas/model.js';

function makeData(overrides: Partial<CanvasNodeData> = {}): CanvasNodeData {
  return {
    node: {
      id: 'LP-1',
      type: 'user_story',
      title: 'Test',
      status: 'backlog',
      kind: 'issue',
      dependsOn: [],
      relatesTo: [],
      body: '',
      attributes: {},
      depth: 3,
      parentId: null,
      period: null,
      assignee: null,
      flag: null,
      relatedFiles: [],
      created: '2026-01-01',
      author: 'RS-1',
    },
    typeLabel: 'User Story',
    tone: 'todo',
    templateRoot: false,
    templateDescription: '',
    group: false,
    collapsible: false,
    collapsed: false,
    hiddenChildren: 0,
    assigneeLabel: null,
    effort: null,
    flag: null,
    flaggedInside: 0,
    schedule: null,
    lineage: [],
    ...overrides,
  };
}

describe('nodeMinSize', () => {
  it('returns the leaf minimum when no data floor is set', () => {
    const data = makeData();
    const size = nodeMinSize(data, 200, 80);
    expect(size.minWidth).toBe(200);
    expect(size.minHeight).toBe(80);
  });

  it('respects the data floor when it is larger than the leaf minimum', () => {
    const data = makeData({ minWidth: 400, minHeight: 200 });
    const size = nodeMinSize(data, 200, 80);
    expect(size.minWidth).toBe(400);
    expect(size.minHeight).toBe(200);
  });

  it('falls back to the leaf minimum when the data floor is too small', () => {
    const data = makeData({ minWidth: 100, minHeight: 40 });
    const size = nodeMinSize(data, 200, 80);
    expect(size.minWidth).toBe(200);
    expect(size.minHeight).toBe(80);
  });

  it('uses whichever dimension is larger independently', () => {
    const data = makeData({ minWidth: 400, minHeight: 30 });
    const size = nodeMinSize(data, 200, 80);
    expect(size.minWidth).toBe(400);
    expect(size.minHeight).toBe(80);
  });

  it('handles undefined data floor as no floor', () => {
    const data = makeData();
    // Explicitly clear minWidth/minHeight
    data.minWidth = undefined;
    data.minHeight = undefined;
    const size = nodeMinSize(data, 200, 80);
    expect(size.minWidth).toBe(200);
    expect(size.minHeight).toBe(80);
  });
});

describe('hasFlagInside', () => {
  it('is false for a clean node', () => {
    expect(hasFlagInside(makeData())).toBe(false);
  });

  it('is false when the node itself is flagged', () => {
    // A flagged node does not also claim to hold a flag inside — it owns its flag.
    expect(hasFlagInside(makeData({ flag: 'blocked', flaggedInside: 3 }))).toBe(false);
  });

  it('is true when something inside is flagged and the node itself is not', () => {
    expect(hasFlagInside(makeData({ flaggedInside: 2 }))).toBe(true);
  });

  it('is false when nothing is flagged anywhere', () => {
    expect(hasFlagInside(makeData({ flag: null, flaggedInside: 0 }))).toBe(false);
  });

  // The engine rolls a flag up the parent chain, so a container holding stopped
  // work carries `DERIVED_FLAG` on the document itself. That is the same claim
  // `flaggedInside` makes about folded-away detail, reaching the node by the
  // other route — and it is what makes an *expanded* epic say anything at all.
  it('is true for a container the roll-up marked, with nothing folded inside it', () => {
    expect(hasFlagInside(makeData({ flag: DERIVED_FLAG, flaggedInside: 0 }))).toBe(true);
  });
});

describe('isRaisedFlag', () => {
  it('is true only for a flag somebody typed', () => {
    expect(isRaisedFlag(makeData({ flag: 'blocked' }))).toBe(true);
    expect(isRaisedFlag(makeData({ flag: 'help' }))).toBe(true);
  });

  // Otherwise a story flagged four levels down would paint its whole ancestry
  // in the loud red that means "this is the thing that stopped".
  it('is false for one the roll-up wrote, and for no flag at all', () => {
    expect(isRaisedFlag(makeData({ flag: DERIVED_FLAG }))).toBe(false);
    expect(isRaisedFlag(makeData({ flag: null }))).toBe(false);
  });
});

describe('isDriftSync', () => {
  it('is true for the four drift states and false for in-sync or none', () => {
    expect(isDriftSync('ahead')).toBe(true);
    expect(isDriftSync('behind')).toBe(true);
    expect(isDriftSync('conflicted')).toBe(true);
    expect(isDriftSync('unlinked')).toBe(true);
    expect(isDriftSync('in-sync')).toBe(false);
    expect(isDriftSync(undefined)).toBe(false);
  });
});
