/**
 * Secret redaction (LP-296) — the one place a secret value becomes `***`.
 *
 * A secret is a credential value resolved at sync time (LP-295). It must never
 * reach a terminal, a log file or a pasted bug report, so every surface that
 * can carry one runs through this module:
 *
 *   - the CLI's output sink wraps it (`src/cli/ui.ts`), which covers errors,
 *     logs and progress output in one place rather than at each call site;
 *   - the dry-run renderer redacts field values with the same pure function
 *     (`render.ts`), so `--dry-run` and the web preview share the marker;
 *   - `redactHeaders` / `redactUrl` cover the two shapes a secret takes on the
 *     wire, for a future HTTP debug trace.
 *
 * The marker is `***` — the story's spelling — and the rule is replacement,
 * never omission: the shape of a line survives, so a redacted log still reads
 * as a log. A header value is redacted *whole* (a header carrying a secret
 * becomes `***`, not `Bearer ***`), because the value is the secret's wrapping,
 * not just its contents.
 *
 * The pure functions take the secret list as an argument so the renderer —
 * browser-compatible, given its secrets per call — and the process-wide
 * redactor below share one definition. Nothing here imports a Node module, so
 * it compiles for the browser exactly like the planners.
 */

/** The marker a redacted secret becomes. */
export const REDACTED = '***';

/**
 * The forms of a secret that may appear in text: the raw value, and its
 * percent-encoded form (a secret sitting in a URL query or fragment). For a
 * token whose characters are all URL-safe the two are identical, so the
 * generator yields it once.
 */
function* secretForms(secret: string): Generator<string> {
  yield secret;
  const encoded = encodeURIComponent(secret);
  if (encoded !== secret) yield encoded;
}

/**
 * Replace every secret that occurs in `text` with `REDACTED`. Empty secrets are
 * ignored (nothing to match). The encoded form is matched too, so a secret in
 * a URL is caught whether or not the URL escaped it.
 */
export function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    for (const form of secretForms(secret)) {
      out = out.split(form).join(REDACTED);
    }
  }
  return out;
}

/** True when `value` carries any form of any secret. */
function containsSecret(value: string, secrets: readonly string[]): boolean {
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    for (const form of secretForms(secret)) {
      if (value.includes(form)) return true;
    }
  }
  return false;
}

/** Redact a value recursively: strings directly, arrays and objects element-wise. */
export function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = redactValue(entry, secrets);
    return out;
  }
  return value;
}

/**
 * Redact a headers record: any header whose *value* carries a secret becomes
 * `REDACTED` whole. Header *names* are never touched — they are fixed
 * vocabulary (`Authorization`, `X-Api-Key`), not data.
 */
export function redactHeaders(
  headers: Readonly<Record<string, string>>,
  secrets: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = containsSecret(value, secrets) ? REDACTED : value;
  }
  return out;
}

/** Redact a URL: the secret, raw or percent-encoded, becomes `REDACTED`. */
export function redactUrl(url: string, secrets: readonly string[]): string {
  return redactText(url, secrets);
}

// ---------------------------------------------------------------------------
// The process-wide redactor
// ---------------------------------------------------------------------------

/**
 * A redactor holding the secrets currently in play. The process-wide instance
 * (`redactor`) is what the output sink consults; `createRedactor` exists for
 * an isolated one in a test.
 */
export interface Redactor {
  /** Add one secret value; empty strings are ignored. */
  register(secret: string): void;
  /** Add every secret value from an iterable. */
  registerAll(secrets: Iterable<string>): void;
  /** The currently-registered secrets, as a snapshot. */
  secrets(): readonly string[];
  /** Forget every registered secret (tests). */
  clear(): void;
  /** Replace every registered secret in `text` with `REDACTED`. */
  redact(text: string): string;
  /** Redact a value recursively against the registered secrets. */
  redactValue(value: unknown): unknown;
  /** Redact header values that carry a registered secret, whole. */
  redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string>;
  /** Redact a URL against the registered secrets. */
  redactUrl(url: string): string;
}

/** A redactor over a private secret set, closed over — nothing else can read it. */
export function createRedactor(): Redactor {
  const known = new Set<string>();
  const snapshot = (): readonly string[] => [...known];
  const register = (secret: string): void => {
    if (secret.length > 0) known.add(secret);
  };

  return {
    register,
    registerAll(secrets) {
      for (const secret of secrets) register(secret);
    },
    secrets: snapshot,
    clear() {
      known.clear();
    },
    redact(text) {
      return redactText(text, snapshot());
    },
    redactValue(value) {
      return redactValue(value, snapshot());
    },
    redactHeaders(headers) {
      return redactHeaders(headers, snapshot());
    },
    redactUrl(url) {
      return redactUrl(url, snapshot());
    },
  };
}

/** The process-wide redactor the CLI's output sink and credential resolver share. */
export const redactor: Redactor = createRedactor();
