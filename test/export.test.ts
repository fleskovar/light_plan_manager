import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import {
  createIssue,
  createPeriod,
  createResource,
  findIssue,
  linkIssue,
  moveNode,
} from '../src/core/index.js';
import {
  STATIC_BOARD_VERSION,
  emptyView,
  parseStaticBoard,
  type StaticBoard,
} from '../src/shared/index.js';
import { toStaticBoard } from '../src/sync/index.js';
import { cleanupBoards, makeBoard, reload } from './helpers.js';

/**
 * Publishing a board as a static site.
 *
 * The engine-side half is `toStaticBoard`; the CLI half is checked against the
 * built binary, the way `cli.test.ts` does, because `--site` copies a bundle
 * whose location is resolved from the package layout.
 */
const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));
const VIEWER_BUILT = existsSync(
  fileURLToPath(new URL('../web/dist-viewer/index.html', import.meta.url)),
);

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'lpm-export-'));
  dirs.push(dir);
  return dir;
}

function lpm(cwd: string, ...args: string[]): { status: number; out: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: result.status ?? 0, out: (result.stdout ?? '') + (result.stderr ?? '') };
}

afterEach(() => cleanupBoards());
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('toStaticBoard', () => {
  it('carries the same snapshot the server would serve', () => {
    const paths = makeBoard();
    createIssue(reload(paths), { type: 'program', title: 'Platform' });
    createPeriod(reload(paths), {
      type: 'increment',
      title: '2026 H2',
      starts: '2026-07-01',
      ends: '2026-12-31',
    });
    createResource(reload(paths), { type: 'person', title: 'Ada' });

    const data = toStaticBoard(reload(paths), [], 'light-plan test');

    expect(data.version).toBe(STATIC_BOARD_VERSION);
    expect(data.generator).toBe('light-plan test');
    expect(data.board.issues.map((issue) => issue.title)).toEqual(['Platform']);
    expect(data.board.periods).toHaveLength(1);
    expect(data.board.resources).toHaveLength(1);
    expect(data.board.config.boardName).toBe(path.basename(paths.root));
  });

  it('keeps a view but drops members the board does not have', () => {
    const paths = makeBoard();
    const program = createIssue(reload(paths), { type: 'program', title: 'Platform' });

    const view = emptyView('roadmap', 'Roadmap');
    view.members = [program.id, 'LP-999', 'new:1'];
    view.layout = {
      [program.id]: { x: 10, y: 20, collapsed: true },
      'new:1': { x: 0, y: 0 },
    };

    const data = toStaticBoard(reload(paths), [view], 'light-plan test');

    expect(data.views).toHaveLength(1);
    // The unpushed create and the id that never existed both go.
    expect(data.views[0]!.members).toEqual([program.id]);
    expect(Object.keys(data.views[0]!.layout)).toEqual([program.id]);
    expect(data.views[0]!.layout[program.id]).toEqual({ x: 10, y: 20, collapsed: true });
  });

  it('never publishes a view’s unpushed changes', () => {
    const paths = makeBoard();
    const view = emptyView('roadmap', 'Roadmap');
    view.changes = [
      { kind: 'create', id: 'new:1', nodeKind: 'issue', patch: { type: 'program', title: 'Secret' } },
    ];

    const data = toStaticBoard(reload(paths), [view], 'light-plan test');

    expect(JSON.stringify(data)).not.toContain('Secret');
    expect(data.views[0]).not.toHaveProperty('changes');
  });

  it('survives a round trip through parseStaticBoard', () => {
    const paths = makeBoard();
    const a = createIssue(reload(paths), { type: 'program', title: 'A' });
    const b = createIssue(reload(paths), { type: 'program', title: 'B' });
    linkIssue(reload(paths), findIssue(reload(paths), b.id)!, { dependsOn: [a.id] });
    moveNode(reload(paths), findIssue(reload(paths), b.id)!, { status: 'in_progress' });

    const data = toStaticBoard(reload(paths), [], 'light-plan test');
    const parsed = parseStaticBoard(JSON.parse(JSON.stringify(data)) as unknown);
    const round = parsed.board.issues.find((issue) => issue.id === b.id);

    expect(round?.dependsOn).toEqual([a.id]);
    expect(round?.status).toBe('in_progress');
  });
});

describe('parseStaticBoard', () => {
  const valid = (): unknown => ({
    version: STATIC_BOARD_VERSION,
    generated: '',
    generator: '',
    board: { config: {}, issues: [], periods: [], resources: [], problems: [], readAt: '' },
    views: [],
  });

  it('rejects something that is not an export', () => {
    expect(() => parseStaticBoard(null)).toThrow(/not a light-plan export/);
    expect(() => parseStaticBoard({ hello: 'world' })).toThrow(/not a light-plan export/);
  });

  it('rejects an export with no board in it', () => {
    expect(() => parseStaticBoard({ version: 1 })).toThrow(/no board/);
  });

  it('names the version it cannot read', () => {
    expect(() => parseStaticBoard({ ...(valid() as object), version: 99 })).toThrow(
      /newer light-plan/,
    );
  });

  it('accepts a well-formed export', () => {
    expect(parseStaticBoard(valid()).views).toEqual([]);
  });

  it('fills in list fields an older export predates', () => {
    // A page deployed today fetches boards exported months ago. The version
    // guard only refuses a file *newer* than the reader, so an older one has to
    // keep working — and a missing list would become the first `.length` in the
    // viewer and blank the page.
    const old = valid() as { board: { issues: unknown[] } };
    old.board.issues = [{ kind: 'issue', id: 'LP-1', title: 'Written before all this' }];

    const [issue] = parseStaticBoard(old).board.issues;
    expect(issue!.dependsOn).toEqual([]);
    expect(issue!.relatesTo).toEqual([]);
    expect(issue!.relatedFiles).toEqual([]);
    expect(issue!.flag).toBeNull();
  });

  it('leaves a list the export does carry alone', () => {
    const current = valid() as { board: { issues: unknown[] } };
    current.board.issues = [
      { kind: 'issue', id: 'LP-1', relatedFiles: ['src/a.ts'], flag: 'blocked' },
    ];
    const [issue] = parseStaticBoard(current).board.issues;
    expect(issue!.relatedFiles).toEqual(['src/a.ts']);
    expect(issue!.flag).toBe('blocked');
  });
});

