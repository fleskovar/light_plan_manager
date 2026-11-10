import { describe, expect, it } from 'vitest';
import { arrivalsToShow } from '$lib/workspace/follow.js';
import { board, issue, sampleBoard } from './fixtures.js';

/**
 * A view follows each branch that it shows whole.
 *
 * The sample board: P > E > F1 (S1, S2) and F2 (S3, S4). Each case re-reads
 * the board with one more document, the way a pull does after MCP or the CLI
 * wrote it, and asks which new documents join the view.
 */
const before = sampleBoard();
const withAlso = (...extra: ReturnType<typeof issue>[]) =>
  board(...Object.values(sampleBoard()), ...extra);
const everything = new Set(['P', 'E', 'F1', 'F2', 'S1', 'S2', 'S3', 'S4']);

describe('arrivalsToShow', () => {
  it('shows a new story under a feature whose whole branch is on the canvas', () => {
    const after = withAlso(issue('S5', 'user_story', 'F1'));
    expect(arrivalsToShow(before, after, everything)).toEqual(['S5']);
  });

  it('keeps a new story hidden when the reader hid part of its feature', () => {
    // S2 is hidden, so the branch of F1 is not shown whole.
    const members = new Set([...everything].filter((id) => id !== 'S2'));
    const after = withAlso(issue('S5', 'user_story', 'F1'));
    expect(arrivalsToShow(before, after, members)).toEqual([]);
  });

  it('keeps a new story hidden when its feature is not on the canvas', () => {
    const after = withAlso(issue('S5', 'user_story', 'F1'));
    expect(arrivalsToShow(before, after, new Set(['P', 'E', 'F2', 'S3', 'S4']))).toEqual([]);
  });

  it('shows the branch of F1 whole even when the branch of F2 is not', () => {
    // S4 is hidden: E is not whole, but F1 is.
    const members = new Set([...everything].filter((id) => id !== 'S4'));
    const after = withAlso(issue('S5', 'user_story', 'F1'));
    expect(arrivalsToShow(before, after, members)).toEqual(['S5']);
  });

  it('brings a new feature in with its new stories', () => {
    const after = withAlso(issue('F3', 'feature', 'E'), issue('S6', 'user_story', 'F3'));
    expect(arrivalsToShow(before, after, everything)).toEqual(['F3', 'S6']);
  });

  it('shows a story that another window moved into a branch shown whole', () => {
    const outside = board(...Object.values(sampleBoard()), issue('X', 'user_story', null));
    const moved = board(...Object.values(sampleBoard()), issue('X', 'user_story', 'F1'));
    expect(arrivalsToShow(outside, moved, everything)).toEqual(['X']);
  });

  it('does not bring back a story that the reader removed from the canvas', () => {
    // S2 existed before and did not move, so it is no arrival.
    const members = new Set([...everything].filter((id) => id !== 'S2'));
    expect(arrivalsToShow(before, sampleBoard(), members)).toEqual([]);
  });

  it('adds nothing on the first read of a view', () => {
    expect(arrivalsToShow({}, sampleBoard(), everything)).toEqual([]);
  });

  it('adds nothing at the top level, where no branch holds the new document', () => {
    const after = withAlso(issue('P2', 'program', null));
    expect(arrivalsToShow(before, after, everything)).toEqual([]);
  });
});
