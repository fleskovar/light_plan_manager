import { describe, expect, it } from 'vitest';
import {
  ConnectionsState,
  answersToSend,
  connectionChanges,
  describeCredential,
  describePrerequisites,
  draftProblems,
  emptyDraft,
  suggestName,
  toConnectRequest,
  unresolvedWords,
  type ConnectionsApi,
  type ConnectionsHost,
} from '$features/drawer/remote/connections.svelte.js';
import type {
  RemoteConnectRequestDto,
  RemoteConnectionDto,
  RemoteInspectDto,
  RemoteProviderDto,
} from '$shared';

/**
 * Connecting a remote from the browser, without a DOM or a server.
 *
 * The providers below are shaped like the ones the server derives from the
 * registry, but they are fixtures: nothing in the module under test knows a
 * platform, so neither do these tests beyond the shapes.
 */

const TRACKER: RemoteProviderDto = {
  name: 'tracker',
  connection: [
    { name: 'site', type: 'string', required: true, example: 'https://acme.example' },
    { name: 'project', type: 'string', required: true },
    { name: 'board', type: 'string', required: false },
    { name: 'tls_verify', type: 'boolean', required: false },
  ],
  credentials: [
    { key: 'email', env: 'TRACKER_EMAIL', visible: true },
    { key: 'token', env: 'TRACKER_TOKEN', visible: false },
  ],
  credentialUrl: 'https://tokens.example',
  conditional: [{ key: 'board', needs: 'periods', why: 'a sprint lives on a board' }],
};

const FILE: RemoteProviderDto = {
  name: 'file',
  connection: [{ name: 'file', type: 'string', required: false }],
  credentials: [],
  conditional: [],
};

function connectionDto(over: Partial<RemoteConnectionDto> = {}): RemoteConnectionDto {
  return {
    name: 'tracker',
    provider: 'tracker',
    scope: null,
    connection: { site: 'https://acme.example', project: 'PAY' },
    credentials: [
      { key: 'email', env: 'TRACKER_EMAIL', source: '.lpm/credentials.json' },
      { key: 'token', env: 'TRACKER_TOKEN', source: '.lpm/credentials.json' },
    ],
    linked: 0,
    ...over,
  };
}

function inspectDto(over: Partial<RemoteInspectDto> = {}): RemoteInspectDto {
  return {
    remoteName: 'tracker',
    reachability: { reachable: true, evidence: 'GET / → 200' },
    stopped: false,
    found: [],
    choices: [],
    needed: [],
    noVocabulary: false,
    written: [],
    ready: true,
    ...over,
  };
}

interface Recording {
  connects: RemoteConnectRequestDto[];
  updates: Array<Record<string, string | boolean>>;
  credentials: Array<Record<string, string>>;
  inspections: string[];
  answers: unknown[];
  removed: string[];
  changed: Array<string | undefined>;
  notices: string[];
  errors: unknown[];
}

function harness(
  over: Partial<ConnectionsApi> = {},
): { state: ConnectionsState; recording: Recording } {
  const recording: Recording = {
    connects: [],
    updates: [],
    credentials: [],
    inspections: [],
    answers: [],
    removed: [],
    changed: [],
    notices: [],
    errors: [],
  };
  const api: ConnectionsApi = {
    remoteProviders: async () => [TRACKER, FILE],
    connectRemote: async (body) => {
      recording.connects.push(body);
      return {
        name: body.name,
        provider: body.provider,
        target: 'PAY @ acme.example',
        replaced: false,
        markers: [],
        stored: Object.keys(body.credentials ?? {}),
        credentials: [
          { key: 'email', source: body.credentials?.email ? '.lpm/credentials.json' : undefined },
          { key: 'token', source: body.credentials?.token ? '.lpm/credentials.json' : undefined },
        ].map(({ key, source }) => ({ key, ...(source ? { source } : {}) })),
      };
    },
    remoteConnection: async () => connectionDto(),
    updateRemoteConnection: async (_name, body) => {
      recording.updates.push(body.connection);
      return connectionDto({ connection: { site: 'https://acme.example', project: 'PAY', ...body.connection } });
    },
    storeRemoteCredentials: async (_name, body) => {
      recording.credentials.push(body.credentials);
      return { stored: Object.keys(body.credentials), credentials: connectionDto().credentials };
    },
    inspectRemote: async (name) => {
      recording.inspections.push(name);
      return inspectDto();
    },
    answerRemote: async (_name, body) => {
      recording.answers.push(body);
      return { changed: ['connection.board: 12'] };
    },
    removeRemote: async (name) => {
      recording.removed.push(name);
      return { name, purged: false };
    },
    ...over,
  };
  const host: ConnectionsHost = {
    notify: (_level, message) => recording.notices.push(message),
    report: (error) => recording.errors.push(error),
    remotesChanged: async (name) => {
      recording.changed.push(name);
    },
  };
  return { state: new ConnectionsState(api, host), recording };
}

