# light-plan Remote Sync — design record

A remote is a mirror: light-plan can keep an external tracker (GitHub Issues,
Jira Cloud, Linear) in step with a `.lpm` board, in either direction. This
document is the reasoning behind `src/remote/`, not the user-facing surface —
the README's *Remote boards* section is the manual, `docs/remote-capabilities.md` is
the per-platform matrix. Here we record the decisions that were made and the
alternatives that were rejected, so a future contributor can tell a deliberate
compromise from an accident.

Sync is the first part of light-plan that **writes to something it does not
own** and that **holds a credential**. Both change what "done" means: the
failure mode of a sync tool is not a crash, it is quietly filing four hundred
duplicate issues in a team's real backlog, or committing a token. The decisions
below are arranged to make those two failures structurally hard.

## 1. Where the layer sits

`src/remote/` sits above the engine, beside `src/sync`. It may import
`src/core`, `src/shared` and `src/sync`; nothing in `src/core` may import it.
Core validated the *frame* of a remote (the `remotes:` key, name, `provider`
string, `scope`, `direction`, both policies) and carries `connection` and
`mapping` through as opaque records; `src/remote` owns their contents. The seam
is the same one the rest of the codebase already relies on: `src/sync/dto.ts`
is the only place that knows both the engine's model and the wire shape, and
remote sync goes through it rather than around it.

The git analogy is load-bearing for the mental model and deliberately breaks
down at the edges. Git syncs *files* and knows nothing about what is in them;
a remote syncs *issues* and has its own ids, its own workflow, its own idea of
a parent. Git merges text and lets you resolve a conflict in an editor; a
remote returns normalised markdown, reorders labels and refuses half a write,
and there is no "working tree" to resolve in. That is why every decision below
exists: each one is an answer to a question git never had to ask.

## 2. The link store, not a frontmatter field

Which local document is which remote issue is recorded in
`.lpm/remotes/<name>/links.json` — the **link store** — committed to git like
everything else. One entry per linked document: the remote id, a human-readable
key and URL, the remote's revision marker, and (below) the base snapshot. The
file also holds the pull cursor, tombstones for deliberately decoupled
documents, and the one-time first-write consent.

**The rejected alternative was a `remote_id:` field in the issue's frontmatter.**
It fails three ways, and the third is the one that ends the argument:

- **It is a breaking reserved field.** A board that already declares an
  attribute named `remote_id` would stop validating the moment the engine
  claimed the name — reserving a field is a breaking config change, and here it
  would be reserved for a layer most boards do not use.
- **It does not extend to two remotes.** A document mirrored to GitHub *and*
  Jira needs two remote ids. A frontmatter field carries one; the link store is
  keyed per remote name, so N remotes are N stores, not N reserved fields.
- **It has nowhere to keep the per-remote state.** The cursor, the base
  snapshot, the tombstone and the consent are facts about *the remote*, not
  about *the document*. Putting them in frontmatter would sprinkle sync state
  over every issue and rewrite every document when a remote is added, removed
  or re-pointed.

This is the same reasoning that keeps derived inverses out of the documents:
`board.dependents` is derived from `depends_on` rather than stored, because a
stored inverse can drift from its source. A stored `remote_id` could drift from
the link store's own records the same way — and the link store is the one place
where the two cannot come apart.

Two properties make the store safe to share. Keys are written sorted and each
link is a contiguous line-group, so two people syncing different issues on
different branches produce a non-overlapping diff. And a hand-edited or
merge-mangled file is rejected with a `BoardError` naming the path and the
offending key — never a bare JSON parse error — because a corrupt store should
fail loudly, not silently drop half a correspondence.

## 3. The base snapshot, and why the body is a hash

Each link entry carries a **base snapshot**: every mapped field's value as it
stood when both sides last agreed, keyed by the *local* name. It is
vocabulary-agnostic on purpose — a field carried in the managed block rather
than a native remote field still appears under its local name, so the merge
logic never has to know how a value travelled.

**Why a base exists at all — the rejected alternative was a two-way compare.**
Two people can edit the same linked document in two places between syncs.
Without a common ancestor, "local says X, remote says Y" has no answer: you
cannot tell a local edit from a remote edit, only that they differ. With the
base, each field falls into exactly one of four cases — *same / local changed /
remote changed / both changed* — and only the fourth is a conflict. Without a
base, *every* difference is a conflict, which is the honest answer but a
useless one. That is why a link created by *matching* (adopting an existing
remote issue into a document, rather than a previous sync) has no base, and a
field that differs on both sides is reported as a conflict rather than
clobbered.

**The body is stored as a `sha256:` hash, not as text, and the managed block is
stripped first.** Two reasons, both about not manufacturing phantom edits:

- Remote markdown is normalised on the way back — `\r\n` folded, trailing
  newlines added or dropped, lists reordered. Comparing raw text would report a
  conflict for edits that agree. The hash is over the *trimmed* text, so
  whitespace noise does not read as an edit. Lists and ids are compared as
  sorted sets for the same reason.
- The managed block (below) is the sync layer's own output written into the
  body, not the remote's content. If it were included in the hash, every push
  that rewrote the block would make the next pull see a body edit — the exact
  loop this design exists to prevent.

After a successful write, the base is recomputed **from the issue as it stands
after the write**, echoing the remote's record back. A remote that normalises
markdown, reorders labels or silently rejects part of an update is absorbed
into the base rather than coming back as a remote change on the next pull.

### 3a. When the remote's body format is not markdown

Absorbing the echo is only half an answer for a remote that does not *store*
markdown. Jira's description is ADF, which has paragraphs but no source line
breaks: a body hard-wrapped at eighty columns arrives as one paragraph node and
comes back as one long line. The base then records the unwrapped text while the
board still holds the wrapped text, the two hashes differ, and **every wrapped
document is permanently ahead** — a push that rewrote forty-three bodies and
did exactly the same thing on the next run, for ever.

The fix is to make the comparison like-for-like rather than to guess at
whitespace. A provider whose bodies are not markdown declares
`Translator.normalizeBody` — for Jira, `adfToMarkdown(markdownToAdf(body))`,
the round trip the remote will perform anyway — and the board's own body is put
through it before hashing. `hashBody(body, normalize)` and `computeBase(doc,
fields, normalize)` take it as an optional argument; `RemoteSnapshot.normalizeBody`
and `ConflictOptions.normalizeBody` carry it to the push diff, the pull merge,
the conflict merge and `lpm remote status`, so all four agree about what has
changed.

