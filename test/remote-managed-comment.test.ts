import { describe, expect, it } from 'vitest';
import { renderManagedBlock, type ManagedBlockEntry } from '../src/remote/managed-block.js';
import {
  isManagedCommentBody,
  planManagedComment,
  renderManagedComment,
  type ManagedCommentCapability,
} from '../src/remote/managed-comment.js';

const ENTRIES: ManagedBlockEntry[] = [
  { name: 'id', kind: 'text', value: 'LP-12' },
  { name: 'parent', kind: 'id', value: 'LP-9' },
  { name: 'depends_on', kind: 'ids', value: ['LP-4', 'LP-7'] },
];

const NONE: ManagedCommentCapability = { native: false, editable: false, deletable: false };
const POST_ONLY: ManagedCommentCapability = { native: true, editable: false, deletable: false };
const EDITABLE: ManagedCommentCapability = { native: true, editable: true, deletable: true };
const REPLACE: ManagedCommentCapability = { native: true, editable: false, deletable: true };

// ---------------------------------------------------------------------------
// The comment body
// ---------------------------------------------------------------------------

describe('renderManagedComment', () => {
  it('renders the managed block itself — the same delimiters, the same bytes', () => {
    expect(renderManagedComment(ENTRIES)).toBe(renderManagedBlock(ENTRIES));
  });

  it('is empty when there are no entries (nothing to write)', () => {
    expect(renderManagedComment([])).toBe('');
  });
});

describe('isManagedCommentBody', () => {
  it('recognises our own block output', () => {
    expect(isManagedCommentBody(renderManagedComment(ENTRIES))).toBe(true);
  });

  it('rejects human prose', () => {
    expect(isManagedCommentBody('Just a note from a person.')).toBe(false);
    expect(isManagedCommentBody('')).toBe(false);
  });

  it('rejects a body whose delimiters a human mangled', () => {
    const mangled = renderManagedComment(ENTRIES).replace('<!-- lpm:end -->', '');
    expect(isManagedCommentBody(mangled)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// planManagedComment — the action the next push takes
// ---------------------------------------------------------------------------

describe('planManagedComment', () => {
  it('does nothing when there is nothing to write and no comment exists', () => {
    expect(planManagedComment(EDITABLE, undefined, false)).toEqual({ kind: 'none' });
  });

  it('posts when there is something to write and no comment exists', () => {
    expect(planManagedComment(EDITABLE, undefined, true)).toEqual({ kind: 'post' });
  });

  it('edits in place when a comment exists and can be edited', () => {
    expect(planManagedComment(EDITABLE, 'IC_1', true)).toEqual({ kind: 'edit', commentId: 'IC_1' });
  });

  it('replaces (delete + repost) when a comment exists but cannot be edited', () => {
    expect(planManagedComment(REPLACE, 'IC_1', true)).toEqual({
      kind: 'replace',
      commentId: 'IC_1',
    });
  });

  it('removes the comment when the entries went away', () => {
    expect(planManagedComment(EDITABLE, 'IC_1', false)).toEqual({
      kind: 'remove',
      commentId: 'IC_1',
    });
    expect(planManagedComment(REPLACE, 'IC_1', false)).toEqual({
      kind: 'remove',
      commentId: 'IC_1',
    });
  });

  it('refuses to post onto a platform with no comments at all', () => {
    const action = planManagedComment(NONE, undefined, true);
    expect(action.kind).toBe('unavailable');
  });

  it('refuses a change when the comment can neither be edited nor deleted', () => {
    const action = planManagedComment(POST_ONLY, 'IC_1', true);
    expect(action).toEqual({
      kind: 'unavailable',
      reason: 'the managed comment exists but cannot be edited or deleted',
    });
  });

  it('refuses to remove a comment on a platform that cannot delete', () => {
    const action = planManagedComment(POST_ONLY, 'IC_1', false);
    expect(action).toEqual({
      kind: 'unavailable',
      reason: 'the managed comment is empty and comments cannot be deleted',
    });
  });
});
