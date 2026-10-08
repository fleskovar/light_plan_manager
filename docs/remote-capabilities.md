# Remote capabilities: GitHub, Jira Cloud, Linear, jsonfile

The answer to LP-267 — *which of a light-plan board's constructs have a native
home, which a push can create on the way in, and which must be encoded — and
what does each platform do when an issue is deleted, archived or moved?*

**Verification status (read this first).** Every fact in this document was
checked against the provider's own machine specification, fetched live on
2026-08-12 and reduced to `test/fixtures/remote/`:

- GitHub REST OpenAPI description + GraphQL schema
- Jira Cloud REST v3 OpenAPI description
- Linear GraphQL SDK schema

Status codes and error semantics quoted below are **documentation-derived**,
not observed. LP-267's method also asked for empirical capture — actually
deleting, archiving and moving a throwaway issue on each platform and saving
the response bodies. **That half is done for Jira Cloud only** (2026-09-16, a
live team-managed project, `test/remote-live-jira.test.ts`); GitHub and Linear
still have no scratch account behind them. The lifecycle tables below mark each
cell `doc` (quoted from the spec), `observed` (a live run did it) or
`unverified` (the spec is silent or the semantics are only knowable at runtime).
The `unverified` cells are precisely the ones that must be re-run before any
`on_delete` automation ships; the fixtures README lists them.

What the live Jira half changed is worth stating, because it is the argument for
doing the same on the other two: **five defects were invisible to a fake
tracker** — a created issue kept the workflow's first status for ever, a
`depends_on` edge was filed backwards, the link readers could never read one
back, `unlink` never matched, and a pulled issue never landed under its
mirrored parent. Each of them round-tripped perfectly offline, because the
fixtures were built from the same reading of the spec as the connector. A
capability matrix compiled from documentation says what a platform *can* hold;
only a live run says what this code actually put there.

Confidence: **high** on the capability matrix (the schemas are unambiguous) and
on every Jira cell marked `observed`; **medium** on the lifecycle "what we
observe" cells that are still spec-quoted; **low** on anything marked
`unverified`.

---

## 1. The capability matrix

Legend: **native** = the provider has a real place for it · **provisioned** =
it has no place until one is created, and the API can create it — which a push
does for itself, before it files anything (`src/remote/prerequisites.ts`) ·
**encoded** = it must live in a managed block (`rung 4`) or a label (`rung 3`).
Rungs refer to the degradation ladder in LP-255: 1 native · 2 custom field ·
3 label · 4 managed block · 5 managed comment · 6 refuse.

| Construct | GitHub (Issues + Projects v2) | Jira Cloud | Linear | jsonfile |
| --- | --- | --- | --- | --- |
| **hierarchy** | native, 1 parent edge (sub-issues), anchored at the **root**; deeper levels → rung 4 | native, ~3 levels (Epic → issue → subtask), anchored at the **leaf**; levels above → rung 4 | native, 1 parent edge (sub-issues); deeper → rung 4 | **no** native parent → rung 4 |
| **type** | native *or* rung 3 (see note 1) | native (issuetype, per-project scheme) | rung 3 (labels) | native (`type` field) |
| **status** | native open/closed + `state_reason`; richer workflow → rung 2 (Projects v2 status field) | native, but transition-mediated | native (team workflow state) | native (`status` field, named states) |
| **`depends_on`** | **no** → rung 4 (no blocking edge anywhere) | native (issue link, directional) | native (relation `blocks`, directional) | native (`depends_on` array) |
| **`relates_to`** | **no** native edge → rung 4 (cross-references in the timeline are mention-derived and read-only) | native (link type "Relates") | native (relation `related`) | **no** → rung 4 |
| **attributes** | rung 1/2, limited types (see note 2) | native, extensive types (see note 3) | **no** custom fields → rung 3/4 | rung 3 (label prefixes) — no typed registry |
| **effort / priority** | **no** native → rung 2 (number field) / rung 2 (select) | native (priority; story points; original estimate) | native but constrained scales (see note 4) | **no** native → rung 3 / rung 4 |
| **periods** | native milestone + rung 2 (Projects v2 Iteration) | native (sprint; version/fixVersion) | native (cycle; milestone) | **no** native container → rung 4 |
| **resources** | native assignee (user); generic pool → rung 4 | native assignee (user); generic pool → rung 3/4 | native assignee (user); generic pool → rung 4 | assignee string stored, not resolved → rung 4 |
| **comments** | native (ids, edit, delete, author) | native (ids, edit, delete, author) | native (ids, edit, delete, author) | native (ids, edit, delete; no author) |
| **incremental read** | `since` timestamp (REST) / `updatedAt` (GraphQL) | JQL `updated >= ts`, `nextPageToken` cursor | `IssueFilter.updatedAt`, relay cursor | `updated_at` filter over a full read |