Two properties keep it honest. It is applied **only to a board body being
compared against a base**, never to prose the remote just handed back — that
text has already been through the round trip, and converting it twice would be
a second normalisation nobody asked for. And it must be **idempotent**, which is
the invariant `src/shared/adf.ts` already carries: a normaliser that moved the
text a little further on each pass would be the same phantom-change loop with
more steps.

A provider whose bodies are markdown (GitHub, Linear, jsonfile) declares
nothing, and every call site falls through to the plain hash.

## 4. The degradation ladder, and its six rungs

A remote cannot hold everything a board can. The answer to "where does this
field go?" is one ordered list of carriers, best first — the **degradation
ladder**:

| Rung | Carrier | When |
| --- | --- | --- |
| 1 | **native** | the remote has a real place for it |
| 2 | **custom field** | the remote can be *given* one (a push creates it) |
| 3 | **label** | a low-fidelity native carrier for enums and types |
| 4 | **managed block** | a delimited region in the issue body |
| 5 | **comment** | the same block as a comment, when the body is not writable |
| 6 | **refuse** | a `required` field with none of the above — the sync stops |

Off the bottom of the ladder is **dropped**: the same field without
`required`, which is lost with a warning rather than refused. Only attributes
carry `required`, so the bottom rung is theirs.

**The rejected alternative was a "native or lose it" binary** — drop everything
the remote cannot hold. That is what a naive integration does, and it is why
they silently lose `depends_on`, hierarchy depth and half the attributes. The
ladder exists because *encoding* a field, lossily but reversibly, is better
than *losing* it, and the rung order is the whole design: a field degrades one
step at a time and never two, so a reader can see exactly what fidelity was
paid for. Rung 4 is the workhorse — a managed block is a delimited
(`<!-- lpm:begin -->` … `<!-- lpm:end -->`) markdown table a human can read and
the next pull parses back. It is written idempotently (sorted entries, no
timestamps) so a push that changes nothing produces identical bytes and no
phantom body edit. Rung 5 is the same block as a comment, for a platform whose
issue body is not writable.

The ladder is **a report, not the gate**. `ladder.ts` computes the rung every
construct lands on and *why the rung above was not available* — what a person
deciding "fix the tracker or accept the encoding" needs to read. `preflight.ts`
separately collects the unmappable *values* as a `Problem[]`, offline, and that
list is what gates a push. They are two modules rather than one because the two
questions have different audiences: a person needs the rungs, a push deciding
"stop or proceed" needs the problems. Note what has **not** landed: nothing
prints the ladder yet — `ladder.ts` has no caller outside the barrel export.
Today the rung analysis is a library with no surface, and `push --dry-run` is
where a person reads the verdict: the preflight problems, plus what the push
would have to create on the remote first.

## 5. Pull emits `Change[]` and reuses `applyChanges`

A pull is planned by `planPull` as a `PullPlan`: a `Change[]` plus link-store
effects (record a new link, drop a link, decouple with a tombstone) and comment
appends. The `Change[]` half is handed to `applyChanges` from `src/sync` — the
**same applier every front end pushes a view through**.

**The rejected alternative was a dedicated pull applier** that wrote core
operations directly from the remote listing. It would be a second engine for
"what does this change mean" — a second copy of validation, of id allocation,
of the status and flag roll-ups, of the `INDEX.md` rewrite. The codebase is
arranged around the rule that there is exactly one of those, and a pull that
landed board edits through any other path would drift from a push the moment a
rule changed. Going through `applyChanges` means a pull *is* a push in reverse:
a remote create becomes a local `create` change, a remote edit an `update`, a
remote deletion a `delete`, and everything the engine does for a person's push
— partial application, temporary-id remapping, the hold-back-and-replay of a
create whose parent is created later in the same batch — is inherited for free,
not re-derived.

The only new code in `pull.ts` is the **correspondence bookkeeping**, because
the link store is the remote layer's own state and no core operation writes it.
That bookkeeping is deliberately careful about failure: a `record` whose create
failed is skipped (there is no real id to link), and an `unlink` naming a
`delete` that failed is skipped too, so a deletion that did not land is retried
on the next pull rather than silently forgotten.

## 6. Providers and connectors are separate

There are two `Connector` contracts, and they never meet:

- **The provider adapter** (`provider.ts`) speaks *board* vocabulary. It
  exposes exactly four members — `config` (a zod schema for the provider's
  `connection`/`mapping` blocks), `capabilities` (what the platform holds
  natively), `translator` (board ↔ remote vocabulary, both directions), and
  `connector` (a factory that builds a live connector) — plus an optional
  `credentials` descriptor. Its `Connector` has methods like `create`, `update`,
  `get`, `link`, `comment`: the shape of *syncing*, not of *HTTP*.
- **The transport layer** (`transport/`) speaks *wire* vocabulary and knows
  nothing at all about boards. Its `Connector` is three methods —
  `request`, `paginate`, `close` — over `RemoteRequest`s whose fields are
  `method`, `path`, `query`, `body`: HTTP, GraphQL, tokens and processes, and
  not a board word anywhere.

The translator is the seam between them: a board op becomes a board-vocabulary
`RemoteRequest`, which the connector turns into the platform's own call.

**Why the split — the rejected alternative was one interface** that mixed
"file an issue" with "send a POST". That interface cannot be tested offline and
cannot be made reliable without re-implementing the reliability once per
provider. The split buys three things at once:

- **Offline tests.** The same provider runs over a fake connector that records
  traffic and replays it, so `make verify` never makes a network request. A
  provider also runs over REST, GraphQL, or a shelled-out `gh` process without
  changing a line of the translator.
- **Reliability as a decorator, not a flag.** Retry/backoff and the request
  budget wrap the transport `Connector` from above, so a provider cannot
  accidentally bypass the rate limiter — there is no flag on the interface to
  forget.
- **A hard boundary, enforced.** `test/remote-transport-isolation.test.ts`
  fails if any file in `transport/` imports `src/core` or `src/shared`. The
  dependency is structural, not hoped for.

The two `Connector`s are deliberately *not* re-exported from one barrel: the
transport one lives in `transport/index.ts` and is imported directly, because
the names would collide in `src/remote/index.ts` and the vocabularies must stay
visibly distinct.

