# Case: a scoped subtree round-trips through a real tracker

**Unit under test:** the whole remote-sync path — `planPush` → the executor →
the connector → the provider's translator → `planPull` → `applyPull`, driven
exactly as `lpm remote push` / `lpm remote pull` drive it.

**The one behaviour this case pins:** *push a subtree to a tracker, pull it
back into an empty board, and every document comes back the same.* Everything
else in the folder exists to make that claim checkable by a person.

**Who runs it, and against what**

| Run | Provider | Credential | When |
| --- | --- | --- | --- |
| offline | `jsonfile` | none | every `npm test` |
| live | `github` | `GITHUB_TOKEN` + `LPM_LIVE_GITHUB_REPO` | `LPM_LIVE=1` |
| live | `jira` | `JIRA_EMAIL` + `JIRA_API_TOKEN` + `LPM_LIVE_JIRA_SITE` + `LPM_LIVE_JIRA_PROJECT` | `LPM_LIVE=1` |
| live | `linear` | `LINEAR_API_KEY` + `LPM_LIVE_LINEAR_TEAM` | `LPM_LIVE=1` |

The offline run is what keeps this baseline honest between live runs: the file
tracker exercises the same planners, the same executor and the same base
snapshot, so a regression in the shared machinery turns the build red without
anybody holding a token. The live runs are what prove the *platform* still
behaves the way the provider adapter believes it does — the thing no fake can
tell you, and the reason `test/fixtures/remote/README.md` says the capability
matrix rests on documentation rather than observation.

---

## Where this baseline came from

**Computed by hand** from `inputs/` and the mapping rules below. No value in
`outputs/` was produced by running the code and then accepted. The walkthrough
is the derivation; check it with nothing but this page.

---

## The inputs

`inputs/config.yml` — three nesting levels (`program › epic › feature ›
user_story`), three statuses of which `done` is terminal, one typed attribute
(`story_points`, an `int`) and one period type (`sprint`).

`inputs/documents.json` — one sprint and six issues, created in the order
listed, so the board assigns `LP-1` … `LP-6` in that order.

Every row is there for one reason:

| Document | Demonstrates |
| --- | --- |
| `Payments` (program) | The scope root. A container is pushed like anything else — the tracker gets an issue for it, not a folder. |
| `Card payments` (epic) | One level of nesting: the parent is one hop up and must survive. |
| `Refunds` (feature) | **Three** levels deep — deeper than any of the four trackers holds natively, so the parent must ride the managed block for at least one of them. |
| `Refund a captured charge` | The normal path: an open status, a typed attribute, and a sprint. |
| `Refund a voided charge` | A **terminal** status. The remote must show its own closed state, and the board's `terminal: true` is the only thing that decides that — never the word "done". |
| `Show the refund on the receipt` | A dependency **across** the subtree. The edge must cross the wire natively where the provider has edges, and through the managed block where it does not. |

`story_points` differs on all three stories (5, 3, 2) on purpose: a mapping
that dropped the attribute, or wrote the same value to all three, produces a
diff that names which story broke.

---

## The mapping the case is solved against

The runner writes the same mapping for every provider, in that provider's own
spelling:

```yaml
types:
  program:    program
  epic:       epic
  feature:    feature
  user_story: story
statuses:
  backlog:     Backlog
  in_progress: In Progress
  done:        { remote: Done, closed: true }
attributes:
  story_points: Points
```

Two mapping facts are load-bearing and are the reason the case exists:

1. **`closed: true` and the board's `terminal: true` must agree.** They are two
   halves of one claim, and `lpm check` reports it when they disagree.
2. **There is no `periods` entry for `jsonfile`.** That provider holds no
   native container, so its schema has no such key. Every other provider maps
   `sprint` to its own container (a milestone, a sprint, a cycle).

---

## Walkthrough — deriving `outputs/recovered.json` by hand

### `Refund a captured charge` — the normal path

1. Type `user_story` maps to `story`, so the tracker's issue is a story.
2. Status `in_progress` maps to `In Progress`; the board's `in_progress` is not
   terminal and the mapping carries no `closed`, so the remote issue is **open**.
3. `story_points: 5` has no typed custom field on three of the four providers,
   so it is written as the label `Points:5` (rung 3).
4. Its parent `Refunds` is three levels down. GitHub holds one level of
   sub-issue, Linear one level of parent, Jira one level, `jsonfile` none — so
   for at least one provider the parent rides the managed block as
   `| parent | <remote id> |`.
