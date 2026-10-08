/**
 * Linear's estimation scale (LP-333): the team's `issueEstimationType` plus its
 * two switches, judged against the board's effort values.
 *
 * `estimate` is a `Float` on the Linear issue, but its *meaning* is the team's
 * scale — `linear`, `exponential`, `fibonacci` or `tShirt` — and Linear rejects
 * a value outside it (note 4 of `docs/remote-capabilities.md`). So a board's
 * effort attribute cannot be mirrored by rounding to the nearest legal value;
 * a value off the scale is reported at preflight with the allowed values, and
 * the write is blocked until a person fixes the value or the team's scale.
 *
 * The allowed values below come from Linear's own docs (`linear.app/docs/estimates`):
 * each scale is five values, `issueEstimationExtended` adds two more, and
 * `issueEstimationAllowZero` admits zero. T-shirt sizes arrive numerically
 * through the `Float` estimate field and follow the Fibonacci scale.
 *
 * The split mirrors Jira's `fields.ts` / `types.ts`: `allowedEstimateValues`
 * and `estimateScaleProblems` are the pure judges, `preflightEstimateScale` is
 * the one async composition that ties the connector fetch to the judge, ready
 * for the sync command to call before it plans a push.
 */

import type { Problem } from '../../../core/model/types.js';

/** The team's estimation type, as `Team.issueEstimationType` reports it. */
export type EstimateScaleKind = 'notUsed' | 'exponential' | 'fibonacci' | 'linear' | 'tShirt';

/** The team's estimation configuration, trimmed from the `team` query. */
export interface LinearEstimateScale {
  /** `issueEstimationType` — "notUsed", "exponential", "fibonacci", "linear", "tShirt". */
  type: string;
  /** `issueEstimationAllowZero` — whether zero is a legal estimate. */
  allowZero: boolean;
  /** `issueEstimationExtended` — whether the two extended values are legal. */
  extended: boolean;
}

/** The five base values of each scale, in Linear's own order. */
const BASE_VALUES: Record<EstimateScaleKind, number[]> = {
  notUsed: [],
  exponential: [1, 2, 4, 8, 16],
  fibonacci: [1, 2, 3, 5, 8],
  linear: [1, 2, 3, 4, 5],
  tShirt: [1, 2, 3, 5, 8], // XS, S, M, L, XL — numeric, follows Fibonacci
};

/** The two values `issueEstimationExtended` adds to each scale. */
const EXTENDED_VALUES: Record<EstimateScaleKind, number[]> = {
  notUsed: [],
  exponential: [32, 64],
  fibonacci: [13, 21],
  linear: [6, 7],
  tShirt: [13, 21], // XXL, XXXL
};

/**
 * The estimate values the team accepts, in ascending order — or `null` when
 * estimates are disabled (`notUsed`), in which case no value is legal.
 */
export function allowedEstimateValues(scale: LinearEstimateScale): number[] | null {
  if (scale.type === 'notUsed') return null;
  const kind = scale.type as EstimateScaleKind;
  const base = BASE_VALUES[kind];
  if (base === undefined) {
    // An estimation type this build predates. Treat it as an empty scale and
    // report rather than guess: every value is off-scale and the report names
    // the unknown type.
    return null;
  }
  const values = [...base, ...(scale.extended ? (EXTENDED_VALUES[kind] ?? []) : [])];
  if (scale.allowZero) values.unshift(0);
  return [...new Set(values)].sort((a, b) => a - b);
}

/** The scale's display name, for a report a person reads. */
function scaleLabel(scale: LinearEstimateScale): string {
  switch (scale.type) {
    case 'notUsed':
      return 'disabled';
    case 'exponential':
      return 'exponential';
    case 'fibonacci':
      return 'fibonacci';
    case 'linear':
      return 'linear';
    case 'tShirt':
      return 'T-shirt';
    default:
      return `"${scale.type}"`;
  }
}

/**
 * Judge the board's effort values against the team's scale. Every value outside
 * the allowed set is reported as an **error** naming the value and the allowed
 * values — never silently rounded, and the push is blocked while one remains.
 *
 * Pure: the scale, the effort attribute name and the values in, `Problem[]`
 * out. `values` are the in-scope documents' effort attribute values (numbers);
 * a non-finite or repeated value is reported once.
 */
export function estimateScaleProblems(
  scale: LinearEstimateScale,
  effortAttribute: string,
  values: readonly number[],
  remoteName: string,
  configPath: string,
): Problem[] {
  const allowed = allowedEstimateValues(scale);
  const path = `remotes.${remoteName}.mapping.effort.attribute`;

  const offenders = [...new Set(values)]
    .filter((value) => Number.isFinite(value) && (allowed === null || !allowed.includes(value)))
    .sort((a, b) => a - b);

  return offenders.map((value) => ({
    level: 'error',
    path: configPath,
    message:
      allowed === null
        ? `${path}: "${effortAttribute}" value ${value} cannot be mirrored — the team's estimate scale is ${scaleLabel(scale)}`
        : `${path}: "${effortAttribute}" value ${value} is outside the team's ${scaleLabel(scale)} scale — allowed values: ${allowed.join(', ')}`,
  }));
}

/** The connector surface the estimate logic reads — a live Linear connector or a fake. */
export interface LinearEstimateConnector {
  readonly name: string;
  /** Fetch the team's estimation configuration (`team` query). */
  estimateScale?(): Promise<LinearEstimateScale>;
}

/**
 * The live preflight for the estimation scale: fetch the team's scale through
 * the connector and judge the board's effort values against it, returning the
 * `Problem[]` a sync gates on (`hasErrorProblems`).
 *
 * A connector without `estimateScale()` — a fake, or a provider build before
 * the method — is a no-op: without the live scale there is nothing to judge.
 */
export async function preflightEstimateScale(
  connector: LinearEstimateConnector,
  effortAttribute: string,
  values: readonly number[],
  remoteName: string,
  configPath: string,
): Promise<Problem[]> {
  if (typeof connector.estimateScale !== 'function') return [];
  const scale = await connector.estimateScale();
  return estimateScaleProblems(scale, effortAttribute, values, remoteName, configPath);
}