**The provider connector does not have to use the transport layer.** The
contract in `provider.ts` is a factory that returns a board-vocabulary
`Connector`; *how* it reaches the platform is the provider's business. GitHub
uses raw `fetch`, and the `jsonfile` provider (LP-360) does `node:fs` against a
local JSON file with no transport at all. That is the proof this split was
meant to make possible — and it is also where the conformance harness initially
fell short: it drove every provider by stubbing `fetch` onto the in-memory HTTP
tracker, so a non-HTTP connector could not be driven by a conformance entry
alone. The harness now carries a `trackerAndConnection` hook, and `jsonfile`
supplies a file-backed tracker double (`test/support/jsonfile-tracker.ts`) that
reads and writes the same file the connector does — the one extension a
non-HTTP provider needs, recorded here rather than left implicit.

## 7. The first sync is confirmed, and a large plan stops

Writing to a remote is the first thing light-plan does that a mistake cannot be
undone from the local checkout. So the push side has a write-confirmation gate
(`guard.ts`), which is a **pure decision**, not a prompt: `consentGate` looks
at the plan and says whether consent is needed and why, and the prompt lives in
the caller — the CLI, the web panel, and an agent all enforce the same decision,
so they cannot disagree about whether a plan is allowed to run.

Two pauses, one memory, plus a standing rule:

- **First write.** The very first write to a remote asks a person to confirm
  the target and the counts. The consent is recorded once (`consentedAt` in the
  link store) and never asked again.
- **Oversized plan.** A push whose plan would create or close more than the
  threshold (25 by default, `write_threshold` per remote) stops and requires
  `--yes`. A scope typo that makes half the board look deleted would otherwise
  close half a backlog — bulk-close is as dangerous as bulk-create.
- **Delete is confirmed every run.** A delete never rides the remembered
  first-write consent, because "I meant to sync" is not "I meant to delete".

A run with no terminal to ask (CI, an agent) **never prompts**: it proceeds
with `--yes` or stops with a message naming what it refused. A guard that hangs
waiting for a person who is not there is not a guard, it is a dead queue.

**The rejected alternatives.** No gate at all — trust the operator — was
rejected because one bad scope is enough to end adoption. A per-operation
prompt was rejected because it is noise a person learns to skip, and an agent
cannot answer it at all. A hard gate with no `--yes` was rejected for the same
reason the epic's risk section names: a guard people cannot talk past gets
turned off wholesale, and then it guards nothing. The memory (`--yes` once per
remote) is the compromise, and its exact shape is an open question below.

## 7a. Setup drafts the mapping, and asks only what it cannot know

`lpm remote add` writes the `mapping:` block, it does not leave one empty. The
scaffold (`scaffold.ts`, LP-369) had been able to draft one from the board's
config and a capability descriptor since it landed, but nothing called it — so
the command that exists to set a remote up produced a declaration that could
not sync, and every user's first act was to hand-write the cross-product of
their own vocabulary with the provider's. That was not a deliberate "declared,
not mirrored" boundary; it was a missing wire.

Three decisions hold it together, and each one is about **not guessing**:

- **The capability table is drafted, not probed.** There is no connector at
  `add` time — no credential has been resolved, and the remote may not even
  exist yet — so `staticCapabilities` resolves each *probed* cell to the
  least-capable reading (`nativeTypes: false`, `customFields: null`) and passes
  every stated cell through untouched. Under-claiming degrades a field onto a
  label or the managed block, which is always safe to correct; over-claiming
  would name a field the platform does not have, which fails at the first sync.
- **`vocabulary` is a capability cell, because "who names the statuses?" is a
  property of the platform.** `fixed` — Jira's issue types, Linear's workflow
  states — is a vocabulary that pre-exists and can only be discovered by
  asking, so the scaffold writes a `TODO:` marker and `openRemote` refuses the
  remote until a person answers it. `open` — the `jsonfile` tracker — is a
  vocabulary *we* write, because the file does not exist until the first sync
  creates it; there is nothing to discover, so the board's own type names and
  status labels are the answer and no marker is left. Without this cell the
  scaffold asked fourteen questions about a file it was about to create itself,
  which is the same "ask the user to name what the tool can name" failure the
  empty mapping was.
- **A connection value light-plan owns is filled in too.**
  `Provider.defaultConnection` lets a provider name a connection key from the
  remote's name alone; `jsonfile`'s `file` is the only case and the only kind
  of case that qualifies — a path *inside `.lpm/`*, not a coordinate in
  somebody else's system. A GitHub `repo` or a Jira `site` can never be
  defaulted, and the flag stays required for them. `connectionFlags` reads the
  same member to print `[--file <file>]` as optional, so the help and the
  behaviour cannot drift.

## 7b. Two remotes may never mirror the same work

A document mirrored to two trackers is filed twice, closed twice and edited
from two directions, and neither remote can see the other to sort it out. No
`on_delete` policy or three-way merge can recover from it, because both sides
are behaving correctly by their own lights.

The rule was half-enforced and half-promised. `checkRemotes` in
`config/schema.ts` refuses what the config alone can answer — two equal scopes,
or either remote claiming the whole board — and its comment said the rest was
"answered against the board tree (by `lpm check`)". No such check existed, so a
remote scoped to `LP-10` and another scoped to the `LP-42` inside it were
accepted by every layer.

`core/board/remote-scopes.ts` is the missing half, and it lives in **core**
rather than `src/remote` for a structural reason: `lpm check` must enforce it,
and nothing in `src/core` may import `src/remote`. It is pure — issues and
declared scopes in, overlapping pairs out — and it has exactly two callers, so
the rule cannot be stated twice and disagree with itself: `checkRemoteScopes`
reports a board that *drifted* into overlap (a reparent, a merge of two
branches), and `addRemote` refuses to write one in the first place. `add` is
the only place that loads the board, and only when another scoped remote is
already declared — the first remote on a board has nothing to overlap with.

It is an **error**, never `fixable`: which remote should lose the work is a
decision about somebody's tracker, not a repair. A scope naming no document is
a separate, gentler finding — a `warn`, because a remote that mirrors nothing
is a surprise worth explaining but not a contradiction.

## 7c. One key per board word, and only statuses are many

`mapping.types` and `mapping.statuses` answer the same question — *what does
this board word look like over there* — and say it with the same key:

```yaml
types:
  user_story: { remote: Story }
statuses:
  done: { remote: Done, closed: true }
```

