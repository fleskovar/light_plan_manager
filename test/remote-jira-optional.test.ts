/**
 * LP-491 — the Jira client is an optional *peer* dependency.
 *
 * `jira.js` must never be required to build or run the engine. This file is
 * its own test module so the mock that makes the dynamic `import('jira.js')`
 * fail lives in one place and cannot leak into the suites that drive the real
 * client through a stubbed `fetch` (`test/remote-jira.test.ts`).
 */

import { describe, expect, it, vi } from 'vitest';
import { BoardError } from '../src/core/errors.js';
import { jiraConnector } from '../src/remote/providers/jira/connector.js';

/** The connection a Jira remote resolves to (credentials already filled). */
const CONNECTION = {
  site: 'https://acme.atlassian.net',
  project: 'PAY',
  email: 'me@acme.com',
  token: 'api-token',
};

/** A BoardError's message plus its hints, flattened. */
function messageOf(error: unknown): string {
  return error instanceof BoardError ? `${error.message}\n${error.details.join('\n')}` : String(error);
}

describe('jira.js absence', () => {
  it('is a BoardError naming the install command, not a crash', async () => {
    vi.doMock('jira.js', () => {
      throw new Error('Cannot find module jira.js');
    });

    const connector = jiraConnector(CONNECTION);
    const message = await (async () => {
      try {
        await connector.get('PAY-1');
        return null;
      } catch (error) {
        return messageOf(error);
      }
    })();

    expect(message).toContain('The Jira client (jira.js) is not available');
    expect(message).toContain('not installed with light-plan');
    expect(message).toContain('npm install -g jira.js');
    expect(message).toContain('npx -p light-plan -p jira.js');

    vi.doUnmock('jira.js');
    vi.resetModules();
  });
});
