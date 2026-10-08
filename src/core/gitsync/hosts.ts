/**
 * The git hosts setup knows how to talk somebody through.
 *
 * Knowing a host is *help*, never a requirement: any URL git can push to works,
 * and an unrecognised one is "a git server". What a host entry adds is what a
 * person setting this up for the first time actually needs — what a URL to
 * that host looks like, where an empty repository is created, and how git will
 * find the credential — because the commonest way setup fails is a URL pasted
 * from the wrong page, or a token git was never told about.
 *
 * light-plan stores no git credential. It runs git, and git asks its own
 * credential helper (Git Credential Manager, the macOS keychain, an SSH key) —
 * the same thing that answers when the person pushes their code. That is why
 * every hint below points at git's configuration rather than at a light-plan
 * command.
 *
 * Data only; the CLI prints it and the web serves it.
 */

export type GitHostId = 'github' | 'gitlab' | 'bitbucket' | 'azure' | 'other';

export interface GitHost {
  id: GitHostId;
  label: string;
  /** URL shapes, with placeholders in angle brackets. */
  examples: string[];
  /** Where to make the (empty) repository the board will live in. */
  create: string;
  /** How git authenticates to it. */
  credentials: string;
}

export const GIT_HOSTS: readonly GitHost[] = [
  {
    id: 'github',
    label: 'GitHub',
    examples: ['https://github.com/<owner>/<repo>.git', 'git@github.com:<owner>/<repo>.git'],
    create: 'https://github.com/new — leave it empty (no README, no licence).',
    credentials:
      'HTTPS: Git Credential Manager signs in through the browser, or use a personal access token with "Contents: read and write". SSH: add your public key at https://github.com/settings/keys.',
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    examples: ['https://gitlab.com/<group>/<project>.git', 'git@gitlab.com:<group>/<project>.git'],
    create: 'New project → "Create blank project", with "Initialize repository with a README" unticked.',
    credentials:
      'HTTPS: a personal or project access token with write_repository (use it as the password). SSH: add your key under Preferences → SSH Keys.',
  },
  {
    id: 'bitbucket',
    label: 'Bitbucket',
    examples: [
      'https://<user>@bitbucket.org/<workspace>/<repo>.git',
      'git@bitbucket.org:<workspace>/<repo>.git',
    ],
    create: 'Create → Repository, with "Include a README?" set to No.',
    credentials:
      'HTTPS: an app password or API token with repository write access (Git Credential Manager can store it). SSH: add your key under Personal settings → SSH keys.',
  },
  {
    id: 'azure',
    label: 'Azure DevOps',
    examples: [
      'https://dev.azure.com/<organization>/<project>/_git/<repo>',
      'git@ssh.dev.azure.com:v3/<organization>/<project>/<repo>',
    ],
    create: 'Repos → "New repository", with "Add a README" unticked.',
    credentials:
      'HTTPS: Git Credential Manager signs in with your Microsoft account, or use a personal access token with Code (Read & write). SSH: add your key under User settings → SSH public keys.',
  },
  {
    id: 'other',
    label: 'Git server',
    examples: ['https://<server>/<path>.git', 'ssh://<user>@<server>/<path>.git', '/path/to/shared/board.git'],
    create: 'An empty (bare) repository: `git init --bare board.git` on the server or a shared drive.',
    credentials: 'Whatever your git is already configured with for this server: a credential helper, or an SSH key.',
  },
];

function hostOf(id: GitHostId): GitHost {
  return GIT_HOSTS.find((host) => host.id === id)!;
}

/** The host name a URL points at, for HTTPS, `ssh://` and `user@host:path` forms. */
function hostname(url: string): string {
  const trimmed = url.trim();
  const scheme = trimmed.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)/i);
  if (scheme) return scheme[1]!.toLowerCase();
  const scp = trimmed.match(/^(?:[^@/]+@)?([^/:]+):(?!\/)/);
  // A Windows drive letter ("C:\boards") is a path, not a host.
  if (scp && scp[1]!.length > 1) return scp[1]!.toLowerCase();
  return '';
}

/** Which host a URL belongs to; `other` for anything unrecognised. */
export function recognizeHost(url: string): GitHost {
  const host = hostname(url);
  if (host === 'github.com' || host.endsWith('.github.com')) return hostOf('github');
  if (host === 'bitbucket.org') return hostOf('bitbucket');
  if (host === 'dev.azure.com' || host === 'ssh.dev.azure.com' || host.endsWith('visualstudio.com')) {
    return hostOf('azure');
  }
  if (host === 'gitlab.com' || host.startsWith('gitlab.')) return hostOf('gitlab');
  return hostOf('other');
}

/**
 * Why a string cannot be a git URL, or null when git may as well try it. Loose
 * on purpose — git is the judge — but a leading dash would be read as an
 * option, and an empty string is a form somebody has not filled in.
 */
export function urlProblem(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return 'Give the URL of the repository the board should live in.';
  // Spaces are allowed: a path to a bare repository on a shared drive may
  // well have one, and git is passed the URL as one argument, never a shell.
  if (trimmed.startsWith('-')) return 'A repository URL cannot start with "-".';
  return null;
}

/** Two URLs naming the same repository, ignoring a trailing `.git`, a slash and case. */
export function sameRepositoryUrl(a: string, b: string): boolean {
  const norm = (url: string): string =>
    url
      .trim()
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '')
      .toLowerCase();
  return norm(a) === norm(b);
}