**What this replaced was a redundancy, not a feature.** A type used to be
declared as `{ type: Story, labels: [story] }` — one key for the native issue
type and one for the labels that carried it. Two things were wrong with that.
It said the *same fact twice* in keys that could disagree, and for a provider
with a native type field it wrote the type into the field *and* onto a label,
so every jsonfile issue carried a `story` label restating its own `type: story`.
And it made the config carry a decision the provider had already made: whether
a value rides a native field or a label is a property of the platform
(`capabilities.nativeTypes`), which the provider knows and the person writing
the mapping should not have to.

**Where the two deliberately differ is the cardinality, and it is not
cosmetic.** A type is one name: a push has one issuetype to file under, and a
pull reading that name knows which board type it is. A *status* is genuinely
many-to-one — "Done", "Won't Fix" and "Duplicate" are all the board's `done` —
so `StatusMapping.remote` stays a list and `push:` says which of them a push
writes back. Giving types a list too would have been symmetry for its own sake:
a one-item list on every line, reading like a choice nobody made. So the
scaffold emits a plain name for both, and a list is what you *widen* a status
to on the day the remote turns out to have three words for finished.

Three consequences worth stating. A mapping **survives a change of carrier**: a
repository that turns GitHub's org issue types on starts reporting the same
name in a different field, and the mapping that was already correct keeps
working, because `entryMatches` checks the observed native type *and* the
observed labels against the one name. Each provider's translator reads
`mapTypeToRemote` and puts the answer in its own slot, so the four of them
cannot drift on what a match is — `boardTypesMatching` is the single definition
they all pull. And the older spellings are **folded, not refused**:
`normalizeTypeMapping` reads `type:`, `labels:` and a list into the one name at
the schema boundary — the native type winning over a label, the first entry
over the rest, which is what the older shape actually wrote. The fold lives at
that boundary and nowhere else, so the engine reads one shape.

## 7c-bis. Vocabulary the push creates; a timeline it does not

Some of what a board carries is not a field on the other side but a *thing the
tracker has to have first*: a GitHub repository only applies labels it already
defines, a Projects v2 board only sets a field somebody created with the right
options, a Jira board only schedules into sprints that exist.

That used to be `lpm remote provision`, a command of its own, which meant the
ordinary first-time sequence was: push, watch it fail or half-apply, read the
name of a second command, run it, push again. The word itself was the smaller
problem. The real one is that a label is not a *decision*: it exists only
because the mapping needs somewhere to put a type, and it is already implied by
what the board wrote down. A step with no decision in it is a step the tool
should take — so `src/remote/prerequisites.ts` asks the remote what vocabulary
it is missing and creates it inside the push, reporting each one, because a
write to somebody's tracker is never silent. `lpm remote check` (which reported
the labels this would create) and `lpm remote ids` (which warmed a cache the
connector fills anyway) went with it: three commands became none.

**A sprint was in that list and should never have been.** It looks like a
prerequisite — an issue cannot be scheduled into a sprint that does not exist —
but it is a *document on the board*, with a name and dates somebody wrote down.
Creating one is filing part of the plan, not preparing to file it. Bundling it
in had the cost you would expect from that category error: the board's whole
timeline became a precondition for filing a single story, and one sprint name
Jira would not take (over 30 characters) stopped a push of forty issues that
had nothing to do with it.

So the line is **vocabulary, not documents**:

- **Labels and Project fields** are created by the push that needs them.
- **Periods are pushed like anything else** — `lpm remote push TL-3` files that
  sprint, `--all` files the timeline with everything else, and a push of work
  files none of it.

The other half of that split is what makes it safe: an issue whose sprint is
not on the remote is **filed unscheduled** rather than refused. The connector
drops the field and names it in `ConnectorResult.unwritten`, and the executor
records that field as **unset** in the base snapshot — never as the value we
hoped for. The next push then sees the board's value against an empty base and
writes it the moment the sprint exists. Recording the local value instead would
make both sides look agreed and the scheduling would never land, which is the
same trap `parentRemoteId` exists to avoid for a parent that arrives late
(§7f). Pushing a period also selects the already-filed issues scheduled in it,
so the assignments land in that same run.

Two things keep the vocabulary half safe. It runs **only when the push has
operations** (or when periods were asked for), so an idle sync costs no extra
requests. And every operation is **additive and idempotent** — nothing here
deletes or renames, and a second push with nothing missing writes nothing.
Refusals are **collected rather than thrown**: a tracker that will not create
one thing is no reason to abandon the rest, and finding out about three
refusals one push at a time is how somebody spends an afternoon on what should
have been one list.

## 7d. The ledger: one document, one remote

7b is the rule stated over *scopes*, which is everything the config can answer
on its own. It leaves a gap the config cannot see: a scope is evaluated against
the current tree, and links outlive the tree they were made in. Reparent a
document out of one remote's subtree and into another's, adopt a twin by hand
with `lpm remote link`, or take both sides of a merge in `links.json`, and one
document ends up with two twins — filed twice, closed twice, and each remote
writing its own truth back onto the same file.

`src/remote/ledger.ts` closes it, and it is **derived**: it reads every declared
remote's `links.json` and answers "where does this document live?". There is no
`ledger.json`. A committed index of a fact the link stores already hold would be
free to disagree with them after a merge, and would need a repair pass of its
own to decide which copy was right — the same reasoning that keeps the
dependency inverses out of the documents.

Enforcement is deliberately asymmetric, because the two ways of arriving at it
are different requests:

- a **push** never gives a claimed document a second twin. The claimed ids
  reach `planPush` as `ownedElsewhere`, and each comes back in the plan's
  `skipped` list with the reason `owned_elsewhere` and the key it already has.
  A whole-board push to a second tracker is then a readable report rather than
  a refusal, which matters on a board whose remotes divide the work.
- an **explicit** request — `lpm remote link`, or `lpm remote push LP-12
  --remote other` — is refused outright, naming the holder and
  `lpm remote decouple`. The person asked for precisely the thing the rule
  forbids, and answering with a silent skip would be answering a different
  question.

A document in two stores *already* is reported by `lpm remote ledger` (exit 1)
and never resolved automatically: which twin to drop is a decision about
somebody's tracker, exactly as in 7b.

## 7e. Scope, selection, and a partial listing

Three words that sound alike and mean different things. Getting two of them
confused is destructive rather than untidy, so they are three fields:

- **`scope`** — what this remote *owns*. The push planner's gone pass reads it:
  a linked document outside the scope has left the mirror, and the `on_delete`
  policy applies.
