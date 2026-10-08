/**
 * The jsonfile provider adapter — one folder, exposing the four-member
 * `Provider` shape the registry holds.
 *
 * Adding a provider is exactly this folder plus one line in
 * `src/remote/registry.ts`. Nothing in core or the planners names jsonfile.
 */

import type { Capabilities } from '../../capabilities.js';
import { parentRemoteIdFromBlock } from '../../hierarchy.js';
import type { Provider, RemoteRecord } from '../../provider.js';
import { jsonfileConfigSchema } from './config.js';
import { jsonfileConnector } from './connector.js';
import { jsonfileTranslator } from './translator.js';

/** The remote id a jsonfile record is keyed by: its per-file issue number. */
export function jsonfileRemoteIdOf(record: RemoteRecord): string {
  const number = record.number;
  if (typeof number === 'number') return String(number);
  if (typeof number === 'string' && number !== '') return number;
  return '';
}

/** The remote issue numbers a record waits on — its native `depends_on` edges. */
export function jsonfileDependsOnOf(record: RemoteRecord): string[] {
  const deps = record.depends_on;
  if (!Array.isArray(deps)) return [];
  return deps
    .map((entry) => (typeof entry === 'number' ? String(entry) : typeof entry === 'string' ? entry : ''))
    .filter((entry) => entry !== '');
}

/**
 * The remote id of a record's parent, from the managed block (the file is a
 * flat tracker — hierarchyDepth 0 — so the parent rides rung 4, never a native
 * field).
 */
export function jsonfileParentIdOf(record: RemoteRecord): string | undefined {
  const body = record.body;
  if (typeof body === 'string') return parentRemoteIdFromBlock(body);
  return undefined;
}

/**
 * The jsonfile capability table. Every cell is a static fact — a JSON file has
 * no plan tiers or rollouts to probe. This is the first provider whose `type`
 * and `status` are both *native* fields (rung 1), and the only one whose
 * `delete` hard-removes the issue.
 */
export const jsonfileCapabilities: Capabilities = {
  // Flat: no native parent field. Deeper nesting rides the managed block.
  hierarchyDepth: 0,
  // The `type` field is native.
  nativeTypes: true,
  // A named `status` field, exactly as Linear's workflow-state name is native.
  status: { kind: 'states' },
  // `depends_on` is a native edge list; no native `relates_to`.
  edges: { dependsOn: true, relatesTo: false },
  // No typed custom-field registry — attributes ride labels (rung 3).
  customFields: null,
  // Nothing is creatable through an API — the file is the whole API.
  provisioning: { customFields: false, periods: false, labels: false },
  // No native period container.
  periods: { native: false, creatable: false },
  // Comments carry ids, can be edited and deleted.
  comments: { native: true, editable: true, deletable: true },
  // `updated_at` filtering over a full read.
  incrementalRead: { kind: 'since' },
  // The file is ours: its type and status strings are whatever we write, so
  // a scaffold names them after the board and leaves nothing to fill in.
  vocabulary: 'open',
};

/**
 * Where a jsonfile remote's tracker lives when nobody says otherwise:
 * `.lpm/remotes/<name>/tracker.json`, beside that remote's own link store and
 * caches. The path is relative to the board root — the connector resolves it
 * from there, so a sync run from a subdirectory finds the same file.
 *
 * This is the one provider whose connection names something *light-plan* owns
 * rather than somebody else's system, so it is the one provider that can pick
 * for itself. `--file` still overrides it.
 */
export function jsonfileDefaultConnection(remoteName: string): Record<string, unknown> {
  return { file: `.lpm/remotes/${remoteName}/tracker.json` };
}

export const jsonfileProvider: Provider = {
  config: jsonfileConfigSchema,
  capabilities: jsonfileCapabilities,
  translator: jsonfileTranslator,
  connector: jsonfileConnector,
  defaultConnection: jsonfileDefaultConnection,
};
