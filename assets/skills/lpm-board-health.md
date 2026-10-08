---
name: lpm-board-health
description: Diagnose and repair a light-plan board, and publish it. Load this for `lpm check` / `check_board` failures, `lpm check --fix`, adopting hand-made or half-written folders, dependency cycles, duplicate or missing ids, "nobody is being offered work", pools nobody covers, work that vanished from a queue, merge conflicts in `.lpm`, or exporting the board as a static site with `lpm export`.
roles:
  - developer
  - pm
---

# Keeping a light-plan board healthy

Load the `lpm` skill first for the tool map.

## `lpm check` is the gate

```bash
lpm check              # read-only; exits 1 while errors remain
lpm check --fix        # repairs exactly what it marks fixable
lpm check --strict     # also exits non-zero on warnings
```

```
check_board            # the same report as JSON, with error/warning counts
```

The exit code is the contract: `lpm check` drops straight into CI or a
pre-commit hook. **`fixable: true` is also a contract** — exactly the problems
`check` marks fixable are what `--fix` repairs, and anything ambiguous is
reported and left alone.

| `--fix` repairs | It refuses to guess at |
| --- | --- |
| missing `id`, `type`, `title`, `status`, `capacity`, `created`, `author` | a duplicate id |
| attributes a type declares but a document lacks | an unresolvable or ambiguous type |
| folder names that are not the document's id | an attribute value of the wrong type |
| duplicated entries in link and coverage lists | a missing period date |
| an id counter that drifted from what is on disk | an assignee who is not on the roster |
| a stale or missing `.lpm/INDEX.md` | |
| a container whose status is out of step with the work inside it | |

Run `lpm check` before you commit, after any hand-edit, and after every merge.

## Loading is deliberately forgiving

You can create a folder and an `_issue.md` by hand — even one containing nothing
but a `# heading` — and `lpm check --fix` will adopt it: allocate an id from the
right counter, infer the type from its depth when that level has only one type,
take the title from the heading or the folder name, set the default status,
default a resource's capacity to 1, fill in `created` (from the file's first
commit, falling back to its mtime) and `author` (from `git config`), add the
attributes its type declares, rename the folder to the id, and rewrite
`INDEX.md`.

This is the **repair path**, not a workflow. Prefer `lpm new` / `create_document`,
which validate up front.

Two things worth knowing about what loading tolerates:

- A document with no id gets an `#unassigned:<dir>` placeholder until `--fix`
  allocates one.
- Frontmatter keys the config does not declare are **preserved, never dropped** —
  they are reported as extras, not deleted.
- `related_files` is **never checked against the filesystem**. An entry naming a
  file that does not exist is not a problem to fix; `check` only reports a
  duplicate, and `--fix` dedupes it.
- A `flag` value that is not `blocked`, `paused` or `help` is an error and is
  **kept, not dropped** — a flag nobody recognises still means somebody wanted
  attention. Fix it by hand, or clear it with `lpm flag clear`.

## "Nobody is being offered work"

The most common board problem, and it is almost never a bug. Work off this list
in order:

1. **Is it a work unit?** Containers are never offered — an issue with children
   never reaches anyone, however it is assigned, *unless* its type is declared
   `atomic` in the config, which makes it a unit that is taken whole. Anything
   nested inside such a unit is never offered either.
   `list_documents { workUnitsOnly: true }` is the list that actually reaches
   people.
2. **Is its status terminal or already active?** Active work is not re-offered;
   that is what stops two people taking it.
3. **Is it assigned to anyone?** Unassigned work reaches people only via
   `includeUnassigned` / `--unassigned`. Check `team_load`'s `unassigned` row.
4. **Is it in a pool nobody covers?** `team_load` reports these as `uncovered`.
   Fix with `lpm link <person> --covers <pool>`.
5. **Is something unfinished blocking it?** `get_document { id }` → `blockedBy`.
   `lpm task next` prints the blocked queue when nothing is ready.
6. **Does the person have an identity?** `lpm me`; `board_overview` →
   `currentUser`. A null user routes nothing.
7. **Is a profile narrowing the queue?** `lpm profile` shows the scope in force
   and `offers N issues of M`. `board_overview` returns `scope` and
   `scopeWarnings`.

Simulate rather than assume:

```
next_tasks { assignee: "RS-1" }      # exactly what that person will be offered
```

### The other half of the question: work that *is* moving and has stopped

`next_tasks` answers "what could start". It does not answer "what started and
went nowhere", and a team can look busy while three people are all waiting on
somebody. That is what flags are for:

```
flagged_issues                       # everything stopped, board-wide, unfiltered
```
```bash
lpm flag list
lpm comment <id> --list              # the reason; a flag always carries one
```

