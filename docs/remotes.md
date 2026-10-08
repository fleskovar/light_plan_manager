# Remotes: mirroring a board onto a real tracker

The user-facing guide to `lpm remote` — what a remote is, which files it
touches, how each provider is configured, what has to be mapped, where the
credentials live, how people and sprints cross the wire, and what happens when
the board's shape is richer than the platform's.

**In the web UI this is experimental.** Every tracker surface of `lpm ui` —
the Sync tab's tracker panel, its dialogs, the drift badges, the per-document
Push and Pull — needs `lpm ui --experimental`; without it the server does not
serve the remote routes and the Sync tab offers git sharing only
([`docs/git-sync.md`](git-sync.md)). The `lpm remote` commands below work
either way.

Three companion pages go deeper on one thing each, and this page links to them
rather than repeating them:

- [`docs/remote-sync.md`](remote-sync.md) — the design record: *why* there is a
  link store, a base snapshot and a degradation ladder, and which alternatives
  were rejected.
- [`docs/remote-capabilities.md`](remote-capabilities.md) — the per-platform
  capability matrix, verified against each vendor's own machine specification,
  plus the deletion/archive/move semantics.
- `docs/remote-<provider>.md` — one setup page per provider
  ([github](remote-github.md), [jira](remote-jira.md),
  [linear](remote-linear.md), [jsonfile](remote-jsonfile.md)) with the exact
  token, the permission list to send an administrator, and that platform's
  failure modes.

A board can instead be **shared through its own git repository**: `lpm git`,
documented in [`docs/git-sync.md`](git-sync.md). The two are exclusive. A board
syncs through git or mirrors onto trackers, never both, because git replicates
the whole `.lpm` folder and so cannot leave some documents to a tracker. While
`git_sync:` is in the config, `lpm remote add` and `connect` refuse, and `git`
is never a tracker remote's name.

