import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import {
  BoardError,
  createIssue,
  createResource,
  findIssue,
  findResource,
  linkIssue,
  listViewIds,
  moveIssue,
  parseFrontmatter,
  readView,
  removeNode,
  retypeNode,
  updateNode,
  writeView,
} from '../src/core/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);

/** program > epic > feature > user_story, returning the board paths. */
function seed(): BoardPaths {
  const paths = makeBoard('scrum', 'LP');
  createIssue(reload(paths), { type: 'program', title: 'Payments platform' });
  createIssue(reload(paths), { type: 'epic', title: 'Checkout revamp', parentId: 'LP-1' });
  createIssue(reload(paths), { type: 'feature', title: 'Guest flow', parentId: 'LP-2' });
  createIssue(reload(paths), { type: 'user_story', title: 'Guest checkout', parentId: 'LP-3' });
  return paths;
}

describe('updateNode', () => {
  it('leaves the folder alone when the title changes', () => {
    const paths = seed();
    const board = reload(paths);
    const story = findIssue(board, 'LP-4')!;
    const oldDir = story.dir;
    const { node } = updateNode(board, story, { title: 'Checkout as a guest' });

    expect(existsSync(oldDir)).toBe(true);
    expect(node.dir).toBe(oldDir);
    expect(path.basename(node.dir)).toBe('LP-4');
    expect(findIssue(reload(paths), 'LP-4')!.title).toBe('Checkout as a guest');
  });

  it('keeps the folder in place when only the body or attributes change', () => {
    const paths = seed();
    const story = findIssue(reload(paths), 'LP-4')!;
    updateNode(reload(paths), story, {
      body: '# Rewritten',
      attributes: { story_points: 8 },
    });

    const updated = findIssue(reload(paths), 'LP-4')!;
    expect(updated.body.trim()).toBe('# Rewritten');
    expect(updated.attributes.story_points).toBe(8);
    // Untouched attributes survive a partial patch.
    expect(updated.attributes.priority).toBe('medium');
  });

  it('rejects a value the attribute type does not allow', () => {
    const paths = seed();
    const story = findIssue(reload(paths), 'LP-4')!;
    expect(() => updateNode(reload(paths), story, { attributes: { priority: 'urgent' } })).toThrow(
      BoardError,
    );
  });

  it('refuses period and resource fields on an issue', () => {
    const paths = seed();
    const story = findIssue(reload(paths), 'LP-4')!;
    expect(() => updateNode(reload(paths), story, { capacity: 2 })).toThrow(/resources only/);
    expect(() => updateNode(reload(paths), story, { starts: '2026-01-01' })).toThrow(
      /periods only/,
    );
  });

  it('edits a resource capacity and coverage', () => {
    const paths = seed();
    createResource(reload(paths), { type: 'role', title: 'Jr Developer', capacity: 3 });
    createResource(reload(paths), { type: 'person', title: 'Ada' });

    const board = reload(paths);
    updateNode(board, findResource(board, 'RS-2')!, { capacity: 0.5, covers: ['RS-1'] });

    const ada = findResource(reload(paths), 'RS-2')!;
    expect(ada.capacity).toBe(0.5);
    expect(ada.covers).toEqual(['RS-1']);
    expect(reload(paths).coveredBy.get('RS-1')).toEqual(['RS-2']);
  });
});

