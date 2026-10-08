import { describe, expect, it } from 'vitest';
import { BoardError } from '../src/core/errors.js';
import { isProbe } from '../src/remote/capabilities.js';
import { githubCapabilities } from '../src/remote/providers/github/index.js';
import { jiraProvider } from '../src/remote/providers/jira/index.js';
import { lookupProvider, providers, registeredProviders } from '../src/remote/registry.js';

// ---------------------------------------------------------------------------
// The registry is an explicit table
// ---------------------------------------------------------------------------

describe('provider registry', () => {
  it('is a plain object literal, not a loader', () => {
    // A plain object with no prototype machinery and no dynamic behaviour.
    expect(providers).toBeTypeOf('object');
    expect(Object.getPrototypeOf(providers)).toBe(Object.prototype);
  });

  it('registers the GitHub provider', () => {
    expect(providers.github).toBeDefined();
  });

  it('registers the Jira provider', () => {
    expect(providers.jira).toBeDefined();
  });

  it('registers the Linear provider', () => {
    expect(providers.linear).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

describe('lookupProvider', () => {
  it('resolves `provider: github` to the GitHub provider', () => {
    expect(lookupProvider('github')).toBe(providers.github);
  });

  it('lists the registered names when the provider is unknown', () => {
    let caught: unknown;
    try {
      lookupProvider('gitlab');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BoardError);
    expect((caught as BoardError).message).toBe('Unknown provider "gitlab"');
    expect((caught as BoardError).details).toEqual(['Registered providers: github, jira, jsonfile, linear']);
  });

  it('returns the same instance on every lookup', () => {
    expect(lookupProvider('github')).toBe(lookupProvider('github'));
  });
});

describe('registeredProviders', () => {
  it('returns the names sorted', () => {
    expect(registeredProviders()).toEqual(['github', 'jira', 'jsonfile', 'linear']);
  });
});

// ---------------------------------------------------------------------------
// The provider shape
// ---------------------------------------------------------------------------

describe('a provider exposes the four members (plus the optional credentials descriptor)', () => {
  const provider = lookupProvider('github');

  it('config schema, capabilities, translator, connector factory', () => {
    expect(Object.keys(provider).sort()).toEqual([
      'capabilities',
      'config',
      'connector',
      'credentials',
      'translator',
    ]);
  });

  it('states no vocabulary convention, because GitHub needs none (LP-537)', () => {
    // A GitHub board's types and statuses ride labels whose names *this board*
    // chooses, so there is no pre-existing vocabulary to convert to and nothing
    // for `lpm remote setup` to correct. A convention here would be inventing a
    // question nobody had.
    expect(provider.standardVocabulary).toBeUndefined();
  });

  it('config is a zod schema (safeParse)', () => {
    expect(provider.config).toBeDefined();
    expect(typeof (provider.config as { safeParse?: unknown }).safeParse).toBe('function');
  });

  it('capabilities is a record table reflecting GitHub', () => {
    expect(provider.capabilities).toBe(githubCapabilities);
    expect(provider.capabilities.periods).toEqual({ native: true, creatable: true });
    expect(isProbe(provider.capabilities.nativeTypes)).toBe(true);
    expect(provider.capabilities.edges).toEqual({ dependsOn: false, relatesTo: false });
  });

  it('translator exposes both directions', () => {
    expect(typeof provider.translator.describeRequest).toBe('function');
    expect(typeof provider.translator.fieldsFromRecord).toBe('function');
  });

  it('connector is a factory function', () => {
    expect(typeof provider.connector).toBe('function');
  });

  it('declares its secret keys and conventional env var (LP-295)', () => {
    expect(provider.credentials?.secrets).toEqual({ token: 'GITHUB_TOKEN' });
  });
});

describe('the Jira provider exposes the same four members (LP-491)', () => {
  const provider = lookupProvider('jira');

  it('config schema, capabilities, translator, connector factory', () => {
    // Plus the three optional descriptors Jira declares: which connection keys
    // hold secrets, what its vocabulary conventionally is (LP-537) — which is
    // why connecting leaves no `TODO:` for a Jira remote — and which
    // connection key a part of the mapping needs (the Agile board id, without
    // which no sprint can be found or created).
    expect(Object.keys(provider).sort()).toEqual([
      'capabilities',
      'conditionalConnection',
      'config',
      'connector',
      'credentials',
      'standardVocabulary',
      'translator',
    ]);
  });

  it('states the Agile board id as a connection key the periods mapping needs', () => {
    // Stated as data so no CLI or planner code names Jira: the preflight turns
    // an unmet one into an error before a push writes anything, and setup
    // tries to answer it from the remote itself.
    expect(provider.conditionalConnection).toEqual([
      { key: 'board', needs: 'periods', why: expect.stringContaining('Agile board') },
    ]);
  });

  it("states the platform's conventional vocabulary, both halves (LP-537)", () => {
    // Jira's vocabulary is `fixed` — it pre-exists remotely and can only be
    // listed by asking — so a convention is what stops every board word being a
    // hand-edit before the first sync.
    expect(provider.capabilities.vocabulary).toBe('fixed');
    expect(typeof provider.standardVocabulary?.typeFor).toBe('function');
    expect(typeof provider.standardVocabulary?.statusFor).toBe('function');
    expect(provider.standardVocabulary?.describe).toContain('Jira');
  });

  it('config is a zod schema (safeParse)', () => {
    expect(typeof (provider.config as { safeParse?: unknown }).safeParse).toBe('function');
  });

  it('capabilities reflect Jira Cloud', () => {
    expect(provider.capabilities.nativeTypes).toBe(true);
    expect(provider.capabilities.status).toEqual({ kind: 'transitions' });
    expect(provider.capabilities.edges).toEqual({ dependsOn: true, relatesTo: true });
    expect(provider.capabilities.incrementalRead).toEqual({ kind: 'cursor' });
  });

  it('translator exposes both directions', () => {
    expect(typeof provider.translator.describeRequest).toBe('function');
    expect(typeof provider.translator.fieldsFromRecord).toBe('function');
  });

  it('connector is a factory function', () => {
    expect(typeof provider.connector).toBe('function');
  });

  it('declares email and token as secrets (LP-290)', () => {
    expect(provider.credentials?.secrets).toEqual({
      email: 'JIRA_EMAIL',
      token: 'JIRA_API_TOKEN',
    });
  });

  it('is the same instance on every lookup', () => {
    expect(lookupProvider('jira')).toBe(jiraProvider);
  });
});
