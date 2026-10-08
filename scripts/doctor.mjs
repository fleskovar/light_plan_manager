// `make doctor`: is this machine ready to build light-plan?
//
// Written in Node rather than shell so it reads the same from cmd.exe, sh and
// PowerShell. The Node minimum comes from `engines` in package.json, so there
// is one place to raise it.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const NPM_MIN = 9;
const NODE_MIN = Number(/\d+/.exec(JSON.parse(readFileSync('package.json', 'utf8')).engines.node)[0]);

let failed = false;
const ok = (s) => console.log(`  ok    ${s}`);
const warn = (s) => console.log(`  warn  ${s}`);
const fail = (s) => {
  console.log(`  FAIL  ${s}`);
  failed = true;
};

/** Run a command through the shell (npm and lpm are .cmd shims on Windows). */
function run(command) {
  const result = spawnSync(command, { shell: true, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}
const major = (version) => Number(version.split('.')[0]);

console.log('Toolchain');
const node = process.versions.node;
if (major(node) >= NODE_MIN) ok(`node ${node}`);
else fail(`node ${node} - light-plan needs ${NODE_MIN} or newer`);

const npm = run('npm -v');
if (npm === null) fail('npm not found - it ships with Node');
else if (major(npm) >= NPM_MIN) ok(`npm ${npm}`);
else warn(`npm ${npm} - ${NPM_MIN}+ recommended (npm install -g npm)`);

// Not required to build, but light-plan reads git for a document's author and
// `lpm init` makes .lpm its own repository.
const git = run('git --version');
if (git === null) {
  warn("git not found - authorship and 'lpm init' git setup are skipped");
} else {
  ok(git);
  const name = run('git config user.name');
  const email = run('git config user.email');
  if (name && email) ok(`git identity ${name} <${email}>`);
  else warn('git user.name/user.email unset - new documents get no author');
}

console.log('\nDependencies');
for (const [dir, label] of [['.', 'root'], ['web', 'web']]) {
  const stamp = `${dir}/node_modules/.install-stamp`;
  if (!existsSync(`${dir}/node_modules`)) fail(`${label.padEnd(4)} not installed - run: make setup`);
  else if (!existsSync(stamp)) warn(`${label.padEnd(4)} installed outside make - run: make setup to check it matches the lockfile`);
  else if (statSync(`${dir}/package-lock.json`).mtimeMs > statSync(stamp).mtimeMs)
    warn(`${label.padEnd(4)} package-lock.json changed since install - run: make setup`);
  else ok(`${label.padEnd(4)} installed and current`);
}

console.log('\nBuild output');
if (existsSync('dist/cli/index.js')) ok('CLI built');
else warn('CLI not built - run: make build');
if (existsSync('web/dist/index.html')) ok('web app built');
else warn("web app not built - 'lpm ui' would serve nothing");
if (existsSync('web/dist-viewer/index.html')) ok('viewer built');
else warn("viewer not built - 'lpm export --site' would have nothing to copy");
const lpm = run(process.platform === 'win32' ? 'where lpm' : 'command -v lpm');
if (lpm) ok(`lpm on PATH (${lpm.split(/\r?\n/)[0]})`);
else warn('lpm not on PATH - run: make link');

console.log();
if (failed) {
  console.log('Not ready. Fix the FAIL lines above.');
  process.exit(1);
}
console.log("Ready. 'make outdated' shows which dependencies have newer releases.");