5. Nothing is recorded on it in the outward direction, so `depends_on` is `[]`.
   (`Show the refund on the receipt` depends *on* it — that edge is recorded on
   the dependent, which is where `depends_on` lives.)
6. Pulled back into an empty board, every one of those is read back: type from
   the mapping, status from the mapping, `5` from the `Points:` label, the
   parent from the sub-issue link or from the block.

→ `{ type: "user_story", status: "in_progress", parent: "Refunds",
     depends_on: [], attributes: { story_points: 5 }, period: "Sprint A" }`

### `Refund a voided charge` — the terminal status

1. Status `done` maps to `Done` with `closed: true`.
2. The remote issue is **closed** — a GitHub issue with `state: closed`, a
   Linear state of type `completed`, a Jira status in the Done category, a
   `jsonfile` `status: "Done"`.
3. On the way back, closed maps to the one board status whose mapping carries
   `closed: true`. There is exactly one, so the recovery is unambiguous.

→ `status: "done"`, not `backlog`. A provider that reports every closed issue
as the *first* status is the failure this row catches.

### `Show the refund on the receipt` — the crossing edge

1. `depends_on: ["Refund a captured charge"]` in the input is a **title** here;
   on the board it is the id `LP-4`.
2. Pushed: GitHub has no dependency edge, so it rides the managed block as a
   `| depends_on | #<n> |` row; Linear and `jsonfile` have native edges and use
   them; Jira uses an issue link.
3. Pulled back into an empty board, the remote id is resolved through the link
   store to whatever local id the fresh board gave that story — which is why
   the baseline names it by **title**. A baseline naming `LP-4` would be
   asserting something about id allocation, which is not what this case is for.

→ `depends_on: ["Refund a captured charge"]`, exactly one entry.

### `Payments` — the scope root

Nothing above it is mirrored, and it has no parent, so `parent: null`. If a
document from outside the scope appears in the tracker, the scope is not being
applied — the classic first-run mistake, and the reason the plan is read before
it is run.

---

## Walkthrough — deriving `outputs/second-sync.json`

Immediately after the first push has landed:

1. **The push plan is empty.** Every document is now in the link store with a
   base snapshot taken from the remote's *own* post-write record, so nothing
   differs from the base and there is nothing to send. A non-zero count here is
   the duplicate wave: a second push that files everything again.
2. **The pull plan is empty.** The base was recomputed from what the remote
   actually stored, so the remote's own normalisation (reordered labels,
   rewritten markdown) was absorbed on the way in and does not read as a remote
   edit. A non-zero count here is the phantom-edit loop.
3. **`lpm remote status` exits 0**, with every document in sync: nothing ahead,
   nothing behind, nothing conflicted, nothing unlinked.

All three are the same claim from three directions, and all three are checked,
because each one has failed on its own in this codebase.

---

## Known gaps this case does not assert

`period` is asserted only for providers that recover scheduling on pull. The
`jsonfile` provider does not: its push now writes a `period:sprint` row into
the managed block, but its translator ignores periods on the way back, so a
fresh board cannot recover the sprint. That is **LP-533**, and the runner's
`SCHEDULING_GAPS` set is the record of it. Do not add a provider to that set to
make a failure go away — a provider that stops round-tripping scheduling is a
regression, and the set is the list of the ones that never did it.

---

## Running it

```bash
npx vitest run test/remote-live.test.ts                # offline (jsonfile) only
LPM_LIVE=1 npx vitest run test/remote-live.test.ts     # every provider you have credentials for
npx vitest run test/remote-live.test.ts -t jsonfile    # one provider
```

The live half **skips loudly**, never silently: a provider with no credentials
prints exactly which variables it wanted, so an empty run is never mistaken for
a green one. Add `--reporter=verbose` to read the skip reasons.

To debug one case, put a breakpoint in the runner and:

```bash
node --inspect-brk ./node_modules/vitest/vitest.mjs run test/remote-live.test.ts -t jsonfile
```

## Cleaning up after a live run

Each live run files its documents with a unique run marker in the title
(`[lpm-uat <timestamp>]`) and **deletes or closes every one of them in a
`finally`**, whatever the assertions did. If a run is killed mid-flight, the
leftovers are findable in the tracker by that marker — search for `lpm-uat`.

Use a throwaway project. Nothing here is safe to point at a backlog people
depend on.
