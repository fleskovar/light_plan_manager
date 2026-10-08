/** An error the CLI can print verbatim: a headline plus optional detail lines. */
export class BoardError extends Error {
  readonly details: string[];

  constructor(message: string, details: string[] = []) {
    super(message);
    this.name = 'BoardError';
    this.details = details;
  }
}

/**
 * Somebody else got there first.
 *
 * A `BoardError` in every respect — it prints the same way and carries the same
 * hints — but distinguishable, because the remedy is different in kind. A
 * request that is wrong stays wrong however often it is repeated; a request that
 * lost a race is answered by reading the board again and asking a fresh
 * question, which is something a queue runner can do for itself. `lpm queue
 * agent` picks the next task instead of stopping on one of these, and nothing
 * else may act on the distinction by matching on the message.
 *
 * The two things that raise one: a document that changed underneath the handle
 * it was read into (`requireUnchanged`), and an issue somebody claimed while
 * this process was deciding to claim it (`claimIssue`).
 */
export class ConflictError extends BoardError {
  constructor(message: string, details: string[] = []) {
    super(message, details);
    this.name = 'ConflictError';
  }
}
