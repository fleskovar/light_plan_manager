// `make dist`: pack the tarball into <dir> and refuse one that is missing files.
//
//   node scripts/pack.mjs <dir>
//
// `npm pack --json` reports exactly what went in, so the check needs no tar or
// grep — and no shell. A package without web/dist installs fine and then serves
// an empty page, which is the failure worth catching before publishing. The
// shipped assets are derived from the tree rather than listed here: a new
// agent, skill or harness mapping must not need this file edited, and an
// `lpm agent` that installs nothing is exactly the silent failure to catch.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] ?? 'release';
mkdirSync(dir, { recursive: true });

const result = spawnSync(`npm pack --json --pack-destination "${dir}"`, {
  shell: true,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
if (result.status !== 0) process.exit(result.status ?? 1);
const [pack] = JSON.parse(result.stdout);
const files = new Set(pack.files.map((file) => file.path));

const walk = (root) =>
  readdirSync(root, { recursive: true })
    .map((entry) => path.join(root, entry))
    .filter((file) => statSync(file).isFile())
    .map((file) => file.split(path.sep).join('/'));

const required = ['dist/cli/index.js', 'web/dist/index.html', 'web/dist-viewer/index.html', 'templates/scrum.yml'];
const assets = [...walk('assets'), ...walk('templates')];

let missing = 0;
for (const file of required) {
  if (files.has(file)) console.log(`  ok    ${file}`);
  else {
    console.log(`  FAIL  ${file} is missing from the tarball`);
    missing++;
  }
}
for (const file of assets) {
  if (!files.has(file)) {
    console.log(`  FAIL  ${file} is missing from the tarball`);
    missing++;
  }
}
if (missing) process.exit(1);
console.log(`  ok    ${assets.length} shipped asset file(s)`);

const tarball = path.join(dir, pack.filename).split(path.sep).join('/');
const size = (statSync(tarball).size / 1024 / 1024).toFixed(1);
console.log(`\nBuilt ${tarball} (${size} MB, ${pack.entryCount} files)`);
// The ./ matters: npm reads a bare `release/x.tgz` as the GitHub repo
// `release/x.tgz` and fails asking for SSH access to it.
console.log(`Install it anywhere with: npm install -g ./${tarball}`);