A word on *anchored*: a tracker holds a fixed number of parent levels and a
board usually has more, so the levels have to be spent at one end. GitHub's
sub-issue edge is type-blind (any issue under any issue), so they are spent at
the root. Jira's hierarchy is defined from the bottom up — `Subtask` < standard
< `Epic`, and only a standard issue may sit under an Epic — so they are spent at
the leaf, and the containers above ride the block. Spending Jira's at the root
writes only edges Jira refuses.

### Notes on the matrix

1. **GitHub type — this changed under the epics.** GitHub now has **org-level
   issue types** (`POST /orgs/{org}/issue-types`, name + color, opt-in per
   repository) and the REST list-issues endpoint takes a `type` filter. Where
   issue types are not enabled for a repository, the type is a label (rung 3).
   LP-247's summary ("flat, weakly typed, no epic") predates this.
2. **GitHub attributes — two systems.** (a) **Issue fields**, org-level, the
   newer and more relevant one: value types `text`, `date`, `single_select`,
   `multi_select`, `number`; created at `/orgs/{org}/issue-fields`; values set
   per issue at `/repos/{o}/{r}/issues/{n}/issue-field-values/{id}`. No
   boolean, no user/assignee type, no nested/cascading. (b) **Projects v2
   fields**, project-scoped, item-based: `TEXT`, `NUMBER`, `DATE`,
   `SINGLE_SELECT`, `ITERATION`. No multi-select, no boolean.
3. **Jira attributes** are the gold standard: text, textarea, number, date,
   datetime, user, group, single/multi select, checkbox, radio, cascading
   select, URL, version, labels. Creation is `POST /rest/api/3/field` and
   requires *Administer Jira*; fields are global but associated per project via
   field-configuration contexts and screens (so "scoped" means *visibility*,
   not *isolation* — two projects can see the same field with different options).
4. **Linear scales are fixed.** `priority` is a 5-value scale (0 no priority,
   1 urgent, 2 high, 3 medium, 4 low). `estimate` is a number on the *team's*
   configured scale (linear / exponential / Fibonacci / T-shirt) and rejects
   values off-scale. Both are native but constrain the board's enums to fit.
5. **The incremental read is an option, not the default.** All four platforms
   can be asked for "what changed since", and `lpm remote pull --changed` is the
   flag that asks. It is opt-in because such a listing is **partial by
   construction**: a twin nobody touched is simply not in it, which is never
   evidence that it is gone. A plain `lpm remote pull` lists everything, which
   is what refreshes every mirrored document and the only listing section 2's
   deletion question can be asked of.
6. **`informed_by` used to be a third edge here, and is retired.** It gated the
   queue exactly as `depends_on` did — one behaviour under two names — and what
   an issue rests on belongs in its body and `related_files`. `lpm check --fix`
   merges any that survive into `depends_on`.
