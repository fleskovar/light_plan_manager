import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

export function isGitRepo(dir: string): boolean {
  return git(dir, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

/** The root of the git work tree `dir` sits in, or null outside one. */
export function gitTopLevel(dir: string): string | null {
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  return top ? path.resolve(top) : null;
}

export function gitInit(dir: string): boolean {
  return git(dir, ['init']) !== null;
}

/** `Name <email>` from git config, falling back to the OS user. */
export function gitIdentity(cwd: string): string {
  const name = git(cwd, ['config', 'user.name']);
  const email = git(cwd, ['config', 'user.email']);
  if (name && email) return `${name} <${email}>`;
  if (name) return name;
  try {
    return os.userInfo().username;
  } catch {
    return 'unknown';
  }
}

/** ISO date of the commit that added `file`, if it is tracked. */
export function gitFileCreationDate(file: string): string | null {
  const dir = path.dirname(file);
  const out = git(dir, ['log', '--diff-filter=A', '--format=%aI', '-1', '--', file]);
  return out ? out.split('\n')[0]! : null;
}
