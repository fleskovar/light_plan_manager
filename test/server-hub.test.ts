import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { USER_HOME_ENV_VAR, initBoard } from '../src/core/index.js';
import type { DesktopCommand } from '../src/server/desktop.js';
import { desktopCommand } from '../src/server/desktop.js';
import type { RunningHub } from '../src/server/hub.js';
import { startHubServer } from '../src/server/hub.js';

// The hub is what `lpm ui` serves outside a board when a central store is set
// (LPM-34): the list of central boards, and a way to open or reveal each one.

const scratch: string[] = [];
let home: string;
let store: string;
let hub: RunningHub | null = null;
let launched: DesktopCommand[];
const savedHome = process.env[USER_HOME_ENV_VAR];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function centralProject(name: string, prefix: string): string {
  const root = path.join(tempDir('lpm-parent-'), name);
  mkdirSync(root);
  initBoard({ root, prefix, git: false, omni: false, store: 'central' });
  return root;
}

async function startHub(): Promise<RunningHub> {
  hub = await startHubServer({
    port: 0,
    boardPort: 0,
    serveApp: false,
    desktopLauncher: async (command) => {
      launched.push(command);
    },
  });
  return hub;
}

async function get(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}

async function post(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { method: 'POST' });
  return { status: response.status, body: await response.json() };
}

beforeEach(() => {
  launched = [];
  home = tempDir('lpm-home-');
  store = tempDir('lpm-store-');
  process.env[USER_HOME_ENV_VAR] = home;
  writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ central_store: store }));
});

afterEach(async () => {
  await hub?.close();
  hub = null;
  if (savedHome === undefined) delete process.env[USER_HOME_ENV_VAR];
  else process.env[USER_HOME_ENV_VAR] = savedHome;
});

afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

describe('the hub server', () => {
  it('answers GET /api/hub with hub: true and the central store', async () => {
    const { url } = await startHub();
    const { status, body } = await get(`${url}/api/hub`);
    expect(status).toBe(200);
    expect(body).toEqual({ hub: true, store, boardsDir: path.join(store, '.lpm_central') });
  });

  it('says in /api/health that it is a hub, so serveBoard never mistakes it for a board', async () => {
    const { url } = await startHub();
    const { body } = await get(`${url}/api/health`);
    expect(body).toMatchObject({ ok: true, hub: true });
  });

  it('lists the central boards on GET /api/hub/boards', async () => {
    const shop = centralProject('shop', 'SHOP');
    centralProject('blog', 'BLOG');
    const { url } = await startHub();

    const { status, body } = await get(`${url}/api/hub/boards`);

    expect(status).toBe(200);
    const entries = body as { name: string; keyPrefix: string; projectPath: string }[];
    expect(entries.map((entry) => entry.name)).toEqual(['blog', 'shop']);
    expect(entries[1]).toMatchObject({ keyPrefix: 'SHOP', projectPath: shop, pointerOk: true });
  });

  it('starts a board server on POST /open, and returns the same URL on a second call', async () => {
    centralProject('shop', 'SHOP');
    const { url } = await startHub();

    const first = await post(`${url}/api/hub/boards/shop/open`);
    const second = await post(`${url}/api/hub/boards/shop/open`);

    expect(first.status).toBe(200);
    const boardUrl = (first.body as { url: string }).url;
    expect(boardUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((second.body as { url: string }).url).toBe(boardUrl);
    const board = await get(`${boardUrl}/api/board`);
    expect(board.status).toBe(200);
    expect((board.body as { config: { keyPrefix?: string; key_prefix?: string } }).config).toBeDefined();
  });

  it('reveals <project>/.lpm on POST /reveal, with the path from project.json', async () => {
    const shop = centralProject('shop', 'SHOP');
    const { url } = await startHub();

    const { status } = await post(`${url}/api/hub/boards/shop/reveal`);

    expect(status).toBe(200);
    expect(launched).toEqual([desktopCommand('reveal', path.join(shop, '.lpm'))]);
  });

  it('answers 404 for a name that is not in the list, and runs nothing', async () => {
    centralProject('shop', 'SHOP');
    const { url } = await startHub();
    expect((await post(`${url}/api/hub/boards/blog/open`)).status).toBe(404);
    expect((await post(`${url}/api/hub/boards/blog/reveal`)).status).toBe(404);
    expect(launched).toEqual([]);
  });

  it('answers 404 for a name that holds .. or a slash', async () => {
    centralProject('shop', 'SHOP');
    const { url } = await startHub();
    for (const name of ['..', '..%2Fshop', 'shop%2F..', '..%5Cshop']) {
      expect((await post(`${url}/api/hub/boards/${name}/reveal`)).status).toBe(404);
    }
    expect(launched).toEqual([]);
  });

  it('refuses to reveal a board whose project is unknown', async () => {
    centralProject('shop', 'SHOP');
    rmSync(path.join(store, '.lpm_central', 'shop', 'project.json'));
    const { url } = await startHub();
    const { status } = await post(`${url}/api/hub/boards/shop/reveal`);
    expect(status).toBe(409);
    expect(launched).toEqual([]);
  });
});
