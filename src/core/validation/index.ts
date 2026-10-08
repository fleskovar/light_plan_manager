/**
 * Board validation. `check` is read-only and reports every problem it finds;
 * `fix` repairs exactly the subset `check` marks `fixable`. Keeping them in one
 * folder — and sharing `shared.ts` — is what stops the two drifting apart.
 */
export * from './check.js';
export * from './fix.js';
