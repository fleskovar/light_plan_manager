import { readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { BoardError } from '../src/core/errors.js';
import type { BoardPaths } from '../src/core/index.js';
import {
  isEnvReference,
  isLiteralSecret,
  readCredential,
  readCredentialsFile,
  resolveConnectionSecrets,
  resolveSecret,
  writeCredential,
} from '../src/remote/credentials.js';
import { cleanupBoards, makeBoard } from './helpers.js';

afterAll(cleanupBoards);
afterEach(() => {
  vi.unstubAllEnvs();
});

const message = (error: unknown): string =>
  error instanceof BoardError ? `${error.message}\n${error.details.join('\n')}` : String(error);

function remotes(text: string): BoardPaths {
  const paths = makeBoard('blank', 'LP');
  writeFileSync(paths.configPath, `${readFileSync(paths.configPath, 'utf8')}\n${text}\n`, 'utf8');
  return paths;
}

const CREDENTIALS_PATH = '.lpm/credentials.json';

describe('reference predicates', () => {
  it('recognises a ${VAR} reference and a literal secret', () => {
    expect(isEnvReference('${GITHUB_TOKEN}')).toBe(true);
    expect(isEnvReference('ghp_abc123')).toBe(false);
    expect(isEnvReference('Bearer ${GITHUB_TOKEN}')).toBe(false);
    expect(isEnvReference('')).toBe(false);

    expect(isLiteralSecret('ghp_abc123')).toBe(true);
    expect(isLiteralSecret('${GITHUB_TOKEN}')).toBe(false);
    expect(isLiteralSecret('')).toBe(false);
  });
});

describe('resolveSecret', () => {
  it('reads an explicit ${VAR} from the environment at sync time', () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_from_env');
    const paths = remotes('');
    const resolved = resolveSecret({
      remote: 'upstream',
      key: 'token',
      conventionalEnv: 'GITHUB_TOKEN',
      configured: '${GITHUB_TOKEN}',
      paths,
    });
    expect(resolved.value).toBe('ghp_from_env');
    expect(resolved.name).toBe('GITHUB_TOKEN');
    expect(resolved.source).toBe('the environment');
  });

  it('fails when the referenced variable is not set, naming it', () => {
    const paths = remotes('');
    expect(
      message(
        (() => {
          try {
            resolveSecret({
              remote: 'upstream',
              key: 'token',
              conventionalEnv: 'GITHUB_TOKEN',
              configured: '${GITHUB_TOKEN}',
              paths,
            });
            return null;
          } catch (error) {
            return error;
          }
        })(),
      ),
    ).toContain('GITHUB_TOKEN');
  });

  it('refuses a literal credential in the connection', () => {
    const paths = remotes('');
    expect(
      message(
        (() => {
          try {
            resolveSecret({
              remote: 'upstream',
              key: 'token',
              conventionalEnv: 'GITHUB_TOKEN',
              configured: 'ghp_literal',
              paths,
            });
            return null;
          } catch (error) {
            return error;
          }
        })(),
      ),
    ).toContain('literal credential');
  });

  it('consults credentials.json, then the conventional env var', () => {
    const paths = remotes('');
    writeCredential(paths, 'upstream', 'token', 'ghp_from_file');
    expect(
      resolveSecret({ remote: 'upstream', key: 'token', conventionalEnv: 'GITHUB_TOKEN', configured: undefined, paths })
        .value,
    ).toBe('ghp_from_file');
    expect(
      resolveSecret({ remote: 'upstream', key: 'token', conventionalEnv: 'GITHUB_TOKEN', configured: undefined, paths })
        .source,
    ).toBe('.lpm/credentials.json');
  });

  it('falls back to the conventional env var when the file has no entry', () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_conventional');
    const paths = remotes('');
    const resolved = resolveSecret({
      remote: 'upstream',
      key: 'token',
      conventionalEnv: 'GITHUB_TOKEN',
      configured: undefined,
      paths,
    });
    expect(resolved.value).toBe('ghp_conventional');
    expect(resolved.name).toBe('GITHUB_TOKEN');
  });

  it('fails naming all three options when nothing holds a credential', () => {
    const paths = remotes('');
    const error = message(
      (() => {
        try {
          resolveSecret({
            remote: 'upstream',
            key: 'token',
            conventionalEnv: 'GITHUB_TOKEN',
            configured: undefined,
            paths,
          });
          return null;
        } catch (error) {
          return error;
        }
      })(),
    );
    expect(error).toContain('No credential for remote "upstream"');
    expect(error).toContain(CREDENTIALS_PATH);
    expect(error).toContain('lpm remote login upstream');
    expect(error).toContain('GITHUB_TOKEN');
    expect(error).toContain('${VAR}');
  });
});

describe('resolveConnectionSecrets', () => {
  it('fills every secret key and leaves the rest alone', () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_env');
    const paths = remotes('');
    const resolved = resolveConnectionSecrets(
      'upstream',
      { repo: 'acme/payments', token: '${GITHUB_TOKEN}' },
      { token: 'GITHUB_TOKEN' },
      paths,
    );
    expect(resolved).toEqual({ repo: 'acme/payments', token: 'ghp_env' });
  });

  it('resolves a secret the connection omits entirely', () => {
    vi.stubEnv('GITHUB_TOKEN', 'ghp_omitted');
    const paths = remotes('');
    const resolved = resolveConnectionSecrets('upstream', { repo: 'acme/payments' }, { token: 'GITHUB_TOKEN' }, paths);
    expect(resolved).toEqual({ repo: 'acme/payments', token: 'ghp_omitted' });
  });
});

describe('the credentials file', () => {
  it('writes owner-only and reads back, preserving other remotes', () => {
    const paths = remotes('');
    writeCredential(paths, 'upstream', 'token', 'ghp_one');
    writeCredential(paths, 'other', 'token', 'ghp_two');

    expect(readCredential(paths, 'upstream', 'token')).toBe('ghp_one');
    expect(readCredential(paths, 'other', 'token')).toBe('ghp_two');

    if (process.platform !== 'win32') {
      expect(statSync(paths.credentialsPath).mode & 0o777).toBe(0o600);
    }

    // A second write for the same remote adds a key rather than replacing.
    writeCredential(paths, 'upstream', 'api_key', 'ghp_key');
    expect(readCredential(paths, 'upstream', 'token')).toBe('ghp_one');
    expect(readCredential(paths, 'upstream', 'api_key')).toBe('ghp_key');
  });

  it('treats an absent file as empty and a malformed one as an error', () => {
    const paths = remotes('');
    expect(readCredentialsFile(paths)).toEqual({});

    writeFileSync(paths.credentialsPath, 'not json', 'utf8');
    expect(
      message(
        (() => {
          try {
            readCredentialsFile(paths);
            return null;
          } catch (error) {
            return error;
          }
        })(),
      ),
    ).toContain('not valid JSON');

    // The lenient read used by `lpm remote login` starts fresh instead.
    writeCredential(paths, 'upstream', 'token', 'ghp_fresh');
    expect(readCredential(paths, 'upstream', 'token')).toBe('ghp_fresh');
  });

  it('is listed in .lpm/.gitignore by init', () => {
    const paths = remotes('');
    expect(readFileSync(path.join(paths.lpmDir, '.gitignore'), 'utf8')).toContain('credentials.json');
  });
});
