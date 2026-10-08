import { execFileSync } from 'node:child_process';

/**
 * Committing the agent's work.
 *
 * These target the *project* repo — the working tree the agent edited — not the
 * nested `.lpm` board repo. Board changes (status, comments, run artifacts) are
 * left for the operator to commit, so a machine never rewrites the plan's own
 * history. The interface is small and injected into the loop, so the loop's
 * tests can drive every commit mode without a real repository.
 */
export interface GitDriver {
  /** True when the working tree at `cwd` has staged or unstaged changes. */
  hasChanges(cwd: string): boolean;
  /**
   * Stage everything and commit with `message`. Returns the short commit hash,
   * or null when there was nothing to commit.
   */
  commitAll(cwd: string, message: string): string | null;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function createGitDriver(): GitDriver {
  return {
    hasChanges(cwd) {
      try {
        return git(cwd, ['status', '--porcelain']).length > 0;
      } catch {
        // No repo, or git not installed: treat as nothing to commit rather than
        // crashing a run whose real work already landed on disk.
        return false;
      }
    },
    commitAll(cwd, message) {
      if (!this.hasChanges(cwd)) return null;
      git(cwd, ['add', '-A']);
      git(cwd, ['commit', '-m', message]);
      return git(cwd, ['rev-parse', '--short', 'HEAD']);
    },
  };
}
