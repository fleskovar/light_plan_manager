import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as flagCommand from '../../src/cli/commands/flag.js';
import * as initCommand from '../../src/cli/commands/init.js';
import * as newCommand from '../../src/cli/commands/new.js';
import * as queueCommand from '../../src/cli/commands/queue.js';
import { boardPathsFor } from '../../src/core/index.js';
import { startBoardServer } from '../../src/server/index.js';
import { api } from '$lib/api/client.js';
import { Workspace } from '$lib/workspace/workspace.svelte.js';
import { buildQueue, markerOf, queueSections, type SectionId } from '$features/queue/queue.js';
import { QueueSequence } from '$features/queue/sequence.svelte.js';

/**
 * The case folders under `test/cases/queue-order/`: one board each, and the
 * queue every reader of that board must see.
 *
 * Each case proves one claim: for a given reader, the command
 * `lpm queue simulate` and the queue panel of the web app show the same work in
 * the same order. The runner drives both for real, in one process:
 *
 *   - The board is built by the `lpm` commands in `inputs/commands.txt`, through
 *     the command modules the CLI dispatches to.
 *   - The terminal side is the text `lpm queue simulate` prints.
 *   - The browser side is the web app's own code: the `api` client talks to a
 *     real server over HTTP, `Workspace` loads the board, `QueueSequence` asks
 *     `GET /api/queue`, and `buildQueue`, `queueSections` and `markerOf` produce
 *     what `QueuePanel.svelte` renders. Only the Svelte markup is left out.
 *
 * Both are compared with each other and with `outputs/`, which a person derived
 * by hand (each case's README has the derivation). Adding a case is adding a
 * folder. `test/cases/queue-order/REVIEW.md` explains how to repeat every step
 * by hand.
 */

const CASES_DIR = fileURLToPath(new URL('../../test/cases/queue-order/', import.meta.url));

interface Audience {
  /** The key this reader has in `outputs/sequence.json` and `outputs/panel.json`. */
  name: string;
  /** The flags that select the reader in `lpm queue simulate`. */
  cli: string[];
  /** The value of "Queue for" in the panel: a resource id, or null for Everyone. */
  queue_for: string | null;
}

interface PanelCard {
  /** The number on the card's marker, or null when the marker shows none. */
  number: number | null;
  id: string;
}

interface PanelQueue {
  in_progress: PanelCard[];
  up_next: PanelCard[];
  waiting: PanelCard[];
}

const caseNames = readdirSync(CASES_DIR).filter((name) =>
  statSync(path.join(CASES_DIR, name)).isDirectory(),
);

function readCase<T>(name: string, ...segments: string[]): T {
  return JSON.parse(readFileSync(path.join(CASES_DIR, name, ...segments), 'utf8')) as T;
}

/** `lpm new story -t "Cart page"` -> ['new', 'story', '-t', 'Cart page']. */
function parseCommand(line: string): string[] {
  const words = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]!);
  if (words[0] !== 'lpm') throw new Error(`A command line must start with "lpm": ${line}`);
  return words.slice(1);
}