describe('the connect form helpers', () => {
  it('names a remote after its provider, stepping aside for a name that is taken', () => {
    expect(suggestName('tracker', [])).toBe('tracker');
    expect(suggestName('tracker', ['tracker', 'tracker-2'])).toBe('tracker-3');
    expect(emptyDraft(TRACKER, ['tracker']).name).toBe('tracker-2');
  });

  it('asks only what the browser can know: required fields and a usable name', () => {
    const draft = emptyDraft(TRACKER, []);
    expect(draftProblems(TRACKER, draft, [])).toEqual(['site is required.', 'project is required.']);

    draft.connection.site = 'https://acme.example';
    draft.connection.project = 'PAY';
    expect(draftProblems(TRACKER, draft, [])).toEqual([]);

    expect(draftProblems(TRACKER, { ...draft, name: 'my tracker' }, [])).toEqual([
      'Name cannot contain spaces.',
    ]);
    expect(draftProblems(TRACKER, draft, ['tracker'])).toEqual(['A remote named "tracker" already exists.']);
    expect(draftProblems(undefined, draft, [])).toEqual(['Choose a tracker.']);
  });

  it('sends only declared keys, never a blank, and a credential only as a credential', () => {
    const draft = emptyDraft(TRACKER, []);
    draft.connection = { site: ' https://acme.example ', project: 'PAY', board: '', tls_verify: false, stray: 'x' };
    draft.credentials = { email: 'me@acme.example', token: '  ' };

    expect(toConnectRequest(TRACKER, draft)).toEqual({
      name: 'tracker',
      provider: 'tracker',
      connection: { site: 'https://acme.example', project: 'PAY' },
      credentials: { email: 'me@acme.example' },
    });
  });

  it('needs nothing at all from a provider that works its connection out', () => {
    const draft = emptyDraft(FILE, []);
    expect(draftProblems(FILE, draft, [])).toEqual([]);
    expect(toConnectRequest(FILE, draft)).toEqual({ name: 'file', provider: 'file', connection: {} });
  });

  it('describes a credential by where it comes from, never by what it is', () => {
    expect(describeCredential({ key: 'token', source: '$TRACKER_TOKEN' })).toBe('set from $TRACKER_TOKEN');
    expect(describeCredential({ key: 'token', env: 'TRACKER_TOKEN' })).toBe(
      'not set — store it here or set $TRACKER_TOKEN',
    );
    expect(describeCredential({ key: 'token', reference: 'MY_TOKEN' })).toBe(
      '$MY_TOKEN is not set (referenced in config.yml)',
    );
  });

  it('saves only what changed, and sends an unticked switch as false', () => {
    const current = { site: 'https://acme.example', project: 'PAY', tls_verify: true };
    expect(
      connectionChanges(TRACKER, current, { site: 'https://acme.example', project: 'OPS', board: '', tls_verify: false }),
    ).toEqual({ project: 'OPS', tls_verify: false });
  });
});

describe('ConnectionsState — connecting', () => {
  async function filledDraft(state: ConnectionsState, credentials: Record<string, string>) {
    await state.openConnect([]);
    state.draft!.connection.site = 'https://acme.example';
    state.draft!.connection.project = 'PAY';
    state.draft!.credentials = { email: '', token: '', ...credentials };
  }

  it('drops the typed credential once it is stored, then selects and tests the new remote', async () => {
    const { state, recording } = harness();
    await filledDraft(state, { email: 'me@acme.example', token: 'secret-token' });

    expect(await state.submitConnect([])).toBe(true);

    expect(recording.connects[0]!.credentials).toEqual({ email: 'me@acme.example', token: 'secret-token' });
    expect(state.draft).toBeNull();
    expect(JSON.stringify(state)).not.toContain('secret-token');
    expect(recording.changed).toContain('tracker');
    expect(state.connection?.name).toBe('tracker');
    // Nothing missing, so the tracker is asked about itself straight away.
    expect(recording.inspections).toEqual(['tracker']);
  });

  it('does not test a remote whose credential is still missing, and says what is needed', async () => {
    const { state, recording } = harness();
    await filledDraft(state, { email: 'me@acme.example' });

    await state.submitConnect([]);

    expect(recording.inspections).toEqual([]);
    expect(recording.notices[0]).toContain('Connected tracker');
  });

  it('keeps the draft after a refused connect, so a mistyped value does not cost the token', async () => {
    const { state, recording } = harness({
      connectRemote: async () => {
        throw new Error('site: must be an https URL');
      },
    });
    await filledDraft(state, { token: 'secret-token' });

    expect(await state.submitConnect([])).toBe(false);

    expect(recording.errors).toHaveLength(1);
    expect(state.draft?.credentials.token).toBe('secret-token');
  });

  it('forgets a typed credential when the form is closed', async () => {
    const { state } = harness();
    await filledDraft(state, { token: 'secret-token' });
    state.closeConnect();
    expect(state.draft).toBeNull();
  });

  it('keeps a typed name when the provider changes, and follows it when it was only suggested', async () => {
    const { state } = harness();
    await state.openConnect([]);
    state.chooseProvider('file', []);
    expect(state.draft!.name).toBe('file');

    state.draft!.name = 'mirror';
    state.chooseProvider('tracker', []);
    expect(state.draft!.name).toBe('mirror');
  });
});