describe('retypeNode', () => {
  it('swaps the type in place when the new type sits at the same depth', () => {
    const paths = seed();
    const board = reload(paths);
    const { node } = retypeNode(board, findIssue(board, 'LP-4')!, { type: 'bug' });

    expect(node.type).toBe('bug');
    const bug = findIssue(reload(paths), 'LP-4')!;
    expect(bug.type).toBe('bug');
    // Attributes of the new type are seeded, those of the old one dropped.
    expect(bug.attributes.severity).toBe('major');
    expect(bug.attributes).not.toHaveProperty('story_points');
  });

  it('keeps attribute values the new type also declares', () => {
    const paths = seed();
    updateNode(reload(paths), findIssue(reload(paths), 'LP-4')!, {
      attributes: { priority: 'critical' },
    });
    retypeNode(reload(paths), findIssue(reload(paths), 'LP-4')!, { type: 'bug' });
    expect(findIssue(reload(paths), 'LP-4')!.attributes.priority).toBe('critical');
  });

  it('demotes a document when it is reparented at the same time', () => {
    const paths = seed();
    createIssue(reload(paths), { type: 'feature', title: 'Returning flow', parentId: 'LP-2' });

    const board = reload(paths);
    const { node } = retypeNode(board, findIssue(board, 'LP-5')!, {
      type: 'user_story',
      parentId: 'LP-3',
    });

    expect(node.type).toBe('user_story');
    expect(node.depth).toBe(3);
    const moved = findIssue(reload(paths), 'LP-5')!;
    expect(moved.parentId).toBe('LP-3');
    expect(path.relative(paths.boardDir, moved.dir).split(path.sep)).toEqual([
      'LP-1',
      'LP-2',
      'LP-3',
      'LP-5',
    ]);
  });

  it('refuses a type that does not belong at the document depth', () => {
    const paths = seed();
    const board = reload(paths);
    expect(() => retypeNode(board, findIssue(board, 'LP-4')!, { type: 'epic' })).toThrow(
      /cannot sit at level 3/,
    );
  });

  it('refuses a retype that would strand a child', () => {
    const paths = seed();
    createIssue(reload(paths), { type: 'sub_task', title: 'Wire the form', parentId: 'LP-4' });

    const board = reload(paths);
    // A feature demoted to a story would put its sub_task at level 4, where
    // the hierarchy has nothing at all.
    expect(() =>
      retypeNode(board, findIssue(board, 'LP-3')!, { type: 'user_story', parentId: 'LP-3' }),
    ).toThrow(BoardError);
  });
});

describe('removeNode', () => {
  it('deletes the folder and everything under it', () => {
    const paths = seed();
    const board = reload(paths);
    const feature = findIssue(board, 'LP-3')!;
    const result = removeNode(board, feature);

    expect(result.removed).toEqual(['LP-3', 'LP-4']);
    expect(existsSync(feature.dir)).toBe(false);
    const after = reload(paths);
    expect(after.issues.map((issue) => issue.id)).toEqual(['LP-1', 'LP-2']);
  });

  it('rewrites documents that pointed at what was deleted', () => {
    const paths = seed();
    createIssue(reload(paths), { type: 'user_story', title: 'Pay as guest', parentId: 'LP-3' });
    linkIssue(reload(paths), findIssue(reload(paths), 'LP-5')!, { dependsOn: ['LP-4'] });

    const board = reload(paths);
    const result = removeNode(board, findIssue(board, 'LP-4')!);

    expect(result.detached).toEqual(['LP-5']);
    const survivor = findIssue(reload(paths), 'LP-5')!;
    expect(survivor.depends_on).toEqual([]);
    // The rewrite goes to disk, not just to the in-memory copy.
    const { data } = parseFrontmatter(readFileSync(survivor.file, 'utf8'));
    expect(data.depends_on).toEqual([]);
  });

  it('unassigns issues when their resource is deleted', () => {
    const paths = seed();
    createResource(reload(paths), { type: 'person', title: 'Ada' });
    moveIssue(reload(paths), findIssue(reload(paths), 'LP-4')!, { assignee: 'RS-1' });

    const board = reload(paths);
    removeNode(board, findResource(board, 'RS-1')!);

    expect(findIssue(reload(paths), 'LP-4')!.assignee).toBeNull();
  });
});

describe('view storage', () => {
  it('round-trips a view and lists it', () => {
    const paths = makeBoard('scrum', 'LP');
    expect(listViewIds(paths)).toEqual([]);

    writeView(paths, 'roadmap', { version: 1, name: 'Roadmap', members: ['LP-1'] });

    expect(listViewIds(paths)).toEqual(['roadmap']);
    expect(readView(paths, 'roadmap')).toEqual({
      version: 1,
      name: 'Roadmap',
      members: ['LP-1'],
    });
  });

  it('rejects an id that would escape the views folder', () => {
    const paths = makeBoard('scrum', 'LP');
    expect(() => readView(paths, '../config')).toThrow(BoardError);
  });
});