Switching between the two loses nothing. `lpm git setup --turn-off-remotes`
turns the trackers **off** rather than removing them: each declaration moves to
`remotes_off:` in `config.yml`, and its links, mapping and credentials stay where
they are. `lpm git off --turn-on-remotes` swaps back, and `lpm remote off
<name>` / `lpm remote on <name>` do the same for one remote on their own. A
remote that is turned back on carries on from its last sync. See
[Swapping a tracker for git, and back](git-sync.md#swapping-a-tracker-for-git-and-back).

---

## 0. Quick start

From no board to a synced tracker, in two commands:

```bash
lpm init --template scrum        # a board, with sprints and a roster

lpm remote connect               # asks which tracker, where it is, and for the credential
lpm remote push --all            # files the plan; the first write asks once
```

`lpm remote connect` has **no required arguments**. It asks which tracker, then
for whatever that provider needs to find your project, then for the credential —
and then declares the remote, drafts the whole mapping, checks the project is
reachable and corrects the mapping against the live project:

```
Which tracker?
  1) github (default)
     --repo <repo> [--base_url <base_url>]
  2) jira
     --site <site> --project <project> [--board <board>] [--tls_verify]
  3) jsonfile
     [--file <file>]
  4) linear
     --team <team> [--base_url <base_url>]

Choose 1-4: 2

  site (https://acme.atlassian.net): acme.atlassian.net
  project (the project key, e.g. PAY): PAY
  email: you@acme.com
  token: ****************
```

Only the keys a provider genuinely needs are asked for; the optional ones in
brackets stay flags.

**Or from the web UI.** `lpm ui --experimental` → the drawer's **Sync** tab →
**Connect a remote…** asks the same questions in one form: the tracker, the fields its
provider declares (with the same worked examples), and the credential, masked
unless it is no secret to look at. It declares the remote, stores the
credential in `.lpm/credentials.json`, and — when nothing is missing — runs
**Test connection** straight away, which is `lpm remote setup`'s conversation
with the tracker: the same checks, the same corrections, and what it cannot
decide offered as a choice. The form is drawn from what each provider
declares, so a new provider appears in it with nothing else to change.

Every one of those questions is also a flag, so a run that passes them all asks
nothing and works in a script:

```bash
lpm remote connect jira --site https://acme.atlassian.net --project PAY
```

Underneath it is three commands that remain for a CI job or an agent, which have
nobody to ask: `lpm remote add` (declare), `lpm remote login` (credential),
`lpm remote setup` (check and correct against the live remote).

Then file the plan a piece at a time, or all at once:

```bash
lpm remote push LP-12      # this document. It asks whether to file what is inside it
lpm remote push --all      # everything this remote mirrors — which is everything that changed
lpm remote pull            # refresh every mirrored document, and bring in anything new
lpm remote pull PAY-31     # or import one remote issue by its key
lpm remote ledger          # which remote holds each document, and what it is called there
```

**A push writes only what changed.** Every mirrored document carries a snapshot
of its fields as they stood when the two sides last agreed (`base`, with the
body as a hash), and a push compares against it: a document that still matches
produces no operation at all. So `--all` is not "re-file the board", it is "file
everything that has moved since last time", and the report says which it was:

```
  5 mirrored · 1 changed · 4 unchanged

  created       0
  updated       1
```

You never type the remote's name in any of those: a document that already has a
twin is pushed to the remote that holds it, and a board with one remote has
nothing to choose between. `--remote <name>` says so explicitly when it matters,
and the name may lead instead if you prefer — `lpm remote jira push LP-12`.

**A document is mirrored by one remote at a time.** Its status and its fields
have one upstream, so a document another remote already holds is never given a
second twin: a targeted push refuses and names the holder, a whole-board push
reports it as skipped. `lpm remote ledger` is the record, read from the link
stores themselves. To move a document between trackers, `lpm remote decouple
<id>` first.

You do not write a mapping. `lpm remote connect` drafts the whole thing — every
board type, every status, every attribute — from this board's own config and
what the provider can hold, using **the platform's conventional names** where
the words are the platform's to give: Jira's `Epic / Story / Task / Bug /
Sub-task` and `To Do → In Progress → Done`, a Linear team's `Backlog / Todo /
In Progress / In Review / Done`. On a project created from the platform's own
template that draft is already right.

The rest of `connect` is what makes the convention safe. It asks the remote what
its words *actually* are and reconciles: a word the project spells differently is
corrected in `config.yml`, and a word the project does not have at all is asked
about, with the remote's own names as the options. (`lpm remote setup` is the
same conversation on its own, for a remote that was declared some other way, and
`--dry-run` there writes nothing at all.)

So the work left to you is **the credential, and nothing else** on a project
that uses its platform's own words — and, on one that does not, one answer per
word the platform has no equivalent of. Customising the mapping by hand is for
what the defaults cannot cover; the rest of this page is that, plus what happens
underneath.

| Command | What it needs from you |
| --- | --- |
| `lpm remote connect` | nothing on the command line — it asks which tracker, where it is, and for the credential |
| `lpm remote push [<id>...\|--all]` | nothing — the ledger knows where each document goes, and only what changed is written |
| `lpm remote pull [<key>...]` | nothing; `--parent <id>` for an imported issue with nowhere to go |
| `lpm remote ledger` | nothing. It reports where everything is filed |
| `lpm remote sync` | nothing. The first write confirms once |

The primitives `connect` is made of, for a script with nobody to ask:

| Command | What it needs from you |
| --- | --- |
| `lpm remote add <name> --provider <p> …` | where the tracker is (`--repo`, `--site` + `--project`, `--team`) |
| `lpm remote login <name>` | the credential. It asks for each key the provider needs; a script pipes one in instead |
| `lpm remote setup <name>` | nothing, unless it reports a word it could not match |

---

## 1. What a remote is

A remote is a **mirror**. The `.lpm` board in your repository stays the source
of truth; the remote is a reflection of it in a tool the rest of the team
already has. You push the board out and pull other people's edits back, one
direction per run.

The git analogy is the right mental model and it breaks down in one place worth
knowing before the first sync. Git syncs files, and when two sides disagree it
hands you both versions plus a merge base you can open in an editor. A remote
syncs *issues*: the platform renumbers them, rewrites their markdown, reorders
their labels and may refuse half a write — and there is no merge base you can
inspect. The only way light-plan can tell your edit from theirs is the snapshot
it recorded the last time the two sides agreed. Everything below follows from
that: a link store, a base snapshot per document, a ladder of carriers for
fields the platform cannot hold, and a confirmation on the first write.

Four providers ship today:

| Provider | What it mirrors onto | Credential |
| --- | --- | --- |
| `github` | GitHub Issues (+ Projects v2) | fine-grained PAT |
| `jira` | Jira Cloud project | Atlassian API token (+ account email) |
| `linear` | one Linear team | personal API key |
| `jsonfile` | a local JSON file | none |

`jsonfile` is the demo and test target: no account, no token, no server. Use it
to run a whole push/pull cycle before pointing anything at a real backlog.

Two rules the layer will not bend on. **A remote never mirrors work another
remote already mirrors** — overlapping `scope:` is refused, because a document
filed in two trackers is closed twice and edited from two directions, and
neither side can see the other to sort it out. And **the board is the original**:
there are no webhooks, no daemon, and no federation of two boards.

---

## 2. The files

### 2.1 `.lpm/config.yml` — the declaration

Everything about a remote's *intent* lives in one block, written by
`lpm remote connect` (or `lpm remote add`) and edited by hand afterwards:

```yaml
remotes:
  upstream:                 # the remote's name; lower_snake_case
    provider: github
    scope: LP-10            # optional: mirror only this subtree
    direction: both         # both (default) | push | pull
    on_delete: unlink       # unlink (default) | close | delete | restore | manual
    conflict: manual        # manual | local | remote     (required)
    encoding: block         # block (default) | comment
    comments: push          # push (default) | both
    write_threshold: 25     # optional; a bigger plan stops and needs --yes
    bulk_guard: 0.5         # optional; see §8
    fields:                 # optional per-field conflict overrides
      status: { owner: remote }
    connection: { … }       # provider-specific: where and how
    mapping:     { … }      # provider-specific: board vocabulary → remote's
```

`provider`, the two policies and the frame keys are validated by **core**, which
carries `connection` and `mapping` through as opaque records. Their contents are
validated by **the provider's own schema**, when the remote is opened — so a
missing `repo` or a malformed `site` is reported against its key path, not as a
zod dump.

### 2.2 `.lpm/remotes/<name>/` — the state

One folder per remote, holding everything that is a fact about *this mirror*
rather than about a document. Commit it: a teammate who pulls your branch
inherits the correspondence and does not re-file the board.

| File | What it is | Written by |
| --- | --- | --- |
| `links.json` | **The link store.** One entry per linked document: the remote id, its human key and URL, the remote revision, the base snapshot, and the remote parent it was filed under. Also the cursor `--changed` reads, the tombstones from `decouple`, and the one-time first-write consent. | every push/pull |
| `log.jsonl` | **The audit log.** One append-only line per *applied* sync: when, who drove it, the counts, each failure's reason, secrets redacted. Read it with `lpm remote log`. A dry run is never logged. | every applied sync |
| `capabilities.json` | Cache of the probed capability cells, so a dry run does not re-ask the platform what it can hold. | first probe |
| `mapping.json` | Fingerprint of the mapping the last sync ran under, so a mapping change can be detected and `lpm remote rebase` offered. | every sync |
| `resolutions.json` | Conflict decisions recorded by `lpm remote resolve`, applied by the next sync. | `resolve` |
| `github.json` | GitHub only: cached Projects v2 node ids for the project, its fields and their options. | the sync |
| `tracker.json` | `jsonfile` only: **the tracker itself.** The default path is `.lpm/remotes/<name>/tracker.json`. | the sync |

**The tracker file does not exist until the first sync creates it.** A missing
file is an empty tracker, exactly as an empty repository is. Connecting writes
the declaration and nothing else — it creates no remote — so going looking for
`tracker.json` straight after `lpm remote connect` finds nothing. That is by
design, not a failure; `lpm remote push` creates the file and its directory.

### 2.3 `.lpm/credentials.json` — the secrets

Written by `lpm remote login`, owner-only, and **git-ignored** by the
`.lpm/.gitignore` that `lpm init` writes (together with `remotes/*/credentials*`).
Nothing else in `.lpm` holds a secret, and a literal secret in `config.yml` is
refused rather than warned about.

### 2.4 What the sync writes into the board itself

- **`_issue.md`** — only on a *pull*. A push never rewrites a document. (If
  `git diff` shows `_issue.md` changes after a push, that is a bug worth
  reporting.)
- **`_comments.md`** — comment appends on pull, when `comments: both`.
- Nothing else. There is no `remote_id:` frontmatter field, deliberately: it
  would be a breaking reserved field, it could not carry two remotes, and it has
  nowhere to keep the cursor and the base snapshot. The link store is the one
  place the correspondence lives.

---

## 3. The lifecycle of a mirror

```bash
# 1. connect it — declares the remote, drafts the mapping, takes the credential,
#    checks the live remote and corrects the mapping to match
lpm remote connect github --repo acme/payments --scope LP-10

# 2. read the plan before anything is written
lpm remote push --dry-run

# 3. land it, whole or a piece at a time. The first write confirms once
lpm remote push LP-12              # this document (it asks about what is inside)
lpm remote push --all              # everything this remote mirrors

# 4. bring in what only exists upstream
lpm remote pull acme/payments#418 --parent LP-10

# 5. ask whether the two sides agree, and where everything is
lpm remote status                  # exit 0 in sync, 1 drifted, 2 conflicted
lpm remote ledger                  # which remote holds each document

# 6. from then on
lpm remote sync                    # pull, then push — the pull --rebase order
lpm remote log                     # "who filed these?"
```

Step 1 is three commands underneath, and they are still there for a script or a
CI job with nobody to answer a question: `lpm remote add` (declare and draft),
`lpm remote login` (the credential), `lpm remote setup` (check and correct
against the live remote — exit 1 while anything is unanswered). `connect` runs
exactly those, so anything they can do it can do, and every question it asks can
be a flag instead.

**The push creates the vocabulary it needs, and nothing else.** A GitHub
repository only applies labels it already defines and a Projects v2 board only
sets a field somebody created; both are implied by the mapping, so the push
makes them and reports each one. A dry run says what it would create.

**A sprint is not vocabulary — it is a document on your board**, so a push of
work never files the timeline. An issue scheduled into a sprint the tracker has
not got is filed *unscheduled*, and the assignment is written by the push that
files the sprint. See [Filing the timeline](#filing-the-timeline).

### Filing part of a plan

`lpm remote push <id>` files the documents you name. Three things it does for
you, none of which need a flag:

- **it knows which remote.** A document that already has a twin goes to the
  remote holding it; a board with one remote has nothing to choose. Otherwise
  `--remote <name>` says, or you are asked.
- **it asks about the work inside.** *How much of LP-3 should go?* — all of it,
  one level, or just the document. `--recursive` and `--children` answer that
  for a script, and with no terminal only the documents named are filed. The
  question is only ever asked about work the remote has not got: a container
  whose contents are all mirrored has nothing to ask about.
- **it says what it cannot carry yet.** A parent that is not upstream means the
  document files at the top level; a dependency whose other end is missing is
  left off. Both are printed before the plan runs.

Neither of those last two is permanent. Push the parent later and the document
moves under it in that same run; push the other end of a dependency and the edge
is written. So a plan can go up in whatever order the team actually wants to
talk about it.

### Filing the timeline

Periods are pushed like any other document:

```bash
lpm remote push TL-3       # file this sprint on the remote
lpm remote push --all      # everything, timeline included
```

Filing a sprint also repairs the work already filed into it: every mirrored
issue scheduled in that period joins the run, and the assignment it could not
carry when it was filed is written now.

**Pushing work never files a sprint**, and that is the point. The board's plan
and the board's calendar move at different speeds — stories are ready to go up
today, the sprint they sit in may be renamed twice before anybody cares — so
requiring the timeline first made the calendar a precondition for filing a
single story. One sprint name Jira would not take (it caps them at 30
characters) once stopped a push of forty issues that had nothing to do with it.

So an issue whose sprint has no twin is filed **unscheduled**, and the tool
remembers that the field was not written rather than pretending it was. The
next push — the one that files the sprint, or any later one — writes the
assignment. Nothing is lost and nothing has to be done in order.

`lpm remote setup` lists the periods that are not filed, separately from the
vocabulary the next push will create for itself.

### Asking how the mirror is doing

Two questions, and they cost very different amounts.

`lpm remote status` begins by saying **what the remote owns**, because a count
with no denominator is not a metric: "433 ahead" means one thing for a mirror of a
single epic and quite another for a mirror of the whole board. The `scope` line
names the subtree the remote owns (or `whole board`) and how much of it has a
twin, so every number below it can be read. If that line says `whole board` and
you expected one epic, the remote has no `scope:` — a selective
`lpm remote push <id>` is a *selection*, which narrows one run and never what the
remote owns. (The Sync tab does not repeat the line; the Connection panel states
the scope when you open it.)

Be careful adding a `scope:` to a remote that already has twins outside it: the
next sync reads those as having left the mirror and writes `out_of_scope`
tombstones for them, which stops them syncing. `lpm remote sync <name> --dry-run`
shows exactly that before anything is written.

**What has drifted?** `lpm remote status` reads the tracker in **one paginated
listing** — a handful of requests whatever the size of the mirror — and compares
every mirrored document with its twin. `--local` skips the remote half
altogether: no request, no credential, an answer straight away, and it still
reports the twins, everything never pushed, and everything edited here since the
last sync. What it cannot tell you is what changed *upstream*, and it says so in
place of the `behind`, `conflicted` and `incoming` columns. `--verbose` names the
fields either way, and the report says how many remote issues it read, so "in
sync" is a claim you can weigh.

The report leads with **what a sync would actually do**. `to push` is the local
edits the next sync will write; `blocked` beside it is the part of `ahead` the
remote **cannot** accept — an assignee that is a generic pool, or a person with no
account on the tracker. Those are genuinely ahead and always will be: the push
tries, the tracker refuses the field, and the next push tries again. Counting them
with the rest is what makes a mirror look catastrophically behind when a handful
of documents need pushing, so they are named apart with the reason. Syncing does
not reduce them; the board or the mapping has to change.

The three counts are named after what happens next, not after where the board
sits, and they are the three-way merge's own answers: `to push` is a document the
board changed and the tracker did not, `to pull` is one the tracker changed and
the board did not, and `conflicts` is one where both changed the same field, which
nothing but a person can settle. A document that moved both ways appears in both,
because it has work to do in both.

An issue that exists in the tracker with no document here is a `to pull` too — a
pull *creates* it rather than updating it. The count folds it in; the changes
table keeps it as its own row, because the action differs.

Below the counts, the **changes table** lists every document a sync would touch:
which one, which way, and which fields say so, with the two sides' values. The
counts answer "how much"; the table answers "which, and why", which is the
question anybody has the moment a count is not zero. In `lpm ui` the tracker is
read as soon as a view opens, so the tab is already current; at the terminal
`lpm remote status --verbose` prints the same field detail.

Because it reads the whole project rather than only the documents it already
knows, it reports one thing a per-twin comparison never could: **`incoming`** —
issues in the tracker with no document on this board yet. Somebody adding a story
to a mirrored epic upstream shows up here, with its key, its title and the local
document a pull would file it under. Adopt it with `lpm remote pull <name> <key>`,
or all of them with `lpm remote pull <name>`.

`--changed` narrows the listing to what moved since the last sync's cursor. It is
cheaper, and it can say nothing about what is *absent* — an untouched twin is
missing from it for reasons that have nothing to do with being deleted — so
`incoming` and `unreadable` stand down for it and the report says it was
incremental.

A board with nothing mirrored yet reads no tracker at all: with no twin anywhere
there is nothing for a listing to be compared against, and reporting a whole
tracker as incoming work is a true list nobody can act on. Use
`lpm remote pull` to adopt a tracker onto a fresh board.

The Sync tab of `lpm ui` works the same way and for the same reason: the local
half is on screen as soon as the board opens, and **Check the tracker** is the
button that goes and asks — it needs a credential and can fail, which is what
keeps it off the path that runs by itself. While it runs it says how many twins
it is comparing and how long it has been going, it can be stopped, and a failure
stays on screen with what the tracker said. Nothing else in the tab waits for it.
The **incoming** count opens a list of what arrived, each row naming where a pull
would file it, with **Pull** beside it and **Pull all** above.

### Before a push writes: can this land?

A board can be perfectly valid and still file forty issues wrongly. The person
an issue is assigned to may have no account on the tracker, or one that went
stale when they left the project; the sprint it is scheduled into may never
have been filed. Nothing about that is visible until the issues themselves
arrive, unassigned or unscheduled.

So every push in `lpm ui` asks first. The check costs two requests whatever the
size of the push — who this project can assign work to, and which periods it
holds — and reports what will not land the way the board says, one row per
thing rather than one per issue:

| It found | What it means |
| --- | --- |
| A person with no account on file | There is nothing to assign the work to upstream. |
| An account the project does not have | A stale id, somebody who left, or one this credential cannot see. |
| A pool | A tracker assigns to accounts; a pool is a statement about your team. |
| A period with no twin | There is nothing to schedule into. |
| An assignee or period the **board** has lost | The board contradicts itself. |

Each row offers the same two answers, and the dialog offers the third:

- **Leave it** — the push goes ahead and the field is left blank. That is what
  the engine does anyway, and it heals: the field is recorded as unset, so a
  later push writes it the moment the far side exists.
- **Fix it** — for a person, the remote account is written onto their roster
  document, so every push after this one assigns them too; the check offers the
  people it matched by address or by name, and offers nothing when nothing
  matched, because a wrong account is worse than none. For a period, the period
  is filed in the same run. For an assignee the board has lost, it is cleared.
- **Cancel the push** — nothing is written on either side.

The last row in the table is the one case that **blocks**: an assignee or a
period the board itself no longer has cannot be made right by pushing, so the
push waits until it is answered. Everything else is a degradation you may
accept with one click.

Listing assignable people needs the credential to be allowed to browse users
(on Jira, the global *Browse users and groups* permission). Where it is not, the
check says so and reports what it can work out from the board alone rather than
implying everything upstream checked out.

### Seeing what the mirror is missing

Filing a piece at a time leaves a question the board itself can answer: *is
what the tracker holds a coherent piece of the plan?* Push a feature on its own
and the tracker has a feature with no stories in it, no epic above it, no
sprint on it, and a dependency whose other end is nowhere. Everything heals
when the rest arrives — but only if somebody knows what the rest is.

The **Coverage** panel in the Sync tab of `lpm ui` is that list. It reads the
board and the link store, asks the tracker nothing, and reports every document
the remote does **not** hold that something it *does* hold points at, grouped
by what each one costs:

| Group | What it means |
| --- | --- |
| Containers above mirrored work | Their contents sit at the tracker's root; filing them moves the work under them. |
| Work inside mirrored containers | The container is filed and looks empty. |
| Periods mirrored work is scheduled into | Those issues were filed unscheduled; filing the period writes every assignment waiting on it. |
| Work mirrored issues wait on | A dependency needs both ends, so the edge was dropped. |
| Work waiting on mirrored issues | The tracker cannot show what is queued behind what it holds. |

Every row names the mirrored documents behind it, so "why is this in the list?"
is answered on the row. Tick what you want and **Push selected** files exactly
those and nothing else — a parent ticked beside its children is created first
and the children are filed under it in the same run. The side panel shows the
same thing for one document (*missing around it*), and the canvas menu offers
it for a selection.

Two things are deliberately reported rather than offered: a document
**decoupled** from this remote, and one **outside its scope**. Both were
decided, and a list that offered to undo a decision would be a worse list. For
the same reason the containers *above* a scoped remote's root are not reported
at all — nobody ever asked it to file them.

From a terminal, the nearest equivalents are `lpm remote status` (which drift
has appeared in what is mirrored, and what has never been pushed at all) and
the push itself, which prints the parent and the dependency ends it could not
carry.

### Bringing work back

`lpm remote pull` with nothing after it refreshes **every document the ledger
holds** and brings in anything new the remote has. That is the complete
listing, and it is the only one a deletion can be detected from. `--changed`
asks the remote for what has changed since the last pull instead — cheaper on a
large remote, and partial by construction, so it can never report a deletion.

`lpm remote pull <key>` fetches the issues you name — by remote key
(`PAY-31`, `acme/payments#418`) or by remote id — and creates a document for
anything the board does not have. Like `--changed` it reconciles no existence:
nothing is closed, deleted or unlinked for being absent from a listing that
never ran, and the pull cursor does not move.

A tracker keeps a flat list and a board keeps a tree, so an imported issue may
have nowhere to go; `--parent <id>` says where it lands. An issue whose remote
parent is already mirrored needs no help — it is filed under that twin.

### Where everything lives

`lpm remote ledger` reads every remote's link store and prints which remote
holds each document and what it is called there; `--unlinked` also lists what is
not mirrored yet. **A document is mirrored by one remote at a time** — the same
rule as two remotes never mirroring the same work, enforced per document rather
than per scope — so a second twin is never created. A targeted push refuses and
names the holder; a whole-board push reports it as skipped and carries on.
`lpm remote decouple <id>` releases a document so another remote may take it.

`lpm remote setup` is the one to re-run whenever anything about the pairing
changes — a new credential, a renamed status upstream, a board that grew a
column. It is read-only on the remote and idempotent, so running it again costs
two requests and tells you where you stand.

Commands you reach for later: `resolve <id> --local|--remote` records how a
conflict is settled (the next sync applies it); `link <name> <id> <key>` adopts
an existing remote issue into a document; `unlink` drops a link so the document
may be re-filed; `decouple` drops it and records "never re-file"; `relink`
undoes that; and `rebase` re-reads both sides after you change the mapping.
`lpm remote --help` is the full reference, including each provider's connection
flags.

**Read the dry run before the first `--yes`.** The classic first-week failure is
a scope typo: `--scope LP-1` mirrors the whole board instead of one feature.
The write threshold (25 operations by default) is what stops that from becoming
four hundred filed issues, and the dry run is what tells you which it was.

---

## 4. The mapping: what needs one, and what does not

`connection` says *where* the tracker is. `mapping` renames the board's own
vocabulary into the platform's. You never say *where* a value lands — whether a
type rides a native issue-type field or a label is a property of the platform,
and the provider already knows it.

**Connecting drafts the mapping for you, and you should not need to edit it.** It reads the board's types, statuses and attributes and matches them
against what the provider can hold. Where the words are the board's own, it uses
them. Where the words are the *platform's* — a Jira issue type, a Linear
workflow state — it uses **that platform's conventional names**, stated by the
provider itself (`Provider.standardVocabulary`):

| Board word | Jira | Linear |
| --- | --- | --- |
| a level above the work | `Epic` | *(no types — the board's own word, on a label)* |
| the work level | `Story` / `Bug` by name, else `Task` | *as above* |
| a level inside an atomic one | `Sub-task` | *as above* |
| the first column | `To Do` | `Backlog` |
| a later unstarted column | `To Do` | `Todo` |
| an `active` column | `In Progress` | `In Progress` / `In Review` |
| the `terminal` column | `Done` | `Done` |

The type rules read the board's *own* `atomic` flag rather than raw depth,
because that is where a board says which level is one job: the level inside an
atomic one is a checklist and becomes a real sub-task, and the atomic level
itself is the work. So `epic › story(atomic) › task` and
`… › user_story(atomic) › sub_task` both land correctly on Jira's three levels,
and a one-level board's single type becomes a `Task` rather than a parentless
sub-task.

**A convention is a starting point, not a claim about your project.** Two things
keep it honest, and neither needs you to do anything:

- `lpm remote setup` asks the remote for its real vocabulary and rewrites the
  draft — a project that spells it `Subtask` gets `Subtask`, and a word the
  project does not have at all is reported with the list of the ones it does.
- the push **preflight** validates every mapped name against the live project
  before a single write, so a name that is wrong and uncorrected refuses the
  push rather than filing anything.

A `TODO:` marker is what is left where a provider states no convention at all:
the remote refuses to open until it is answered. None of the four shipped
providers leaves one for any of the shipped board templates, and
`test/remote-vocabulary.test.ts` asserts that over the whole cross-product.

### 4.1 The blocks, and which provider accepts which

| Block | Answers | github | jira | linear | jsonfile |
| --- | --- | :-: | :-: | :-: | :-: |
| `types` | which remote type each board issue type becomes | ✓ | ✓ | ✓ | ✓ |
| `statuses` | which remote state each board status means, and which closes | ✓ | ✓ | ✓ | ✓ |
| `attributes` | where each board attribute's value travels | ✓ | ✓ | ✓ | ✓ |
| `accounts` | which resource attribute holds the remote account | ✓ | ✓ | ✓ | — |
| `periods` | which period level maps to the remote's container | ✓ | ✓ | ✓ | — |
| `project`, `fields`, `status_precedence` | the Projects v2 surface | ✓ | — | — | — |
| `transitions`, `transition_fields` | how a status change walks the workflow | — | ✓ | — | — |
| `effort` | which attribute is the native estimate | — | — | ✓ | — |

A block a provider does not declare is **stripped** on the way in, so writing
one states a mapping that can never fire. The scaffold no longer drafts one,
and `lpm check` reports any that is already in the file:

```
warn  remotes.demo.mapping.periods: provider "jsonfile" has no "periods"
      mapping, so this block does nothing (it accepts: types, statuses, attributes)
```

### 4.2 Types and statuses

Both name their counterpart under `remote:`, and both accept the shorthand:

```yaml
types:
  user_story: Story                 # same as { remote: Story }
statuses:
  backlog: "To Do"
  done: { remote: [Done, "Won't Fix", Duplicate], push: Done, closed: true }
```

They differ in cardinality, because the world does. **A type is one name** —
there is one issuetype to file under, and a pull reading that name knows which
board type it is. **A status may name several**, because a remote often has more
than one word for the same thing; all of them pull back as the board's `done`,
and `push:` says which one a push writes.

`closed: true` is what closes the remote issue, and it must agree with the
board status's own `terminal` flag — `lpm check` warns when they disagree,
because a push would otherwise close a non-end column or leave an end column
open. **Every board status must be mapped**: an unmapped one cannot be mirrored
in either direction, so the remote refuses to open rather than dropping it.

### 4.3 Attributes

An attribute maps to whatever carrier the platform offers, named by the
mapping's value:

```yaml
attributes:
  story_points: customfield_10016    # Jira: the instance's own field id
  priority: Priority                 # elsewhere: a label prefix → "Priority:critical"
```

On a platform with no typed field registry the value rides a **label prefix** —
`story_points: Points` writes the label `Points:3`. A `text` attribute is the
one type a label cannot carry faithfully, so the scaffold routes it to the
managed block instead and says so on the line it comments out. A mapping key
naming an attribute no type declares is an **error**: it would mirror nothing.

---

## 5. Credentials

**A credential never sits in the committed config.** A connection key that holds
a secret names *where* the value comes from, and resolves at sync time through a
chain, most specific first:

1. a `${VAR}` reference in the config, read from the environment;
2. `.lpm/credentials.json` — written by `lpm remote login <name>`, git-ignored
   and owner-only;
3. the platform's conventional environment variable.

| Provider | Secret keys | Conventional env var | `lpm remote login <name>` asks for |
| --- | --- | --- | --- |
| `github` | `token` | `GITHUB_TOKEN` | `token` |
| `jira` | `email`, `token` | `JIRA_EMAIL`, `JIRA_API_TOKEN` | `email` and `token`, in that order |
| `linear` | `api_key` | `LINEAR_API_KEY` | `api_key` |
| `jsonfile` | none | — | nothing — this provider needs no account |

At a terminal, `lpm remote login` **asks** for each of the provider's keys in
turn. What you type is not echoed (an email, which is no secret to look at, is),
a bare Enter keeps a value that already resolves, and every answer is written to
`.lpm/credentials.json`:

```bash
lpm remote login jira
#   email: you@acme.com
#   token: ****************
```

With no terminal — a script, a CI job — it reads one value from **stdin**
instead, so the secret never reaches shell history. `--key` says which one when
the provider has several:

```bash
echo github_pat_… | lpm remote login upstream
echo you@acme.com | lpm remote login jira --key email
```

A secret key is never a flag on `connect` or `add`, for the same reason. The web UI's
**Connection** panel writes the same file: each key shows where its value comes
from (`.lpm/credentials.json`, `$JIRA_API_TOKEN`, or not set), a typed
replacement is stored and never shown again, and a blank keeps what is stored.
No page and no response of `lpm ui` ever carries a credential back. Resolved values are
redacted wherever a run prints anything, including the audit log.

**TLS verification is on and stays on.** A corporate MITM proxy is handled by
adding its root CA to the trust store Node's `fetch` already verifies against
(`NODE_EXTRA_CA_CERTS=/path/to/root-ca.pem`, or `node --use-system-ca` on
22.19+), never by turning verification off. `connection.tls_verify: false`
exists for Jira as an explicit last resort, warns on every run, and is never
suggested by an error message before the trust-store route.

Each provider's page names the exact token to create and the minimum
permissions; `docs/remote-jira.md` also carries a copy-pasteable permission list
to send a Jira administrator.

---

## 6. Team members

A board's roster is a statement about the team: named people, and **generic
pools** (any resource type declared `generic: true` — "a jr. developer"). A
tracker has assignees and no notion of a pool. `mapping.accounts` is the join,
and it names the *resource attribute* whose value is the remote account:

```yaml
accounts: { via: github }            # the `github` attribute on each person
```

Pick the attribute whose value the platform actually accepts. On GitHub that is
the login; on Jira, `via: jira_account_id` is safer than `via: email`, because
email lookup goes through user search and fails on a privacy-restricted
instance; on Linear it is the email or an attribute holding the Linear user id.
`lpm check` refuses a `via` that names no resource attribute, or one that is not
a string.

What happens on each side:

- **push** — a person whose `via` attribute has a value becomes that remote
  account. A person with no value is pushed **unassigned** and reported once
  per person, never once per issue. A **pool** has no account anywhere, so it is
  pushed unassigned plus a `pool:` label naming it — which is what lets the pull
  put the work back in the pool.
- **pull** — an account matching a person's `via` value restores that person;
  the `pool:` label restores the pool. An account matching **nobody** is
  reported with the `lpm new person` command that would add them, and is never
  invented: a sync must not enlarge the roster.

`pool` is reserved as a label prefix for this reason — do not use it in
`mapping.attributes`.

---

## 7. Sprints and increments

Periods answer "when", and a tracker has at most one container concept — a
GitHub milestone or Projects v2 iteration, a Jira sprint, a Linear cycle.
`mapping.periods` names which *level* of the board's period hierarchy is that
container:

```yaml
periods: { container: sprint }                        # carrier defaults to milestones
periods: { container: sprint, carrier: iteration }    # GitHub Projects v2 iteration
periods: milestones                                   # shorthand: carrier only
```

The board's period hierarchy is derived from `period_hierarchy`, never declared
twice. The deepest level is the natural container — a sprint maps to a
milestone, an increment does not.

**The levels above the mapped one degrade to the managed block**, one row each.
That is the transversal case a real board actually has: a feature scheduled in
an increment, its stories in sprints. The sprint rides the native container; the
increment rides `period:increment` in the block, so it round-trips without
pretending the platform has two levels of calendar. A push against the
`jsonfile` tracker, which has no native container at all, therefore writes both:

```
| light-plan | |
| --- | --- |
| parent | 2 |
| period:increment | PI - 6 - Remote Services |
| period:sprint | Remote Implementation Sprint |
```

Three rules worth knowing before you schedule anything:

- **A remote container is matched by name.** A Linear cycle is *numbered* rather
  than named, so the convention is that the period's title is the cycle's name
  (`Cycle 12`); renaming a cycle on either side breaks the match until the other
  follows.
- **Nothing invents a period, and nothing files one behind your back.** A
  remote container matching no local period is reported with a suggestion,
  never created locally. In the other direction, a sprint is created only by a
  push that *names* the period (`lpm remote push TL-3`) or by `--all`; a push
  of work files no sprints and schedules into the ones that already exist. (A
  GitHub milestone is the exception the platform makes for itself: it is
  created on demand as an issue is scheduled into it, because a milestone is a
  field value rather than a container with its own life.)
- **A board with periods and no mapping refuses to open** — on a provider with a
  native container. Mirroring a board whose Gantt is full onto a tracker whose
  calendar is empty is a silent half-mirror, so it is an error naming the key to
  set. A provider with no native container (`jsonfile`) declares no `periods`
  key, and the schedule rides the block instead.

---

## 8. When the board does not fit the platform

This is the interesting half. The board templates under [`templates/`](../templates)
describe deeper structures than any tracker holds natively — `scrum.yml` is five
issue levels (`program › epic › feature › [user_story|bug|test|review|research] ›
sub_task`) and two period levels (`increment › sprint`); `kanban.yml` is three
and one. GitHub and Linear hold **one** native parent edge; Jira holds about
three (Epic → issue → subtask). So a board built from the shipped Scrum template
cannot be mirrored natively, and the question is what happens to the remainder.

### 8.1 The degradation ladder

The answer to "where does this field go?" is one ordered list of carriers, best
first. A field degrades **one rung at a time and never two**, so a reader can
see exactly what fidelity was paid for:

| Rung | Carrier | When |
| --- | --- | --- |
| 1 | **native** | the remote has a real place for it |
| 2 | **custom field** | the remote can be *given* one (a push creates it) |
| 3 | **label** | a low-fidelity native carrier for enums and types |
| 4 | **managed block** | a delimited region in the issue body |
| 5 | **comment** | the same block as a comment, when the body is not writable |
| 6 | **refuse** | a `required` attribute with none of the above — the sync stops |

Off the bottom is **dropped**: the same field *without* `required`, lost with a
warning rather than refused. Only attributes carry `required`, so the bottom two
rungs are theirs.

The alternative — "native or lose it" — is what a naive integration does, and it
is why they silently lose `depends_on`, hierarchy depth and half the attributes.
Encoding a field lossily but reversibly is better than losing it.

### 8.2 The managed block

Rung 4 is the workhorse. It is a delimited markdown table in the issue body that
a person can read and the next pull parses back:

```markdown
<!-- lpm:begin -->
| light-plan | |
| --- | --- |
| depends_on | #8 |
| parent | #2 |
| period:increment | PI - 6 |
<!-- lpm:end -->
```

Two properties make it safe. **The delimiters are the contract, not the
markdown** — the parser matches the comments, so the table is presentation. And
**it is idempotent**: entries and id lists are sorted, and nothing inside
carries a timestamp. A push that changes nothing produces identical bytes, which
is what stops the next pull seeing a phantom body edit. The block is also
stripped before the body is hashed into the base snapshot, for the same reason.

`encoding: comment` moves the same block into a comment, for a platform whose
issue body is not writable.

> **Known defect — LP-534.** A document whose *own prose* contains
> `<!-- lpm:begin -->` / `<!-- lpm:end -->` is corrupted on every push: the
> writer takes the first marker it finds as the start of its own region and
> overwrites the text between them. Such a document is reported `ahead` for
> ever and `lpm remote status` exits 1 whatever you do. Only a document that
> *documents the delimiters* hits this; if you have one, expect it in the drift
> report.

### 8.3 What each platform does with the overflow

| Board construct | github | jira | linear | jsonfile |
| --- | --- | --- | --- | --- |
| hierarchy | native ×1, deeper → block | native ×~3, deeper → block | native ×1, deeper → block | no parent field → block |
| issue type | native where org issue types are on, else label | native | label | native |
| status | native open/closed; richer → Projects v2 field | native, transition-mediated | native team state | native |
| `depends_on` | **no edge** → block | native link | native `blocks` relation | native array |
| `relates_to` | **no edge** → block | native link | native `related` | → block |
| attributes | org issue fields / Projects v2 / label | native, extensive | **no custom fields** → label or block | label prefixes |
| effort / priority | a field the push creates | native | native, **fixed scales** | label |
| periods | milestone, or Projects v2 iteration | sprint (filed by pushing the period) | cycle (numbered) | → block |
| assignee | native user; pool → block + `pool:` label | native user; pool → label/block | native user; pool → block | string, **not resolved** |
| comments | native | native | native | native (no author) |

The headline: **Jira is the most capable**, **Linear is the least capable for
attributes** (no custom fields at all), and **GitHub is the least capable for
edges** (no blocking or relates edge anywhere, so `depends_on` is always
encoded). Deeper-than-native hierarchy is encoded everywhere.

The table above is the platform's capability. The verdict for *your* mapping
comes from `lpm remote push --dry-run`, which runs the preflight offline and
reports every value that cannot be mapped — an unmapped type or status, an
attribute that will not coerce, an assignee with no account — and refuses the
push rather than dropping the field. The same dry run lists the vocabulary the
push would create on the remote first — the labels and Project fields the
mapping names. (The rung analysis in `src/remote/ladder.ts` is not yet printed
by any command.)

### 8.4 The other shape mismatches

- **Several board types may name one remote type, and the cost is on the way
  back.** The Scrum template's fourth level is five types (`user_story`, `bug`,
  `test`, `review`, `research`) and a tracker may have one word for all of them.
  A push is fine. A pull resolves the remote name to a board type by **depth
  first**: when the candidates sit at different levels of the hierarchy, the
  document's depth picks one. When they sit at the *same* level — exactly the
  case above — the only tiebreak is the type the link already recorded, so an
  existing document keeps its type and a **new** remote issue is reported
  `ambiguous` rather than guessed. Give each board type its own remote name if
  issues will be created upstream; where the platform has no types at all
  (Linear) they become distinct labels and the distinction survives for free.
- **Which levels nest natively, and which end of the board they are spent on.**
  A tracker holds a fixed number of parent levels, and there are two ways to
  spend them on a deeper board. GitHub's sub-issue edge is type-blind — any
  issue under any issue — so the levels are spent at the **root**: a
  programme's epics nest, the work below rides the block. Jira's hierarchy is
  defined from the bottom up (`Subtask` < standard < `Epic`, and only a standard
  issue may sit under an Epic), so its levels are spent at the **leaf**: the
  work items nest under their container and the containers above ride the
  block. Each provider declares which (`hierarchyAnchor`), and getting it wrong
  is not a matter of taste — anchored at the root, every native edge a
  team-managed Jira board writes is one Jira refuses, and the tracker shows a
  flat list. `mapping.hierarchy` overrides it per remote where a provider
  supports the key.
- **A status that cannot be reached.** On Jira a status change is a *workflow
  transition*: a push to `done` may have no single hop from where the issue
  stands. That is a refusal naming the reachable statuses, not a silent skip.
  `mapping.transitions.multi_hop: true` opts in to walking the workflow, and is
  off by default because transitions fire automations and stamp resolutions.
- **A scale that will not take the value.** Linear's `estimate` follows the
  team's configured scale and `priority` is a fixed 0–4; a value off-scale is
  reported with the allowed values at preflight, never silently rounded.
- **Deleting locally does not delete remotely.** When a linked document is
  removed or moves out of `scope:`, `on_delete` decides: `unlink` (the default)
  leaves the twin alone and drops the link, `close` closes it with a comment
  saying why, `delete` removes it — only where the platform allows, and with
  confirmation **every** run, because "I meant to sync" is not "I meant to
  delete". GitHub cannot hard-delete over REST, so `delete` there is a close.
- **A wave of missing twins is treated as an outage, not a mass deletion.**
  Infrastructure failures arrive all at once and real deletions arrive a few at
  a time, so a run where more than `bulk_guard` (0.5 by default) of the linked
  twins is missing is reported unreachable and writes nothing. That question is
  only asked of a **complete** listing: a targeted pull, or `--changed`, holds a
  listing an untouched twin was never going to appear in, so neither one
  concludes anything about absence.

### 8.5 What is *not* degraded, by design

`related_files` is text and is never resolved. Comments are not board state and
are read on demand. A **flag** is not part of the edit protocol — it says work
has stopped *now* — and neither is a view. None of these travel through a
mapping, and none of them can make a remote refuse to open.

---

## 9. Provider quick reference

Each of these is the short version; the linked page is the one to read before a
first sync.

### 9.1 GitHub — [`docs/remote-github.md`](remote-github.md)

```bash
lpm remote connect github --repo acme/payments [--base_url …] [--name upstream]
```

- **Credential**: a fine-grained PAT scoped to the one repository, with
  **Issues: read and write** and **Metadata: read-only** — nothing else.
  Optional: *Projects* (only with `mapping.project`), *Issue types* / *Issue
  fields* (org-level, only if the mapping uses them). `base_url` is for GitHub
  Enterprise.
- **Mapping specifics**: `project` + `fields` + `status_precedence` open the
  Projects v2 surface (a status field, an iteration field). Attributes ride
  labels unless you point them at org issue fields.
- **The push creates first**: the missing labels (a GitHub issue can only carry
  labels the repository already defines), the named Projects v2 fields and
  single-select options, and a milestone on demand when it schedules into one.
- **Watch for**: no dependency or relates edge at all; one native parent level;
  `on_delete: delete` is a close; pull requests come back in the issues listing
  and are dropped, never turned into stories.

### 9.2 Jira Cloud — [`docs/remote-jira.md`](remote-jira.md)

```bash
lpm remote connect jira --site https://acme.atlassian.net \
  --project PAY [--board 12] [--tls_verify]
```

- **Credential**: an Atlassian API token plus the **account email** (Basic
  auth). What the token may do is decided by the *project permissions* granted
  to that account, not by a scope list — the setup page carries the list to send
  an administrator. Needs the `jira.js` client, which a standard install leaves
  out: `npm install -g jira.js` beside a global light-plan (Node 22+).
- **Mapping specifics**: `attributes` names the instance's own custom-field
  **ids** (`customfield_10016`). `transitions.multi_hop` and
  `transition_fields` control how a status change walks the workflow.
  `--board` (an Agile board id) is what sprint mapping needs, because a Jira
  sprint belongs to a board rather than a project — connecting asks Jira for the
  project's boards and fills it in, and a push refuses at preflight if it is
  still missing.
- **Sprints are filed by pushing the period** (`lpm remote push TL-3`), never
  by a push of work; an issue whose sprint is not there is filed unscheduled and
  picked up later. Custom fields are deliberately not created — that needs
  *Administer Jira* — and instead a copy-pasteable request names the field, its
  type and the issue types it must be added to.
- **Watch for**: Cloud only (Server/DC is refused with a clear message rather
  than a confusing 401); status is transition-mediated; deletion is permanent
  with no recycle bin.

### 9.3 Linear — [`docs/remote-linear.md`](remote-linear.md)

```bash
lpm remote connect linear --team ENG [--base_url …]
```

- **Credential**: a personal API key with **Read**, **Write**, **Create
  issues**, **Create comments** — *not* Admin — and scoped to the team if your
  workspace allows it. `lpm remote login linear` asks for it and stores it under
  `api_key`, this provider's own secret key; `LINEAR_API_KEY` or
  `${LINEAR_API_KEY}` work just as well.
- **Mapping specifics**: no issue types, so `types` are labels. `effort:
  { attribute: story_points }` maps to the native `estimate`.
  `periods.container` maps onto **cycles**, matched by title.
- **The push creates nothing first** on this provider today: the labels and the
  cycle the mapping names must already exist in Linear. A name that does not
  resolve is reported, not guessed.
- **Watch for**: everything is team-scoped (states, labels, cycles, the
  estimation scale); fixed priority and estimate scales; cycles are numbered, so
  a rename breaks the match. Linear is the one platform where `restore` is a
  real undo — `issueDelete` is a trash with a 30-day grace period.

### 9.4 jsonfile — [`docs/remote-jsonfile.md`](remote-jsonfile.md)

```bash
lpm remote connect jsonfile [--file <path>] [--scope LP-10] [--name demo]
```

- **Credential**: none. Nothing can leak because nothing is a secret.
- **The file**: `--file` is optional — the provider names
  `.lpm/remotes/<name>/tracker.json` from the remote's own name, because it is a
  path inside `.lpm` that this tool owns. A relative path resolves against the
  **board root**, so a sync run from a subdirectory finds the same file. The
  file is created by the first push, not by `add`.
- **Mapping specifics**: `type`, `status` and `depends_on` are all **native**
  fields — this is the one provider where rung 1 lights up — so `types` and
  `statuses` name the strings directly and the scaffold leaves no `TODO:` to
  answer. Attributes ride label prefixes. There is **no** `accounts` and **no**
  `periods` block; writing one is dead config that `lpm check` now warns about.
- **Watch for**: a whole-file rewrite per operation and no locking, so two
  processes pointed at one file race — it is a mirror target, never a shared
  tracker. And the limitation below.

> **Known defect — LP-533.** A push writes each period level as a
> `period:<type>` row in the managed block, but the jsonfile translator ignores
> periods **on the way back**, and an assignee is stored as an opaque string
> that nothing resolves against the roster. So a board mirrored here and pulled
> into a fresh checkout recovers no schedule and no assignees. Do not use this
> provider as a backup.

---

## 10. Gotchas, in the order people hit them

| Symptom | Cause | What to do |
| --- | --- | --- |
| `tracker.json` is missing right after connecting | Expected: connecting writes the declaration, not the tracker. A missing file is an empty tracker. | `lpm remote push` creates it. |
| The remote refuses to open, naming `TODO:` lines | A provider that states no conventional vocabulary left the decision open. None of the shipped four does this for a shipped template. | Answer each one in `.lpm/config.yml`. |
| `lpm remote setup` says a name is "not there" | The drafted convention is not a word this project has. | Copy one of the names it lists into `.lpm/config.yml`, then run setup again. |
| `lpm check` warns that one remote state serves two board statuses | Your board has more columns than the platform has states — the ordinary Jira case. | Nothing, unless you need remote status changes to come back for those two; then give them distinct remote states. |
| The remote refuses to open: "not every board status is mapped" | A status has no remote counterpart, so it could be mirrored in neither direction. | Add it to `mapping.statuses`. |
| The remote refuses to open: "the board uses periods but no period level is mapped" | A provider with a native container and no `mapping.periods`. | Set `periods: { container: <period type> }`. |
| The plan is the whole board | `--scope` typo, or no scope at all. | Read `lpm remote push --dry-run`; fix `scope:`. |
| The push stops: "more than the threshold" | The plan creates or closes more than `write_threshold` (25). | Re-read the dry run; `--yes` if it is genuinely intended. |
| The remote is missing labels the mapping needs | GitHub only applies labels the repository already defines. | Nothing — the push creates them and says so. `lpm remote push --dry-run` lists them first. |
| A document is `ahead` for ever | Its prose contains the managed-block delimiters (LP-534). | Nothing yet — expect it in the report. |
| A pull wants to rewrite documents straight after a push | The base snapshot is not absorbing the remote's normalisation. That is a bug, not a quirk. | Raise it; stop syncing that remote meanwhile. |
| `lpm check` warns that a mapping block "does nothing" | The block is not one this provider declares. | Delete it, or move the intent to the block that is. |
| `--changed` pulls nothing when the remote did change | An incremental listing holds only what the remote says changed since the last pull, and a twin absent from it is never read as deleted. | Drop the flag: a plain `lpm remote pull` lists everything and is what detects a deletion. |
| Two remotes both claim a document | Overlapping `scope:` — refused when the second is declared, and reported by `lpm check` when a reparent causes it. | Re-scope one, or `lpm remote rm` the one you are replacing. |
| A push skips a document, saying it is "already mirrored" | It has a twin on another remote, and a document is mirrored by one remote at a time. | `lpm remote ledger` shows where it lives; `lpm remote decouple <id>` releases it. |
| A pushed document sits at the tracker's top level | Its parent had no twin yet when it was filed. | Push the parent — that push moves it. |
| A dependency is missing on the remote | The other end was not filed yet when the edge was planned. | Push the other end — that push writes the edge. |
| `lpm remote pull <key>` fails: "needs a parent issue" | A tracker keeps a flat list; the board's hierarchy has no room for the issue at the top. | `lpm remote pull <key> --parent <id>`. |

Two things that are **not** implemented and are worth knowing before you rely on
them: **push-side conflict detection is deferred** — a push diffs against the
base and never asks the remote about a field it is about to write, so only a
*pull* detects a both-sides edit; and the link store is a single file with
last-writer-wins, so two syncs racing (CI plus a laptop) are resolved by git,
not by a lock.