7. **jsonfile is a local file, not a SaaS platform.** It is the fourth
   provider, added as the proof of the authoring kit (LP-360) rather than from
   an audit. There is no spec to fetch, no token, no permission model, and no
   lifecycle table below: deletion is trivially hard (remove the object), the
   404-conflation question does not arise, and `on_delete` needs no bulk probe.
   Its value is that `type` and `status` are native fields — the ladder's rung
   1 finally lights up — and that its connector does `node:fs`, proving the
   provider contract is not HTTP-shaped.

The single structural surprise: **GitHub is no longer "flat and weakly typed"**
at the level the LP-247 epic assumed, and **Linear is the only platform with no
custom fields at all**, which inverts the usual expectation — the "capable"
platform is Jira, then GitHub (org-level fields), then Linear, for attributes.

---

## 2. Lifecycle semantics

The 404-versus-403 question is answered per platform. The headline, worth
stating before the tables:

> **All three platforms return "not found" (404, or GraphQL `null`) for both
> "deleted" and "exists but you may not see it."** None of them exposes a
> per-issue read that distinguishes the two. LP-364's bulk reachability probe
> is therefore the *only* defence, not a backstop — but all three platforms
> *do* have a workable bulk probe (repo/project/team reachable + issue absent
> from its list), so the defence exists.

And a second condition on top of it, which the probe cannot supply for itself:
**absence is only evidence when the listing was complete.** A pull that asked
for one issue by key, or for "what changed since", holds a listing an untouched
twin was never going to be in — so those runs reconcile no existence at all,
whatever the probe says. Only a plain `lpm remote pull` can conclude that a twin
is gone (`RemoteSnapshot.partial`, `docs/remote-sync.md` §7e).

### 2.1 GitHub

