/**
 * What connecting to each provider asks for — derived from the providers.
 *
 * Every front end that asks a person for connection details reads this:
 * `lpm remote connect` for the example beside each question, and the web
 * connect form for everything it draws. Nothing here is written per platform.
 * The fields come from the provider's own zod schema (`connectionFlags`), the
 * credential keys — and which of them may be shown while typed — from
 * `Provider.credentials`, and the keys only part of a mapping needs from
 * `conditionalConnection`. A provider added to the registry appears in the form
 * with no edit anywhere else; a form that knew "GitHub needs a repo" would be a
 * second copy of a fact the schema already states, free to disagree with it.
 *
 * Pure: no I/O, no board.
 */

import { connectionFlags } from './config-file.js';
import { lookupProvider, registeredProviders } from './registry.js';

/** One non-secret connection key, as a form field. */
export interface ConnectionField {
  name: string;
  type: 'string' | 'boolean';
  /**
   * What a person must supply. False for a key the provider can work out for
   * itself (`jsonfile`'s `file`), whatever the schema says a fully declared
   * remote carries.
   */
  required: boolean;
  /** A worked example, so "site" is not a riddle. Absent when nobody wrote one. */
  example?: string;
}

/** One credential key — a secret, stored beside the board and never in config.yml. */
export interface CredentialField {
  key: string;
  /** The platform's conventional env var, which satisfies the key as well. */
  env?: string;
  /**
   * True when the value is no secret to *look* at — Jira's account email, half
   * of the credential and no secret at all — and may be shown while it is
   * typed. Everything else is masked.
   */
  visible: boolean;
}

/** A connection key only part of a mapping needs, and what breaks without it. */
export interface ConditionalField {
  key: string;
  /** The `mapping` block whose presence makes the key necessary. */
  needs: string;
  why: string;
}

/** Everything a connect form needs to know about one provider. */
export interface ProviderDescriptor {
  name: string;
  connection: ConnectionField[];
  /** Empty for a provider with no secrets (`jsonfile`). */
  credentials: CredentialField[];
  /** The page where this credential is created. */
  credentialUrl?: string;
  /** One line naming what to create, and with what access. */
  credentialHint?: string;
  conditional: ConditionalField[];
}

/**
 * Worked examples, keyed by connection key rather than by platform: a key
 * nobody has written one for simply gets none, and a new provider declaring a
 * `repo` inherits the example without anybody touching this file.
 */
const EXAMPLES: Readonly<Record<string, string>> = {
  repo: 'owner/repo',
  site: 'https://acme.atlassian.net',
  project: 'the project key, e.g. PAY',
  team: 'the team key, e.g. ENG',
  board: 'the board id',
  base_url: 'leave empty for the default',
  file: 'a path under .lpm/',
};

/** The worked example for one connection key, when there is one. */
export function connectionExample(key: string): string | undefined {
  return EXAMPLES[key];
}

/** Describe one registered provider for a connect form. Throws for an unknown name. */
export function describeProvider(name: string): ProviderDescriptor {
  const provider = lookupProvider(name);
  const secrets = provider.credentials?.secrets ?? {};
  const visible = new Set(provider.credentials?.visible ?? []);
  return {
    name,
    connection: connectionFlags(provider).map((flag) => {
      const example = connectionExample(flag.name);
      return {
        name: flag.name,
        type: flag.type,
        required: flag.required,
        ...(example !== undefined ? { example } : {}),
      };
    }),
    credentials: Object.entries(secrets).map(([key, env]) => ({
      key,
      ...(env ? { env } : {}),
      visible: visible.has(key),
    })),
    ...(provider.credentials?.url !== undefined ? { credentialUrl: provider.credentials.url } : {}),
    ...(provider.credentials?.hint !== undefined ? { credentialHint: provider.credentials.hint } : {}),
    conditional: (provider.conditionalConnection ?? []).map(({ key, needs, why }) => ({ key, needs, why })),
  };
}

/** Every registered provider, in registry order (sorted by name). */
export function describeProviders(): ProviderDescriptor[] {
  return registeredProviders().map(describeProvider);
}