function commandsOf(name: string): string[][] {
  return readFileSync(path.join(CASES_DIR, name, 'inputs', 'commands.txt'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(parseCommand);
}

const COMMANDS: Record<string, { run(args: string[]): number }> = {
  init: initCommand,
  new: newCommand,
  flag: flagCommand,
  queue: queueCommand,
};

/** Run one `lpm` command in this process, and return what it printed on stdout. */
function lpm(args: string[]): string {
  const [name, ...rest] = args;
  const command = COMMANDS[name ?? ''];
  if (!command) throw new Error(`The case runner does not know the command "lpm ${name}"`);

  let printed = '';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed += String(chunk);
    return true;
  });
  try {
    const status = command.run(rest);
    if (status !== 0) throw new Error(`lpm ${args.join(' ')} exited with ${status}:\n${printed}`);
  } finally {
    stdout.mockRestore();
  }
  // The colour codes are not part of the text a reader compares.
  return printed.replace(/\u001b\[[0-9;]*m/g, '');
}

/** The ids in the numbered lines `lpm queue simulate` prints, in printed order. */
function printedSequence(output: string): string[] {
  return [...output.matchAll(/^\s+(\d+)\.\s+(\S+)/gm)].map((match) => match[2]!);
}

describe.each(caseNames)('queue-order/%s', (caseName) => {
  const inputs = path.join(CASES_DIR, caseName, 'inputs');
  const audiences = readCase<Audience[]>(caseName, 'inputs', 'audiences.json');
  const expectedSequence = readCase<Record<string, string[]>>(caseName, 'outputs', 'sequence.json');
  const expectedPanel = readCase<Record<string, PanelQueue>>(caseName, 'outputs', 'panel.json');

  let root: string;
  let server: Server;
  let workspace: Workspace;
  const savedEnv = { board: process.env.LPM_BOARD_PATH, user: process.env.LPM_USER };

  beforeAll(async () => {
    root = mkdtempSync(path.join(os.tmpdir(), 'lpm-queue-case-'));
    // A developer's own shell must not choose the board or the reader.
    delete process.env.LPM_USER;
    process.env.LPM_BOARD_PATH = path.join(root, '.lpm');

    for (const args of commandsOf(caseName)) {
      if (args[0] !== 'init') {
        lpm(args);
        continue;
      }
      // `lpm init` reads the template from the working folder and creates the
      // board there. The runner names both folders instead of changing folder.
      const template = args.indexOf('--template');
      const located = args.map((word, index) =>
        index === template + 1 ? path.join(inputs, word) : word,
      );
      lpm([...located, root]);
    }

    const running = await startBoardServer(boardPathsFor(root), { port: 0, serveApp: false });
    server = running.server;
    // The web client asks for `/api/...` relative to the page it runs in.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      realFetch(new URL(String(input), running.url), init),
    );

    const view = await api.createView('Queue case');
    workspace = new Workspace();
    await workspace.open(view.id);
  });

  afterAll(() => {
    workspace?.dispose();
    server?.close();
    vi.unstubAllGlobals();
    if (savedEnv.board === undefined) delete process.env.LPM_BOARD_PATH;
    else process.env.LPM_BOARD_PATH = savedEnv.board;
    if (savedEnv.user !== undefined) process.env.LPM_USER = savedEnv.user;
    rmSync(root, { recursive: true, force: true });
  });

  /** The queue panel for one reader, as `QueuePanel.svelte` computes it. */
  async function panelFor(audience: Audience): Promise<PanelQueue> {
    const sequence = new QueueSequence();
    await sequence.refresh(workspace.snapshot!, audience.queue_for);
    expect(sequence.error).toBeNull();

    const queue = buildQueue(
      workspace.nodes,
      workspace.config,
      { resourceId: audience.queue_for, sequence: sequence.steps },
      workspace.index,
    );
    const sections = queueSections(queue);
    const cardsOf = (id: SectionId): PanelCard[] => {
      const section = sections.find((entry) => entry.id === id)!;
      return section.cards.map((card, position) => {
        const marker = markerOf(card, section, position, sequence.steps !== null);
        return { number: /^\d+$/.test(marker) ? Number(marker) : null, id: card.issue.id };
      });
    };
    return { in_progress: cardsOf('now'), up_next: cardsOf('next'), waiting: cardsOf('waiting') };
  }

  it.each(audiences)('$name: lpm queue simulate and the queue panel show the same order', async (audience) => {
    const terminal = printedSequence(lpm(['queue', 'simulate', ...audience.cli]));
    const panel = await panelFor(audience);
    const numbered = [...panel.in_progress, ...panel.up_next, ...panel.waiting]
      .filter((card) => card.number !== null)
      .sort((a, b) => a.number! - b.number!);

    // The claim: read the numbered cards in number order, and they are the
    // lines the terminal printed.
    expect(numbered.map((card) => card.id)).toEqual(terminal);
    expect(numbered.map((card) => card.number)).toEqual(terminal.map((_, index) => index + 1));

    // And both are the order a person derived by hand in the case's README.
    expect(terminal).toEqual(expectedSequence[audience.name]);
    expect(panel).toEqual(expectedPanel[audience.name]);
  });
});