| Question | Answer | Evidence |
| --- | --- | --- |
| deletion | Yes, but **GraphQL-only** (`deleteIssue` mutation) — no REST endpoint, no UI. Admin-level. Permanent. | `doc` (schema) |
| soft vs hard | **No archive/trash.** "Closed" is the soft, reversible state; `state_reason` records *why*. Delete is hard and gone. | `doc` |
| what we observe | `GET …/issues/{n}` documents `404` (not found), `410` (gone) and `301` (moved permanently). A private repo the token cannot read also returns `404`. Deletion vs no-permission **not distinguishable**. | `doc` (spec lists 404/410/301); `unverified` which one a real `deleteIssue` produces |
| recreate | A deleted issue cannot be restored — only **re-filed** (new number). A *closed* issue can be reopened. | `doc` |
| move | `transferIssue` mutation (GraphQL-only). The **number changes** (new repo's numbering); the global node id survives. Old number → 404/301. | `doc` (schema); `unverified` the old-number response |
| convert | No issue→PR. Issue *type* is a mutable field where issue types are enabled; changing it does not change the id. Issue → discussion exists in some orgs. | `doc` |
| permissions | `404` for a resource the token cannot read (no 403 on reads). 403 appears only on write-permission denials. | `doc` |
| bulk signal | **Yes, strong.** `GET /repos/{o}/{r}` (repo reachable) + `GET /repos/{o}/{r}/issues?state=all` (issue present). A repo you can list but where the issue is absent = deleted/transferred, not a permission loss (that would 404 the repo itself). | `doc` |

### 2.2 Jira Cloud

| Question | Answer | Evidence |
| --- | --- | --- |
| deletion | Yes — `DELETE /rest/api/3/issue/{id}`, permanent, "Delete Issues" project permission. Subtasks need `deleteSubtasks`. No recycle bin in Cloud. | `observed` (the live suite empties its project this way before every run) |
| soft vs hard | **No archive.** A "Done"/terminal status is the soft convention. Delete is hard. | `doc` |
| what we observe | `GET …/issue/{id}`: `404` is documented as *"the issue is not found or the user does not have permission to view it."* The two are **conflated by the spec itself**. After a project move, the old key still resolves (the GET performs a "check for moved issues" and returns the current key). | `doc` (spec wording is explicit); `unverified` the exact `errorMessages` body |
| recreate | No restore — re-file (new id and key). | `doc` |
| move | `POST /rest/api/3/bulk/issues/move` (also works for a single issue). Project *and* type can change in one call. The numeric **issue id survives**; the **key changes**. | `doc` (spec) |
| convert | Yes — `PUT /rest/api/3/issue/{id}` with `fields.issuetype`, or the bulk move. Id survives. Subtask ↔ standard conversion is restricted (needs parent handling). | `doc` |
| permissions | On **read**: `404` = "not found or no permission to view" (conflated). On **delete**: `403` = "can see but may not delete", `404` = "cannot see / gone". So the *write* path gives an extra signal the read path does not. | `doc` (spec, DELETE responses) |
| bulk signal | **Yes.** `GET /rest/api/3/project/{key}` (reachable) + `POST /rest/api/3/search/jql` `project=KEY AND key = ABC-123` (or `id = …`). Search respects browse permission: a project you cannot browse yields nothing/denied, so "project reachable but issue absent from search" = deleted or moved, not a permission loss. | `observed` (an issue deleted in Jira, then a full pull, applied `on_delete: unlink` to its twin). One live caveat the spec does not mention: **JQL is an index and lags its own writes**, so a listing taken immediately after a push can be short — a read by key is not affected. |

### 2.3 Linear

| Question | Answer | Evidence |
| --- | --- | --- |
| deletion | Yes — `issueDelete` (trashes) with an admin-only `permanentlyDelete` that skips the grace period. | `doc` (schema) |
| soft vs hard | **The richest of the three.** `issueArchive` (soft, reversible) · `issueDelete` = **trash with a 30-day grace period** · then permanent. Plus a `canceled` state (soft "not doing this"). | `doc` (schema) |
| what we observe | The `Issue` type carries `archivedAt: DateTime`, `trashed: Boolean`, `previousIdentifiers`. Whether a trashed/archived issue is still resolvable through the plain `issue(id)` query (vs only admin/`issueSearch`) is **not determinable from the schema** and needs empirical capture. Permanently deleted → `null`. | `doc` (fields exist); `unverified` (query behaviour) |
| recreate | **Yes, within the 30-day grace period** (`issueUnarchive`) — the only platform where "restore" is a genuine restore rather than a re-file. Archive is reversible at any time. | `doc` (schema) |
| move | Change team via `issueUpdate` (`teamId`). The **identifier changes** (`LIN-1` → `NEW-2`); the UUID survives and `previousIdentifiers` retains the old ones. Whether the old identifier still resolves is `unverified`. | `doc` (fields); `unverified` (old-id lookup) |
| convert | No issue types to convert; labels/team/state change freely. A team move changes the identifier; the UUID is stable. | `doc` |
| permissions | Linear scopes are org-wide, not per-team; a token without `issues:read` gets an authorization error rather than `null`. For a **private team** (beta), non-members see `null` — the same "not there" signal as deletion. | `doc` (partial); `unverified` (private-team behaviour) |
| bulk signal | **Yes.** `team(id)` / `project(id)` existence + `issues(filter: { team: { id: … } })` list. Team reachable but issue absent = gone. The org-wide scoping means "I can see this team but not that one" is rare (private teams excepted). | `doc` |

---

## 3. `on_delete` implementability, per platform

The question LP-361 needs answered: which of its two remote-side resolutions
can actually be automated on each platform, and at what risk.

- **`on_delete: delete`** — *follow the remote by deleting the local document.*
  This is always implementable (it is a local operation). The question is
  whether it can be **safely automated**, and the answer is the same on all
  three: only when the 404 is *known* to be a deletion, which the per-issue read
  cannot establish on any platform. Gate it behind LP-364's bulk probe (repo /
  project / team reachable, issue absent from its list) — never on a bare 404,
  and never on a partial listing. Both gates are live: `resolveLifecycle` runs
  the probe, and it assesses nothing at all when the listing was targeted or
  incremental.

