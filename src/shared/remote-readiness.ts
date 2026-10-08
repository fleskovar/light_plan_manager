/**
 * The pre-push readiness check: what will not land the way the board says it
 * should, asked *before* anything is written, and what can be done about each.
 *
 * `preflightPush` already refuses a push whose values the mapping cannot carry
 * — an unmapped type, an attribute that will not coerce. This is the other
 * half of that question, and the half only the tracker can answer: **does the
 * person this is assigned to exist over there, and does the sprint it is
 * scheduled into?** A board can be perfectly valid and still file forty issues
 * unassigned because a colleague's account id is stale, or unscheduled because
 * the sprint was never created — and today the first anybody hears of it is
 * the issues themselves, filed and wrong.
 *
 * The unit is a **finding**, and a finding is not a message. It names the one
 * thing that is wrong, the documents it affects, what ignoring it costs, and —
 * where one exists — the fix that would make it go away. Three answers are
 * possible and they are the same three every time:
 *
 *   - **ignore it**: the push proceeds and the field is left blank. That is
 *     what the engine already does, and it heals on a later push once the far
 *     side exists (`docs/remote-sync.md` §7f), so it is a real answer rather
 *     than a shrug;
 *   - **fix it**: a concrete change with a concrete effect — write the remote
 *     account onto the person, file the sprint in the same run, clear an
 *     assignee the roster has lost;
 *   - **cancel**: write nothing.
 *
 * Only the *fix* differs per finding, which is why it is data on the finding
 * rather than a branch in a dialog.
 *
 * Import-free, like the rest of this folder: `src/remote/readiness.ts`
 * computes it, the server returns it, the web draws it, and `lpm remote push`
 * prints it.
 */

/** Which check produced a finding. */
export type ReadinessCode =
  /** A pool, which no tracker has a concept of. */
  | 'assignee_pool'
  /** A person with no value in the attribute `accounts.via` names. */
  | 'assignee_no_account'
  /** A value the remote does not know — a stale id, somebody who left. */
  | 'assignee_unknown'
  /** An assignee id the board's own roster no longer has. */
  | 'assignee_off_roster'
  /** A period with no twin upstream: the issues in it file unscheduled. */
  | 'period_not_filed'
  /** A period id the board's own timeline no longer has. */
  | 'period_off_timeline';

/**
 * Whether the push may proceed with this finding unanswered.
 *
 * `degrades` is the ordinary case: the field is left blank, the rest of the
 * document files, and a later push writes it once the far side exists.
 * `blocks` means the board itself is wrong — an assignee or a period that is
 * not on the board at all — and no amount of pushing will make it right.
 */
export type ReadinessSeverity = 'blocks' | 'degrades';

/** One value a fix could write, with the label a person chooses it by. */
export interface ReadinessCandidate {
  /** The value to store in the board attribute. */
  value: string;
  /** How the remote names this person: "Ada Lovelace · ada@acme.com". */
  label: string;
  /**
   * True when the match was made on a value rather than a name — an email the
   * roster already holds. A name match is a suggestion; this is close to a
   * fact, and the two should not look the same on screen.
   */
  exact?: boolean;
}

/** What could be done about a finding, beside ignoring it. */
export type ReadinessFix =
  /** Write a remote account onto a person's roster document. */
  | {
      kind: 'link_account';
      resourceId: string;
      resourceTitle: string;
      /** The board attribute that carries the account (`accounts.via`). */
      via: string;
      /** Remote people this person might be, best first. Empty when none matched. */
      candidates: ReadinessCandidate[];
    }
  /** File the period in the same run, so the issues in it are scheduled. */
  | { kind: 'file_period'; periodId: string; periodTitle: string }
  /** Clear an assignee the roster has lost, on the documents carrying it. */
  | { kind: 'unassign'; issueIds: string[] };

/** One thing that will not land the way the board says. */
export interface ReadinessFinding {
  /** Stable across runs, so a choice survives a re-check: `assignee:RS-4`. */
  key: string;
  code: ReadinessCode;
  severity: ReadinessSeverity;
  /** One line naming the subject: "Ada Lovelace has no Jira account". */
  title: string;
  /** Why, in the platform's own terms where it said something. */
  detail: string;
  /** What ignoring it costs, stated plainly — never "it will be skipped". */
  ignored: string;
  /** The documents affected, at most `READINESS_DOCUMENTS_SHOWN` of them. */
  documents: string[];
  /** How many there are in all; `documents` may be a sample. */
  count: number;
  fix?: ReadinessFix;
}

/** Documents are sampled: one stale account can touch four hundred issues. */
export const READINESS_DOCUMENTS_SHOWN = 8;

/** What the check found, and whether a push may go ahead. */
export interface RemoteReadinessReport {
  remote: { name: string; provider: string; target: string };
  /** In the order they should be answered: what blocks first. */
  findings: ReadinessFinding[];
  /** How many documents the check looked at. */
  documents: number;
  /**
   * True when at least one finding blocks. The push is refused rather than
   * degraded, because the board itself has to change first.
   */
  blocked: boolean;
  /**
   * Why the remote could not be asked, when it could not. The offline half of
   * the check still answers — an absent tracker is not a reason to say
   * everything is fine.
   */
  unreachable?: string;
  /** True when the remote was asked and could name its assignable people. */
  askedUsers: boolean;
  /** True when the remote was asked and could name its periods. */
  askedPeriods: boolean;
}

/** One fix a caller chose to apply. `file_period` is not here: it widens the push. */
export type ReadinessFixRequest =
  | { kind: 'link_account'; resourceId: string; via: string; value: string }
  | { kind: 'unassign'; issueIds: string[] };

/** `POST /api/remotes/:name/readiness/fix` — apply the chosen fixes. */
export interface RemoteReadinessFixDto {
  fixes: ReadinessFixRequest[];
}

/** What the fixes changed, one line each, for the panel to report. */
export interface RemoteReadinessFixResultDto {
  changed: string[];
}

/** True when nothing found needs answering before a push. */
export function readinessClear(report: RemoteReadinessReport): boolean {
  return report.findings.length === 0;
}

/** One line for a header: `3 problems · 1 blocks the push`. */
export function summarizeReadiness(report: RemoteReadinessReport): string {
  if (report.findings.length === 0) return 'Ready to push';
  const blocks = report.findings.filter((finding) => finding.severity === 'blocks').length;
  const head = `${report.findings.length} ${report.findings.length === 1 ? 'problem' : 'problems'}`;
  return blocks > 0 ? `${head} · ${blocks} blocks the push` : head;
}
