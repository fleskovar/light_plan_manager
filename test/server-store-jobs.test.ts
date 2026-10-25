import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import { USER_HOME_ENV_VAR, createIssue, findBoardPaths, initBoard, loadBoard, recordProject } from '../src/core/index.js';
import type { BackupListDto, BoardStoreInfoDto, StoreJobDto } from '../src/shared/index.js';
import { startHubServer } from '../src/server/hub.js';
import { startBoardServer } from '../src/server/index.js';
import { storeJobs } from '../src/server/jobs.js';

// The background jobs of `lpm ui`: POST /api/projects/move, /backup and
// /restore start a job, GET /api/projects/jobs lists the jobs, and a board
// server that moves its own board serves it from the new folder afterwards.

const scratch: string[] = [];
let home: string;
let store: string;
let running: { close(): Promise<void> }[];
const savedHome = process.env[USER_HOME_ENV_VAR];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function project(name: string, where: 'local' | 'central' = 'local'): BoardPaths {
  const root = path.join(tempDir('lpm-parent-'), name);
  mkdirSync(root);
  const paths = initBoard({ root, template: 'scrum', prefix: 'SH', git: false, omni: false, store: where }).paths;
  createIssue(loadBoard(paths), { type: 'program', title: 'First' });
  recordProject(paths);
  return paths;
}

function closer(server: Server): { close(): Promise<void> } {
  return {
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

async function boardServer(paths: BoardPaths): Promise<string> {
  const started = await startBoardServer(paths, { port: 0, serveApp: false, boardPort: 0 });
  running.push(closer(started.server), { close: () => started.launcher.close() });
  return started.url;
}

async function get<T>(url: string): Promise<{ status: number; body: T }> {
  const response = await fetch(url);
  return { status: response.status, body: (await response.json()) as T };
}

async function post<T>(url: string, body: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

/** Wait for the job that a route started, and return how it ended. */
async function finished(job: StoreJobDto): Promise<StoreJobDto> {
  return (await storeJobs.settled(job.id))!;
}

beforeEach(() => {
  running = [];
  home = tempDir('lpm-home-');
  store = tempDir('lpm-store-');
  process.env[USER_HOME_ENV_VAR] = home;
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ central_store: store }));
});

afterEach(async () => {
  for (const server of running.reverse()) await server.close();
  if (savedHome === undefined) delete process.env[USER_HOME_ENV_VAR];
  else process.env[USER_HOME_ENV_VAR] = savedHome;
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('a board server that moves its own board', () => {
  it('answers 202 with a running job, moves the board, and serves it from the central store after', async () => {
    const shop = project('shop');
    const url = await boardServer(shop);

    const started = await post<StoreJobDto>(`${url}/api/projects/move`, { lpmDir: shop.lpmDir, to: 'central' });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ kind: 'move', root: shop.root, to: 'central', state: 'running' });

    const ended = await finished(started.body);
    expect(ended.state).toBe('done');
    expect(ended.message).toContain('Moved shop to the central store');
    expect(ended.notes.join(' ')).toContain('.lpm_backups');

    const central = path.join(store, '.lpm_central', 'shop');
    expect(findBoardPaths(shop.root)!.lpmDir).toBe(central);
    const self = await get<BoardStoreInfoDto>(`${url}/api/projects/self`);
    expect(self.body).toMatchObject({ store: 'central', lpmDir: central });
    expect(self.body.backup?.name).toBe('shop_backup');
    const board = await get<{ issues: { title: string }[] }>(`${url}/api/board`);
    expect(board.status).toBe(200);
    expect(board.body.issues.map((issue) => issue.title)).toEqual(['First']);

    const jobs = await get<StoreJobDto[]>(`${url}/api/projects/jobs`);
    expect(jobs.body.some((job) => job.id === started.body.id && job.state === 'done')).toBe(true);
  });

  it('refuses a move to the store that holds the board, an unknown board and an unknown target', async () => {
    const shop = project('shop');
    const url = await boardServer(shop);
    expect((await post(`${url}/api/projects/move`, { lpmDir: shop.lpmDir, to: 'local' })).status).toBe(409);
    expect((await post(`${url}/api/projects/move`, { lpmDir: '/nowhere/.lpm', to: 'central' })).status).toBe(404);
    expect((await post(`${url}/api/projects/move`, { lpmDir: shop.lpmDir, to: 'away' })).status).toBe(400);
  });
});

describe('backups over HTTP', () => {
  it('creates the first backup without a word, and replaces it only with the word "backup"', async () => {
    const shop = project('shop');
    const url = await boardServer(shop);

    const first = await post<StoreJobDto>(`${url}/api/projects/backup`, { lpmDir: shop.lpmDir });
    expect(first.status).toBe(202);
    expect((await finished(first.body)).state).toBe('done');

    const refused = await post<{ error: string }>(`${url}/api/projects/backup`, { lpmDir: shop.lpmDir });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('already has a backup');

    const replaced = await post<StoreJobDto>(`${url}/api/projects/backup`, { lpmDir: shop.lpmDir, confirm: 'backup' });
    expect(replaced.status).toBe(202);
    expect((await finished(replaced.body)).state).toBe('done');

    const list = await get<BackupListDto>(`${url}/api/projects/backups`);
    expect(list.body.store).toBe(store);
    expect(list.body.backups.map((backup) => [backup.name, backup.projectPath])).toEqual([['shop_backup', shop.root]]);
  });

  it('restores only with the word "restore", and overwrites the board', async () => {
    const shop = project('shop');
    const url = await boardServer(shop);
    await finished((await post<StoreJobDto>(`${url}/api/projects/backup`, { lpmDir: shop.lpmDir })).body);
    createIssue(loadBoard(shop), { type: 'program', title: 'Later' });

    expect((await post(`${url}/api/projects/restore`, { name: 'shop_backup' })).status).toBe(400);
    expect((await post(`${url}/api/projects/restore`, { name: '../shop_backup', confirm: 'restore' })).status).toBe(404);

    const started = await post<StoreJobDto>(`${url}/api/projects/restore`, { name: 'shop_backup', confirm: 'restore' });
    expect(started.status).toBe(202);
    expect((await finished(started.body)).state).toBe('done');
    expect(loadBoard(shop).issues.map((issue) => issue.title)).toEqual(['First']);
  });
});

describe('the hub', () => {
  it('moves a central board into its project in the background', async () => {
    const blog = project('blog', 'central');
    const hub = await startHubServer({ port: 0, boardPort: 0, serveApp: false });
    running.push(hub);

    const started = await post<StoreJobDto>(`${hub.url}/api/projects/move`, { lpmDir: blog.lpmDir, to: 'local' });
    expect(started.status).toBe(202);
    const ended = await finished(started.body);

    expect(ended.state).toBe('done');
    expect(findBoardPaths(blog.root)!.lpmDir).toBe(path.join(blog.root, '.lpm'));
    expect(existsSync(blog.lpmDir)).toBe(false);
    expect(existsSync(path.join(store, '.lpm_backups', 'blog_backup', 'board', 'config.yml'))).toBe(true);
  });
});
