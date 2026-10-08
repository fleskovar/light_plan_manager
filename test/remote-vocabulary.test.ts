import { describe, expect, it } from 'vitest';
import { parseConfigText } from '../src/core/index.js';
import type { BoardConfig } from '../src/core/index.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { staticCapabilities } from '../src/remote/capabilities.js';
import { lookupProvider, registeredProviders } from '../src/remote/registry.js';
import { scaffoldMapping } from '../src/remote/scaffold.js';
import { jiraTypeFor, jiraStatusFor } from '../src/remote/providers/jira/vocabulary.js';
import { linearStatusFor } from '../src/remote/providers/linear/vocabulary.js';
import type { BoardStatusRole, BoardTypeRole } from '../src/remote/vocabulary.js';

/**
 * The platform-standard vocabulary (LP-537): what a board word is called on a
 * remote nobody has looked at yet.
 *
 * This is the table that decides whether `lpm remote add` produces a mapping
 * somebody can sync or fourteen `TODO:` lines they have to answer in YAML
 * first. Two halves are tested here: the per-provider convention as a pure
 * function of a board type's *role*, and the end-to-end draft for each shipped
 * board template, because the templates are what most boards actually are.
 */

const role = (over: Partial<BoardTypeRole> = {}): BoardTypeRole => ({
  name: 'thing',
  depth: 0,
  depthCount: 1,
  atomic: false,
  insideUnit: false,
  leaf: true,
  ...over,
});

const status = (over: Partial<BoardStatusRole> = {}): BoardStatusRole => ({
  id: 'backlog',
  label: 'Backlog',
  index: 0,
  count: 3,
  terminal: false,
  active: false,
  ...over,
});

/** A shipped board template, parsed. */
function template(name: string): BoardConfig {
  const text = readFileSync(path.join(process.cwd(), 'templates', `${name}.yml`), 'utf8');
  const { config, errors } = parseConfigText(text);
  expect(errors).toEqual([]);
  return config!;
}

/** The `types` / `statuses` a provider's scaffold drafts for a template. */
function draftFor(templateName: string, providerName: string) {
  const provider = lookupProvider(providerName);
  const { mapping, markers } = scaffoldMapping(
    template(templateName),
    staticCapabilities(provider.capabilities),
    {
      provider: providerName,
      ...(provider.standardVocabulary ? { vocabulary: provider.standardVocabulary } : {}),
    },
  );
  const names = (block: unknown): Record<string, string> =>
    Object.fromEntries(
      Object.entries(block as Record<string, { remote: string }>).map(([key, entry]) => [
        key,
        entry.remote,
      ]),
    );
  return { types: names(mapping.types), statuses: names(mapping.statuses), markers };
}

describe('jiraTypeFor', () => {
  it('answers from a name Jira has its own type for, at any depth', () => {
    expect(jiraTypeFor(role({ name: 'bug', depth: 3, depthCount: 5, atomic: true }))).toBe('Bug');
    expect(jiraTypeFor(role({ name: 'epic', depth: 1, depthCount: 5 }))).toBe('Epic');
    expect(jiraTypeFor(role({ name: 'user_story', depth: 3, depthCount: 5 }))).toBe('Story');
    // The name is matched loosely, so a board's `Sub-Task` and `sub_task` agree.
    expect(jiraTypeFor(role({ name: 'Sub-Task', depth: 4, depthCount: 5 }))).toBe('Sub-task');
  });

  it("uses the level's role where the name says nothing", () => {
    // Inside an atomic level: a checklist item inside one job — Jira's sub-task.
    expect(jiraTypeFor(role({ name: 'step', insideUnit: true, depth: 4, depthCount: 5 }))).toBe(
      'Sub-task',
    );
    // The work level itself, whether declared atomic or merely the deepest.
    expect(jiraTypeFor(role({ name: 'chore', atomic: true, depth: 2, depthCount: 4 }))).toBe('Task');
    expect(jiraTypeFor(role({ name: 'chore', leaf: true, depth: 3, depthCount: 4 }))).toBe('Task');
    // Above the work: Jira's only level above Story is Epic.
    expect(jiraTypeFor(role({ name: 'capability', depth: 0, depthCount: 4, leaf: false }))).toBe(
      'Epic',
    );
  });

  it('maps the only level of a one-level board to Task, not Sub-task', () => {
    // A board with a single `task` level has no hierarchy to compress, and its
    // one level is the work — filing it as a Jira sub-task would need a parent
    // that does not exist.
    expect(jiraTypeFor(role({ name: 'task', depth: 0, depthCount: 1, leaf: true }))).toBe('Task');
  });
});

