/**
 * The GitHub provider adapter — one folder, exposing the four-member `Provider`
 * shape the registry holds.
 *
 * Adding a provider is exactly this folder plus one line in
 * `src/remote/registry.ts`. Nothing in core or the planners names GitHub.
 */

import type { Capabilities } from '../../capabilities.js';
import type { Provider, RemoteRecord } from '../../provider.js';
import { githubConfigSchema } from './config.js';
import { githubConnector } from './connector.js';
import { githubBlockEdgesOf } from './edges.js';
import { githubParentIdOf } from './hierarchy.js';
import { githubTranslator } from './translator.js';

export { githubBlockEdgesOf } from './edges.js';
export { githubParentIdOf, githubNativeParentIdOf } from './hierarchy.js';

/**
 * The remote id a GitHub record is keyed by: its repository issue number, the
 * same id the connector writes into a `ConnectorResult.remoteId`. The global
 * `id` / `node_id` fields are never used here — a cross-board link names the
 * repo-local number, exactly as `acme/payments#418` does.
 */
export function githubRemoteIdOf(record: RemoteRecord): string {
  const number = record['number'];
  if (typeof number === 'number') return String(number);
  if (typeof number === 'string' && number !== '') return number;
  return '';
}

/**
 * GitHub's capability table (LP-274), from the LP-267 audit
 * (`docs/remote-capabilities.md`). Static cells are facts of the platform;
 * probed cells vary by plan, rollout or permission and are answered by
 * `githubConnector(...).probe(name)` once per remote.
 */
export const githubCapabilities: Capabilities = {
  // Sub-issues give one native parent edge, but their availability varies by
  // plan and rollout — a live probe, never a version constant (LP-309).
  hierarchyDepth: { probe: 'sub_issues' },
  // Issue types are org-level and opt-in per repository — a live fact.
  nativeTypes: { probe: 'native_types' },
  // Open/closed, with `state_reason` recording why.
  status: { kind: 'binary', open: 'open', closed: 'closed' },
  // No blocking or "relates" edge anywhere (cross-references are read-only).
  edges: { dependsOn: false, relatesTo: false },
  // Org issue fields are plan/rollout gated; their value types arrive live.
  customFields: { probe: 'custom_fields' },
  // What a push can create before it files is permission-dependent.
  provisioning: { probe: 'provisioning' },
  // Milestones are native period containers, creatable via REST.
  periods: { native: true, creatable: true },
  // Issue comments carry ids, can be edited and deleted over REST.
  comments: { native: true, editable: true, deletable: true },
  // REST `since` timestamp.
  incrementalRead: { kind: 'since' },
  // Label and issue-type names are GitHub's own; a scaffold must ask.
  vocabulary: 'fixed',
};

export const githubProvider: Provider = {
  config: githubConfigSchema,
  capabilities: githubCapabilities,
  translator: githubTranslator,
  connector: githubConnector,
  credentials: {
    secrets: { token: 'GITHUB_TOKEN' },
    url: 'https://github.com/settings/personal-access-tokens/new',
    hint:
      'A fine-grained personal access token limited to the one repository, with Issues: ' +
      'read and write (Metadata: read-only comes with it). Nothing else is needed for a ' +
      'labels-only board.',
  },
};
