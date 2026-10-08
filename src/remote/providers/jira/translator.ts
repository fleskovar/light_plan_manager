/**
 * Jira's two-way vocabulary translation.
 *
 * Jira Cloud has *native* issue types, workflow statuses and custom fields, so
 * the mapping names them rather than encoding them onto labels (the GitHub
 * approach). This translator is the Jira-specific bridge, using the remote's
 * `mapping` block:
 *
 *   push: a `BoardOp` plus the mapping becomes a `RemoteRequest` carrying
 *         `type` (issuetype name), `state` (workflow status name, transition-
 *         mediated), `title`, `body`, `assignee` and `parent` key;
 *   pull: a Jira issue record plus the mapping becomes a `BoardFieldsPatch`,
 *         recovering `type` from `fields.issuetype.name` and `status` from
 *         `fields.status.name` when the mapping names them unambiguously.
 *
 * Pure: no I/O. One translator serves every Jira remote. Where a value cannot
 * be mapped back unambiguously, the field is left absent rather than guessed —
 * the pull planner breaks ties with the board's hierarchy (LP-268).
 *
 * Two things are deliberately deferred rather than half-encoded here:
 * **custom fields** (LP-324) — `mapping.attributes` names a field id, but
 * `RemoteRequest` has no field to carry it, so attributes are deferred until
 * that wire shape exists. **Sprints** (LP-328) are carried natively: the
 * period resolves to a `PeriodContainer` on push and the connector writes the
 * sprint field, and on pull the connector's `record.sprint` enrichment resolves
 * back to a period by name.
 */

import { adfToMarkdown, markdownToAdf, type AdfDocument, type AdfNode } from '../../../shared/adf.js';
import type { AttributeDefs } from '../../provider.js';
import type {
  BoardFieldsPatch,
  BoardOp,
  DescribeResult,
  FieldsFromRecordResult,
  RemoteRecord,
  RemoteRequest,
  RemoteUser,
  Translator,
} from '../../provider.js';
import { stripManagedBlock } from '../../links.js';
import { parseManagedBlock } from '../../managed-block.js';
import { withBlockAssignee } from '../../accounts.js';
import {
  boardTypesMatching,
  mapStatusFromRemote,
  mapStatusToRemote,
  mapTypeToRemote,
} from '../../mapping.js';
import {
  mapAssigneeFromRemote,
  mapAssigneeToRemote,
  normalizeAccountMapping,
  type Roster,
} from '../../accounts.js';
import {
  degradedFromBlockFields,
  degradedTypesOf,
  mapPeriodFromRemote,
  mapPeriodToRemote,
  normalizePeriodMapping,
  type DegradedPeriod,
  type PeriodContainer,
  type PeriodGap,
  type PeriodIndex,
} from '../../periods.js';
import type { JiraMapping } from './config.js';
import { isSubtaskType, type JiraIssueType } from './types.js';

/** A Jira issue's `fields` object, read loosely. */
function fieldsOf(record: RemoteRecord): Record<string, unknown> {
  const fields = record['fields'];
  if (fields && typeof fields === 'object' && !Array.isArray(fields)) {
    return fields as Record<string, unknown>;
  }
  return {};
}

/** The Jira issuetype name, when the record carries one. */
function issueTypeNameOf(record: RemoteRecord): string | undefined {
  const issuetype = fieldsOf(record)['issuetype'];
  if (issuetype && typeof issuetype === 'object') {
    const name = (issuetype as Record<string, unknown>)['name'];
    if (typeof name === 'string') return name;
  }
  return undefined;
}

/**
 * Whether this record is a Jira **sub-task**, by Jira's own marker.
 *
 * Not the type's *name*, which a project may rename or localise, and not the
 * board's type name, which says nothing about what Jira thinks. `isSubtaskType`
 * is the one definition — it reads the `subtask` boolean and falls back to
 * `hierarchyLevel === -1`, which is the same claim spelled the other way.
 */
function isSubtaskRecord(record: RemoteRecord): boolean {
  const issuetype = fieldsOf(record)['issuetype'];
  if (issuetype === null || typeof issuetype !== 'object') return false;
  return isSubtaskType(issuetype as JiraIssueType);
}

