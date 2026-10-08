import type { BoardPaths, GitHost } from '../../core/index.js';
import {
  GIT_HOSTS,
  PROJECT_BOARD_BRANCH,
  checkGitUrl,
  describeFiles,
  disableGitSync,
  gitSyncStatus,
  loadConfig,
  projectRepository,
  sameRepositoryUrl,
  setupGitSync,
  syncBoard,
} from '../../core/index.js';
import type {
  GitHostDto,
  GitSetupRequest,
  GitSyncRequest,
  GitSyncResponse,
  GitSyncStatusDto,
  GitUrlCheckDto,
} from '../../shared/index.js';
import { HttpError, readJson, sendJson } from '../http/respond.js';
import type { Router } from '../http/router.js';

/**
 * Sharing the board through git, from the Sync tab: read where it stands,
 * check a URL, set it up, sync on demand, settle a conflict, turn it off.
 *
 * Thin over `operations/git-sync.ts`, like `lpm git`. Nothing here ever asks
 * for or returns a credential — git authenticates with whatever it already
 * uses — and nothing here can prompt: a URL git cannot reach without a
 * password is reported as unreachable, with the host's hint, rather than
 * leaving a request hanging on a terminal nobody is at.
 */
export function gitRoutes(router: Router, paths: BoardPaths): void {
  router.get('/api/git', ({ res, query }) => {
    sendJson(res, 200, statusOf(paths, query.get('fetch') === '1'));
  });

  router.post('/api/git/check', async ({ req, res }) => {
    const body = await readJson<{ url?: string; branch?: string }>(req);
    const url = body.url?.trim() || projectRepository(paths)?.url || '';
    if (!url) throw new HttpError(400, 'Give the URL of a repository to check');
    const check = checkGitUrl(paths.root, url, body.branch?.trim() || defaultBranch(paths, url));
    const dto: GitUrlCheckDto = { ...check, host: hostDto(check.host) };
    sendJson(res, 200, dto);
  });

  router.post('/api/git/setup', async ({ req, res }) => {
    const body = await readJson<GitSetupRequest>(req);
    setupGitSync(paths, {
      url: body.url?.trim() || undefined,
      branch: body.branch?.trim() || undefined,
      project: body.project === true,
      turnOffRemotes: body.turnOffRemotes === true,
    });
    sendJson(res, 200, statusOf(paths, false));
  });

  router.post('/api/git/sync', async ({ req, res }) => {
    const body = await readJson<GitSyncRequest>(req);
    if (body.resolve !== undefined && body.resolve !== 'ours' && body.resolve !== 'theirs') {
      throw new HttpError(400, 'resolve must be "ours" or "theirs"');
    }
    const result = syncBoard(paths, { resolve: body.resolve });
    const response: GitSyncResponse = {
      saved: result.saved.length,
      pulled: result.pulled.kind,
      pushed: result.pushed,
      status: statusOf(paths, false),
    };
    sendJson(res, 200, response);
  });

  router.delete('/api/git', ({ res, query }) => {
    disableGitSync(paths, { turnOnRemotes: query.get('turnOnRemotes') === '1' });
    sendJson(res, 200, statusOf(paths, false));
  });
}

function defaultBranch(paths: BoardPaths, url: string): string {
  const project = projectRepository(paths);
  return project && sameRepositoryUrl(project.url, url) ? PROJECT_BOARD_BRANCH : 'main';
}

function hostDto(host: GitHost): GitHostDto {
  return {
    id: host.id,
    label: host.label,
    examples: [...host.examples],
    create: host.create,
    credentials: host.credentials,
  };
}

function statusOf(paths: BoardPaths, fetch: boolean): GitSyncStatusDto {
  const loaded = loadConfig(paths);
  if (!loaded.config) throw new HttpError(400, 'The board config does not validate', loaded.errors);
  const status = gitSyncStatus(paths, loaded.config, { fetch });
  return {
    ...status,
    host: status.host ? hostDto(status.host) : null,
    project: status.project ? { ...status.project, host: hostDto(status.project.host) } : null,
    conflict: status.conflict
      ? { ...status.conflict, documents: describeFiles(status.conflict.paths) }
      : null,
    hosts: GIT_HOSTS.map(hostDto),
    projectBranch: PROJECT_BOARD_BRANCH,
  };
}