Flagged issues keep their in-progress status and their assignee — they are held,
not free — and are drawn in red on the canvas, including a count on any node they
are folded inside. `flagged_issues` is deliberately **not** scoped by a profile:
a flag is addressed to whoever runs the plan, and hiding one because it sat
outside the reader's slice would defeat it.

Clearing is a deliberate act by whoever answered it
(`lpm flag clear <id> --comment "..."`), and `lpm check` warns about a flag left
on a finished issue. Finishing an issue clears its flag automatically, so that
warning means somebody edited a file by hand.

## Scope surprises

If a profile is involved:

- **A stale `under` fails closed.** `under: [LP-404]` on a board without LP-404
  offers *nothing*, and warns. That is deliberate — silently widening to the whole
  board is the failure nobody would notice.
- **Unknown keys are errors.** `excludes:` is refused rather than ignored.
- **A profile that does not parse is reported and skipped**, and the board is
  unscoped. `lpm profile` exits 1 in that state; over MCP it shows in
  `scopeWarnings`.
- Scope never hides work already in flight — `task current` and `current_tasks`
  ignore it.

Full reference: `docs/profiles.md`.

## Dependency cycles

`link_issues` and `lpm link` refuse a dependency that would close a cycle, so
cycles arrive only by hand-editing or by a merge. `lpm check` catches them and
will not auto-fix them — breaking a cycle is a judgement about which edge is
wrong.

```bash
lpm check                                  # names the cycle
lpm link LP-42 --depends-on LP-40 --remove # drop the edge that should not exist
```

Only forward edges are stored (`depends_on`, `covers`); the inverses are derived
at load. Never try to edit an inverse — there is nothing to edit.

## Merge conflicts

`.lpm` is its own git repository nested in the project. Conflicts are ordinary
markdown conflicts in a document or its `_comments.md`. Resolve them by hand, then:

```bash
lpm check --fix     # resyncs id counters, dedupes link lists, rolls statuses up
lpm check           # confirm nothing is left
```

A merge that takes one side of a status is the usual way a container ends up
disagreeing with the work inside it — a feature back in `backlog` with every
story done, or closed over a story somebody reopened. `check` reports each one
and `--fix` rolls it up; nothing else has to be edited by hand.

**Ids are never reused**: `allocateIds` skips any id already present on disk, so a
counter mangled by a merge cannot produce a duplicate — `--fix` just resyncs it.

## Deleting safely

```
delete_document { id: "LP-20", dryRun: true }        # list what would go
delete_document { id: "LP-20", recursive: true }
```

```bash
lpm rm LP-20 --dry-run
lpm rm LP-20 -r
```

Deleting requires `recursive` when the document has children, because that is
rarely what a typo means. Everything that referenced the deleted subtree is
rewritten, so the board is left valid — the reply's `rewritten` / `detached` list
tells you what was touched.

## Looking at it

```bash
lpm ui                 # local editor at 127.0.0.1:4571
lpm ui --port 0        # pick a free port
lpm ui --no-open       # do not launch a browser
lpm ui --api-only      # serve the API only (pair with `npm run dev:web`)
```

The server is local-only and edits this checkout's `.lpm`. **Editing is queued**:
actions update a working copy and a pending list, and nothing is written until
Push. A push is **partial, not atomic** — what lands, lands; failures stay
pending and are shown. If a push half-fails, fix the reported cause and push
again; earlier changes are already on disk.

## Publishing

```bash
lpm export                            # refresh .lpm/board.json
lpm export --site docs                # a full static site in docs/, ready for Pages
lpm export --site docs --workflow     # ...and an Actions workflow that keeps it current
lpm export --pretty                   # readable diffs, bigger file
```

`--site docs` writes `docs/index.html`, its assets, `docs/board.json` and a
`.nojekyll`; commit it and point **Settings → Pages → Source: `/docs`**.
`--workflow` instead writes `.github/workflows/lpm-board.yml` and wants **Source:
GitHub Actions**.

Two things to keep straight:

- **An export is the board as committed.** A view's queued-but-unpushed changes
  are somebody's draft and never travel; publishing them would assert something
  untrue.
- **`board.json` is generated**, so it goes stale like any build output. Let the
  workflow rebuild it, or re-run `lpm export` before committing.

The published viewer is read-only by construction and renders bodies as plain
text, never as markup — it will happily read a board from a URL a stranger
supplied.

## Routine maintenance

```bash
lpm check --strict          # errors and warnings
lpm team                    # uncovered pools, unowned work, load vs capacity
lpm task next --unassigned  # is anything ready that nobody owns?
lpm export                  # refresh the published file
cd .lpm && git add -A && git commit -m "..." && git push
```

A board that passes `check --strict`, has no `uncovered` pools and offers each
person at least one thing tomorrow is healthy. Everything else is planning.