- **`only`** — what this *run* is about (`lpm remote push LP-12`).
  It filters what is created, updated, reparented, edged and commented, and the
  gone pass never consults it. Expressing a selective push by narrowing `scope`
  would tell the planner that every other twin on the board had left the
  mirror, and one story pushed would decouple two hundred.
- **`partial`** — this *listing* is not exhaustive (`lpm remote pull PAY-31`
  fetched what was named). Absence is then not evidence: `planPull` plans no
  gone-twin work, `resolveLifecycle` assesses no twin at all — which is also
  what stops the bulk guard reading a one-issue fetch as a mass deletion — and
  the pull cursor does not move, because nothing was listed.

Reference resolution is the other half of `only`. A selected child whose parent
is already filed still *names* that parent: selection says what to act on, never
what may be referred to.

**The three reach the browser unchanged, and that is the point.** The editor's
Push and Pull — on the selected document in the side panel, and on a canvas or
table selection in the context menu — post the same `only` / `scope` /
`pullIds` the CLI passes, to the same `runSync`. The web app has no sync of its
own: `RemoteState` builds a request body and the server threads it through, so
a browser tab and `lpm remote push` cannot disagree about what "push this one"
means.

Which field each gesture uses is a decision, not a detail:

| gesture | field | why |
| --- | --- | --- |
| Push (panel, one document) | `only: [id]` | acts on exactly that document |
| Push subtree (panel checkbox) | `scope: id` | names a *root* and expands under it |
| Push (menu, a selection) | `only: ids` | the selection, never the subtrees beneath it |
| Pull (either) | `pullIds: [remote ids]` | a **targeted** pull, so it is `partial` |

Pull is the one worth explaining. Narrowing a pull by `scope` would make it a
*complete* listing of a one-document world — and a twin missing from it is then
100% of that world, which trips the bulk guard and declines the pull outright.
Naming the twin instead makes the run partial, where absence is not evidence at
all. It also means a document with no twin has nothing to pull rather than a
smaller pull: the menu counts the twins it can actually fetch and greys itself
out at zero, instead of sending an empty list that would read as "everything".

## 7f. A plan filed a piece at a time

Pushing part of a plan is a normal way to work: a story goes up before the epic
it belongs to, a dependency points at something nobody has filed yet, a sprint
nobody has filed holds work that is ready to go up today. The board survives
that — what it must not do is leave the shape wrong for ever.

**Three things can be missing when a document is filed, and all three heal the
same way**: its parent, the other end of a dependency, and the period it is
scheduled in. In each case the document is filed without what is missing, what
was *actually written* is recorded (never what was intended), and the push that
supplies the other half writes the rest.

The base snapshot records the document's **local** parent, which answers "did
somebody reparent this here?" and cannot answer "was the parent upstream yet
when this was filed?". They look identical from the base: a story filed at the
tracker's root has the same local parent it always had. So `LinkEntry`
records what was actually filed — `parentRemoteId`, the remote id, or `null`
for "filed at the root" — and `planPush` emits a `reparent` when the board's
parent has since become resolvable and is not what was filed. A parent created
in the *same* run counts, so pushing a feature moves the stories filed before it
immediately rather than on the push after.

An older link that never recorded a `parentRemoteId` reads as **unknown**, and
unknown changes nothing. The alternative — reading absent as "filed at the root"
— would emit a reparent for every twin on the board the first time anybody
pushed after upgrading.

The **period** is the third case and works the same way through a different
field. The connector files the issue without the sprint and names the dropped
field in `ConnectorResult.unwritten`; the executor writes that field as `null`
into the base, so the board's value and the base disagree and the next push
carries it. Recording the local period instead would make both sides look
agreed for ever — the same failure the `parentRemoteId` distinction exists to
avoid.

Two smaller pieces finish it. The CLI adds a named document's already-linked
descendants to the selection (so pushing the parent repairs the children), its
already-filed dependents (so pushing one end writes the edge), and the
already-filed issues scheduled in a period being pushed (so filing a sprint
lands its assignments). And before the plan is built it says what this push
cannot carry: a parent with no twin yet, and a dependency whose other end is
outside the run. Neither is an error; both are things nobody should discover
later.

## 7g. Connecting without a terminal

`lpm remote connect` asks one question at a time; the web connect form sends
every answer at once. Three things follow from that, and each is load-bearing.

**The conversation with the tracker is a report, not output.** `inspectRemote`
used to live inside the CLI command, interleaved with what it printed, and a
browser cannot read a terminal. Its decisions — reachability first and
stopping when it fails, a discovered key written when the tracker offered
exactly one value, spelling corrections applied, a word the tracker does not
have left for a person — now live in `inspectRemoteConnection`
(`src/remote/inspect.ts`), and both front ends render the same report. What a
person answers goes through `applyInspectAnswers`, over the same two surgical
writers. A second copy of those decisions in the server would have been free
to disagree with `lpm remote setup` about what "set up" means.

**The refusals live in the engine, not in the routes** (`src/remote/connection.ts`):

- *A secret never reaches config.yml.* A credential key sent as a connection
  value is refused before anything is written. So is a connection *answer*
  naming anything but a key the provider declares discoverable: that writer
  takes free-form keys, and without the check it would write a token into the
  committed file.
- *Every key is checked before any is written*, so a refused credential never
  leaves a remote declared with half its setup done.
