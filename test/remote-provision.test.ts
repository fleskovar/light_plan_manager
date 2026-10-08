import { afterAll, describe, expect, it } from 'vitest';
import { createPeriod, createResource } from '../src/core/index.js';
import { desiredLabelsOf } from '../src/remote/provision.js';
import { missingLabels } from '../src/remote/labels.js';
import { findProvider } from '../src/remote/registry.js';
import type { OpenedRemote } from '../src/remote/remotes.js';
import { boardPath, cleanupBoards, makeBoard, reload, writeRawIssue } from './helpers.js';

afterAll(cleanupBoards);

/** A fully valid GitHub remote for the scrum board (the preflight's FULL mapping). */
function githubRemote(mapping: Record<string, unknown>, scope?: string): OpenedRemote {
  return {
    name: 'upstream',
    provider: findProvider('github')!,
    ...(scope !== undefined ? { scope } : {}),
    direction: 'both',
    on_delete: 'unlink',
    conflict: 'manual',
    fields: {},
    encoding: 'block',
    comments: 'push',
    connection: { repo: 'acme/payments' },
    mapping,
  };
}

const FULL = {
  types: {
    program: { remote: 'program' },
    epic: { remote: 'epic' },
    feature: { remote: 'feature' },
    user_story: { remote: 'story' },
    bug: { remote: 'bug' },
  },
  statuses: {
    backlog: { remote: ['Backlog'], closed: false },
    in_progress: { remote: ['In Progress'], closed: false },
    done: { remote: ['Done'], closed: true },
  },
  attributes: { priority: 'Priority' },
  accounts: { via: 'github' },
  periods: { container: 'sprint' },
};

/** Hand-write an issue. */
function rawIssue(
  paths: ReturnType<typeof makeBoard>,
  id: string,
  fields: {
    type: string;
    status?: string;
    assignee?: string;
    period?: string;
    attributes?: Record<string, string>;
  },
): void {
  const lines = [`id: ${id}`, `type: ${fields.type}`, `title: ${id}`];
  if (fields.status) lines.push(`status: ${fields.status}`);
  if (fields.assignee) lines.push(`assignee: ${fields.assignee}`);
  if (fields.period) lines.push(`period: ${fields.period}`);
  for (const [key, value] of Object.entries(fields.attributes ?? {})) {
    lines.push(`${key}: ${value}`);
  }
  writeRawIssue(boardPath(paths, id), `---\n${lines.join('\n')}\n---\n`);
}

describe('desiredLabelsOf', () => {
  it('collects type, status, attribute, pool and degraded-period labels', () => {
    const paths = makeBoard('scrum', 'LP');
    createPeriod(reload(paths), {
      type: 'increment',
      title: 'PI-1',
      starts: '2026-01-01',
      ends: '2026-03-31',
    });
    createPeriod(reload(paths), {
      type: 'sprint',
      title: 'Sprint 1',
      starts: '2026-01-01',
      ends: '2026-01-14',
      parentId: 'TL-1',
    });
    createResource(reload(paths), { type: 'role', title: 'Backend Pool' });
    rawIssue(paths, 'LP-1', {
      type: 'user_story',
      status: 'backlog',
      assignee: 'RS-1',
      period: 'TL-2',
      attributes: { priority: 'high' },
    });

    const desired = desiredLabelsOf(reload(paths), githubRemote(FULL));

    // The labels a sync would write for this document.
    expect(desired).toEqual(
      expect.arrayContaining([
        'story', // type
        'Backlog', // status
        'Priority:high', // mapped attribute
        'pool:RS-1', // generic pool
      ]),
    );
    // The mapping's static type and status labels exist even before a document
    // uses them — a repo must define them before any sync can apply them.
    expect(desired).toEqual(expect.arrayContaining(['program', 'epic', 'Done']));
    // No sprint label: the sprint is the container, carried by the milestone.
    expect(desired).not.toContain('sprint:Sprint 1');
    // The increment rides the managed block, never a label (LP-313).
    expect(desired).not.toContain('increment:PI-1');
  });

  it('only collects per-issue labels from the remote scope', () => {
    const paths = makeBoard('scrum', 'LP');
    rawIssue(paths, 'LP-1', { type: 'user_story', status: 'backlog', attributes: { priority: 'high' } });
    rawIssue(paths, 'LP-2', { type: 'bug', status: 'backlog', attributes: { priority: 'low' } });

    const desired = desiredLabelsOf(reload(paths), githubRemote(FULL, 'LP-1'));
    expect(desired).toContain('Priority:high');
    expect(desired).not.toContain('Priority:low');
  });
});

describe('missingLabels (provision report)', () => {
  it('reports the desired labels the repository does not define, sorted', () => {
    const desired = ['story', 'Backlog', 'Priority:high', 'pool:RS-1'];
    expect(missingLabels(desired, ['story', 'Backlog'])).toEqual([
      'Priority:high',
      'pool:RS-1',
    ]);
  });

  it('reports nothing when every label exists', () => {
    expect(missingLabels(['story'], ['story', 'other'])).toEqual([]);
  });
});
