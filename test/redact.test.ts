import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createIssue } from '../src/core/index.js';
import { BoardError } from '../src/core/errors.js';
import { parseConfigText } from '../src/core/index.js';
import {
  buildConnector,
  emptyCapabilities,
  executePush,
  loadLinkStore,
  openRemote,
  type BoardFields,
  type BoardOp,
  type Connector,
  type OpenedRemote,
  type Provider,
  type Translator,
} from '../src/remote/index.js';
import {
  createRedactor,
  REDACTED,
  redactHeaders,
  redactText,
  redactUrl,
  redactValue,
  redactor,
} from '../src/remote/redact.js';
import { toBoardError } from '../src/remote/transport-error.js';
import { RemoteError, restConnector } from '../src/remote/transport/index.js';
import { err, out } from '../src/cli/ui.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

afterAll(cleanupBoards);
afterEach(() => {
  redactor.clear();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/**
 * LP-296 — a secret value becomes `***` everywhere, from one definition.
 *
 * The pure functions take the secret list as an argument (the renderer is
 * browser-compatible and hands them per call); the process-wide `redactor`
 * holds what the credential resolver registered and the CLI's output sink
 * (`out` / `err`) consults it on every line. The last two suites are the
 * story's acceptance test: a failing sync with a sentinel token, whose output
 * must never carry the sentinel.
 */

const SENTINEL = 'ghp_SENTINEL12345';

describe('redactText', () => {
  it('replaces a secret with the marker, leaving the rest of the line intact', () => {
    expect(redactText(`token is ${SENTINEL}, keep it safe`, [SENTINEL])).toBe(
      `token is ${REDACTED}, keep it safe`,
    );
  });

  it('replaces every occurrence and several secrets at once', () => {
    expect(redactText(`${SENTINEL} and again ${SENTINEL}`, [SENTINEL])).toBe(
      `${REDACTED} and again ${REDACTED}`,
    );
    expect(redactText(`a=${SENTINEL} b=${SENTINEL}`, [SENTINEL])).toBe(`a=${REDACTED} b=${REDACTED}`);
  });

  it('redacts the percent-encoded form of a secret, for URLs', () => {
    // A secret with a character `encodeURIComponent` escapes.
    const secret = 'ab/c d=';
    const encoded = encodeURIComponent(secret);
    expect(encoded).not.toBe(secret);
    expect(redactText(`token=${encoded}`, [secret])).toBe(`token=${REDACTED}`);
  });

  it('ignores empty secrets and text without a secret', () => {
    expect(redactText('ordinary line', [''])).toBe('ordinary line');
    expect(redactText('ordinary line', [SENTINEL])).toBe('ordinary line');
  });
});

describe('redactValue', () => {
  it('recurses through arrays and objects', () => {
    expect(
      redactValue({ a: [SENTINEL, { b: `x${SENTINEL}` }], c: 1 }, [SENTINEL]),
    ).toEqual({ a: [REDACTED, { b: `x${REDACTED}` }], c: 1 });
  });
});

describe('redactHeaders', () => {
  it('redacts a header value whole, and never a header name', () => {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${SENTINEL}`,
      'X-Api-Key': SENTINEL,
    };
    expect(redactHeaders(headers, [SENTINEL])).toEqual({
      Accept: 'application/json',
      Authorization: REDACTED,
      'X-Api-Key': REDACTED,
    });
  });

  it('leaves a header without the secret alone', () => {
    expect(redactHeaders({ Accept: 'application/json' }, [SENTINEL])).toEqual({
      Accept: 'application/json',
    });
  });
});

describe('redactUrl', () => {
  it('redacts a secret in a query string and in the userinfo', () => {
    expect(redactUrl(`https://api.example.com/repos?a=${SENTINEL}`, [SENTINEL])).toBe(
      `https://api.example.com/repos?a=${REDACTED}`,
    );
    expect(redactUrl(`https://${SENTINEL}@api.example.com/repos`, [SENTINEL])).toBe(
      `https://${REDACTED}@api.example.com/repos`,
    );
  });
});

describe('the process-wide redactor', () => {
  it('register / clear control the secret set', () => {
    const isolated = createRedactor();
    isolated.register('');
    isolated.register(SENTINEL);
    expect(isolated.secrets()).toEqual([SENTINEL]);
    expect(isolated.redact(`v=${SENTINEL}`)).toBe(`v=${REDACTED}`);
    isolated.clear();
    expect(isolated.secrets()).toEqual([]);
    expect(isolated.redact(`v=${SENTINEL}`)).toBe(`v=${SENTINEL}`);
  });
});

describe('the output sink redacts every line (out and err)', () => {
  it('redacts a registered secret from out() and err()', () => {
    redactor.register(SENTINEL);

    const stdout: string[] = [];
    const stderr: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    out(`logged token ${SENTINEL}`);
    err(`error: token ${SENTINEL}`);

    outSpy.mockRestore();
    errSpy.mockRestore();

    expect(stdout.join('')).toContain(`logged token ${REDACTED}`);
    expect(stdout.join('')).not.toContain(SENTINEL);
    expect(stderr.join('')).toContain(`error: token ${REDACTED}`);
    expect(stderr.join('')).not.toContain(SENTINEL);
  });
});

describe('a failing sync redacts the sentinel token (LP-296 AC)', () => {
  it('redacts a sentinel echoed back in a failed request body', async () => {
    redactor.register(SENTINEL);

    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ message: `Bad credentials for ${SENTINEL}` }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    const connector = restConnector({ baseUrl: 'https://api.example.com', fetch: fetchImpl });

    let remoteError: unknown;
    try {
      await connector.request({ method: 'GET', path: '/repos/acme/payments', purpose: 'fetch issues' });
    } catch (error) {
      remoteError = error;
    }
    expect(remoteError).toBeInstanceOf(RemoteError);

    const boardError = toBoardError(remoteError as RemoteError, 'github');

    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    err(`error: ${boardError.message}`);
    for (const detail of boardError.details) err(`  ${detail}`);

    spy.mockRestore();

    const output = stderr.join('');
    expect(output).toContain(REDACTED);
    expect(output).not.toContain(SENTINEL);
  });

  it('runs a failing push whose recorded error never carries the sentinel', async () => {
    const paths = makeBoard('scrum', 'LP');
    const programme = createIssue(reload(paths), { type: 'program', title: 'Programme' });
    const board = reload(paths);
    const store = loadLinkStore(paths, 'test');
    const remote = failingRemote();

    const connector: Connector = {
      name: 'memory',
      async create() {
        throw new BoardError(`GitHub create failed (422): ${SENTINEL}`);
      },
      async update() {
        return { remoteId: 'x', remoteKey: 'k', remoteUrl: '', remoteRev: 'r' };
      },
      async delete() {
        return { remoteId: 'x', remoteKey: 'k', remoteUrl: '', remoteRev: 'r' };
      },
      async get() {
        return null;
      },
      async list() {
        return { records: [], cursor: null };
      },
    };

    redactor.register(SENTINEL);

    const plan = [
      {
        kind: 'create' as const,
        placeholder: 'new:1',
        localId: programme.id,
        fields: { title: 'Programme', body: '', type: 'program', status: 'backlog' } as BoardFields,
      },
    ];

    const result = await executePush(board, remote, connector, store, plan);
    expect(result.failed).toHaveLength(1);

    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    for (const op of result.failed) err(`error: ${op.error}`);

    spy.mockRestore();

    const output = stderr.join('');
    expect(output).toContain(REDACTED);
    expect(output).not.toContain(SENTINEL);
  });
});

