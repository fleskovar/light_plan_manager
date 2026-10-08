/**
 * The Jira provider adapter — one folder, exposing the four-member `Provider`
 * shape the registry holds.
 *
 * Adding a provider is exactly this folder plus one line in
 * `src/remote/registry.ts`. Nothing in core or the planners names Jira.
 */

import type { Capabilities } from '../../capabilities.js';
import type { Provider, RemoteRecord } from '../../provider.js';
import { jiraConfigSchema } from './config.js';
import { jiraConnector } from './connector.js';
import { jiraTranslator } from './translator.js';
import { jiraVocabulary } from './vocabulary.js';

export { jiraDependsOnOf, jiraRelatesToOf } from './links.js';
export { jiraParentIdOf, jiraNativeParentIdOf } from './hierarchy.js';

/**
 * The remote id a Jira record is keyed by: its numeric issue `id`, the same id
 * the connector writes into a `ConnectorResult.remoteId`. The human-facing
 * `key` (`PAY-418`) is never used as a key — it is carried as `remoteKey`.
 */
export function jiraRemoteIdOf(record: RemoteRecord): string {
  const id = record['id'];
  if (typeof id === 'string' && id !== '') return id;
  if (typeof id === 'number') return String(id);
  return '';
}

/**
 * Jira Cloud's capability table (LP-274), from the LP-267 audit
 * (`docs/remote-capabilities.md`). Static cells are facts of the platform;
 * probed cells vary by plan or permission and are answered by
 * `jiraConnector(...).probe(name)` once per remote.
 *
 * Jira is the *most* capable platform of the three researched: native types,
 * transition-mediated statuses, native blocking/relates edges, rich custom
 * fields, sprints and full-featured comments.
 */
export const jiraCapabilities: Capabilities = {
  // Epic → Story → Sub-task is the *classic* ceiling, but levels above Epic
  // are a paid Premium feature and the ceiling is per-project configuration —
  // so the depth is detected against the project's actual type scheme, never
  // assumed (LP-324). The connector answers the `hierarchy` probe once per
  // remote.
  hierarchyDepth: { probe: 'hierarchy' },
  // Jira's hierarchy is defined from the bottom up — `Subtask` < standard <
  // `Epic` — and only a standard issue may sit under an Epic. So the native
  // chain is spent on the *deepest* board levels: the work items nest under
  // their container, and everything above rides the managed block. Anchored at
  // the root instead, every native edge lands where Jira refuses it (a board
  // with three levels above its stories maps them all onto `Epic`, and an Epic
  // may not sit under an Epic) while the one relationship Jira would hold is
  // the one that degrades — which is how a filed board came out flat.
  hierarchyAnchor: 'leaf',
  // Issue types are native and per-project.
  nativeTypes: true,
  // Status is a workflow: a change is a transition, and the target may be
  // unreachable from where the issue stands.
  status: { kind: 'transitions' },
  // `blocks` / `is blocked by` and `relates to` are native issue links.
  edges: { dependsOn: true, relatesTo: true },
  // Custom fields exist extensively; the value types available are a live fact
  // (LP-324 discovers and caches names → ids against the instance).
  customFields: { probe: 'custom_fields' },
  // Custom fields and sprints are creatable; labels are free-form (applied,
  // never pre-created).
  provisioning: { customFields: true, periods: true, labels: false },
  // Sprints are native period containers, creatable through the Agile API.
  periods: { native: true, creatable: true },
  // Comments carry ids, can be edited and deleted.
  comments: { native: true, editable: true, deletable: true },
  // Cursor-paginated search (`nextPageToken`) paired with a `updated >=` JQL
  // filter — the offset-paginated endpoint is deprecated and never used.
  incrementalRead: { kind: 'cursor' },
  // Issue types and workflow statuses are the project's own vocabulary.
  vocabulary: 'fixed',
};

export const jiraProvider: Provider = {
  config: jiraConfigSchema,
  capabilities: jiraCapabilities,
  translator: jiraTranslator,
  connector: jiraConnector,
  conditionalConnection: [
    {
      key: 'board',
      needs: 'periods',
      why:
        'a Jira sprint belongs to an Agile board, not a project. ' +
        'Run `lpm remote setup jira` to find it, or set it by hand: the id is the number in the ' +
        'board URL (…/jira/software/c/projects/PAY/boards/12).',
    },
  ],
  credentials: {
    secrets: { email: 'JIRA_EMAIL', token: 'JIRA_API_TOKEN' },
    visible: ['email'],
    url: 'https://id.atlassian.com/manage-profile/security/api-tokens',
    hint:
      'An Atlassian API token, plus the email of the account that owns it. What the token may ' +
      'do is decided by the project permissions that account has (Browse / Create / Edit / ' +
      'Transition Issues at a minimum) — see docs/remote-jira.md for the list to send an admin.',
  },
  standardVocabulary: jiraVocabulary,
};
