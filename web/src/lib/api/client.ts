import type {
  ApiErrorBody,
  BoardSnapshot,
  CommentDto,
  CurrentUserDto,
  GitDisableRequest,
  GitSetupRequest,
  GitSyncRequest,
  GitSyncResponse,
  GitSyncStatusDto,
  GitUrlCheckDto,
  PushFailure,
  RemoteConflictDto,
  RemoteConnectRequestDto,
  RemoteConnectResultDto,
  RemoteConnectionDto,
  RemoteConnectionUpdateDto,
  RemoteCoverageReport,
  RemoteCredentialsRequestDto,
  RemoteCredentialsResultDto,
  RemoteInspectAnswersDto,
  RemoteInspectAnswersResultDto,
  RemoteInspectDto,
  RemoteProviderDto,
  RemoteReadinessFixDto,
  RemoteReadinessFixResultDto,
  RemoteReadinessReport,
  RemotePreviewDto,
  RemoteResolveRequestDto,
  RemoteResolveResultDto,
  RemoteStatusReport,
  RemoteSummaryDto,
  RemoteSyncEventDto,
  RemoteSyncRequestDto,
  ServerInfoDto,
  ViewDocument,
  ViewMode,
  ViewSummary,
} from '$shared';

/**
 * The only place the app talks to the server.
 *
 * Every call is a plain function over `fetch`; there is no client-side cache,
 * because the board is authoritative and the app already keeps the one copy it
 * needs. Failures arrive as `ApiError`, carrying the hints core produced.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
    readonly status = 0,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    });
  } catch (error) {
    throw new ApiError(
      'Cannot reach the light-plan server',
      ['Check that `lpm ui` is running.', (error as Error).message],
      0,
    );
  }

  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const problem = (body ?? {}) as ApiErrorBody;
    throw new ApiError(problem.error ?? response.statusText, problem.details ?? [], response.status);
  }
  return body as T;
}

const send = (method: string, body?: unknown): RequestInit => ({
  method,
  body: body === undefined ? undefined : JSON.stringify(body),
});

/**
 * Stream a sync over the server's event-stream route.
 *
 * Unlike `request`, this reads the body as it arrives: a first push can take
 * minutes of paginated requests, so the panel shows each `progress` event as it
 * lands rather than holding one fetch open silently. A non-2xx (the one-sync
 * guard's 409, a bad remote name) still returns JSON, so that path is shared.
 */