describe('ConnectionsState — the connection panel', () => {
  it('saves only the changed connection values', async () => {
    const { state, recording } = harness();
    await state.loadConnection('tracker');
    expect(state.connectionDirty).toBe(false);

    state.setConnectionValue('board', '12');
    expect(state.connectionDirty).toBe(true);
    await state.saveConnection();

    expect(recording.updates).toEqual([{ board: '12' }]);
    expect(state.connectionDirty).toBe(false);
  });

  it('stores only the credentials typed, and clears them once stored', async () => {
    const { state, recording } = harness();
    await state.loadConnection('tracker');
    state.setCredentialValue('email', '');
    state.setCredentialValue('token', 'rotated-token');

    await state.saveCredentials();

    expect(recording.credentials).toEqual([{ token: 'rotated-token' }]);
    expect(state.credentialsTyped).toBe(false);
    expect(JSON.stringify(state)).not.toContain('rotated-token');
  });

  it('writes the answers chosen, then asks the tracker again', async () => {
    const { state, recording } = harness({
      inspectRemote: async (name) => {
        recording.inspections.push(name);
        return inspectDto({
          ready: false,
          choices: [
            {
              key: 'board',
              why: 'a sprint lives on a board',
              candidates: [
                { key: 'board', value: '12', label: 'PAY board' },
                { key: 'board', value: '14', label: 'OPS board' },
              ],
            },
          ],
        });
      },
    });
    await state.loadConnection('tracker');
    await state.inspect();
    expect(state.hasAnswers).toBe(false);

    state.setAnswer('connection', 'board', '12');
    state.setAnswer('statuses', 'done', '');
    await state.submitAnswers();

    expect(recording.answers).toEqual([{ connection: { board: '12' } }]);
    expect(recording.inspections).toEqual(['tracker', 'tracker']);
  });

  it('removes the remote and lets the Sync tab re-read its list', async () => {
    const { state, recording } = harness();
    await state.loadConnection('tracker');
    await state.remove();
    expect(recording.removed).toEqual(['tracker']);
    expect(state.connection).toBeNull();
    expect(recording.changed.at(-1)).toBeUndefined();
  });
});

describe('reading an inspection', () => {
  it('lists the words the tracker does not have, with its own words as the options', () => {
    const report = inspectDto({
      vocabulary: {
        statuses: {
          entries: [
            { boardKey: 'backlog', claimed: 'To Do', verdict: 'ok' },
            { boardKey: 'in_review', claimed: 'In Review', verdict: 'unresolved' },
          ],
          candidates: ['To Do', 'In Progress', 'Done'],
        },
      },
    });
    expect(unresolvedWords(report)).toEqual([
      { block: 'statuses', boardKey: 'in_review', claimed: 'In Review', candidates: ['To Do', 'In Progress', 'Done'] },
    ]);
  });

  it('says what the next push creates and what it will not file', () => {
    expect(
      describePrerequisites(
        inspectDto({ prerequisites: { labels: ['story'], projectFields: 0, sprints: ['S1', 'S2'], canListLabels: true } }),
      ),
    ).toEqual([
      'The next push creates 1 label.',
      '2 periods are not on the tracker. Push a period to create it.',
    ]);
  });

  it('sends no answer that was left alone', () => {
    expect(answersToSend({ connection: { board: '' }, types: {}, statuses: { done: 'Done' } })).toEqual({
      statuses: { done: 'Done' },
    });
  });
});