- *A blank keeps what is stored* — the form's bare Enter at the `login` prompt.
- *A remote with twins is not re-pointed in place.* Changing its repo, site or
  project would leave every link naming an issue somewhere else. The exception
  is the provider's to state, not the server's: a key the provider declares
  *conditional* (Jira's board — where sprints live, never where issues are)
  may be corrected at any time.
- *A switch is set or removed, never written `false`.* Absent is every
  switch's default, and for Jira an explicit `tls_verify: false` is what turns
  certificate checking *off*. That has to be typed into the file on purpose; an
  untick restores the default.

**Secrets travel in, never out.** These are the only routes that take a
secret. Every response reports where a credential comes from
(`credentialStates`), never its value; an error names a key and never echoes
what was sent; and a secret key's config value is withheld from the connection
read even when it is only a `${VAR}` reference. The loopback bind and origin
check every route already has are what stop another page from sending one.

Nothing in the web app names a platform. The form is drawn from
`GET /api/remote-providers`, derived from the registry by
`src/remote/connection-catalogue.ts` — which also holds the worked example the
CLI prints beside each question, so the two cannot drift apart.

## 7h. What a fake tracker cannot tell you

The conformance harness drives every provider against an in-memory tracker, and
that is the right default: it is fast, it needs no token, and it is where the
planners' behaviour belongs. It has exactly one blind spot, and it is not a
small one. **A double is built from the same reading of the platform as the
connector, so a shared misunderstanding round-trips perfectly.** The write goes
in wrong, the read takes it back out wrong, the base agrees with both, and every
test is green.

Five defects reached a live Jira push that way, and each is worth naming because
none of them is a typo:

- **A created issue kept the workflow's first status, for ever.** `POST /issue`
  cannot set a status — Jira moves one only through a transition — and the push
  planner emits transitions for twins it *already knows*, so a create was never
  covered. It could not be seen afterwards either: the base is recomputed from
  the remote's echo, `To Do` maps back to more than one board status, and an
  ambiguous read leaves the local value standing. Both sides recorded agreement
  on a status Jira did not hold. GitHub had the same hole with `state`.
- **`depends_on` was filed backwards.** Jira's link API calls the blocker the
  `inwardIssue`, which reads the opposite way round to the obvious guess.
- **The link readers could never read one back.** They asked "is this end me?"
  of `issuelinks` entries that name only the *other* end.
- **`unlink` never matched**, for the same reason, so an edge removed on the
  board stayed in Jira and the run reported success.
- **Jira had no `parentIdOf` seam**, so a pulled issue never landed under the
  twin of its Jira parent (section 7f's table, one row short).

So a provider gets a second kind of live test beside the round trip: one
provider, many scenarios, **asserting against the platform's own payload rather
than through the `Connector`** (`test/remote-live-jira.test.ts`). Reading a
write back through the thing that wrote it proves only that the code is
self-consistent, which is precisely the property the five defects had.

Two constraints make such a suite something a repository can keep. It **empties
its project before each run, never after** — cleanup at the end leaves a killed
run's wreckage for the next one, and assertions against whatever happened to be
lying around are not a result. And the wipe is guarded twice: the target is
named explicitly with no default, and a key any board *in this working tree*
mirrors is refused before a request is made. That second rule is not
hypothetical — this repository's own board mirrors a Jira project. The guard is
a pure function with offline tests, because a rail nobody exercises is not a
rail.

One thing a live platform teaches that no specification mentions: **a search
index is not a read.** Jira's JQL lags its own writes by seconds, so counting
issues straight after a push is a race; a fetch by key is not. A listing is the
only thing section 7e's existence check can be asked of, which is one more
reason it may only be asked of a *complete* one.

## 7i. Coverage: the question the drift report does not answer

§7f says a plan is filed a piece at a time and the shape heals. That is the
right design and it leaves a hole: nothing said what the piece was *missing*.
Push one feature and the tracker holds a feature with no stories inside it, no
epic above it, no sprint on it, and a dependency with one end. Each of those
repairs itself on a later push — but only if somebody knows to make one.

The drift report cannot answer it. `unlinked` is "every in-scope document with
no link and no tombstone", which on a board mirroring one feature is the entire
backlog: a true list nobody can act on. What makes a document worth a person's
attention is not that it is unpushed, it is that **something already mirrored
points at it**. So coverage (`src/remote/coverage.ts`, report shape in
`src/shared/remote-coverage.ts`) is relational: a gap is an unmirrored document
related to a mirrored one, and it always carries *which* mirrored documents and
*how* — the container above them, the work inside them, the period they were
filed without, the far end of a dropped edge.

Four decisions in it are worth keeping.

**It is offline.** The board and the link store answer it between them, so it
costs no request, needs no credential, and is re-read after every push without
slowing one down. That is the opposite trade from `computeRemoteStatus`, which
reads every twin upstream and takes minutes on a large project — and it is why
the two are separate calls rather than one report. The gap list has to appear
while somebody is halfway through filing a board, which is exactly when the
drift report is least able to answer.

**A decided document is reported, never offered.** A tombstone and an
out-of-scope document both come back in their own lists rather than as gaps.
Offering to push them would offer to undo a decision. The containers *above* a
scoped remote's root go further and are not reported at all: a scoped remote's
root has a parent by definition, nobody ever meant to file it, and listing it
on every run is how a short report teaches people to stop reading it.

**A period is only a gap where periods are filed.** A remote whose mapping
carries no `periods` block rides the schedule in the managed block, and a level
*above* the mapped container degrades the same way — in neither case is there a
twin for a sprint to be missing. `filesPeriods` on the report says which world
the reader is in.

**Pushing the gaps is a selection, never a scope.** The ticked ids travel as
`only` (§7e): filing the missing stories of one feature must not tell the
planner that every other twin has left the mirror. Order inside the selection
does not matter, because `planPush` already files a parent created in the same
run before the children that name it.

## 7j. The drift report is two halves, and a screen reads the cheap one

`computeRemoteStatus` reads the remote to answer "what changed upstream?", and
that half used to fetch **every twin, one request each**: measured against this
repository's own mirror — 537 issues on Jira Cloud — **115 seconds**. The Sync
tab ran it on open, and again after every sync, behind a single `loading` flag
that hid the whole panel. So the tab read "Reading drift…" for two minutes, with
no count, no elapsed time, no error surface and no other control usable, which
is indistinguishable from a hang and was duly reported as one.

Two separate things were wrong, and it is worth keeping them apart, because
fixing the cheap one first is what made the expensive one look acceptable for as
long as it did. **The split below is right and stays.** But the remote half was
*also* doing the most expensive thing available to it — see §7l, which replaces
the per-twin loop with one paginated listing and takes the same read from minutes
to seconds.

The fix is not a spinner. It is that **the two halves of the report answer
different questions and only one of them needs the tracker**:

- the **local half** (`local: true`) builds no connector and makes no request.
  Which documents have twins, what has never been pushed, what has been edited
  here since the last sync — all of that is the board and the link store, and
  it comes back in under a second. `remoteMissing` carries the sentence saying
  why `behind` and `conflicted` are empty, which is the same field a missing
  credential already used, because it answers the same question;
- the **remote half** is everything else, and it is a deliberate act:
  `checkDrift` in the web, `lpm remote status` without `--local` at the
  terminal. It is seconds rather than minutes since §7l, and it stays a click:
  it needs a credential and it can fail, which is exactly what a tab opening a
  board must not depend on.

Three properties came with it and are the point rather than decoration. **The
expensive half never runs by itself** — not on open, and not after a sync,
where the run has just reported what it wrote. **While it runs, everything
about it is on screen**: the twin count, a clock, and a Stop that aborts the
request. And **a failure stays put** rather than passing through a notice that
is gone in five seconds — "the tab shows nothing and says nothing" is a
complaint about error handling, not about speed.

One thing the split exposed rather than caused: the local half answers `ahead`
from the base snapshot, so a field the remote *cannot hold* reads as an unpushed
edit for ever. On the Jira mirror that is 430 documents assigned to generic
pools, which no Jira account can represent; the push correctly writes nothing,
and the report correctly says the two sides differ. They are both right, which
is what makes it a design question rather than a bug — recording *why* a field
is unset (refused for good, or waiting on something that does not exist yet) is
what would let the two agree.

## 7k. The pre-push question, and why it has three answers

`preflightPush` refuses a push whose values the mapping cannot carry. It is
pure and offline, which is right for that question and useless for the one
underneath it: **the mapping can carry an account id perfectly well and the
tracker may never have heard of it.** A board can be entirely valid and still
file forty issues unassigned because somebody left the project, or unscheduled
because nobody filed the sprint. Nothing said so until the issues themselves
arrived, wrong, and from then on the two sides disagreed about work nobody had
edited.

`checkReadiness` is that question asked in time. Two requests whatever the size
of the push — the project's assignable people and its periods — measured at
3.8 seconds against this repository's own 537-document board, which is cheap
enough to gate every push rather than to offer as a separate command nobody
would run.

Four decisions in it are worth keeping.

**The offline half is not computed twice.** Every assignee and period finding
starts from `pushGaps`, the same translator walk `preflightPush` reports from,
so the dialog and `lpm remote push` cannot disagree about one board. The
preflight's `include` argument exists only so the two do not *render* the same
gap twice in one conversation.

**A finding says what ignoring it costs.** "Leave it blank" is a real answer
here rather than a shrug: the executor records the field as unset, and a later
push writes it the moment the far side exists (§7c-bis, §7f). An option nobody
can price is not a choice, so each finding carries the sentence — *filed
unassigned*, *filed unscheduled*, *the pool is recorded in a label and a pull
restores it*.

**The fix is data, not a branch.** `link_account` writes the remote account
onto that person's roster document, so every push after this one assigns them
too; `unassign` clears an assignee the board itself has lost; `file_period`
writes nothing at all — it widens the push, exactly as naming a period does at
the terminal. A dialog that knew what each code meant would be a second
definition of the same rules, and the third kind shows why the split matters:
two of these are board edits and one is a change to the run.

**Only self-contradiction blocks.** An assignee or a period the *board* no
longer has cannot be made right by pushing, so it waits. Everything else
degrades, and degrading is what this layer does everywhere else — refusing a
push because somebody has no account would make the tracker's user list a
precondition for filing any work at all, which is the same category error the
timeline split fixed.

One thing the check must never do is invent a person. A remote user is offered
as a *candidate* only on an exact address match or an exact display-name match,
never a substring: a wrong account is worse than no account, because the work
lands on somebody. When nothing matches, the finding says so and names the
attribute to fill in by hand. And which of a remote user's fields answers a
board attribute is the provider's own knowledge (`Translator.accountValue`) —
Jira assigns by account id and resolves an email by search, GitHub assigns by
login, and nothing above the provider may guess between them.

## 7l. The remote half is one listing, and that is also the bucket that was missing

Two symptoms, one cause, and the cause is the shape of the question the report
asked.

`computeRemoteStatus` used to iterate the **link store** and call
`connector.get()` once per entry. Everything follows from that. It was the most
expensive read available — 537 sequential requests on this repository's own
board, about two minutes — and it was also *structurally blind*: a loop over the
links can only ever ask about documents the board already knows. Somebody adding
a story to a mirrored epic in Jira produced no change the report could observe,
so "Check the tracker" ran for two minutes and correctly reported nothing.

The replacement is one paginated `connector.list()` — the same call a pull makes,
which is the tell that the report was doing it the hard way all along. It is
about 11 requests for those 537 twins, and it comes back with every issue in the
project rather than only the ones with twins. So the same sweep answers three
questions where it used to answer one:

| bucket | what it means | keyed by |
| --- | --- | --- |
| `behind` | a twin the remote has changed | local id |
| `unreadable` | a twin no longer in the listing | local id |
| `incoming` | a remote issue with no local document | **remote** key |

`incoming` is the sixth bucket and the only one not keyed by a local id, because
there is no local document yet. It carries the remote id, the key, the title and
`parentLocalId` — the twin of its nearest mirrored ancestor, which is where a
pull would file it. Adopting it is `lpm remote pull <name> <key>`, or the **Pull**
button beside the row in the Sync tab; `planPull` already planned a `create` for
an untwinned remote issue, so nothing on the applying side had to change. The
capability was there the whole time and only the report could not see it.

Five things about it are load-bearing.

**`list()` is called once.** A connector pages internally and returns every
record plus the cursor for the *next pull*. Treating that cursor as a
continuation token asks the remote for the same listing twice, which is a real
mistake made while writing this and caught by the request count in
`test/remote-report.test.ts`.

**Progress comes from inside the listing, through `ListProgress`.** The pages are
the connector's business and nothing above it can see them, so `list` takes an
`onPage` callback and the report passes its `onProgress` straight through. That
is what a terminal prints to stderr and what a panel can show; a report that only
knew "finished" could offer no progress at all, which is how this read came to be
indistinguishable from a hang.

**Absence is only evidence from a full listing** — the same rule as a pull, for
the same reason. With `--changed` the listing holds what moved since the cursor,
so a twin nobody touched is missing from it and an untwinned remote issue may
simply not have been looked at. Both `unreadable` and `incoming` stand down, and
`incremental` on the report says so.

**A twin outside the connection's project reads as absent**, where a `get` by id
would have found it. For a report that is the better answer — it has left the
mirror — and nothing is written on the strength of it. Absence has consequences
only in the pull's gone pass, which has its own guard.

**A board with nothing mirrored reads no tracker at all.** With no twin anywhere,
every remote issue anchors nowhere, and a listing could only report a tracker's
entire contents as work to import: true, and nothing anybody can act on. It is
the same judgement `coverage` makes — a document is worth reporting because
something mirrored points at it — and it keeps the older property that a board
with nothing to sync answers "in sync" with no request. Adopting a whole tracker
onto a fresh board is `lpm remote pull`, asked for explicitly.

Scope applies exactly as it does to a pull, through the *same* walk:
`anchorResolver` in `src/remote/anchor.ts` is shared by `planPull` and the
report, so the report offers precisely what a pull would adopt. A second copy of
that walk would be a report offering work the pull then declined to take.

## 7m. The mapping editor: the tracker's items beside the board's, chosen and written whole

`lpm remote add` drafts the mapping from a convention, and `lpm remote setup`
corrects the spelling of a drafted name. Neither lets a person choose. A
project with an `Initiative` level, or a workflow with an `In Review` state,
keeps the conventional `Epic` and `In Progress` until somebody edits YAML. The
mapping editor (`mapping-editor.ts`, and `web/src/features/config/remote/`) is
that edit as a screen.

- **`readRemoteMapping` asks four questions and survives each one failing.**
  `reachable()`, `issueTypes()` (or `vocabulary().types`), `vocabulary().statuses`
  and `listSprints()`. Each is optional on a connector. A question that throws
  becomes a line in `problems`, and the block is answered from the mapping
  alone with `fixed: false`. A missing credential stops before the first
  question, with the reason. The editor is then still usable, and that matters:
  the screen where a person completes a mapping must not need a complete setup.
- **The read opens the remote with `lenient: true`.** `openRemote` refuses a
  scaffold marker, a board status with no remote state and a board with periods
  and no period mapping. Each of those is a reason to open the editor.
  `OpenRemoteOptions.lenient` skips those three refusals and nothing else: the
  connection is validated as always. Only `readRemoteMapping` passes the
  option. A sync that passed it would file against a placeholder.
- **The write opens the remote strictly before it writes.** `writeRemoteMapping`
  edits the `yaml` document, parses the whole file, and calls the strict
  `openRemote` on the result. A choice that leaves the remote unable to open
  is refused and the file is not written. Every issue type and every status of
  the board must have an entry. `openRemote` does not check the types, so the
  writer does.
- **The write keeps the shape of an entry that exists.** `{ remote: Done,
  closed: true }` keeps `closed`, and a plain name stays a plain name. A new
  status entry gets `closed` from the `terminal` flag of the board status, as
  the scaffold writes it. The list of a status is written with the pushed
  state first, and an explicit `push:` is removed, because the two would say
  the same thing twice. A key for a board word that the board no longer
  declares is removed.
- **The control sits on the tracker item, and the file is keyed by the board
  item.** A person reads the tracker's list and says what each item is on the
  board. `.lpm/config.yml` stores the answer the other way round (§7c). The
  draft in `mapping.svelte.ts` is keyed like the file, and `boardTypesFor` and
  `boardStatusesFor` answer the question from the tracker side. A board type
  has one tracker type, so adding it to a tracker type moves it. A tracker
  status can mean several board statuses, because a tracker with three states
  must hold a board with five. `sharedStatuses` names each such pair, which is
  the pair that `lpm check` reports.
- **Periods map one type, and the sprints are shown, not mapped.** The block
  writes `mapping.periods.container` and keeps the carrier. A sprint is matched
  to a period by its title at push time (LP-328), so the list of sprints is
  context for the choice and not a second mapping.
- **The editor does not re-base.** A mapping change after the first sync
  changes the fingerprint (LP-370), and the next sync stops until `lpm remote
  rebase` runs. `RemoteMappingDto.linked` lets the dialog say so after the save.
  A re-base reads every twin, which can take minutes, so it is not a side
  effect of a Save button.

## 8. Open questions

Listed as open, deliberately not resolved by omission:

- **The threshold-guard memory is unsettled.** The epic's risk stands: does
  `--yes` need to be remembered *per remote per operation kind* (create once,
  close once), or is one consent per remote enough? The current implementation
  remembers only the first-write consent and re-asks the threshold each time.
  If the guard annoys people into turning it off wholesale, the memory shape is
  the first thing to revisit.
- **The link store is a single file, last-writer-wins.** Two syncs can race on
  it (CI plus a laptop), and the answer is git as the backstop, not a lockfile
  in the per-remote folder. The store's API is deliberately free of the
  single-file assumption so a per-document split under `links/` remains an
  internal change if the one file proves conflict-prone in practice.
- **The lifecycle `unverified` cells.** `docs/remote-capabilities.md` marks a
  set of per-platform behaviours — the real status code after a
  `deleteIssue`, Linear's query behaviour for trashed/archived issues, private
  teams — as `unverified`: the spec is silent or the behaviour is only
  observable with a live account, which the research environment did not have.
  Automatic `on_delete: delete` is gated behind LP-364's bulk reachability
  probe precisely because these cells are unresolved.
- **The transport contract's optional methods.** `link`, `unlink`, `comment`,
  `editComment` and `deleteComment` are optional on the transport `Connector`
  because their wire shape is not yet defined for every provider. A provider
  that omits one gets a skip-with-reason, not a pretend-write — but that is a
  gap to close, not a settled design.
- **Rung 1 never lights up for attributes.** The capability table declares no
  native attribute fields and the providers shipped so far have none; a
  provider with native fields (Jira) will add a capability cell before
  attributes are ever reported `native`. Until then the ladder reports
  attributes a rung lower than the platform might deserve.
- **Push-side conflict detection is deferred.** `planPush` diffs a document
  against its base and pushes what changed locally — it never consults the
  remote for a field it is about to push. Only the pull planner detects a
  both-sides edit. A push that overwrites a concurrent remote edit is the known
  consequence, and closing it is later work, not this document's.

## 9. Deliberately out of scope

`lpm remote` mirrors a tracker; it does not replace one, and it does not grow a
server. No webhooks, no daemon watching the remote, and no federation of two
boards. The remote is a *mirror*: one remote per board declaration, one
direction per run, and the board is the source of truth. Anything that would
make the mirror think it is the original is out.

What the layer deliberately does **not** do, each the subject of its own story
rather than a decision made here: reshaping logic (the planners in
`plan.ts` decide *what* changed and *in what order* — no provider, and no file
outside `src/shared/plans/`, may re-derive it); silent conflict resolution (a
conflict is reported, and the policy story resolves it, never the merge); and
inventing remote state (a link is only written for a create that actually
landed, a cursor only advances on a clean pull). The principle is the one the
rest of the codebase is arranged around: one engine, one set of rules, and a
front end — remote included — is a thin caller over them.