async function streamRemoteSync(
  path: string,
  body: RemoteSyncRequestDto,
  onEvent: (event: RemoteSyncEventDto) => void,
): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError(
      'Cannot reach the light-plan server',
      ['Check that `lpm ui` is running.', (error as Error).message],
      0,
    );
  }

  if (!response.ok) {
    const problem = ((await response.json().catch(() => null)) ?? {}) as ApiErrorBody;
    throw new ApiError(problem.error ?? response.statusText, problem.details ?? [], response.status);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new ApiError('The sync response has no body', [], response.status);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            onEvent(JSON.parse(line.slice('data: '.length)) as RemoteSyncEventDto);
          } catch {
            // A malformed line is not a reason to kill the stream.
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface PushResponse {
  /** Temporary id -> the id the board allocated. */
  idMap: Record<string, string>;
  failures: PushFailure[];
  board: BoardSnapshot;
  view: ViewDocument;
}

export const api = {
  /** Which board, and whether `lpm ui --experimental` turned the tracker remotes on. */
  serverInfo: (): Promise<ServerInfoDto> => request('/api/health'),

  me: (): Promise<CurrentUserDto> => request('/api/me'),

  board: (): Promise<BoardSnapshot> => request('/api/board'),

  listViews: (): Promise<ViewSummary[]> => request('/api/views'),

  createView: (name: string, mode: ViewMode = 'board'): Promise<ViewDocument> =>
    request('/api/views', send('POST', { name, mode })),

  loadView: (id: string): Promise<ViewDocument> => request(`/api/views/${encodeURIComponent(id)}`),

  saveView: (view: ViewDocument): Promise<ViewDocument> =>
    request(`/api/views/${encodeURIComponent(view.id)}`, send('PUT', view)),

  deleteView: (id: string): Promise<void> =>
    request(`/api/views/${encodeURIComponent(id)}`, send('DELETE')),

  push: (view: ViewDocument): Promise<PushResponse> =>
    request(`/api/views/${encodeURIComponent(view.id)}/push`, send('POST', { view })),

  // Comments are written straight through rather than queued in the view: they
  // record what already happened, so holding them back until Push would risk
  // losing them.
  comments: (id: string): Promise<{ comments: CommentDto[] }> =>
    request(`/api/documents/${encodeURIComponent(id)}/comments`),

  addComment: (id: string, body: string): Promise<{ comment: CommentDto; total: number }> =>
    request(`/api/documents/${encodeURIComponent(id)}/comments`, send('POST', { body })),

  deleteComment: (id: string, index: number): Promise<void> =>
    request(
      `/api/documents/${encodeURIComponent(id)}/comments/${index}`,
      send('DELETE'),
    ),

  // Flags are written straight through for the same reason comments are: one
  // says work has stopped *now*, and queueing it until Push would hold back the
  // one edit that cannot wait. `reason: null` clears; both need a comment.
  setFlag: (
    id: string,
    reason: string | null,
    comment: string,
  ): Promise<{ id: string; flag: string | null; comment: number }> =>
    request(`/api/documents/${encodeURIComponent(id)}/flag`, send('POST', { reason, comment })),

  // Remote sync — the same routes `lpm remote` drives, so the browser and the
  // CLI cannot disagree about what a sync will do or what it did.
  listRemotes: (): Promise<RemoteSummaryDto[]> => request('/api/remotes'),

  /**
   * The drift report. `local` skips the remote half entirely and answers in
   * milliseconds; without it every twin is fetched one at a time, which is
   * minutes on a large mirror — hence the `signal`, so a screen can give up.
   */
  remoteStatus: (
    name: string,
    options: { local?: boolean; verbose?: boolean; signal?: AbortSignal } = {},
  ): Promise<RemoteStatusReport> => {
    // `verbose` is what fills the changes table: without the per-field detail a
    // panel can say "3 to push" and nothing about *what* changed, which is the
    // question anybody actually has. It costs no extra request — the detail falls
    // out of the merge the report already computed.
    const query = new URLSearchParams();
    if (options.local === true) query.set('local', '1');
    if (options.verbose === true) query.set('verbose', '1');
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return request(
      `/api/remotes/${encodeURIComponent(name)}/status${suffix}`,
      options.signal ? { signal: options.signal } : undefined,
    );
  },

  /** What the mirror is missing around what it holds — offline, no tracker call. */
  remoteCoverage: (name: string): Promise<RemoteCoverageReport> =>
    request(`/api/remotes/${encodeURIComponent(name)}/coverage`),

  /** What will not land the way the board says — asked before a push writes. */
  remoteReadiness: (name: string, body: { only?: string[] } = {}): Promise<RemoteReadinessReport> =>
    request(`/api/remotes/${encodeURIComponent(name)}/readiness`, send('POST', body)),

  /** Apply the fixes somebody chose in the readiness dialog. */
  remoteReadinessFix: (
    name: string,
    body: RemoteReadinessFixDto,
  ): Promise<RemoteReadinessFixResultDto> =>
    request(`/api/remotes/${encodeURIComponent(name)}/readiness/fix`, send('POST', body)),

  remotePreview: (name: string, body: RemoteSyncRequestDto = {}): Promise<RemotePreviewDto> =>
    request(`/api/remotes/${encodeURIComponent(name)}/preview`, send('POST', body)),

  remoteSync: (
    name: string,
    body: RemoteSyncRequestDto,
    onEvent: (event: RemoteSyncEventDto) => void,
  ): Promise<void> => streamRemoteSync(`/api/remotes/${encodeURIComponent(name)}/sync`, body, onEvent),

  // The conflict panel: one document's conflicted fields, and the decision a
  // person records about them. Resolving never fires a sync — the next sync
  // applies the recorded decision.
  remoteConflict: (name: string, id: string): Promise<RemoteConflictDto> =>
    request(`/api/remotes/${encodeURIComponent(name)}/conflicts/${encodeURIComponent(id)}`),

  resolve: (name: string, body: RemoteResolveRequestDto): Promise<RemoteResolveResultDto> =>
    request(`/api/remotes/${encodeURIComponent(name)}/resolve`, send('POST', body)),

  // Connecting a remote — the connect form and the connection panel. Credential
  // values travel *in* only: every response says where a value comes from and
  // never what it is, so nothing here can hand a token back to the page.
  remoteProviders: (): Promise<RemoteProviderDto[]> => request('/api/remote-providers'),

  connectRemote: (body: RemoteConnectRequestDto): Promise<RemoteConnectResultDto> =>
    request('/api/remotes', send('POST', body)),

  remoteConnection: (name: string): Promise<RemoteConnectionDto> =>
    request(`/api/remotes/${encodeURIComponent(name)}/connection`),

  updateRemoteConnection: (name: string, body: RemoteConnectionUpdateDto): Promise<RemoteConnectionDto> =>
    request(`/api/remotes/${encodeURIComponent(name)}/connection`, send('PUT', body)),

  storeRemoteCredentials: (name: string, body: RemoteCredentialsRequestDto): Promise<RemoteCredentialsResultDto> =>
    request(`/api/remotes/${encodeURIComponent(name)}/credentials`, send('PUT', body)),

  inspectRemote: (name: string, body: { dryRun?: boolean } = {}): Promise<RemoteInspectDto> =>
    request(`/api/remotes/${encodeURIComponent(name)}/inspect`, send('POST', body)),

  answerRemote: (name: string, body: RemoteInspectAnswersDto): Promise<RemoteInspectAnswersResultDto> =>
    request(`/api/remotes/${encodeURIComponent(name)}/answers`, send('POST', body)),

  removeRemote: (name: string): Promise<{ name: string; purged: boolean }> =>
    request(`/api/remotes/${encodeURIComponent(name)}`, send('DELETE')),

  // Sharing the board through its own git repository.
  gitStatus: (fetch = false): Promise<GitSyncStatusDto> => request(`/api/git${fetch ? '?fetch=1' : ''}`),

  checkGitUrl: (body: { url?: string; branch?: string }): Promise<GitUrlCheckDto> =>
    request('/api/git/check', send('POST', body)),

  setupGit: (body: GitSetupRequest): Promise<GitSyncStatusDto> => request('/api/git/setup', send('POST', body)),

  syncGit: (body: GitSyncRequest): Promise<GitSyncResponse> => request('/api/git/sync', send('POST', body)),

  disableGit: (body: GitDisableRequest = {}): Promise<GitSyncStatusDto> =>
    request(`/api/git${body.turnOnRemotes ? '?turnOnRemotes=1' : ''}`, send('DELETE')),

  /** A tracker remote turned off to share through git, back on (`--experimental` servers only). */
  turnRemoteOn: (name: string): Promise<{ name: string }> =>
    request(`/api/remotes/${encodeURIComponent(name)}/on`, send('POST')),
};

