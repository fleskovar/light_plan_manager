/**
 * The Linear provider adapter — one folder, exposing the four-member `Provider`
 * shape the registry holds.
 *
 * Adding a provider is exactly this folder plus one line in
 * `src/remote/registry.ts`. Nothing in core or the planners names Linear.
 */

import type { Capabilities } from '../../capabilities.js';
import type { Provider, RemoteRecord } from '../../provider.js';
import { linearConfigSchema } from './config.js';
import { linearConnector } from './connector.js';
import { linearTranslator } from './translator.js';
import { linearVocabulary } from './vocabulary.js';

export { linearDependsOnOf, linearParentIdOf, linearRelatesToOf } from './labels.js';

/**
 * The remote id a Linear record is keyed by: its GraphQL `id`, the same id the
 * connector writes into a `ConnectorResult.remoteId`. The human-facing
 * `identifier` (`LIN-1`) is never used as a key — two records always resolve
 * by `id`.
 */
export function linearRemoteIdOf(record: RemoteRecord): string {
  const id = record['id'];
  if (typeof id === 'string' && id !== '') return id;
  if (typeof id === 'number') return String(id);
  return '';
}
export {
  allowedEstimateValues,
  estimateScaleProblems,
  preflightEstimateScale,
  type EstimateScaleKind,
  type LinearEstimateConnector,
  type LinearEstimateScale,
} from './estimate.js';
export {
  preflightWorkflowStates,
  stateProblems,
  validateStateMapping,
  type BoardStatusFlags,
  type LinearWorkflowState,
  type LinearWorkflowStatesConnector,
  type MissingWorkflowState,
  type StateMappingReport,
  type WorkflowStateTypeMismatch,
} from './states.js';

/**
 * Linear's capability table (LP-274), from the LP-267 audit
 * (`docs/remote-capabilities.md`). Every cell is a static fact of the platform
 * — Linear has no plan-tier variance in what its API can hold — so there are
 * no probes here (unlike GitHub's plan/rollout-gated cells).
 *
 * Linear is the *least* capable platform for attributes — no custom fields at
 * all — but fully native for status (workflow states), edges (relations) and
 * periods (cycles), with a real soft delete (`issueDelete` → 30-day trash).
 */
export const linearCapabilities: Capabilities = {
  // Native sub-issues give exactly one parent level (issue › sub-issue);
  // deeper boards ride the managed block (rung 4).
  hierarchyDepth: 1,
  // No issue types — the board type rides labels (rung 3).
  nativeTypes: false,
  // Team workflow states, named per team, each with a `type`.
  status: { kind: 'states' },
  // `blocks` and `related` relations are native and directional.
  edges: { dependsOn: true, relatesTo: true },
  // No custom fields — attributes ride labels or the managed block.
  customFields: null,
  // Cycles and labels are creatable; custom fields are not a thing at all.
  provisioning: { customFields: false, periods: true, labels: true },
  // Cycles are native period containers, creatable through the API.
  periods: { native: true, creatable: true },
  // Comments carry ids, can be edited and deleted.
  comments: { native: true, editable: true, deletable: true },
  // `updatedAt` filtering over a relay cursor.
  incrementalRead: { kind: 'since' },
  // Workflow state names are the team's own vocabulary.
  vocabulary: 'fixed',
};

export const linearProvider: Provider = {
  config: linearConfigSchema,
  capabilities: linearCapabilities,
  translator: linearTranslator,
  connector: linearConnector,
  credentials: {
    secrets: { api_key: 'LINEAR_API_KEY' },
    url: 'https://linear.app/settings/account/security',
    hint:
      'A personal API key (Settings → Account → Security & access) with Read, Write, ' +
      'Create issues and Create comments — not Admin. Scope it to the team this remote names.',
  },
  standardVocabulary: linearVocabulary,
};
