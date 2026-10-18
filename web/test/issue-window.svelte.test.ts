import { describe, expect, it } from 'vitest';
import { BodyDraft } from '$features/issue/body-draft.svelte.js';
import {
  DEFAULT_ISSUE_LAYOUT,
  SIDE_MAX,
  SIDE_MIN,
  SPLIT_MAX,
  SPLIT_MIN,
  parseIssueLayout,
  splitFromCommentsHeight,
} from '$features/issue/layout.js';
import { ago, saveLabel } from '$features/issue/save-status.js';
import { followsToEnd, sameComments } from '$features/panel/sections/comment-list.js';

describe('saveLabel', () => {
  const base = { saving: false, unsaved: false, savedAt: null, savedBy: 'auto' as const };

  it('says "No changes" before the first write', () => {
    expect(saveLabel(base, 0)).toEqual({ tone: 'idle', text: 'No changes' });
  });

  it('puts a running push before an unsaved change', () => {
    expect(saveLabel({ ...base, saving: true, unsaved: true }, 0).text).toBe('Saving…');
  });

  it('reports an unsaved change', () => {
    expect(saveLabel({ ...base, unsaved: true, savedAt: 0 }, 1000).tone).toBe('unsaved');
  });

  it('names an automatic write', () => {
    expect(saveLabel({ ...base, savedAt: 0 }, 3000).text).toBe('Saved automatically just now');
  });

  it('names a write of the Save button without "automatically"', () => {
    expect(saveLabel({ ...base, savedAt: 0, savedBy: 'manual' }, 42_000).text).toBe('Saved 40 seconds ago');
  });
});

describe('ago', () => {
  it.each([
    [0, 'just now'],
    [9_999, 'just now'],
    [10_000, '10 seconds ago'],
    [14_000, '10 seconds ago'],
    [59_000, '55 seconds ago'],
    [60_000, '1 minute ago'],
    [125_000, '2 minutes ago'],
    [3_600_000, '1 hour ago'],
    [7_300_000, '2 hours ago'],
    [-5_000, 'just now'],
  ])('%i ms is "%s"', (elapsed, text) => {
    expect(ago(elapsed)).toBe(text);
  });
});

describe('BodyDraft', () => {
  it('is not dirty until the text changes', () => {
    const draft = new BodyDraft();
    draft.open('body');
    expect(draft.editing).toBe(true);
    expect(draft.dirty).toBe(false);
    draft.text = 'body!';
    expect(draft.dirty).toBe(true);
  });

  it('keeps the draft when the editor is opened again', () => {
    const draft = new BodyDraft();
    draft.open('one');
    draft.text = 'edited';
    draft.open('two');
    expect(draft.text).toBe('edited');
  });

  it('returns the text on commit and is clean afterwards', () => {
    const draft = new BodyDraft();
    draft.open('one');
    draft.text = 'two';
    expect(draft.commit(false)).toBe('two');
    expect(draft.editing).toBe(true);
    expect(draft.dirty).toBe(false);
  });

  it('returns null on commit when nothing changed, and closes with `close`', () => {
    const draft = new BodyDraft();
    draft.open('one');
    expect(draft.commit(true)).toBeNull();
    expect(draft.editing).toBe(false);
  });

  it('drops the draft on discard', () => {
    const draft = new BodyDraft();
    draft.open('one');
    draft.text = 'two';
    draft.discard();
    expect(draft.editing).toBe(false);
    expect(draft.dirty).toBe(false);
  });
});

describe('issue window layout', () => {
  it('uses the defaults for a missing or corrupt entry', () => {
    expect(parseIssueLayout(null)).toEqual(DEFAULT_ISSUE_LAYOUT);
    expect(parseIssueLayout('{nope')).toEqual(DEFAULT_ISSUE_LAYOUT);
    expect(parseIssueLayout('{"side":"wide"}')).toEqual(DEFAULT_ISSUE_LAYOUT);
  });

  it('starts the details and the comments at the same height', () => {
    expect(DEFAULT_ISSUE_LAYOUT.split).toBe(0.5);
  });

  it('clamps a stored value into its range', () => {
    expect(parseIssueLayout('{"side":10,"split":0.99}')).toEqual({ side: SIDE_MIN, split: SPLIT_MAX });
    expect(parseIssueLayout('{"side":9000,"split":0}')).toEqual({ side: SIDE_MAX, split: SPLIT_MIN });
  });

  it('turns a comments height into the share of the details', () => {
    expect(splitFromCommentsHeight(300, 1000)).toBeCloseTo(0.7);
    expect(splitFromCommentsHeight(990, 1000)).toBe(SPLIT_MIN);
    expect(splitFromCommentsHeight(100, 0)).toBe(DEFAULT_ISSUE_LAYOUT.split);
  });
});

describe('comment list', () => {
  const comment = (index: number, body = `body ${index}`) => ({
    index,
    author: 'ana',
    at: `2026-10-18T10:0${index}:00.000Z`,
    body,
  });

  it('treats a refetch with the same comments as no change', () => {
    expect(sameComments([comment(1), comment(2)], [comment(1), comment(2)])).toBe(true);
  });

  it('sees an added, removed or edited comment', () => {
    expect(sameComments([comment(1)], [comment(1), comment(2)])).toBe(false);
    expect(sameComments([comment(1), comment(2)], [comment(1)])).toBe(false);
    expect(sameComments([comment(1)], [comment(1, 'edited')])).toBe(false);
  });

  it('scrolls to the end on the first load', () => {
    expect(followsToEnd(0, 5, false)).toBe(true);
  });

  it('does not move a reader who scrolled up, when nothing new arrives', () => {
    expect(followsToEnd(5, 5, false)).toBe(false);
    expect(followsToEnd(5, 5, true)).toBe(false);
  });

  it('follows a new comment only while the reader is at the end', () => {
    expect(followsToEnd(5, 6, true)).toBe(true);
    expect(followsToEnd(5, 6, false)).toBe(false);
  });
});
