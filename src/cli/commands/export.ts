import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { BoardPaths } from '../../core/index.js';
import { BoardError, LPM_DIR, displayPath, listViewIds } from '../../core/index.js';
import { VIEWER_DIST } from '../../server/http/static.js';
import { loadView } from '../../server/views/store.js';
import type { ViewDocument } from '../../shared/index.js';
import { STATIC_BOARD_FILE } from '../../shared/index.js';
import { toStaticBoard } from '../../sync/index.js';
import { requireBoard } from '../context.js';
import { bold, dim, out } from '../ui.js';

/**
 * Publishing a board as a static site.
 *
 * The whole feature is one file plus a page that fetches it: no API, no
 * directory listing, no per-document requests. That is why the data is a single
 * `board.json` rather than the `.lpm` markdown itself — a static host cannot
 * list a folder, and a browser that parsed the markdown would be a second
 * engine.
 */
export const help = `Publish the board as a static site anyone can open.

Usage
  lpm export [options]

Options
  -o, --out <path>    Where to write the board data (default ${LPM_DIR}/${STATIC_BOARD_FILE})
      --site <dir>    Also copy the read-only viewer into <dir>, with the board
                      data beside it. Point GitHub Pages at <dir> and you are done
      --workflow      Write a GitHub Actions workflow that rebuilds and deploys
                      the site on every push
      --pretty        Indent the JSON: a bigger file with readable diffs

The exported board is the board as committed. A view's queued-but-unpushed
changes are somebody's draft and never travel, and neither does anything the
.lpm folder does not already publish.

Examples
  lpm export                     # refresh ${LPM_DIR}/${STATIC_BOARD_FILE}
  lpm export --site docs         # a complete site in docs/, ready for Pages
  lpm export --site docs --workflow`;

/** Forward slashes: it is shown to the user and it names a path in a repo. */
const WORKFLOW_PATH = '.github/workflows/lpm-board.yml';

/** Every view on the board, skipping any that will not parse. */
function readViews(paths: BoardPaths): ViewDocument[] {
  const views: ViewDocument[] = [];
  for (const id of listViewIds(paths)) {
    try {
      views.push(loadView(paths, id));
    } catch {
      // One unreadable view file must not cost you the whole export. `lpm check`
      // is where a broken board gets reported.
    }
  }
  return views;
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** Board-relative where that reads well, absolute where it would not. */
function report(paths: BoardPaths, target: string): string {
  const shown = displayPath(paths, target);
  return shown.startsWith('..') ? target : shown;
}

function writeJson(file: string, data: unknown, pretty: boolean): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, pretty ? 2 : 0)}\n`, 'utf8');
}

/**
 * Copy the viewer bundle next to the data.
 *
 * The bundle is built with relative asset paths, so it runs from a project
 * Pages site (`/repo/`) as happily as from a domain root.
 */
function copyViewer(dir: string): void {
  if (!existsSync(path.join(VIEWER_DIST, 'index.html'))) {
    throw new BoardError('The static viewer has not been built', [
      `Looked in ${VIEWER_DIST}`,
      'From a checkout, run `npm run build:viewer` (or `make build-viewer`).',
    ]);
  }
  mkdirSync(dir, { recursive: true });
  cpSync(VIEWER_DIST, dir, { recursive: true });
  // GitHub Pages serves through Jekyll unless told not to, and Jekyll drops
  // files and folders whose names begin with an underscore.
  writeFileSync(path.join(dir, '.nojekyll'), '', 'utf8');
}

function workflowText(siteDir: string, version: string): string {
  return `# Publish this light-plan board as a static site.
#
# Written by \`lpm export --workflow\`. It regenerates ${siteDir}/${STATIC_BOARD_FILE} from
# the .lpm folder on every push, then deploys ${siteDir}/ to GitHub Pages.
#
# Before this can run, enable Pages for the repository:
#   Settings > Pages > Build and deployment > Source: GitHub Actions
name: Board

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

# One deployment at a time; a queued run supersedes the one waiting.
concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  publish:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: \${{ steps.deploy.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Build the site
        run: npx --yes light-plan@${version} export --site ${siteDir}

      - uses: actions/configure-pages@v5

      - uses: actions/upload-pages-artifact@v3
        with:
          path: ${siteDir}

      - id: deploy
        uses: actions/deploy-pages@v4
`;
}

export function run(args: string[]): number {
  const { values } = parseArgs({
    args,
    options: {
      out: { type: 'string', short: 'o' },
      site: { type: 'string' },
      workflow: { type: 'boolean' },
      pretty: { type: 'boolean' },
    },
  });

  const board = requireBoard();
  const { paths } = board;
  const pretty = values.pretty === true;
  const siteDir = values.site === undefined ? null : path.resolve(paths.root, values.site);

  // Everything that can refuse the run does so here, before a byte is written:
  // half a site plus a non-zero exit is worse than either outcome on its own.
  if (values.site !== undefined && values.site.trim() === '') {
    throw new BoardError('--site needs a directory');
  }
  if (values.out !== undefined && values.out.trim() === '') {
    throw new BoardError('--out needs a file to write');
  }

  let workflow: string | null = null;
  let siteInRepo = '';
  if (values.workflow) {
    if (!siteDir) {
      throw new BoardError('--workflow needs --site', [
        'The workflow deploys a directory, so it has to know which one.',
        'Try `lpm export --site docs --workflow`.',
      ]);
    }
    siteInRepo = path.relative(paths.root, siteDir).split(path.sep).join('/');
    if (!siteInRepo || siteInRepo.startsWith('..')) {
      throw new BoardError('--workflow needs a --site inside the board', [
        'A workflow can only deploy a directory the repository contains.',
      ]);
    }
    workflow = path.join(paths.root, WORKFLOW_PATH);
    if (existsSync(workflow)) {
      throw new BoardError(`${WORKFLOW_PATH} already exists`, [
        'Delete it first if you want a fresh one.',
      ]);
    }
  }

  const version = packageVersion();
  const views = readViews(paths);
  const data = toStaticBoard(board, views, `light-plan ${version}`);

  // Writing the data into .lpm as well as the site would leave two copies to
  // keep in step, so an explicit --site means the site unless --out asks for it.
  const targets: string[] = [];
  if (values.out !== undefined) targets.push(path.resolve(paths.root, values.out));
  else if (!siteDir) targets.push(path.join(paths.lpmDir, STATIC_BOARD_FILE));
  if (siteDir) targets.push(path.join(siteDir, STATIC_BOARD_FILE));

  if (siteDir) copyViewer(siteDir);
  for (const target of targets) writeJson(target, data, pretty);

  if (workflow) {
    mkdirSync(path.dirname(workflow), { recursive: true });
    writeFileSync(workflow, workflowText(siteInRepo, version), 'utf8');
  }

  const counts = [
    `${data.board.issues.length} issue${data.board.issues.length === 1 ? '' : 's'}`,
    `${data.views.length} view${data.views.length === 1 ? '' : 's'}`,
  ].join(', ');

  out(`${bold('exported')} ${counts}`);
  for (const target of targets) out(`  ${report(paths, target)}`);
  if (siteDir) out(`  ${report(paths, siteDir)}/index.html ${dim('(the viewer)')}`);
  if (workflow) out(`  ${WORKFLOW_PATH}`);

  if (siteDir) {
    out();
    out(dim('Commit it, then Settings > Pages > Source: GitHub Actions (or /docs).'));
  }
  return 0;
}