describe('lpm export', () => {
  it('writes .lpm/board.json by default', () => {
    const paths = makeBoard();
    lpm(paths.root, 'new', 'program', '-t', 'Platform');

    const run = lpm(paths.root, 'export');
    expect(run.status).toBe(0);
    expect(run.out).toContain('1 issue');

    const file = path.join(paths.lpmDir, 'board.json');
    const data = parseStaticBoard(JSON.parse(readFileSync(file, 'utf8')) as unknown);
    expect(data.board.issues.map((issue) => issue.title)).toEqual(['Platform']);
  });

  it('writes where --out says, and only there', () => {
    const paths = makeBoard();
    const run = lpm(paths.root, 'export', '--out', 'public/data.json', '--pretty');

    expect(run.status).toBe(0);
    expect(existsSync(path.join(paths.root, 'public', 'data.json'))).toBe(true);
    expect(existsSync(path.join(paths.lpmDir, 'board.json'))).toBe(false);
    // --pretty is the only reason to indent, so check it took.
    expect(readFileSync(path.join(paths.root, 'public', 'data.json'), 'utf8')).toContain('\n  "');
  });

  it.skipIf(!VIEWER_BUILT)('builds a complete site with --site', () => {
    const paths = makeBoard();
    lpm(paths.root, 'new', 'program', '-t', 'Platform');

    const run = lpm(paths.root, 'export', '--site', 'docs');
    expect(run.status).toBe(0);

    const site = path.join(paths.root, 'docs');
    expect(existsSync(path.join(site, 'index.html'))).toBe(true);
    expect(existsSync(path.join(site, 'board.json'))).toBe(true);
    // Pages runs Jekyll otherwise, and Jekyll drops _-prefixed files.
    expect(existsSync(path.join(site, '.nojekyll'))).toBe(true);
    // Assets must be relative or the site breaks under /repo/.
    expect(readFileSync(path.join(site, 'index.html'), 'utf8')).toContain('"./assets/');
    // A site is self-contained: no second copy left inside .lpm to go stale.
    expect(existsSync(path.join(paths.lpmDir, 'board.json'))).toBe(false);
  });

  it.skipIf(!VIEWER_BUILT)('writes a deploy workflow with --workflow', () => {
    const paths = makeBoard();
    lpm(paths.root, 'export', '--site', 'docs', '--workflow');

    const workflow = path.join(paths.root, '.github', 'workflows', 'lpm-board.yml');
    const text = readFileSync(workflow, 'utf8');
    expect(text).toContain('export --site docs');
    expect(text).toContain('actions/deploy-pages');

    // Never silently overwritten: it is a file people edit.
    const again = lpm(paths.root, 'export', '--site', 'other', '--workflow');
    expect(again.status).toBe(1);
    expect(again.out).toContain('already exists');
    // ...and it refuses before writing, rather than half-building a site and
    // then reporting failure.
    expect(existsSync(path.join(paths.root, 'other'))).toBe(false);
  });

  it('refuses a --workflow whose site is outside the repository', () => {
    const paths = makeBoard();
    const run = lpm(paths.root, 'export', '--site', '../elsewhere', '--workflow');
    expect(run.status).toBe(1);
    expect(run.out).toContain('inside the board');
    expect(existsSync(path.join(paths.root, '..', 'elsewhere'))).toBe(false);
  });

  it('refuses --workflow without --site', () => {
    const paths = makeBoard();
    const run = lpm(paths.root, 'export', '--workflow');
    expect(run.status).toBe(1);
    expect(run.out).toContain('--workflow needs --site');
  });

  it('says what an empty --out or --site is missing', () => {
    const paths = makeBoard();
    expect(lpm(paths.root, 'export', '--out', '').out).toContain('--out needs a file');
    expect(lpm(paths.root, 'export', '--site', '').out).toContain('--site needs a directory');
  });

  it.skipIf(!VIEWER_BUILT)('ships a viewer that cannot call an API', () => {
    // There is no server behind a published board, so importing the editor's
    // fetch layer into the viewer would be a bug that only shows up in
    // production. The bundle is the only place to catch it.
    const assets = path.join(
      fileURLToPath(new URL('../web/dist-viewer/', import.meta.url)),
      'assets',
    );
    const scripts = readdirSync(assets).filter((name) => name.endsWith('.js'));
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(readFileSync(path.join(assets, script), 'utf8')).not.toContain('/api/');
    }
  });

  it('fails outside a board', () => {
    const run = lpm(tempDir(), 'export');
    expect(run.status).toBe(1);
    expect(run.out).toContain('No light-plan board');
  });

  it('exports a board with periods and resources turned off', () => {
    const paths = makeBoard('blank');
    lpm(paths.root, 'export');

    const data = JSON.parse(
      readFileSync(path.join(paths.lpmDir, 'board.json'), 'utf8'),
    ) as StaticBoard;
    expect(data.board.config.hasPeriods).toBe(false);
    expect(data.board.config.hasResources).toBe(false);
    expect(data.board.periods).toEqual([]);
  });
});
