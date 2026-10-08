import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/core/index.js';
import {
  corrections,
  hasCorrections,
  hasUnresolved,
  reconcileMapping,
  reconcileNames,
} from '../src/remote/reconcile.js';
import { addRemote, updateRemoteMapping } from '../src/remote/config-file.js';
import { cleanupBoards, makeBoard } from './helpers.js';

/**
 * `reconcile.ts` — matching a drafted mapping against the words a remote
 * actually has, and `updateRemoteMapping`, which lands the corrections.
 *
 * Together these are `lpm remote setup` minus the request, which is the whole
 * point of splitting them out: the interesting cases are a table rather than a
 * live Jira project.
 */

afterAll(cleanupBoards);

describe('reconcileNames', () => {
  it('accepts a claim the remote reports verbatim', () => {
    const block = reconcileNames({ done: 'Done' }, ['To Do', 'In Progress', 'Done']);
    expect(block.entries).toEqual([{ boardKey: 'done', claimed: 'Done', verdict: 'ok' }]);
  });

  it("adopts the remote's spelling of the same word", () => {
    // The commonest real correction: the convention says `Sub-task`, the project
    // spells it `Subtask`, and the request has to carry the project's spelling.
    const block = reconcileNames({ sub_task: 'Sub-task', backlog: 'To Do' }, ['Subtask', 'TODO']);
    expect(block.entries).toEqual([
      { boardKey: 'sub_task', claimed: 'Sub-task', resolved: 'Subtask', verdict: 'renamed' },
      { boardKey: 'backlog', claimed: 'To Do', resolved: 'TODO', verdict: 'renamed' },
    ]);
    expect(corrections(block)).toEqual({ sub_task: 'Subtask', backlog: 'TODO' });
  });

  it('reports a word the remote does not have, and never guesses a near miss', () => {
    // `In Review` and `In Progress` are one edit apart and are two different
    // columns of somebody's board. A question beats a rewrite.
    const block = reconcileNames({ in_review: 'In Review' }, ['To Do', 'In Progress', 'Done']);
    expect(block.entries).toEqual([
      { boardKey: 'in_review', claimed: 'In Review', verdict: 'unresolved' },
    ]);
    expect(corrections(block)).toEqual({});
    expect(block.candidates).toEqual(['To Do', 'In Progress', 'Done']);
  });

  it('refuses to choose when two remote names share one normalized form', () => {
    // A project carrying both spellings makes the rewrite a coin toss.
    const block = reconcileNames({ sub_task: 'Sub task' }, ['Sub-task', 'Subtask']);
    expect(block.entries[0]).toMatchObject({ verdict: 'unresolved' });
  });
});

describe('reconcileMapping', () => {
  const claims = {
    types: { epic: 'Epic', user_story: 'Story' },
    statuses: { backlog: 'To Do', done: 'Done' },
  };

  it('skips a vocabulary the remote does not report at all', () => {
    // Linear reports states and no types, because it *has* no types. Treating
    // the absent key as an empty list would mark every mapped type unresolved.
    const report = reconcileMapping(claims, { statuses: ['To Do', 'Done'] });
    expect(report.types).toBeUndefined();
    expect(report.statuses?.entries.every((entry) => entry.verdict === 'ok')).toBe(true);
    expect(hasUnresolved(report)).toBe(false);
    expect(hasCorrections(report)).toBe(false);
  });

  it('marks every mapped name unresolved when the remote reports an empty list', () => {
    // The opposite claim: the remote *has* this vocabulary and reported none.
    const report = reconcileMapping(claims, { types: [], statuses: [] });
    expect(hasUnresolved(report)).toBe(true);
    expect(report.types?.entries.map((entry) => entry.verdict)).toEqual([
      'unresolved',
      'unresolved',
    ]);
  });

  it('reports both blocks when the remote has both vocabularies', () => {
    const report = reconcileMapping(claims, {
      types: ['Epic', 'Story', 'Bug'],
      statuses: ['Todo', 'Done'],
    });
    expect(report.types?.entries.every((entry) => entry.verdict === 'ok')).toBe(true);
    expect(corrections(report.statuses)).toEqual({ backlog: 'Todo' });
    expect(hasCorrections(report)).toBe(true);
  });
});

describe('updateRemoteMapping', () => {
  it("rewrites only the named entries' remote name, leaving the rest of the file alone", () => {
    const paths = makeBoard('scrum', 'LP');
    addRemote(paths, {
      name: 'jira',
      provider: 'jira',
      connection: { site: 'https://acme.atlassian.net', project: 'PAY' },
    });
    const before = readFileSync(paths.configPath, 'utf8');

    const result = updateRemoteMapping(paths, 'jira', {
      types: { sub_task: 'Subtask' },
      statuses: { done: 'Closed' },
    });
    expect(result.changed).toEqual([
      'types.sub_task: Sub-task → Subtask',
      'statuses.done: Done → Closed',
    ]);

    const { config } = loadConfig(paths);
    const mapping = config!.remotes['jira']!.mapping as {
      types: Record<string, { remote: string }>;
      statuses: Record<string, { remote: string; closed?: boolean }>;
    };
    expect(mapping.types['sub_task']).toEqual({ remote: 'Subtask' });
    // The entry's other keys survive: a corrected name must not un-close a
    // terminal status.
    expect(mapping.statuses['done']).toMatchObject({ remote: 'Closed', closed: true });
    // Everything the correction did not name is untouched.
    expect(mapping.types['epic']).toEqual({ remote: 'Epic' });

    // And the board's own config — its comments included — is not re-rendered.
    const after = readFileSync(paths.configPath, 'utf8');
    expect(after).toContain('# light-plan board config -- Scrum template');
    expect(after.split('\n').length).toBe(before.split('\n').length);
  });

  it('reports nothing changed when the mapping already says it', () => {
    const paths = makeBoard('scrum', 'LP');
    addRemote(paths, {
      name: 'jira',
      provider: 'jira',
      connection: { site: 'https://acme.atlassian.net', project: 'PAY' },
    });
    const before = readFileSync(paths.configPath, 'utf8');
    expect(updateRemoteMapping(paths, 'jira', { types: { epic: 'Epic' } }).changed).toEqual([]);
    expect(readFileSync(paths.configPath, 'utf8')).toBe(before);
  });

  it('ignores a key the mapping does not declare rather than inventing one', () => {
    // A remote reporting a word for something this board does not have is not a
    // reason to add a mapping entry: the key set is the board's vocabulary.
    const paths = makeBoard('scrum', 'LP');
    addRemote(paths, {
      name: 'jira',
      provider: 'jira',
      connection: { site: 'https://acme.atlassian.net', project: 'PAY' },
    });
    expect(updateRemoteMapping(paths, 'jira', { types: { saga: 'Saga' } }).changed).toEqual([]);
    const { config } = loadConfig(paths);
    expect((config!.remotes['jira']!.mapping as { types: Record<string, unknown> }).types).not.toHaveProperty(
      'saga',
    );
  });

  it('refuses a remote it does not know', () => {
    const paths = makeBoard('scrum', 'LP');
    expect(() => updateRemoteMapping(paths, 'nope', { types: { epic: 'Epic' } })).toThrow(
      /No remote named "nope"/,
    );
  });
});
