import { getContext, setContext } from 'svelte';
import type {
  RemoteConnectRequestDto,
  RemoteConnectResultDto,
  RemoteConnectionDto,
  RemoteConnectionUpdateDto,
  RemoteCredentialStateDto,
  RemoteCredentialsRequestDto,
  RemoteCredentialsResultDto,
  RemoteInspectAnswersDto,
  RemoteInspectAnswersResultDto,
  RemoteInspectDto,
  RemoteProviderDto,
} from '$shared';

/**
 * Connecting a remote from the browser — the connect form's and the connection
 * panel's state machine, kept out of the components so they stay
 * presentational and the tests stay DOM-free.
 *
 * **Nothing here knows a platform.** Every field is drawn from a
 * `RemoteProviderDto`, which the server derives from the provider registry, so
 * a provider added there appears in the form with no edit in this file.
 *
 * **A typed credential is the one thing held here that must not linger.** It
 * lives in `draft.credentials` or `credentialDraft` only until it has been
 * sent, and is cleared on success and whenever the form closes. It is kept
 * after a *failed* request, so a mistyped repo does not cost somebody their
 * token — and it never leaves the page except in the one request that stores
 * it. The server never sends one back: every response carries where a value
 * comes from, never the value.
 *
 * The refusals — a secret in config.yml, an undeclared key, re-pointing a
 * remote that already mirrors documents — are the engine's. This module
 * reports them; it does not second-guess them.
 */

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** The server calls this state machine makes, behind a seam for tests. */
export interface ConnectionsApi {
  remoteProviders(): Promise<RemoteProviderDto[]>;
  connectRemote(body: RemoteConnectRequestDto): Promise<RemoteConnectResultDto>;
  remoteConnection(name: string): Promise<RemoteConnectionDto>;
  updateRemoteConnection(name: string, body: RemoteConnectionUpdateDto): Promise<RemoteConnectionDto>;
  storeRemoteCredentials(name: string, body: RemoteCredentialsRequestDto): Promise<RemoteCredentialsResultDto>;
  inspectRemote(name: string, body?: { dryRun?: boolean }): Promise<RemoteInspectDto>;
  answerRemote(name: string, body: RemoteInspectAnswersDto): Promise<RemoteInspectAnswersResultDto>;
  removeRemote(name: string): Promise<{ name: string; purged: boolean }>;
}