describe('buildConnector registers the resolved secret', () => {
  it('registers the token from the environment with the redactor', () => {
    vi.stubEnv('GITHUB_TOKEN', SENTINEL);
    const paths = makeBoard('blank', 'LP');

    const { config } = parseConfigText(
      `${MINIMAL}${GITHUB_REMOTE}`,
    );
    expect(config).toBeDefined();

    const remote = openRemote(config!, 'upstream');
    buildConnector(remote, paths);

    expect(redactor.secrets()).toContain(SENTINEL);
  });
});

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const MINIMAL = `
version: 1
key_prefix: LP
statuses:
  - id: todo
    label: To Do
  - id: done
    label: Done
hierarchy: [task]
issue_types:
  task:
    label: Task
`;

const GITHUB_REMOTE = `
remotes:
  upstream:
    provider: github
    on_delete: unlink
    conflict: manual
    connection:
      repo: acme/payments
    mapping:
      statuses: { todo: Todo, done: Done }
`;

/** A provider/remote whose translator echoes board fields; the connector is injected. */
function failingRemote(): OpenedRemote {
  const translator: Translator = {
    describeRequest(op: BoardOp) {
      if (op.kind === 'delete') {
        return { request: { kind: 'delete' }, problems: [], resourceGaps: [], periodGaps: [] };
      }
      return {
        request: { kind: op.kind, title: op.fields.title },
        problems: [],
        resourceGaps: [],
        periodGaps: [],
      };
    },
    fieldsFromRecord() {
      return { patch: {}, problems: [], unknownAccounts: [] };
    },
  };
  const provider: Provider = {
    config: z.object({ connection: z.object({}), mapping: z.object({}) }),
    capabilities: emptyCapabilities(),
    translator,
    connector: () => {
      throw new Error('the executor drives a connector directly');
    },
  };
  return {
    name: 'test',
    provider,
    scope: undefined,
    direction: 'both',
    on_delete: 'unlink',
    conflict: 'manual',
    fields: {},
    encoding: 'block',
    comments: 'push',
    connection: {},
    mapping: {},
  };
}