/** The Jira status name, when the record carries one. */
function statusNameOf(record: RemoteRecord): string | undefined {
  const status = fieldsOf(record)['status'];
  if (status && typeof status === 'object') {
    const name = (status as Record<string, unknown>)['name'];
    if (typeof name === 'string') return name;
  }
  return undefined;
}

/**
 * Recover the local markdown body from a Jira `description` field.
 *
 * Jira Cloud returns `description` as an ADF document (an object) — never a
 * markdown string — so this is where ADF → markdown happens. It also accepts
 * the defensive spellings: a client that stringified the ADF, and a plain
 * string left by an older write, both degrade gracefully rather than dropping
 * the prose.
 */
export function bodyFromDescription(description: unknown): string | undefined {
  if (description === undefined || description === null) return undefined;
  if (typeof description === 'string') {
    const trimmed = description.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (parsed !== null && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>)['type'] === 'string') {
          return adfToMarkdown(parsed as AdfNode);
        }
      } catch {
        // Not JSON — fall through and treat the string as literal prose.
      }
    }
    return description;
  }
  if (typeof description === 'object' && typeof (description as Record<string, unknown>)['type'] === 'string') {
    return adfToMarkdown(description as AdfNode);
  }
  return undefined;
}

/** The Jira labels as plain strings. */
function labelsOf(record: RemoteRecord): string[] {
  const labels = fieldsOf(record)['labels'];
  if (!Array.isArray(labels)) return [];
  return labels.filter((label): label is string => typeof label === 'string');
}

/**
 * The assignee value the account mapping should match against (LP-329). The
 * generic pull matches the observed value against each person's `via`
 * attribute, so the value must be of the *same kind* as that attribute:
 *
 *   - `via: email` matches `assignee.emailAddress` — an email attribute against
 *     an email. A privacy-restricted instance hides the address, in which case
 *     the value falls back to the account id (which will not match, and the
 *     pull reports the assignee as unknown rather than guessing);
 *   - any other `via` (a `jira_account_id` attribute) matches the account id.
 */
function assigneeValueOf(record: RemoteRecord, via: string | undefined): string | undefined {
  const assignee = fieldsOf(record)['assignee'];
  if (!assignee || typeof assignee !== 'object') return undefined;
  const a = assignee as Record<string, unknown>;
  if (via === 'email') {
    const email = a['emailAddress'];
    if (typeof email === 'string' && email.length > 0) return email;
  }
  const accountId = a['accountId'];
  if (typeof accountId === 'string') return accountId;
  return undefined;
}

/**
 * Push: a board op becomes a Jira request description.
 *
 * `type` is the mapped issuetype name; `state` the mapped workflow status name
 * (a push writes it as a transition, resolved by the connector). A create/update
 * also carries `title`, `body` and the resolved assignee account id. A delete
 * carries only its kind — Jira deletes hard.
 */
export function describeRequest(
  op: BoardOp,
  mapping: Record<string, unknown>,
  _attributes: AttributeDefs,
  roster: Roster = new Map(),
  periods: PeriodIndex = new Map(),
): DescribeResult {
  if (op.kind === 'delete') {
    return { request: { kind: 'delete' }, problems: [], resourceGaps: [], periodGaps: [] };
  }

  const m = mapping as JiraMapping;
  const resourceGaps = [];
  const periodGaps: PeriodGap[] = [];
  let state: string | undefined;
  let assignee: string | null | undefined;
  let period: PeriodContainer | null | undefined;
  let degradedPeriods: DegradedPeriod[] | undefined;

  // Jira has a native issuetype, so the mapped value is written there.
  const type = mapTypeToRemote(m.types ?? {}, op.fields.type);

  const remoteStatus = mapStatusToRemote(m.statuses ?? {}, op.fields.status);
  if (remoteStatus !== undefined) state = remoteStatus;

  if (op.fields.assignee !== undefined) {
    const accounts = normalizeAccountMapping(m.accounts);
    const push = mapAssigneeToRemote(roster, accounts, op.fields.assignee);
    assignee = push.account ?? null;
    if (push.gap) resourceGaps.push(push.gap);
  }

  // Period: resolve the issue's period to a sprint (the container) plus the
  // degraded levels above it, which ride the managed block (LP-328, LP-313).
  // Absent (`undefined`) means the op does not carry a period, so the remote
  // side is left untouched; a period at a degraded level has no container and
  // clears the sprint, its membership riding on the block instead.
  if (op.fields.period !== undefined) {
    const periodMapping = normalizePeriodMapping(m.periods);
    if (periodMapping) {
      const push = mapPeriodToRemote(periods, periodMapping, op.fields.period);
      if (push.degraded.length > 0) degradedPeriods = push.degraded;
      period = push.container ?? null;
      if (push.gap) periodGaps.push(push.gap);
    }
  }

  // The body leaves here as **markdown**, with the managed block stripped: the
  // block is the executor's to compose (it knows the degraded parent, the
  // degraded period levels and the edges that landed), and it composes in
  // markdown. Converting to ADF here meant the executor's
  // `typeof body === 'string'` guard skipped the block entirely on create and
  // sent raw markdown on a block rewrite, which Jira refused — so rung 4 did
  // not work on Jira at all. The connector converts at the wire, which is
  // where an encoding belongs.
  let body: string | undefined;
  if (op.fields.body !== undefined) {
    body = stripManagedBlock(op.fields.body);
  }

  return {
    request: {
      kind: op.kind,
      type,
      title: op.fields.title,
      body,
      state,
      assignee,
      period,
      ...(degradedPeriods !== undefined ? { degradedPeriods } : {}),
    },
    problems: [],
    resourceGaps,
    periodGaps,
  };
}