- **`on_delete: restore`** — *bring the remote twin back.*

| Platform | `restore` implementable? | Caveat |
| --- | --- | --- |
| GitHub | **No true restore.** A deleted issue can only be re-filed under a new number (and re-linked). A *closed* issue can be reopened (real restore, but only if it was closed, not deleted). | link store must accept a new remote key |
| Jira | **No true restore.** Re-create under a new id/key and re-link. | same |
| Linear | **Yes** — `issueUnarchive` within the 30-day grace period, and archive is reversible at any time. The only platform where `on_delete: restore` means "undo", not "re-file". | grace period expires; `permanentlyDelete` (admin) skips it |

**Recommendation.** Default `on_delete: manual` on all three. Offer
`on_delete: delete` only when the bulk reachability probe has confirmed the
remote twin is genuinely gone, and never on an ambiguous 404. Offer
`on_delete: restore` on **Linear only** (a real restore within the window), and
on GitHub/Jira as the explicitly-labelled "re-file and re-link" variant with the
new key written back to the link store. `on_delete: delete` should not be
offered at all for GitHub or Jira **until LP-364 lands**, because their reads
conflate deletion with permission loss and the bulk probe is the only thing
that separates them.

---

## 4. What this changes for the provider epics

Findings that contradict or sharpen what the epics currently assume (risk
sections updated accordingly):

1. **GitHub (LP-247) is less of a degraded case than its summary claims.**
   Org-level **issue types** and **issue custom fields** (including multi-select)
   now exist and give `type` and `attributes` a native or provisionable home
   *on the issue itself*, not only in Projects v2. The epic's "flat, weakly
   typed, no custom fields" premise is stale. The degradation ladder still
   earns its keep for `depends_on` and `relates_to` (nothing native for either)
   and for hierarchy beyond one level.

2. **Jira (LP-248) has a finer lifecycle signal than the design assumed.** The
   DELETE endpoint returns `403` (can see, may not delete) versus `404` (cannot
   see / gone), which is an extra disambiguation the read path lacks. And the
   bulk move endpoint makes "move" and "convert" (project + type) a single
   first-class operation with a surviving id — so reshaping detection can lean
   on the id, not the key.

3. **Linear (LP-249) is the only platform where soft-delete is real.** Archive,
   30-day trash and `issueUnarchive` mean `on_delete: restore` is genuinely
   implementable, and `trashed`/`archivedAt`/`previousIdentifiers` are
   first-class signals. Conversely Linear has **no custom fields**, so every
   board attribute beyond the fixed fields (estimate, priority, label, assignee,
   state, cycle, project) is rung 3/4 — the opposite of the Jira case.

4. **The 404-conflation holds on all three** — the LP-364 bulk heuristic is the
   only defence everywhere, which raises its priority from backstop to
   prerequisite for any automatic `on_delete: delete`.

---

## 5. Confidence and falsifiability

- **What would falsify each high-confidence claim:** an API change that is
  checkable cheaply — re-fetch the three spec files (URLs in the fixtures
  README) and diff. A provider that ships a real "deleted" tombstone (e.g. a
  `deleted_at` field on the issue object) would falsify the 404-conflation
  headline and demote LP-364 back to backstop.
- **Lowest-confidence cells, re-verify first:** GitHub's real status code after
  `deleteIssue`/`transferIssue` (404 vs 410 vs 301); Jira's exact 404
  `errorMessages` body; Linear's query behaviour for trashed/archived issues and
  private teams. These are the `unverified` rows in section 2.
- **"We could not tell"** applies to every lifecycle cell marked `unverified`:
  the documentation is silent or the behaviour is only observable with a live
  account, which was not available. Recorded rather than padded.
