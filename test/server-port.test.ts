import { createServer as createHttpServer } from 'node:http';
import type { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { probeBoardServer, serveBoard, startBoardServer } from '../src/server/index.js';
import { cleanupBoards, makeBoard } from './helpers.js';

afterAll(cleanupBoards);

/**
 * `lpm ui` without --port searches upward from 4571, so each board in its own
 * `lpm ui` gets its own port. These cases hold a port with another process and
 * check what `serveBoard` does with the next one.
 */
const open: Array<Server | NetServer> = [];

afterEach(async () => {
  await Promise.all(
    open.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

/** Listen on a free loopback port and return that port. */
function listen(server: Server | NetServer): Promise<number> {
  open.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
}

/** An HTTP server that answers 404 to every request, as a program that is not `lpm ui` does. */
const stranger = (): Server =>
  createHttpServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

const portOf = (url: string): number => Number(new URL(url).port);

describe('serveBoard', () => {
  it('takes the next free port when another program holds the first one', async () => {
    const blocked = await listen(stranger());
    const outcome = await serveBoard(makeBoard('scrum', 'LP'), {
      port: blocked,
      portAttempts: 5,
      serveApp: false,
    });

    expect(outcome.kind).toBe('started');
    if (outcome.kind !== 'started') return;
    open.push(outcome.server);
    expect(portOf(outcome.url)).toBeGreaterThan(blocked);
    expect(portOf(outcome.url)).toBeLessThanOrEqual(blocked + 4);
  });

  it('starts a second board next to a first board', async () => {
    const first = await startBoardServer(makeBoard('scrum', 'AA'), { port: 0, serveApp: false });
    open.push(first.server);
    const second = makeBoard('scrum', 'BB');
    const outcome = await serveBoard(second, {
      port: portOf(first.url),
      portAttempts: 5,
      serveApp: false,
    });

    expect(outcome.kind).toBe('started');
    if (outcome.kind !== 'started') return;
    open.push(outcome.server);
    expect(outcome.url).not.toBe(first.url);
    expect(await probeBoardServer('127.0.0.1', portOf(outcome.url))).toBe(second.root);
  });

  it('returns the address of an lpm ui that already serves the same board', async () => {
    const paths = makeBoard('scrum', 'LP');
    const first = await startBoardServer(paths, { port: 0, serveApp: false });
    open.push(first.server);
    const outcome = await serveBoard(paths, {
      port: portOf(first.url),
      portAttempts: 5,
      serveApp: false,
    });

    // No second server: two servers on one board would each hold a draft.
    expect(outcome).toEqual({ kind: 'running', url: first.url });
  });

  it('tries only the named port when portAttempts is left out', async () => {
    const blocked = await listen(stranger());
    const outcome = await serveBoard(makeBoard('scrum', 'LP'), { port: blocked, serveApp: false });

    expect(outcome).toEqual({ kind: 'taken', taken: [{ port: blocked, root: null }] });
  });

  it('reports the board root of each lpm ui that holds a port', async () => {
    const other = makeBoard('scrum', 'AA');
    const first = await startBoardServer(other, { port: 0, serveApp: false });
    open.push(first.server);
    const outcome = await serveBoard(makeBoard('scrum', 'BB'), {
      port: portOf(first.url),
      serveApp: false,
    });

    expect(outcome).toEqual({
      kind: 'taken',
      taken: [{ port: portOf(first.url), root: other.root }],
    });
  });
});

describe('probeBoardServer', () => {
  it('gives up on a port that accepts the connection and never answers', async () => {
    // The test destroys each socket that the server accepted, so `close` in afterEach does not wait for it.
    const server = createNetServer();
    const sockets: Socket[] = [];
    server.on('connection', (socket) => sockets.push(socket));
    const silent = await listen(server);
    const started = Date.now();

    try {
      expect(await probeBoardServer('127.0.0.1', silent, 200)).toBeNull();
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      sockets.forEach((socket) => socket.destroy());
    }
  });
});