/** What this state machine needs back from the editor. */
export interface ConnectionsHost {
  notify(level: 'info' | 'error', message: string, details?: string[]): void;
  report(error: unknown): void;
  /**
   * The set of remotes changed — re-read the list, and select `name` when one
   * is given, so the Sync tab shows what was just connected or edited.
   */
  remotesChanged(name?: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** What a connect form collected. */
export interface ConnectDraft {
  provider: string;
  name: string;
  scope: string;
  connection: Record<string, string | boolean>;
  credentials: Record<string, string>;
}

/** Answers to what a connection test left for a person. A blank means "leave it". */
export interface AnswerDraft {
  connection: Record<string, string>;
  types: Record<string, string>;
  statuses: Record<string, string>;
}

const emptyAnswers = (): AnswerDraft => ({ connection: {}, types: {}, statuses: {} });

/**
 * A remote is named after its provider unless that name is taken — the same
 * default `lpm remote connect` uses, so `lpm remote push --remote jira` reads
 * well without anybody having had to invent a word.
 */
export function suggestName(provider: string, taken: readonly string[]): string {
  if (!taken.includes(provider)) return provider;
  for (let n = 2; ; n += 1) {
    const candidate = `${provider}-${n}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/** A blank form for one provider: every declared field present and empty. */
export function emptyDraft(provider: RemoteProviderDto, taken: readonly string[]): ConnectDraft {
  const connection: Record<string, string | boolean> = {};
  for (const field of provider.connection) connection[field.name] = field.type === 'boolean' ? false : '';
  const credentials: Record<string, string> = {};
  for (const field of provider.credentials) credentials[field.key] = '';
  return { provider: provider.name, name: suggestName(provider.name, taken), scope: '', connection, credentials };
}

/**
 * What stops the form being sent. Only what the browser can know: a missing
 * required field, a name that is empty, spaced or taken. Everything else —
 * a malformed repo, an unknown key — is the server's to refuse, with its own
 * words.
 */
export function draftProblems(
  provider: RemoteProviderDto | undefined,
  draft: ConnectDraft,
  taken: readonly string[],
): string[] {
  if (!provider) return ['Choose a tracker.'];
  const problems: string[] = [];
  const name = draft.name.trim();
  if (name === '') problems.push('Enter a name.');
  else if (/\s/.test(name)) problems.push('Name cannot contain spaces.');
  else if (taken.includes(name)) problems.push(`A remote named "${name}" already exists.`);
  for (const field of provider.connection) {
    if (field.required && field.type === 'string' && String(draft.connection[field.name] ?? '').trim() === '') {
      problems.push(`${field.name} is required.`);
    }
  }
  return problems;
}

/**
 * The request a form sends. Built by walking the *provider's* fields, so a key
 * the provider does not declare can never be sent; blanks are dropped, and a
 * credential only ever travels under `credentials`.
 */
export function toConnectRequest(provider: RemoteProviderDto, draft: ConnectDraft): RemoteConnectRequestDto {
  const connection: Record<string, string | boolean> = {};
  for (const field of provider.connection) {
    const value = draft.connection[field.name];
    if (field.type === 'boolean') {
      if (value === true) connection[field.name] = true;
      continue;
    }
    const text = String(value ?? '').trim();
    if (text !== '') connection[field.name] = text;
  }
  const credentials: Record<string, string> = {};
  for (const field of provider.credentials) {
    const text = (draft.credentials[field.key] ?? '').trim();
    if (text !== '') credentials[field.key] = text;
  }
  return {
    name: draft.name.trim(),
    provider: provider.name,
    connection,
    ...(draft.scope.trim() !== '' ? { scope: draft.scope.trim() } : {}),
    ...(Object.keys(credentials).length > 0 ? { credentials } : {}),
  };
}

/** One credential's standing, in words — where it comes from, never what it is. */
export function describeCredential(state: RemoteCredentialStateDto): string {
  if (state.source !== undefined) return `set from ${state.source}`;
  if (state.reference !== undefined) return `$${state.reference} is not set (referenced in config.yml)`;
  return state.env !== undefined ? `not set — store it here or set $${state.env}` : 'not set — store it here';
}

/** The edit form's values for a stored connection: every declared field present. */
export function connectionDraftOf(
  provider: RemoteProviderDto | undefined,
  current: Readonly<Record<string, string | boolean>>,
): Record<string, string | boolean> {
  const draft: Record<string, string | boolean> = {};
  for (const field of provider?.connection ?? []) {
    const value = current[field.name];
    draft[field.name] = field.type === 'boolean' ? value === true : value === undefined ? '' : String(value);
  }
  return draft;
}

/** The connection values that differ from what is written — exactly what Save sends. */
export function connectionChanges(
  provider: RemoteProviderDto,
  current: Readonly<Record<string, string | boolean>>,
  draft: Readonly<Record<string, string | boolean>>,
): Record<string, string | boolean> {
  const changes: Record<string, string | boolean> = {};
  for (const field of provider.connection) {
    if (field.type === 'boolean') {
      const before = current[field.name] === true;
      const after = draft[field.name] === true;
      if (before !== after) changes[field.name] = after;
      continue;
    }
    const before = current[field.name] === undefined ? '' : String(current[field.name]);
    const after = String(draft[field.name] ?? '').trim();
    if (before !== after) changes[field.name] = after;
  }
  return changes;
}

/** A word the mapping names and the tracker does not have, with the tracker's own words as options. */
export interface UnresolvedWord {
  block: 'types' | 'statuses';
  boardKey: string;
  claimed: string;
  candidates: string[];
}

export function unresolvedWords(report: RemoteInspectDto): UnresolvedWord[] {
  const out: UnresolvedWord[] = [];
  for (const block of ['types', 'statuses'] as const) {
    const reconciled = report.vocabulary?.[block];
    for (const entry of reconciled?.entries ?? []) {
      if (entry.verdict !== 'unresolved') continue;
      out.push({ block, boardKey: entry.boardKey, claimed: entry.claimed, candidates: [...reconciled!.candidates] });
    }
  }
  return out;
}

/** What the next push makes, and what it will not file, as lines. */
export function describePrerequisites(report: RemoteInspectDto): string[] {
  const missing = report.prerequisites;
  if (!missing) return [];
  const lines: string[] = [];
  const created: string[] = [];
  if (missing.labels.length > 0) created.push(`${missing.labels.length} label${missing.labels.length === 1 ? '' : 's'}`);
  if (missing.projectFields > 0) {
    created.push(`${missing.projectFields} Project field${missing.projectFields === 1 ? '' : 's'}`);
  }
  if (created.length > 0) lines.push(`The next push creates ${created.join(' and ')}.`);
  if (missing.sprints.length > 0) {
    lines.push(
      `${missing.sprints.length} period${missing.sprints.length === 1 ? ' is' : 's are'} not on the tracker. ` +
        'Push a period to create it.',
    );
  }
  return lines;
}

/** The answers worth sending: blanks ("leave it") dropped, empty blocks omitted. */
export function answersToSend(answers: AnswerDraft): RemoteInspectAnswersDto {
  const pick = (block: Record<string, string>) =>
    Object.fromEntries(Object.entries(block).filter(([, value]) => value.trim() !== ''));
  const connection = pick(answers.connection);
  const types = pick(answers.types);
  const statuses = pick(answers.statuses);
  return {
    ...(Object.keys(connection).length > 0 ? { connection } : {}),
    ...(Object.keys(types).length > 0 ? { types } : {}),
    ...(Object.keys(statuses).length > 0 ? { statuses } : {}),
  };
}

// ---------------------------------------------------------------------------
// The state machine
// ---------------------------------------------------------------------------

export class ConnectionsState {
  providers = $state<RemoteProviderDto[]>([]);
  #providersLoaded = false;

  /** The connect form's answers; `null` while the form is closed. */
  draft = $state<ConnectDraft | null>(null);
  submitting = $state(false);
  lastConnect = $state<RemoteConnectResultDto | null>(null);

  /** The remote the connection panel shows. */
  connection = $state<RemoteConnectionDto | null>(null);
  loadingConnection = $state(false);
  connectionDraft = $state<Record<string, string | boolean>>({});
  savingConnection = $state(false);
  /** Replacement credential values, typed but not yet stored. */
  credentialDraft = $state<Record<string, string>>({});
  savingCredentials = $state(false);

  inspection = $state<RemoteInspectDto | null>(null);
  inspecting = $state(false);
  answers = $state<AnswerDraft>(emptyAnswers());
  answering = $state(false);
  removing = $state(false);

  #api: ConnectionsApi;
  #host: ConnectionsHost;

  constructor(api: ConnectionsApi, host: ConnectionsHost) {
    this.#api = api;
    this.#host = host;
  }

  providerNamed(name: string): RemoteProviderDto | undefined {
    return this.providers.find((provider) => provider.name === name);
  }

  /** Read the provider catalogue once — it is derived from the registry and never changes while the server runs. */
  async loadProviders(): Promise<void> {
    if (this.#providersLoaded) return;
    try {
      this.providers = await this.#api.remoteProviders();
      this.#providersLoaded = true;
    } catch (error) {
      this.#host.report(error);
    }
  }

  // -- the connect form -----------------------------------------------------

  async openConnect(taken: readonly string[]): Promise<void> {
    await this.loadProviders();
    const first = this.providers[0];
    if (first) this.draft = emptyDraft(first, taken);
  }

  /** Switch the form to another provider. A name somebody typed is kept; a suggested one follows the provider. */
  chooseProvider(name: string, taken: readonly string[]): void {
    const provider = this.providerNamed(name);
    if (!provider || !this.draft) return;
    const typed = this.draft.name.trim() !== suggestName(this.draft.provider, taken);
    this.draft = { ...emptyDraft(provider, taken), ...(typed ? { name: this.draft.name } : {}) };
  }

  /** Close the form. Anything typed — a credential included — is dropped. */
  closeConnect(): void {
    this.draft = null;
  }

  /**
   * Send the form. On success the typed credential is dropped with the draft,
   * the new remote is selected, its connection is opened, and — when nothing is
   * missing — the tracker is asked about itself straight away, as
   * `lpm remote connect` does.
   */
  async submitConnect(taken: readonly string[]): Promise<boolean> {
    const draft = this.draft;
    const provider = draft ? this.providerNamed(draft.provider) : undefined;
    if (!draft || !provider || this.submitting) return false;
    if (draftProblems(provider, draft, taken).length > 0) return false;

    this.submitting = true;
    try {
      const result = await this.#api.connectRemote(toConnectRequest(provider, draft));
      this.lastConnect = result;
      this.draft = null;
      await this.#host.remotesChanged(result.name);

      const missing = result.credentials.filter((state) => state.source === undefined).map((state) => state.key);
      const details: string[] = [];
      if (missing.length > 0) details.push(`Missing: ${missing.join(' and ')}. Store it in the Connection panel.`);
      if (result.markers.length > 0) {
        details.push(`${result.markers.length} mapping decision(s) left in .lpm/config.yml.`);
      }
      this.#host.notify('info', `Connected ${result.name} — ${result.target}`, details);

      await this.loadConnection(result.name);
      if (missing.length === 0) await this.inspect(result.name);
      return true;
    } catch (error) {
      // The draft — the typed credential with it — is kept, so fixing a
      // mistyped repo does not mean pasting the token again.
      this.#host.report(error);
      return false;
    } finally {
      this.submitting = false;
    }
  }

  // -- the connection panel -------------------------------------------------

  async loadConnection(name: string): Promise<void> {
    if (this.connection?.name !== name) {
      this.inspection = null;
      this.answers = emptyAnswers();
      this.credentialDraft = {};
    }
    this.loadingConnection = true;
    try {
      await this.loadProviders();
      const connection = await this.#api.remoteConnection(name);
      this.connection = connection;
      this.connectionDraft = connectionDraftOf(this.providerNamed(connection.provider), connection.connection);
    } catch (error) {
      this.#host.report(error);
    } finally {
      this.loadingConnection = false;
    }
  }

  setConnectionValue(key: string, value: string | boolean): void {
    this.connectionDraft = { ...this.connectionDraft, [key]: value };
  }

  setCredentialValue(key: string, value: string): void {
    this.credentialDraft = { ...this.credentialDraft, [key]: value };
  }

  /** True when the edit form differs from what config.yml holds. */
  get connectionDirty(): boolean {
    const connection = this.connection;
    const provider = connection ? this.providerNamed(connection.provider) : undefined;
    if (!connection || !provider) return false;
    return Object.keys(connectionChanges(provider, connection.connection, this.connectionDraft)).length > 0;
  }

  /** True when a replacement credential has been typed. */
  get credentialsTyped(): boolean {
    return Object.values(this.credentialDraft).some((value) => value.trim() !== '');
  }

  async saveConnection(): Promise<void> {
    const connection = this.connection;
    const provider = connection ? this.providerNamed(connection.provider) : undefined;
    if (!connection || !provider || this.savingConnection) return;
    const changes = connectionChanges(provider, connection.connection, this.connectionDraft);
    if (Object.keys(changes).length === 0) return;

    this.savingConnection = true;
    try {
      const updated = await this.#api.updateRemoteConnection(connection.name, { connection: changes });
      this.connection = updated;
      this.connectionDraft = connectionDraftOf(provider, updated.connection);
      // What the tracker said about the old values is no longer about this remote.
      this.inspection = null;
      await this.#host.remotesChanged(updated.name);
      this.#host.notify('info', `Updated ${updated.name}`);
    } catch (error) {
      this.#host.report(error);
    } finally {
      this.savingConnection = false;
    }
  }

  /** Store the replacement credentials typed. A blank keeps the value already stored. */
  async saveCredentials(): Promise<void> {
    const connection = this.connection;
    if (!connection || this.savingCredentials) return;
    const credentials = Object.fromEntries(
      Object.entries(this.credentialDraft)
        .map(([key, value]) => [key, value.trim()] as const)
        .filter(([, value]) => value !== ''),
    );
    if (Object.keys(credentials).length === 0) return;

    this.savingCredentials = true;
    try {
      const result = await this.#api.storeRemoteCredentials(connection.name, { credentials });
      this.credentialDraft = {};
      this.connection = { ...connection, credentials: result.credentials };
      this.#host.notify('info', `Stored ${result.stored.join(' and ')} for ${connection.name}`, [
      ]);
    } catch (error) {
      this.#host.report(error);
    } finally {
      this.savingCredentials = false;
    }
  }

  /** Ask the tracker about itself. Whatever it answered unambiguously is written by the server. */
  async inspect(name: string | undefined = this.connection?.name): Promise<void> {
    if (!name || this.inspecting) return;
    this.inspecting = true;
    this.answers = emptyAnswers();
    try {
      const report = await this.#api.inspectRemote(name);
      this.inspection = report;
      if (report.written.length > 0) {
        await this.loadConnection(name);
        await this.#host.remotesChanged(name);
      }
    } catch (error) {
      this.inspection = null;
      this.#host.report(error);
    } finally {
      this.inspecting = false;
    }
  }

  setAnswer(block: keyof AnswerDraft, key: string, value: string): void {
    this.answers = { ...this.answers, [block]: { ...this.answers[block], [key]: value } };
  }

  get hasAnswers(): boolean {
    return Object.keys(answersToSend(this.answers)).length > 0;
  }

  /** Write what was chosen, then ask the tracker again so the report reflects it. */
  async submitAnswers(): Promise<void> {
    const name = this.inspection?.remoteName;
    const body = answersToSend(this.answers);
    if (!name || this.answering || Object.keys(body).length === 0) return;

    this.answering = true;
    let written = false;
    try {
      const result = await this.#api.answerRemote(name, body);
      written = true;
      this.#host.notify(
        'info',
        result.changed.length > 0 ? `Wrote ${result.changed.length} answer(s) to .lpm/config.yml` : 'Nothing changed',
        result.changed,
      );
      await this.loadConnection(name);
      await this.#host.remotesChanged(name);
    } catch (error) {
      this.#host.report(error);
    } finally {
      this.answering = false;
    }
    if (written) await this.inspect(name);
  }

  /** Remove the declaration. The link store and the stored credential are kept. */
  async remove(): Promise<void> {
    const connection = this.connection;
    if (!connection || this.removing) return;
    this.removing = true;
    try {
      await this.#api.removeRemote(connection.name);
      this.connection = null;
      this.inspection = null;
      this.credentialDraft = {};
      await this.#host.remotesChanged();
      this.#host.notify('info', `Removed ${connection.name}`, [
      ]);
    } catch (error) {
      this.#host.report(error);
    } finally {
      this.removing = false;
    }
  }
}

const KEY = Symbol('connections');

export function provideConnectionsState(state: ConnectionsState): ConnectionsState {
  setContext(KEY, state);
  return state;
}

export function useConnectionsState(): ConnectionsState {
  return getContext<ConnectionsState>(KEY);
}
