# Case: a small board mirrored end to end into a real Jira project

**Unit under test:** the Jira provider against Jira Cloud itself — the
connector, the translator, the hierarchy encoding and both link seams, driven
exactly as `lpm remote push` / `lpm remote pull` drive them.

**The one thing this case exists for:** *every assertion reads Jira's own REST
payload, never the adapter.* `test/remote-round-trip/scoped-subtree/` already
proves "what went out comes back", and it proves it for every provider — but a
round trip compares light-plan to itself. It passes just as happily when both
halves share one wrong belief about the platform, which is precisely what
happened: a dependency written backwards was read back backwards and the trip
was perfect.

So the runner here (`test/remote-live-jira.test.ts`) asks Jira what it holds.

---

## The board

Five levels, because that is the smallest board on which Jira both nests
natively *and* has to degrade. Jira Cloud team-managed projects hold two native
parent levels (`Epic` > standard > `Subtask`), and the provider is
**leaf-anchored** — the native edge is spent on the deepest levels, where Jira
will actually accept it, and everything above rides the managed block.

Working it out by hand: `hierarchyDepth` probes as 2, so `nativeDepth` is 3 and
the span is 2. The board's deepest level is 4, so `nativeFrom = 4 - 2 + 1 = 3`
and `nativeTo = 4`.

| depth | board type | Jira type | parent carrier |
| --- | --- | --- | --- |
| 0 | `program` | Epic | none — the remote root |
| 1 | `epic` | Epic | managed block |
| 2 | `feature` | Epic | managed block |
| 3 | `user_story` | Story | **native** (`fields.parent`) |
| 4 | `sub_task` | Subtask | **native** (`fields.parent`) |

Anchored at the *root* instead — the default, and right for a type-blind edge
like GitHub's sub-issues — every native edge light-plan wrote would be one Jira
refuses (an `Epic` cannot sit under an `Epic`), while the one relationship Jira
*would* hold degraded to the block. A board filed that way comes out flat.

## The documents

Seven issues and one sprint (`inputs/documents.json`). Each is there for a
reason:

| document | why it is in the case |
| --- | --- |
| `Payments` | the root: filed with no parent at all, and none in the block either |
| `Card payments` | depth 1 — a block-carried parent |
| `Refunds` | depth 2 — block-carried, and an *active* status, which Jira reaches only by transition |
| `Chargebacks` | somewhere for the reparent scenario to move a story to |
| `Refund a voided charge` | **already `done` before it was ever pushed** — the document that proves a create transitions |
| `Refund a captured charge` | depth 3, the first native level; carries the sprint and the one dependency |
| `Write the refund ledger entry` | depth 4, filed as a Jira `Subtask` under its story |

`Refund a captured charge` **depends on** `Refund a voided charge`, which means
the voided-charge story **blocks** the captured-charge one. That sentence is
the whole of the link assertion, and reversing it is silent.

## What the mapping says

Team-managed vocabulary, because that is what such a project actually offers:
every container level is `Epic`, work items are `Story`, the leaf is `Subtask`,
and the statuses are `To Do` / `In Progress` / `Done`.

No `attributes:` block — a scratch project has no custom fields, and field
mapping is covered offline. This case is about structure, status and edges.

## Expected values, derived by hand

- **7 issues** in the project after the first push, and seven link entries.
- `Refund a voided charge` is **`Done`** in Jira. Jira cannot set a status on
  `POST /issue`, so this is true only if the create transitions afterwards.
  When it did not, the issue sat in `To Do` and *nothing reported it*: the base
  is recomputed from the echo, `To Do` maps back to more than one board status,
  the ambiguous read leaves the local value standing, and both sides then agree
  on a status Jira does not hold.
- `Refund a captured charge`'s `fields.parent` is the **`Refunds`** issue;
  `Refunds`'s `fields.parent` is **absent**, and its managed block names
  `Card payments`.
- The `Blocks` link, read from the dependent, names the dependency as its
  **`inwardIssue`** — "this issue is blocked by that one". Measured against
  Jira Cloud rather than inferred: posting `{outwardIssue: A, inwardIssue: B}`
  records "**B** blocks A". The field names invite the opposite reading.
- A second push plans **0 operations**.

## Running it

```
LPM_LIVE=1
JIRA_EMAIL=...
JIRA_API_TOKEN=...
LPM_LIVE_JIRA_SITE=https://<you>.atlassian.net
LPM_LIVE_JIRA_PROJECT=<a scratch project key>
```

The project must exist and be **team-managed**, with an Agile board and the
`Epic` / `Story` / `Subtask` types. The runner checks all of that and fails
with what is missing rather than skipping. It cannot create the project: this
Jira instance exposes no project templates over REST.

**The suite empties the project before every run**, not after — cleaning up
afterwards leaves a killed run's wreckage for the next one, and asserting
against whatever was lying around is not a result. Two things keep the wipe off
a real project: the key must be named explicitly, and a key that any board in
this working tree mirrors is refused outright.