describe('jiraStatusFor', () => {
  it('reads the two flags the engine itself reads', () => {
    expect(jiraStatusFor(status({ terminal: true, label: 'Shipped' }))).toBe('Done');
    expect(jiraStatusFor(status({ active: true, label: 'In Review' }))).toBe('In Progress');
    expect(jiraStatusFor(status({ label: 'Ready', index: 1 }))).toBe('To Do');
  });
});

describe('linearStatusFor', () => {
  it('maps a board column onto the default team states, review included', () => {
    expect(linearStatusFor(status({ index: 0, label: 'Backlog' }))).toBe('Backlog');
    expect(linearStatusFor(status({ index: 1, label: 'Ready' }))).toBe('Todo');
    expect(linearStatusFor(status({ index: 2, label: 'In Progress', active: true }))).toBe(
      'In Progress',
    );
    // Both of Linear's started states are `active` on the board; the *name* is
    // the only thing that separates them, and it is enough.
    expect(linearStatusFor(status({ index: 3, label: 'In Review', active: true }))).toBe('In Review');
    expect(linearStatusFor(status({ index: 4, label: 'Done', terminal: true }))).toBe('Done');
    expect(linearStatusFor(status({ index: 5, label: 'Cancelled' }))).toBe('Canceled');
  });
});

describe('the draft a shipped template gets', () => {
  it('leaves nothing to fill in for the Scrum template on Jira', () => {
    const { types, statuses, markers } = draftFor('scrum', 'jira');
    expect(markers).toEqual([]);
    // Five issue levels onto Jira's three: the levels above the work become
    // Epic (separated on pull by depth), the work level keeps its own words,
    // and the level inside a story becomes a real sub-task.
    expect(types).toEqual({
      program: 'Epic',
      epic: 'Epic',
      feature: 'Epic',
      user_story: 'Story',
      bug: 'Bug',
      test: 'Task',
      review: 'Task',
      research: 'Task',
      sub_task: 'Sub-task',
    });
    expect(statuses).toEqual({
      backlog: 'To Do',
      ready: 'To Do',
      in_progress: 'In Progress',
      in_review: 'In Progress',
      done: 'Done',
    });
  });

  it('leaves nothing to fill in for the Kanban template on Jira', () => {
    const { types, markers } = draftFor('kanban', 'jira');
    expect(markers).toEqual([]);
    // `story` is the atomic level here, so `task` below it is a Jira sub-task —
    // which is the one type that can nest natively under a story.
    expect(types).toEqual({ epic: 'Epic', story: 'Story', task: 'Sub-task' });
  });

  it('leaves nothing to fill in for the blank template on Jira', () => {
    const { types, markers } = draftFor('blank', 'jira');
    expect(markers).toEqual([]);
    expect(types).toEqual({ task: 'Task' });
  });

  it('drafts only statuses for Linear, because a Linear type is a label', () => {
    const { types, statuses, markers } = draftFor('scrum', 'linear');
    expect(markers).toEqual([]);
    // No issue types on the platform: every board type keeps its own name and
    // rides a label, so there is no convention to apply.
    expect(types['user_story']).toBe('user_story');
    expect(statuses).toEqual({
      backlog: 'Backlog',
      ready: 'Todo',
      in_progress: 'In Progress',
      in_review: 'In Review',
      done: 'Done',
    });
  });

  it('leaves nothing to fill in for GitHub or jsonfile either', () => {
    for (const provider of ['github', 'jsonfile']) {
      const { markers, statuses } = draftFor('scrum', provider);
      expect(markers).toEqual([]);
      // Both carry the board's own words: GitHub on labels, jsonfile natively.
      expect(statuses['in_review']).toBe('In Review');
    }
  });

  it('leaves nothing to fill in for any shipped template on any provider', () => {
    // The invariant behind "declare a remote, give it a credential, sync". A
    // marker is a board word somebody has to answer in YAML before the remote
    // will open at all, so any pair that produces one has put a hand-edit back
    // into first-time setup — whether by a new provider that states no
    // convention, or by a template whose vocabulary the conventions do not
    // cover. Asserted over the cross-product, because that is where it broke:
    // Jira left fourteen markers for the Scrum template and nothing failed.
    for (const templateName of ['blank', 'kanban', 'scrum']) {
      for (const providerName of registeredProviders()) {
        const { markers } = draftFor(templateName, providerName);
        expect(markers, `${providerName} x ${templateName}`).toEqual([]);
      }
    }
  });
});
