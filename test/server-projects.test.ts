import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardPaths } from '../src/core/index.js';
import { USER_HOME_ENV_VAR, initBoard, recordProject } from '../src/core/index.js';
import type { DesktopCommand } from '../src/server/desktop.js';
import { desktopCommand } from '../src/server/desktop.js';
import type { RunningHub } from '../src/server/hub.js';
import { startHubServer } from '../src/server/hub.js';
import { startBoardServer } from '../src/server/index.js';
import { createView } from '../src/server/views/store.js';

// The project routes (LPM-52): a board server and the hub both list every
// project of the index, open any of them, and reveal its .lpm folder.

const scratch: string[] = [];
let home: string;
let store: string;
let launched: DesktopCommand[];
let running: { close(): Promise<void> }[];
const savedHome = process.env[USER_HOME_ENV_VAR];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function project(name: string, where: 'local' | 'central'): BoardPaths {
  const root = path.join(tempDir('lpm-parent-'), name);
  mkdirSync(root);
  return initBoard({ root, prefix: name.slice(0, 2).toUpperCase(), git: false, omni: false, store: where }).paths;
}

const recorder = async (command: DesktopCommand): Promise<void> => {
  launched.push(command);
};

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
  const started = await startBoardServer(paths, { port: 0, serveApp: false, desktopLauncher: recorder, boardPort: 0 });
  running.push(closer(started.server), { close: () => started.launcher.close() });
  return started.url;
}

async function hub(): Promise<RunningHub> {
  const started = await startHubServer({ port: 0, boardPort: 0, serveApp: false, desktopLauncher: recorder });
  running.push(started);
  return started;
}

async function get(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

async function post(url: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

let shop: BoardPaths;
let blog: BoardPaths;

beforeEach(() => {
  launched = [];
  running = [];
  home = tempDir('lpm-home-');
  store = tempDir('lpm-store-');
  process.env[USER_HOME_ENV_VAR] = home;
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ central_store: store }));
  shop = project('shop', 'local');
  blog = project('blog', 'central');
  recordProject(shop);
});

afterEach(async () => {
  for (const server of running.reverse()) await server.close();
  if (savedHome === undefined) delete process.env[USER_HOME_ENV_VAR];
  else process.env[USER_HOME_ENV_VAR] = savedHome;
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('the project routes on a board server', () => {
  it('lists local and central projects on GET /api/projects', async () => {
    const url = await boardServer(shop);
    const { status, body } = await get(`${url}/api/projects`);
    expect(status).toBe(200);
    expect((body as { name: string; store: string }[]).map((entry) => [entry.name, entry.store])).toEqual([
      ['blog', 'central'],
      ['shop', 'local'],
    ]);
  });

  it('answers open for its own board with its own URL', async () => {
    const url = await boardServer(shop);
    const { status, body } = await post(`${url}/api/projects/open`, { lpmDir: shop.lpmDir });
    expect(status).toBe(200);
    expect((body as { url: string }).url).toBe(url);
  });

  it('starts a board server for another board, and returns the same URL on a second call', async () => {
    const url = await boardServer(shop);

    const first = await post(`${url}/api/projects/open`, { lpmDir: blog.lpmDir });
    const second = await post(`${url}/api/projects/open`, { lpmDir: blog.lpmDir });

    const blogUrl = (first.body as { url: string }).url;
    expect(first.status).toBe(200);
    expect(blogUrl).not.toBe(url);
    expect((second.body as { url: string }).url).toBe(blogUrl);
    const health = await get(`${blogUrl}/api/health`);
    expect((health.body as { root: string }).root).toBe(blog.root);
  });

  it('reveals <root>/.lpm of an entry', async () => {
    const url = await boardServer(shop);
    const { status } = await post(`${url}/api/projects/reveal`, { lpmDir: blog.lpmDir });
    expect(status).toBe(200);
    expect(launched).toEqual([desktopCommand('reveal', path.join(blog.root, '.lpm'))]);
  });

  it('answers 404 for a board folder that is not in the list, and runs nothing', async () => {
    const url = await boardServer(shop);
    const elsewhere = tempDir('lpm-elsewhere-');
    expect((await post(`${url}/api/projects/open`, { lpmDir: elsewhere })).status).toBe(404);
    expect((await post(`${url}/api/projects/reveal`, { lpmDir: elsewhere })).status).toBe(404);
    expect((await post(`${url}/api/projects/open`, {})).status).toBe(404);
    expect(launched).toEqual([]);
  });

  it('answers 409 for a project in the state missing', async () => {
    const gone = project('gone', 'local');
    recordProject(gone);
    rmSync(gone.root, { recursive: true, force: true });
    const url = await boardServer(shop);
    expect((await post(`${url}/api/projects/open`, { lpmDir: gone.lpmDir })).status).toBe(409);
    expect((await post(`${url}/api/projects/views`, { lpmDir: gone.lpmDir })).status).toBe(409);
  });

  it('lists the views of another board, with the description of each', async () => {
    createView(blog, 'Roadmap', 'board', 'Epics of 2026, by quarter');
    createView(blog, 'Patterns', 'templates');
    const url = await boardServer(shop);

    const { status, body } = await post(`${url}/api/projects/views`, { lpmDir: blog.lpmDir });

    expect(status).toBe(200);
    const views = body as { id: string; name: string; description: string; mode: string }[];
    expect(views.map((view) => [view.id, view.description, view.mode]).sort()).toEqual([
      ['patterns', '', 'templates'],
      ['roadmap', 'Epics of 2026, by quarter', 'board'],
    ]);
    expect((await post(`${url}/api/projects/views`, { lpmDir: shop.lpmDir })).body).toEqual([]);
    expect((await post(`${url}/api/projects/views`, { lpmDir: tempDir('lpm-elsewhere-') })).status).toBe(404);
  });
});

describe('the project routes on the hub', () => {
  it('lists every project, and opens a local one', async () => {
    const { url } = await hub();

    const list = await get(`${url}/api/projects`);
    const opened = await post(`${url}/api/projects/open`, { lpmDir: shop.lpmDir });

    expect((list.body as { name: string }[]).map((entry) => entry.name)).toEqual(['blog', 'shop']);
    expect(opened.status).toBe(200);
    const health = await get(`${(opened.body as { url: string }).url}/api/health`);
    expect((health.body as { root: string }).root).toBe(shop.root);
  });
});