/**
 * Pull: a Jira issue record becomes board fields.
 *
 * `title` ← `fields.summary`; `body` ← `fields.description` (a string here —
 * Jira Cloud returns ADF, and LP-322 is where the ADF → markdown conversion
 * lands); `type` ← `fields.issuetype.name` matched against the mapping's
 * native type names; `status` ← `fields.status.name`; `assignee` ← the account
 * id matched against the roster.
 */
export function fieldsFromRecord(
  record: RemoteRecord,
  mapping: Record<string, unknown>,
  _attributes: AttributeDefs,
  roster: Roster = new Map(),
  periods: PeriodIndex = new Map(),
): FieldsFromRecordResult {
  const m = mapping as JiraMapping;
  const patch: BoardFieldsPatch = {};
  const unknownAccounts: FieldsFromRecordResult['unknownAccounts'] = [];
  const result: FieldsFromRecordResult = { patch, problems: [], unknownAccounts };

  const summary = fieldsOf(record)['summary'];
  if (typeof summary === 'string') patch.title = summary;

  // `description` is ADF on Jira Cloud; ADF → markdown lands here (LP-323).
  //
  // The managed block is the sync layer's own output, never the document's
  // prose, so it is **parsed off** the way GitHub and Linear have always parsed
  // it. Jira used to do neither: the block's markdown was written straight into
  // the local body on every pull, and everything it carried — the degraded
  // period levels, the parent, the assignee a tracker cannot hold — was lost.
  // A board pushed to Jira and pulled back somewhere else came out missing the
  // half of itself that Jira has no field for, which is exactly what the block
  // exists to prevent.
  const body = bodyFromDescription(fieldsOf(record)['description']);
  let managedFields: Record<string, string> = {};
  if (body !== undefined) {
    const parsed = parseManagedBlock(body);
    patch.body = parsed.found ? parsed.body : body;
    if (parsed.found) managedFields = parsed.fields;
  }

  // Type: the native issuetype name matched against the mapping's `type`
  // names. Ambiguity leaves the field absent — the pull planner breaks ties.
  const remoteType = issueTypeNameOf(record);
  if (remoteType !== undefined) {
    const candidates = boardTypesMatching(m.types ?? {}, { remoteType, labels: [] });
    if (candidates.length === 1) patch.type = candidates[0];
  }

  // Status: the native status name resolved through the mapping.
  const remoteStatus = statusNameOf(record);
  if (remoteStatus !== undefined) {
    const resolution = mapStatusFromRemote(m.statuses ?? {}, [remoteStatus]);
    if (resolution.status !== undefined) patch.status = resolution.status;
  }

  // Period: the sprint (enriched onto the record by the connector as
  // `record.sprint`) resolves to a local period by name among the mapped
  // level's periods; its dates are recovered for the planner to reconcile, and
  // a sprint matching no local period is reported, never invented (LP-328).
  //
  // **A sub-task's sprint is not its own, so it is never read back.** Jira does
  // not let a sub-task be scheduled independently: it reports the *parent's*
  // sprint on the sub-task, the identical object, whether or not anything ever
  // wrote it there. Reading that as the sub-task's own value is a remote edit
  // nobody made — on this repository's board every one of the 13 sub-tasks came
  // back `behind` on `period`, permanently, because the board schedules the
  // story and Jira echoes that sprint onto each of its children. Pulling it
  // would not settle anything either: it would write a derived sprint onto
  // documents the plan deliberately schedules one level up, changing what the
  // periods view and the Gantt add up, and every one of them would drift again
  // the moment the parent moved sprint.
  //
  // Omitting the field is the whole fix, in both directions, because the base
  // snapshot falls back to the *local* value for a field the record does not
  // carry (`baseFromRecord` in execute.ts): board and base agree, so nothing is
  // ahead, and there is no remote value, so nothing is behind. The sprint is
  // still mirrored — by the parent's own twin, which is the document that owns
  // it. Same family as `normalizeBody`: a round trip the remote performs
  // anyway, absorbed rather than reported as drift.
  const periodMapping = normalizePeriodMapping(m.periods);
  if (periodMapping && !isSubtaskRecord(record)) {
    const sprint = record['sprint'];
    let name: string | undefined;
    let starts: string | undefined;
    let ends: string | undefined;
    if (sprint !== null && typeof sprint === 'object') {
      const observed = sprint as Record<string, unknown>;
      if (typeof observed['name'] === 'string') name = observed['name'];
      if (typeof observed['starts'] === 'string') starts = observed['starts'];
      if (typeof observed['ends'] === 'string') ends = observed['ends'];
    }
    const pull = mapPeriodFromRemote(periods, periodMapping, {
      container: name,
      starts,
      ends,
      // The levels above the mapped one ride the block, because a Jira sprint is
      // the only native container there is. Reading them back is what lets a
      // fresh board recover the increment an issue sat in.
      degraded: degradedFromBlockFields(managedFields, degradedTypesOf(periods, periodMapping)),
    });
    if (pull.periodId !== undefined) patch.period = pull.periodId;
    result.period = pull;
  }

  // Assignee: the account id (or, for `via: email`, the email address) matched
  // against the roster's `via` attribute. An assignee nobody matches is
  // reported, never invented (LP-329).
  const accounts = normalizeAccountMapping(m.accounts);
  const account = assigneeValueOf(record, accounts?.via);
  const labels = labelsOf(record);
  // An assignee the remote could not hold rides the managed block (rung 4), and
  // it is recovered by handing the block's value to the same pool resolution the
  // `pool:` label uses — both carry a board resource id, so one reader serves
  // both and there is no second way for an assignee to come back.
  const resolved = mapAssigneeFromRemote(roster, accounts, {
    account,
    labels: withBlockAssignee(labels, managedFields),
  });
  if (resolved.resourceId !== undefined) {
    patch.assignee = resolved.resourceId;
  } else if (resolved.unassigned) {
    patch.assignee = null;
  } else if (resolved.unknown) {
    unknownAccounts.push(resolved.unknown);
  }

  return result;
}

