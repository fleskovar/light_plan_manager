/**
 * Label reconciliation — which labels a sync owns, and how a push merges them
 * without trampling human triage (LP-308).
 *
 * A remote that carries board vocabulary on labels (GitHub) shares its labels
 * with people: a maintainer triages by slapping `bug`, `needs-triage` or
 * `team:frontend` on an issue, and a sync that replaces the label list would
 * wipe that taxonomy every time it ran. The fix is to know, precisely, which
 * labels the sync *claims* — the ones the mapping says it writes — and to touch
 * only those. Everything else on the issue is a human's, and it survives.
 *
 * The claim is **computed from the mapping**, never from a prefix convention:
 * a board that maps its `labels` attribute onto real label names has no `:`
 * anywhere in them, and a convention that said "labels with a colon are ours"
 * would either miss them or (worse) claim a human's `team:frontend`. The
 * mapping's declared type labels and status states are the exact labels; the
 * mapping's attribute prefixes, the `pool:` prefix and the degraded period
 * levels are the prefixes. Everything else is left alone.
 *
 * Pure: no disk, no network. The claim is a plain value, handed to the
 * connector that does the I/O, so the merge and the "what is missing" report
 * are both testable against literals.
 */

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

/**
 * The labels a mapping claims: the exact labels it writes, and the label
 * prefixes it writes under. Both are derived from the mapping declaration —
 * type labels and status states are exact; attribute values, pool assignments
 * and degraded period levels are prefixes.
 */
export interface LabelClaim {
  /** Exact labels the mapping claims (type labels, status states). */
  exact: ReadonlySet<string>;
  /** Label prefixes the mapping claims (`Points:` for story_points, `pool:`). */
  prefixes: readonly string[];
}

/** Build a claim from exact labels and prefixes, deduplicating both. */
export function labelClaim(
  exact: Iterable<string> = [],
  prefixes: Iterable<string> = [],
): LabelClaim {
  return { exact: new Set(exact), prefixes: [...new Set(prefixes)].sort() };
}

/**
 * True when the mapping claims a label — an exact match, or the label sits
 * under a claimed prefix. The one definition of "this label is ours", shared
 * by the push merge (keep the rest) and the missing-label report (only ours
 * are ever reported or created).
 */
export function isClaimedLabel(claim: LabelClaim, label: string): boolean {
  if (claim.exact.has(label)) return true;
  return claim.prefixes.some((prefix) => label.startsWith(prefix));
}

// ---------------------------------------------------------------------------
// Push: merge the desired set onto the current set, touching only ours
// ---------------------------------------------------------------------------

/**
 * Reconcile the labels already on a remote issue with the labels the board now
 * wants. Only the claimed labels are added or removed:
 *
 *   - a claimed label the board wants but the issue lacks is added;
 *   - a claimed label on the issue that the board no longer wants is removed
 *     (it is not in `desired`, so it does not survive the merge);
 *   - any label the mapping does **not** claim survives exactly as it was.
 *
 * `current` is the issue's label list as the remote holds it, `desired` the
 * full list the mapping derives from the board's current state. Order is not
 * load-bearing (the remote reorders labels anyway); the result dedupes.
 */
export function reconcileLabels(
  current: readonly string[],
  desired: readonly string[],
  claim: LabelClaim,
): string[] {
  const kept = current.filter((label) => !isClaimedLabel(claim, label));
  const merged = new Set(kept);
  for (const label of desired) merged.add(label);
  return [...merged];
}

// ---------------------------------------------------------------------------
// Which mapped labels the repository does not have
// ---------------------------------------------------------------------------

/**
 * The desired labels the repository does not yet define — the ones a push
 * creates before it files anything (`prerequisites.ts`), and the ones
 * `lpm remote setup` reports. Only a concrete label can be missing (a prefix
 * like `Points:` is not itself a label; `Points:3` is). `desired` is every label the board's current state
 * produces; `existing` the repository's own label list.
 *
 * Returns `desired` minus `existing`, deduped and sorted — a stable report.
 */
export function missingLabels(
  desired: readonly string[],
  existing: readonly string[],
): string[] {
  const existingSet = new Set(existing);
  return [...new Set(desired)].filter((label) => !existingSet.has(label)).sort();
}

/**
 * A deterministic colour for a provisioned label — a six-digit hex string
 * (no leading `#`), derived from the name so the same label always gets the
 * same colour and two labels rarely collide. GitHub requires a colour to
 * create a label, and a random one would make creating them non-idempotent.
 */
export function labelColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  const hue = hash % 360;
  // HSV with fixed saturation/value → RGB, so colours are readable on GitHub's
  // dark text and never too light to see.
  const h = hue / 60;
  const f = h - Math.floor(h);
  const p = 0;
  const q = Math.round(255 * (1 - 0.55 * f));
  const t = Math.round(255 * (1 - 0.55 * (1 - f)));
  const v = 255;
  let r: number;
  let g: number;
  let b: number;
  const sector = Math.floor(h) % 6;
  switch (sector) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  return `${hex(r)}${hex(g)}${hex(b)}`;
}
