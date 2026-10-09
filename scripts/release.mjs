// `make publish`, `make version-minor`, `make version-major`.
//
//   node scripts/release.mjs publish        bump the patch, commit, tag, push
//   node scripts/release.mjs bump minor     start the next minor (or major)
//
// A release is a pushed version tag: .github/workflows/publish.yml verifies,
// packs and publishes it to npm. So `publish` publishes nothing itself. It
// writes the tag the workflow is waiting for and pushes it with the commit
// that names the same version.
//
// The patch number is the machine's; the major and minor are a person's. So
// `publish` bumps the patch only when the version in package.json has been
// released already (its tag exists). A version nobody has tagged yet was set
// by hand, by `bump`, to start a new minor or major, and `publish` releases it
// as it stands, so 0.2.0 is published rather than skipped on the way to 0.2.1.
//
// Tags are the bare version (0.1.1, not v0.1.1), as the existing ones are.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const RELEASE_BRANCH = 'main';
const FILES = ['package.json', 'package-lock.json'];

const fail = (message) => {
  console.error(`release: ${message}`);
  process.exit(1);
};

// npm is npm.cmd on Windows, which only a shell can start, so it goes as one
// command string. Its arguments are a version and fixed words, so the shell
// has nothing to mangle. git is started directly.
const run = (command, args, { check = true, quiet = false } = {}) => {
  const viaShell = command === 'npm';
  const result = spawnSync(viaShell ? `npm ${args.join(' ')}` : command, viaShell ? { shell: true } : args, {
    shell: viaShell,
    encoding: 'utf8',
    stdio: ['ignore', quiet ? 'pipe' : 'inherit', quiet ? 'pipe' : 'inherit'],
  });
  if (check && result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed${quiet ? `:\n${result.stderr.trim()}` : ''}`);
  }
  return result;
};
const git = (...args) => run('git', args, { quiet: true }).stdout.trim();
const tagExists = (tag) => run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], { check: false, quiet: true }).status === 0;

const currentVersion = () => JSON.parse(readFileSync('package.json', 'utf8')).version;

const next = (version, part) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) fail(`package.json version ${version} is not MAJOR.MINOR.PATCH`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (part === 'major') return `${major + 1}.0.0`;
  if (part === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
};

// package.json and package-lock.json move together, and nothing else moves.
const setVersion = (version, message) => {
  run('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { quiet: true });
  run('git', ['commit', '-q', '-m', message, '--', ...FILES]);
};

const requireClean = () => {
  if (git('status', '--porcelain')) fail('the working tree has uncommitted changes. Commit or stash them first.');
};

// The repository page on GitHub, from an ssh or https remote URL.
const repoUrl = (remote) => {
  const url = git('remote', 'get-url', remote);
  const match = /github\.com[:/](.+?)(?:\.git)?$/.exec(url);
  return match ? `https://github.com/${match[1]}` : undefined;
};

const publish = () => {
  requireClean();
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== RELEASE_BRANCH) fail(`releases are made from ${RELEASE_BRANCH}, and this is ${branch}.`);
  const upstream = run('git', ['rev-parse', '--abbrev-ref', '@{u}'], { check: false, quiet: true });
  if (upstream.status !== 0) fail(`${branch} has no upstream branch to push to.`);
  const remote = upstream.stdout.trim().split('/')[0];

  console.log(`Fetching ${remote}...`);
  run('git', ['fetch', '-q', '--tags', remote]);
  if (git('rev-list', '--count', 'HEAD..@{u}') !== '0') {
    fail(`${branch} is behind ${upstream.stdout.trim()}. Pull first.`);
  }

  const current = currentVersion();
  const bumped = tagExists(current);
  const version = bumped ? next(current, 'patch') : current;
  if (tagExists(version)) fail(`tag ${version} already exists.`);

  if (bumped) {
    console.log(`Bumping ${current} -> ${version}`);
    setVersion(version, `Release ${version}`);
  } else {
    console.log(`Releasing ${version} as set in package.json (it has no tag yet)`);
  }
  run('git', ['tag', '-a', version, '-m', `light-plan ${version}`]);

  // Atomic: the commit and the tag land together or not at all. A refused
  // push takes the local commit and tag back, so running it again is safe.
  console.log(`Pushing ${branch} and tag ${version} to ${remote}...`);
  const pushed = run('git', ['push', '--atomic', remote, `HEAD:refs/heads/${branch}`, `refs/tags/${version}`], { check: false });
  if (pushed.status !== 0) {
    run('git', ['tag', '-d', version], { quiet: true });
    if (bumped) run('git', ['reset', '-q', '--keep', 'HEAD~1']);
    fail('the push was refused. The local commit and tag were undone.');
  }

  const repo = repoUrl(remote);
  console.log(`\nPushed ${version}. The Publish workflow verifies, packs and publishes it to npm.`);
  if (repo) console.log(`Follow it at ${repo}/actions/workflows/publish.yml`);
};

const bump = (part) => {
  if (part !== 'minor' && part !== 'major') fail('bump takes minor or major. The patch is bumped by make publish.');
  requireClean();
  const version = next(currentVersion(), part);
  setVersion(version, `Start ${version}`);
  console.log(`package.json is now ${version}, committed and not tagged. make publish releases it.`);
};

const [command, arg] = process.argv.slice(2);
if (command === 'publish') publish();
else if (command === 'bump') bump(arg);
else fail('usage: node scripts/release.mjs publish | bump minor|major');