/**
 * A board body as Jira will hand it back.
 *
 * Jira's description is ADF, and ADF has paragraphs but no source line breaks:
 * a body hard-wrapped at eighty columns is one paragraph node on the way out
 * and comes back as one long line. The base snapshot records what the remote
 * echoed, so without this every wrapped document is permanently ahead — a push
 * that rewrote all forty-three of them, and did it again on the next run.
 *
 * Running the board's own body through the same round trip makes the comparison
 * like-for-like: re-wrapping stops counting as a change, and a real edit on
 * either side still does.
 */
function normalizeBody(markdown: string): string {
  return adfToMarkdown(markdownToAdf(markdown));
}

/**
 * Which of a remote user's fields answers a board attribute.
 *
 * Jira assigns by **account id** and nothing else; an `email` in the mapping
 * is a lookup key the connector resolves by search, not the thing Jira stores.
 * So an `email`-keyed roster wants the user's email and everything else wants
 * the account id — and a user the instance reports without an email (a
 * privacy-restricted site does exactly that) cannot answer an email-keyed
 * attribute at all, which is `undefined` rather than a guess.
 */
function accountValue(user: RemoteUser, via: string): string | undefined {
  if (via === 'email') return user.email;
  return user.id;
}

export const jiraTranslator: Translator = {
  describeRequest,
  fieldsFromRecord,
  normalizeBody,
  accountValue,
};
