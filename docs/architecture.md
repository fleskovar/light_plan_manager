# Architecture

This document describes the architecture of `light-plan`. `CLAUDE.md` links to
this document. Read the section that covers the code before you change that
code, and update the section after the change.

Each path in this document is relative to the repository root.

## One engine, five collections

`board/` holds **issues** (what gets built), `timeline/` holds **periods**
(sprints, increments — when it gets built), `team/` holds **resources** (who
builds it: people and generic pools), `squads/` holds **squads** (named
sub-teams of resources), and `registry/` holds **templates** (reusable pieces of
plan: the shape a kind of work always takes). They are structurally identical and
almost all code handles all five through
`NodeKind = 'issue' | 'period' | 'resource' | 'squad' | 'template'`
plus a lookup helper (`hierarchyFor`, `typesFor`, `prefixFor`, `typesAtDepth`,
`collectionDir`, `documentFileName`, `reservedFieldsFor`, `counterFor`). When
adding logic that touches one collection, ask whether it should be
`kind`-parameterized instead of duplicated — `KINDS` in `validation/shared.ts`
is the canonical list. Periods and resources are optional: a config with no
`period_types` / `resource_types` means `hasPeriods(config)` /
`hasResources(config)` is false and the folder is never created. The registry is
not optional and has no config of its own — see the invariant below.

## Layers (`src/core`), each depending only on the ones above

| Folder | Responsibility |
| --- | --- |
| `model/` | Domain types + pure logic (attribute coercion/validation, dependency-cycle detection). No I/O; every layer may import it. |
| `config/` | `schema.ts` parses `.lpm/config.yml` into a validated `BoardConfig` (zod); `lookup.ts` answers every question about it. Callers never inspect the raw config shape. |
| `storage/` | Disk encoding: `paths` (layout constants, slugs, id↔folder-name, and which board a command works on), `frontmatter`, `document` (serialize/write), `comments` (`_comments.md` beside a document), `activity` (the timestamped block at the end of a body), `state` (id counters), `local` (`.lpm/local.json`, the git-ignored current user and profile path), `views` (`.lpm/views/*.json`, contents deliberately opaque), `templates` (`.lpm/templates/context/*.md`, the layouts a brief is rendered with), `user` (the user folder `~/.light-plan`, or the folder that `LPM_HOME` names: `templates/<name>.yml` and `settings.json`, which belong to one person and to no board), `git` (identity, first-commit date), plus the two that make the folder safe to share: `atomic` (temp-then-rename writes, and the `DocStamp` that says whether a file moved under a reader) and `lock` (`.lpm/lock`, one writer at a time across processes). Knows the layout, not what makes it valid. |
| `board/` | `load.ts` reads every collection into a `LoadedBoard`; `query.ts` navigates it; `registry.ts` answers what the template registry adds (roots, folders, placement); `scope.ts` narrows it to one reader's part of it; `tasks.ts` ranks work and reports roster load; `simulate.ts` runs that ranking forward as one person's whole sequence; `rollup.ts` asks which containers are out of step with the work inside them (all read-only, config-aware). |
| `gitsync/` | Sharing the board through its own git repository: `run.ts` (the only way git is run — never prompts, always times out), `repo.ts` (repository questions, and committing an exact list of files through a private index), `integrate.ts` (bring fetched work in: fast-forward, lay local work over upstream when the files differ, report a conflict when they are the same), `sync.ts` (fetch, pull, push, and `sharedWrite` — the write transaction), `status.ts`, `hosts.ts` (the hosts setup can talk somebody through). Sits between `board/` and `operations/`; `operations/git-sync.ts` builds the public entry points on it. |
| `profile/` | The file one developer is handed: `schema.ts` parses it (strictly), `current.ts` finds the one in force and resolves its scope. Types live in `model/profile.ts`, evaluation in `board/scope.ts` — this layer is only the file it arrived in. |
| `instructions/` | One issue plus its ancestry as a working brief: `analyze.ts` (the safety check a template passes *before* it is compiled), `template.ts` (rendering with Eta, plus the helpers a template may call), `context.ts` (board+issue → the values a template sees), `builtin.ts` (the layout every board falls back to, naming no type), `instructions.ts` (which layout, and rendering it). Read-only, like `board/tasks.ts`. |
| `operations/` | `init`, `create`, `update`, `retype`, `move`, `claim`, `link`, `flag`, `comment`, `remove`, `user`, `profile`, `config-edit` — validate fully, then write, every one of them under the board lock and refusing a document that changed underneath the handle. `board-template.ts` resolves the template that `init` copies and saves a config as a user template. It writes the user folder and never a board, so it takes no lock. `shared.ts` holds their common guards (`boardWrite`, `requireUnchanged`, `writeDocument`) and is intentionally not re-exported; `board-index.ts` renders and rewrites `.lpm/INDEX.md`. |
| `validation/` | `check.ts` (read-only) and `fix.ts` (writes). `shared.ts` keeps them agreeing. |

`errors.ts` sits outside the stack: any layer may `throw new BoardError(message, details[])`.
Each folder's `index.ts` carries a doc comment stating its contract — update it
when the contract moves. `src/core/index.ts` re-exports everything, so the
public API is insensitive to internal file moves.

Four operations write a document, and which one to use is not a style choice:
`update` changes a document's own payload (title, body, attributes, related
files, dates, capacity, covers), `move` changes where it sits (parent, status,
period, assignee — and carries a status change up to the containers above it,
see the roll-up invariant), `retype` changes what it *is* (and may reparent in the same
call, which is how "drag a feature onto a feature" demotes it), `remove` deletes
a subtree and rewrites everything that referenced it. The hierarchy guards and
folder relocation they share live in `operations/shared.ts`
(`resolveNewParent`, `requireSubtreeFits`, `relocateFolder`) — extend those
rather than re-deriving depth rules in a new operation.

**Every operation runs under the board lock, and none of them writes over a
document it did not read.** A `.lpm` folder has no server in front of it: two
people, a browser session and a swarm of agents may be writing to one checkout,
and each of them is a separate process holding a `LoadedBoard` that is a
photograph of a moment. Three rules, in `storage/atomic.ts`, `storage/lock.ts`
and `operations/shared.ts`, and every one of them is load-bearing. **Writes are
temp-then-rename**, so a reader never catches a `_issue.md` half-written — which
on a YAML frontmatter file reads as a corrupt board. **`boardWrite` wraps every
exported operation** in `withBoardLock`, which is re-entrant (an operation built
out of operations takes it once), and held for the write and never for the work
(an agent holds it for the milliseconds it takes to record that it started, not
for the twenty minutes of the task). **A stale lock is broken on age and on
nothing else.** The obvious extra test — "is that pid still running?" — was
written, shipped and taken back out: `process.kill(pid, 0)` returns `ESRCH` for
live processes often enough to matter under load, and a lock broken on a wrong
answer is not a degraded lock, it is no lock — eight concurrent `lpm new` calls
produced duplicate ids exactly that way. A false "alive" costs a wait; a false
"dead" costs the guarantee, so liveness is not consulted. Crash recovery is
handled where it belongs instead: `releaseOnExit` gives the lock up on `exit`,
`SIGINT` and `SIGTERM` (a `finally` does not cover Ctrl-C — Node's default
signal handling terminates without unwinding), and the age window is generous
because it has to exceed the longest honest hold, which is a whole push.
**`requireUnchanged` is called before an operation mutates anything**, comparing
the file against the `DocStamp` the load recorded, so a handle that went stale
between the read and the lock is refused rather than allowed to win. The third
exists because the second cannot be perfect: the lock is advisory, nothing stops
an editor writing the file, and breaking a stale lock needs a filesystem
primitive nobody has. Note what follows for `allocateIds` (read-modify-write, so
two creates would otherwise share an id) and for `INDEX.md` (rendered
incrementally, so a stale render publishes a table of contents missing somebody
else's work — `writeBoardIndex` stamps it too and reloads when it is not ours).
Do not add an operation that writes outside `boardWrite`, and do not "fix" a
refusal into a merge: light-plan cannot know whether your title and their status
change belong together, and the board is in git.

**On a board shared through git, the same wrapper commits and pushes every
write, or undoes it and refuses.** `boardWrite` calls `withBoardWrite`
(`operations/git-sync.ts`), which with `git_sync:` configured runs the operation
inside `sharedWrite` (`gitsync/sync.ts`). That transaction notes what was dirty,
runs the operation, commits **exactly the files it changed** (`lpm: <what>`, so
the `what` you pass `boardWrite` is a commit message), and pushes. When the push
is rejected it fetches and integrates: different files are laid over upstream,
and the **same file is refused**. The commit is undone, the board shows the
other side's version, and a `ConflictError` names the documents. That is the
cross-machine version of `requireUnchanged`, and it is what makes a claim safe
between two checkouts. An unreachable remote also undoes the write and refuses
it, unless `LPM_GIT_OFFLINE=1`. Four rules keep it honest. **Never merge inside
a document**: the unit of conflict is the file, and only `INDEX.md` (rendered
again) and `state.json` (counters merged by max) are exempt. **Plumbing, never
porcelain**: `checkout <commit> -- <paths>` and `update-ref`, with no `merge`,
`rebase` or `stash`, so no half-finished rebase or conflict marker ever lands in
a folder people open in an editor. **Commit through a private index**, so
somebody's staged work and the views the web app keeps saving are neither
swept in nor disturbed. **Undo only what the write changed**, each file back to
what it held before, never `reset --hard`. Freshness is the front ends' job:
`requireBoard`, the server (`server/git.ts`), `BoardContext.board()` and the
queue runner's reload all call `pullBoard` first, best effort. Correctness does
not depend on that pull, because a stale handle is refused at the push. A new
write path must go through `withBoardWrite` (as `applyChanges` does) or it is
committed by nobody.

**Git sync and tracker remotes are exclusive.** A board syncs through git or
mirrors onto trackers, never both. Git replicates the whole folder, every
link store included, so one remote per document can only be decided for the
whole board. `config/schema.ts` refuses both together, `setupGitSync` and
`addRemote` refuse with the way out, the web Sync tab holds one panel or the
other (`panelMode`), and `git` is reserved as a tracker remote name because
`lpm remote git …` is `lpm git …`.

**Swapping between them turns a tracker off; it never removes one.** A
turned-off remote is its declaration moved, unchanged and with its comments,
from `remotes:` to `remotes_off:` (`moveRemoteBlocks` in
`config/remote-blocks.ts`). Its link store and credentials are not touched.
Every consumer of a remote reads `config.remotes`, so a turned-off one needs no
special case anywhere, and it does not count against the exclusivity rule.
`setupGitSync({ turnOffRemotes })` and `disableGitSync({ turnOnRemotes })` move
the blocks **in the same config write as `git_sync`**, so the swap is one
commit and cannot half-happen. `turnRemotesOff`/`turnRemoteOn`
(`operations/remotes-off.ts`) are the standalone pair, and `turnRemoteOn`
refuses while git is on. The swap is asked for, never implied. The CLI refuses
without the flag or asks at a terminal. The web Share button opens a warning
(`GitState.turnOffQuestion`) before anything is sent. Do not "simplify" this
into `lpm remote rm`: reconnecting a tracker from nothing is exactly what this
exists to spare people.

`claim` is the one operation that is a **test-and-set**, and the only one that
reloads the board inside the lock. Everywhere else a stale handle is *detected*
and the caller told to read again; here the caller is a queue runner picking
work, and "read again" is something it can do for itself in the same breath. So
`claimIssue` re-reads, checks the issue is still free *as it stands on disk*,
and refuses with a `ConflictError` naming the holder — which is what stops two
agents on one checkout both writing their name on `LP-12` and doing the work
twice. It is the single definition of "pick this up" for `lpm task start`, MCP
`start_task` and `lpm queue agent`; those three had the rule three times over
and did not agree (the CLI let a pool be drawn from, the MCP tool refused).
`ConflictError` exists so the runner can tell "somebody got there first" (ask the
queue again, leave the issue completely untouched — no flag, no comment) from
"this request is wrong" (stop). Matching on the message instead would be a bug
waiting for a reworded string. And the claim writes an activity entry as well as
the frontmatter, because `assignee` + an active status is what *withholds* the
issue from every other queue, and the line in `_issue.md` is how a person reading
a file tree or a git diff finds out who took it.

`flag` is the fifth and is not one of those four on purpose: it writes the
document *and* a comment in one call, because a flag a *person* raised with no
explanation is a red box nobody can act on, and that rule has to hold for all
three front ends at once. The comment lands in `_comments.md`; the document gets
the flag itself plus a timestamped entry in the activity section at the end of
its body (`<!-- lpm:activity -->`).

**Every flag change is recorded in the document, including the ones with no
comment — and `setFlag` in `operations/shared.ts` is what makes that structural
rather than remembered.** Most flag changes on a working board are written by
the engine, not typed by anybody: `moveNode` drops a flag when work reaches a
terminal status (`flag cleared — work finished`), the flag roll-up gives a
container `DERIVED_FLAG` and takes it away again, the status roll-up clears one
off a parent it just closed, and `check --fix` repairs a container that drifted.
None of those writes a comment, deliberately. So the activity section is the
only record, and a flag that moved without leaving one is a red box that
appeared — or quietly went away — with nothing in `_issue.md` and nothing in the
board's git history saying when or why. `setFlag` sets the field and appends the
entry in the same call so the two cannot come apart, all four sites go through
it, and `test/flags.test.ts` greps `operations/` for a bare assignment to `flag`
and fails naming the file if a fifth appears. Do not write `issue.flag` directly;
if a new operation needs to move one, give it a heading and call `setFlag`.

## Above the engine (`src/shared`, `src/sync`, `src/remote`, `src/server`, `src/mcp`, `web/`)

| Folder | Responsibility |
| --- | --- |
| `src/shared/` | The contract: DTOs (`model.ts`), the edit protocol (`changes.ts`), the multi-step edits as pure planners (`plans/` — split into `reading.ts`, `breakdown.ts`, `reparent.ts`, `timeline.ts`, `instantiate.ts`, `upstream.ts`), what a registry template asks for (`template-params.ts`), the view file (`view.ts`), the published board file (`static.ts`). **Imports nothing** — it compiles for Node and for the browser, and every front end depends on it. |
| `src/sync/` | The hinge between the protocol and the engine: `dto.ts` (core model → wire, the only place that knows both), `session.ts` (a board handle that reloads between operations), `patch.ts` (one patch → the core calls it implies), `apply.ts` (a change list → what landed), `static.ts` (a board → the one file `lpm export` publishes). Used by the server, the CLI and the MCP server. |
| `src/remote/` | The remote-sync layer: mirrors a board onto an external tracker (GitHub, Jira, Linear) and back. `plan.ts` (`planPush`/`planPull`, pure — no I/O), `pull.ts`/`execute.ts` (the appliers), `mapping.ts`/`attributes.ts` (board ↔ remote vocabulary), `links.ts` (the correspondence store), `anchor.ts` (where a remote issue belongs in the local tree — one walk, shared by the pull planner and the drift report), `report.ts` (the drift report, which reads the tracker in one paginated listing) and `coverage.ts` (what the mirror is *missing* around what it holds, which reads nothing upstream at all), `guard.ts` (the write-confirmation gate), `audit.ts` (the sync log), `providers/` (one adapter per platform), `transport/` (the wire-level connector that knows nothing about boards). Sits above the engine beside `src/sync`: it may import `src/core`, `src/shared` and `src/sync`, and nothing in `src/core` may import it — the design record is `docs/remote-sync.md`. |
| `src/server/` | `http/` (router, respond, static), `views/` (zod schema + store over `storage/views.ts`), `routes/` (one file per resource). |
| `src/mcp/` | `context.ts` (per-session board handle and identity), `reply.ts`, `tools/{read,plan,templates,work}.ts`. Registered by `lpm mcp`; the SDK is dynamically imported so a missing optional dependency is a message, not a crash. `cli/commands/mcp/` holds the command: `serve.ts`, plus `setup.ts`/`config.ts`, which write a host's JSON config. |
| `src/runner/` | `lpm queue agent`: the autonomous development loop. `loop.ts` picks the top of `nextTasks`, hands the brief to an injected `PiRunner`, and records the outcome through the engine's own operations (`moveNode`, `flagIssue`, `addComment`); `pi.ts` is the one file that touches the optional pi SDK; `shell.ts` (the non-interactive environment and the guard that keeps a command from waiting for a person), `config.ts` (the `--file` YAML), `git.ts` (project-repo commits), `stats.ts` (the comment + `.lpm/runs/` artifact), `types.ts` (the SDK-free vocabulary, including the `RunEvent` a run reports itself with). |
| `assets/` + `cli/commands/agent/` | What `lpm agent` installs into someone else's project. `assets/` is a **neutral tree** of any files at all; `assets/harnesses/*.yml` is a list of copy rules saying which of them land where, selected `.gitignore`-style. `assets.ts` walks the tree, `glob.ts` matches patterns, `mapping.ts` validates a mapping and expands its templates, `install.ts` writes without destroying, `prompt.ts` asks the one question. |
| `web/src/lib/` | `api/` (the only `fetch` in the editor), `app/` (`router.svelte.ts`, `tabs.svelte.ts`, `preferences.svelte.ts`, `shell.svelte.ts`), `board/` (working copy, selectors, links, critical path), `workspace/` (the store, `pool.svelte.ts` and the mutation vocabulary), `ui/` (presentational primitives, plus `markdown.ts` — the only place that produces HTML), `shortcuts/`. |
| `web/src/features/` | `canvas/`, `drawer/{table,periods,gantt,team,remote}/`, `queue/` (the left panel), `panel/`, `config/` (the dialog that File ▸ Board configuration opens: `model.ts` derives its rows, `editor.svelte.ts` sends the edits, and `remote/` holds the tab Remote board with the mapping editor of a tracker remote), `commandbar/` (the menu bar and the tabs: `menus.ts` builds the File, Edit, View and Help menus, `CommandBar` draws the bar, `ViewTabs` and `TabStrip` draw the tabs, plus `ViewDialog` and `ShortcutsDialog`), `overview/` (the dialog that View ▸ Board overview opens, and `digest.ts`). |
| `web/src/viewer/` | The read-only app, its own entry (`web/viewer/index.html`, `web/vite.viewer.config.ts`, out to `web/dist-viewer`): `source.ts` (URL → the board file to fetch), `board.svelte.ts` (the store), `Viewer`/`ViewerCanvas`/`Inspector`. It reuses the canvas wholesale and touches nothing in `lib/api/`. |

Things to keep true here:

- **The editor has one screen, and a view is a tab.** `App.svelte` renders
  `routes/Workspace.svelte` for the view that the address `#/view/<id>` names.
  The app has no start page: an address that names no view makes `Tabs.land`
  pick a view, and `Tabs.land` creates the view `Default` on a board with none.
  Three stores divide the work:
  - `Tabs` in `lib/app/tabs.svelte.ts` holds the ids of the open views and the
    view list. It writes the open ids to the `localStorage` entry
    `lpm:tabs:<board root>`. A window that "Open in new window" created has
    `window.name` starting with `lpm-window-`, gets no storage, and writes no
    entry. The tabs follow the address, so every change of tab goes through
    `goToView`.
  - `WorkspacePool` in `lib/workspace/pool.svelte.ts` holds one `Workspace` for
    each open tab. A switch of tab destroys the `Workspace.svelte` component
    and keeps the store: the component calls `suspend` and `resume`, and only
    `Tabs` reports a closed tab, which makes the pool call `dispose`. Create a
    workspace through `pool.acquire` from an effect or an event handler, not
    during the render of a component.
  - `Workspace` writes the view file. `scheduleSave` records a layout change
    and sets `viewDirty`. The preference `autoSave` (`lpm:preferences`, values
    `true` and `false`, default `true`) decides whether that change writes the
    file after the delay or waits for `save`. A push and the write of the queue
    go through `#outgoing`, which sends the last stored layout when `autoSave`
    holds `false`. A new write path must use `#outgoing` too, or it saves a
    layout that the reader did not save.
- **The menu bar is data, and a shortcut has one implementation.** `barMenus`
  in `features/commandbar/menus.ts` returns the four menus as `MenuEntry`
  lists, and `lib/ui/menu/MenuBar.svelte` draws them. An entry with a keyboard
  shortcut calls `runBinding` with the id of the binding in
  `lib/shortcuts/bindings.ts`, and takes its key label from `shortcutLabel`.
  Add a command with a shortcut as a binding first, then as a menu entry that
  runs the binding. Help ▸ Keyboard shortcuts lists `BINDINGS`, so a binding
  needs no second entry there.
- **The tab row belongs to the column of the canvas.** `Workspace.svelte`
  renders `ViewTabs` inside the `.column` element, above the `.stack` element
  that holds the canvas and the drawer. The row therefore has the left edge
  and the width of the canvas whatever the queue panel and the details panel
  take. `stackHeight` measures `.stack` and not `.column`, because the drawer
  takes its room from the canvas and not from the tabs.
- **The server refuses to write a view that has no file.** `updateView` in
  `server/views/store.ts` is behind `PUT /api/views/:id`, and the push route
  skips the save of a deleted view. A window can hold a view that another
  window deleted, and its autosave must not create the file again. Only
  `createView` creates a view file. `createView` allocates the id: the slug of
  the name, or the slug with a number when a file uses the slug, because a
  renamed view keeps its id.

- **Tracker remotes are experimental in the web UI, and one switch hides them.**
  The switch has two sources. The key `experimental` in `.lpm/config.yml` holds
  `true` or `false`, and is off when absent. `setExperimental` in
  `core/operations/experimental.ts` writes it, as text, the way `setPlanning`
  writes `planning`: turning the features on appends one commented line, and
  turning them off removes that line, byte for byte. `experimentalOf` in
  `config/lookup.ts` is the one read. The flag `lpm ui --experimental` turns the
  features on for one run. `cli/commands/ui.ts` passes "the flag or the key" to
  the server once, at start, so a change to the key needs a restart of
  `lpm ui`.

  `lpm experimental on` also installs the packages that the features load.
  That half is in `cli/experimental-deps.ts` and not in core, because the
  packages belong to the installation of light-plan and not to a board. The
  list is the optional peer dependencies of `package.json`, so a new optional
  peer is installed with no edit. `installTarget` decides where npm runs from
  the folder of the package (a global install, a project, a clone, or an npx
  cache where nothing is installed). The command checks on every `on`, because
  the key travels with the board and the packages do not.
  `boardTemplateText` removes the key from a template.

  `lpm ui --experimental` sets `ServerOptions.experimental`; without it
  `buildRouter` does not register `remoteRoutes` at all, and `/api/health`
  (`ServerInfoDto`) says so. The web app reads that into `RemoteState.enabled`,
  whose loaders refuse to fetch while it is false — so `remotes` stays empty and
  every surface keyed off it (badges, canvas menu, side panel sections) has
  nothing to draw — and the Sync tab, the side panel and `Workspace.svelte`
  check it explicitly for what is not keyed off loaded remotes (the welcome
  copy, the connect/readiness/blocked dialogs). Git sharing is never behind the
  flag. A new tracker surface in `web/` must read `remote.enabled`, or it ships
  to everybody; the `lpm remote` CLI and the MCP tools are not gated.
- **Nothing in `src/core` may import `src/sync`, `src/remote` or a front end.**
  The dependency runs one way; `sync/dto.ts` is the seam. `src/remote` sits
  beside `src/sync` on the far side of it: it may import core, shared and sync,
  and no core file may import it.

  **Exception — the ten pure rule modules of `src/shared`** may be imported
  by core: `period-stance`, `work-unit`, `period-query`, `blocking`, `rollup`,
  `flag-rollup`, `dependency-rollup`, `cohesion`, `routing` and
  `template-params`. These are single-source
  definitions shared with the browser, kept import-free so they compile for both.
  Core may never import `src/shared`'s DTOs, plans, changes, or anything else —
  only these files that themselves import nothing.
- **Reshaping logic lives in `src/shared/plans/`, nowhere else.** A planner is
  a pure function from a `BoardView` to a `Change[]`; the web queues the result,
  the CLI and MCP hand it to `applyChanges`. Never write a second copy of
  "what does breaking down mean". Remote translation is the same rule in a
  different register: **translation lives in a provider, reshaping lives in
  `plans.ts`.** A provider's `translator` maps board vocabulary ↔ remote
  vocabulary and never decides *what* changed or *in what order* — the sync
  planners in `src/remote/plan.ts` do that, and board reshaping stays in
  `src/shared/plans/`. Put provider logic in `src/sync`, or reshaping logic in
  a provider, and the one-way dependency this codebase is arranged around
  stops holding.
- **A step with no decision in it is a step the tool takes.** Two commands were
  removed by asking what they were *for*. `lpm remote provision` created what
  the mapping already named — nothing to decide, nobody to ask — so the push
  does it (`src/remote/prerequisites.ts`), reports each one, and a dry run says
  what it would create; `lpm remote check` and `lpm remote ids` reported and
  cached what that step needed, and went with it. The rule generalises: before
  adding a command, ask what question it puts to a person. If the answer is
  "none", it belongs inside the command that needed it. Two properties keep the
  fold safe — it runs only when the push has operations (an idle sync costs no
  extra requests), and every operation is additive and idempotent. Refusals are
  **collected, not thrown**: one thing a tracker will not create is no reason to
  abandon the rest, and learning about three refusals one push at a time is an
  afternoon spent on what should have been one list.
- **Vocabulary the push creates; a timeline it does not.** The line inside that
  rule, and the one that was drawn wrong first. A **label** or a Project field
  exists only because the mapping needs somewhere to put a type — it is
  vocabulary, implied, and the push makes it. A **sprint is a document on the
  board**, with a name and dates somebody wrote down, so filing it is filing
  part of the plan and is asked for explicitly (`lpm remote push TL-3`, or
  `--all`). Bundling the two cost exactly what a category error costs: the whole
  timeline became a precondition for filing one story, and a single sprint name
  Jira would not take stopped a push of forty issues unrelated to it. The other
  half of the split is what makes it safe — an issue whose sprint is not there
  is **filed unscheduled**, the connector names the dropped field in
  `ConnectorResult.unwritten`, and the executor records that field as **unset**
  in the base so the next push writes it the moment the sprint exists. Recording
  the intended value would make both sides look agreed for ever, which is the
  same trap `parentRemoteId` exists to avoid.
- **Connecting is one command, and it is a wizard over the primitives, never a
  second implementation of them.** `lpm remote connect [<provider>]` asks for
  what the tool cannot work out — which tracker, where the project is, the
  credential — and then does `addRemote`, `writeCredential` and the whole of
  `setup`'s conversation with the remote. The three commands underneath
  (`add`, `login`, `setup`) stay, stay tested and stay documented, because a CI
  job, a Dockerfile and an agent have nobody to ask; every question `connect`
  asks can be answered by a flag instead, so a fully flagged run asks nothing.
  Two things keep it honest: the remote half of `setup` lives in
  `inspectRemoteConnection` (`src/remote/inspect.ts`), called by both, so the command a person is told to run and
  the wizard that runs it for them cannot answer differently; and the
  credential is the one thing that can never be a flag.
  The web connect form is the third caller, and the same rule holds for it:
  the conversation with the tracker is `inspectRemoteConnection`, which
  `lpm remote setup`/`connect` render and the server returns as JSON, and the
  refusals a form needs — a secret sent as a connection value, an undeclared
  key, re-pointing a remote that already has twins, a switch written `false`
  — are `src/remote/connection.ts`, never the routes. Those routes are the only
  ones that take a secret in, and none sends one back: a credential is reported
  by its source.
- **Setting a remote up is one command and one secret, and every step of that
  is derived from the provider.** `lpm remote connect` (over `addRemote`) drafts
  the whole `mapping:`;
  where the words are the platform's rather than the board's, a provider states
  its **conventional** vocabulary (`Provider.standardVocabulary`,
  `src/remote/vocabulary.ts`) and the scaffold writes that instead of a `TODO:`
  marker. This replaced a real failure: Jira's `vocabulary: 'fixed'` meant the
  Scrum template produced **fourteen** markers, `openRemote` refused the remote
  until every one was answered by hand in `config.yml`, and the answers were the
  same on almost every project. A convention is safe only because two things
  check it: `lpm remote setup` asks the live remote for its real words
  (`connector.vocabulary()`, reconciled by the pure `src/remote/reconcile.ts` and
  written back by `updateRemoteMapping`), and the push preflight refuses a name
  the project does not have. A convention is a **word**, never a carrier — that
  stays `capabilities`' answer. A provider that declares `standardVocabulary`
  must also implement `connector.vocabulary()`, or the convention can never be
  corrected; `test/remote-discovery.test.ts` pairs them, and
  `test/remote-vocabulary.test.ts` asserts the real invariant over the whole
  cross-product of shipped providers × shipped templates: **no marker, ever**.
  Adding a board template or a provider keeps that true or the test fails.
- **What a person has to do next is printed, never documented.** The credential
  is the one thing the tool cannot work out, so `Provider.credentials` carries
  `url` and `hint` beside `secrets`, and `credentialStates` (in `credentials.ts`,
  the read-only twin of `resolveSecret` — it reports a *source*, never a value)
  answers which are already resolvable. `renderCredentialGuide` in
  `cli/commands/remote.ts` is the only renderer, shared by `add` and `setup`.
  `lpm remote login` writes under the provider's own secret key rather than a
  hard-coded `token` (which is why it silently did nothing for Linear), with
  `--key` for one of several. At a terminal it **asks** for every key the
  provider declares, in one command, because the piped form alone made a
  two-part credential (Jira's email + token) two invocations and a shell trick
  to learn; a bare Enter keeps a key that already resolves, and the value is
  read with echo off unless `credentials.visible` says that key is no secret to
  look at. Piped — a script, CI — it still reads one value from stdin, and it is
  never a flag either way, which is the property worth defending. The reading
  itself is `src/cli/prompt.ts`, the one definition of asking a person
  something, shared with `lpm agent`'s prompt. Nothing in `src/cli` names a
  platform: every line of that output comes from the descriptor.
- **A push writes only what changed, and the base snapshot is already the hash
  that says so.** `LinkEntry.base` holds every mirrored field as it stood when
  the two sides last agreed — the body as a `sha256:` hash, the whole snapshot
  hashed again as `baseHash` — so `planPush` diffs against it and a document
  that still matches produces no operation. Do **not** add a second
  "document hash" to detect changes: it would be a weaker copy of a fact the
  base already holds (the base powers the three-way merge as well, which a
  bare hash cannot), and two records of the same thing are free to disagree.
  What was missing was never the detection but the *reporting* — a summary of
  what got written cannot distinguish "nothing to do" from "everything was
  already up to date", which is how somebody comes to believe a bare push
  re-files the board. `RunSyncResult.pushConsidered` is that line
  (`5 mirrored · 1 changed · 4 unchanged`), and `--all` is the no-id default
  given a spelling, since naming ids is now the ordinary way to push.
- **One document, one remote — and the ledger is derived, never a file.**
  `src/remote/ledger.ts` reads every declared remote's `links.json` and answers
  "where does LP-12 live?". Two twins of one story is not a mirror of a plan: a
  status moves on one side, the other keeps its own, and the next sync of each
  writes a different truth onto the same document. Enforced in two places and
  differently in each, on purpose. A **push** never creates a second twin — the
  claimed ids reach `planPush` as `ownedElsewhere` and come back in `skipped`
  with the reason `owned_elsewhere`, so a whole-board push to a second tracker
  is a readable report rather than a refusal. An explicit **`link`** (or a
  `push <id>` naming one) is *refused*, because the request is exactly the
  thing the rule forbids. Nothing is stored: a committed `ledger.json` would be
  a second copy of what the link stores already say, free to disagree after a
  merge and needing its own repair pass, which is the same reasoning that keeps
  derived inverses out of the documents. `lpm remote ledger` prints it, and
  reports a document that has ended up in two stores rather than picking a
  winner.
- **A push asks whether it can land before it writes, and the answer is three
  choices rather than a message.** `preflightPush` asks whether the *mapping*
  can carry the board's values and is pure; `checkReadiness`
  (`src/remote/readiness.ts`) asks the question only the tracker can answer —
  **does the person exist over there, and does the sprint?** A stale account
  id, a colleague who left the project, a sprint nobody filed: the board is
  valid in all three cases, the push writes, and forty issues arrive
  unassigned. Two requests whatever the size of the push (`connector.listUsers`,
  `connector.listSprints`), so it is cheap enough to gate every push — measured
  at 3.8s against a 537-document board. Four things in it are load-bearing.
  **The offline half comes from `pushGaps`**, the same translator walk the
  preflight reports from, so the dialog and `lpm remote push` cannot disagree
  about one board; the preflight's `include` argument is what stops the two
  rendering the same gap twice. **Every finding carries what ignoring it
  costs**, because "leave it blank" is a real answer here — the field is
  recorded as unset and a later push writes it once the far side exists — and
  an option nobody can price is not a choice. **A fix is data on the finding**
  (`link_account`, `file_period`, `unassign`), so the dialog has no branch per
  code, and `file_period` is deliberately *not* a board edit: it widens the
  push, exactly as `lpm remote push TL-3` does. And **only the board
  contradicting itself blocks** — an assignee or period the board itself has
  lost — because nothing a push does can settle that, while every other finding
  is a degradation somebody may accept. Which of a remote user's fields answers
  a board attribute is the provider's to say (`Translator.accountValue`);
  nothing above the provider may guess at it.
- **`ahead` is the honest total; `pendingAhead` is the useful one.** A local edit
  the remote *cannot accept* is genuinely ahead and will be ahead for ever: the
  push tries, the remote refuses the field, the base records it unset, and the
  next push tries again — right behaviour, and on this repository's board it was
  **428 of 433 documents** (an assignee that is a generic pool, or a person with
  no account), which hid the five documents somebody could act on. So
  `RemoteStatusReport.blocked` names that subset with the reason per field, and
  `pendingAhead` in `src/shared/remote-status.ts` is the one definition of
  "what a sync would really write" — the CLI, the Sync tab and an agent all read
  it rather than each subtracting the sets. **Every blocked field carries a
  `remedy`**, because a reason on its own tells somebody they have a problem and
  not what to do with it: "Web Developer cannot be assigned on this remote" is
  true and leaves the question *so what?*. The remedy is derived from the roster
  and the mapping (`assigneeBlock` in `report.ts`), never by matching the
  provider's reason text, which would break the first time anybody rephrased one
  — and it is absent rather than invented when there is nothing to suggest, so a
  reader can tell that apart from a suggestion nobody wrote. Both front ends
  group by *cause* rather than listing documents, **and count causes rather than
  documents**: there are only ever a handful, and one person with no account
  value held back 220 documents on this board — "392 blocked" reads as a mirror in
  serious trouble when the truth is five things to fix, one of them a missing
  email. The document count is the *size* of a cause, not its importance, so it
  rides the row and the tooltip; the number a reader acts on is how many
  decisions are waiting. Four things are load-bearing. The test
  is **only**: a document ahead on an unwritable assignee *and* a title is
  ordinary pending work, because the title will land. The unwritable map is
  computed by asking the **provider's own translator** what the request would
  carry, not by collecting its complaints — a generic pool reports no gap at all
  (it is encoded as a `pool:` label, which is a real mirror where labels are
  written and nothing on Jira, which writes none), and asking only about gaps
  found 220 of the 440. It is pure, so it rides the **local** half and needs no
  credential. And `planStatus` takes the map rather than deriving it, because that
  file knows nothing about providers; absent means "nothing known to be
  unwritable", which reports nothing blocked rather than guessing a change will
  land.
- **The buckets are named after the action, and the table is what makes them
  readable.** `ahead`/`behind` named the board's *position*; `to push`/`to pull`
  name what happens next, which is what a reader is deciding about. `behind` and
  `incoming` fold into one `to pull` count because the answer to both is "pull",
  and they stay separate **rows** because the actions differ: one updates a
  document that exists on both sides, the other creates one the board has never
  had. The three directions are not a fresh judgement either — they are exactly
  what the three-way merge already decided per field (`planConflicts`): the board
  moved and the tracker did not (`push`), the tracker moved and the board did not
  (`pull`), both moved (`conflict`). `ChangeRow` in
  `web/src/features/drawer/remote/remote.svelte.ts` groups them and nothing more,
  off the report's own `verbose` detail, so a row can never disagree with the tile
  that led the reader to it. A document that moved both ways gets a row in each
  direction, because it genuinely has work to do in both.
- **A drift count carries its denominator, and `planStatus` computes both.**
  `RemoteStatusReport.remote` carries `scope`, `inScope` and `mirrored` beside
  `target`, because "433 ahead" is unreadable until you know whether the mirror
  holds one epic or the whole board — those two readings were a factor of twelve
  apart on this repository's board, and a reader concluded the report was broken
  when it was merely silent. Both numbers are computed in `planStatus` from the
  **same scope set that filters the buckets**, and `StatusInputs.remote` omits
  them so a caller cannot supply a denominator that disagrees with the numerators
  beside it. It rides the *local* half, so it costs nothing to have. The CLI
  prints it above the buckets (`scope  whole board  · 537 of 537 documents
  mirrored`); the **Sync tab deliberately does not** — it was tried as a card with
  a meter and taken out again, because on an unscoped remote it is a line that
  says "everything" every time you open the panel, and the panel already has more
  vertical content than a drawer shows at once. The fields stay on the report
  regardless: a scoped remote's numbers are unreadable without them, and a caller
  that wants to explain a count has them to hand.
- **The drift report has two halves, and only one of them needs the network.**
  `computeRemoteStatus` with `local: true` builds no connector and makes no
  request: the board and the link store say which documents have twins, which
  have never been pushed and which have been edited here since the last sync,
  and `remoteMissing` says why `behind`, `conflicted` and `incoming` are empty.
  The web reads that half on open, paints the panel from it, and *then* starts the
  tracker read — `RemoteState.autoCheck`, unawaited, selected remote only, once
  per remote per session, and never retried after a failure. **That reverses an
  earlier decision on purpose.** While the remote half was one request per twin
  (115 seconds on a 537-issue mirror) it was a click and nothing else; at one
  paginated listing (~9 seconds on the same board) making somebody press a button
  to learn whether their mirror moved is a step with no decision in it. What has
  *not* changed is why the split exists: the local half needs no credential and
  cannot fail, so it is what the panel is built from, and `autoCheck` is a
  separate call rather than a line in `load` because `load` also runs after a
  remote is connected or removed, where a tracker read is not implied. Still do
  not put it after a *sync* — the run has just said what it wrote.
  `lpm remote status --local` is the same split at the terminal.
- **The remote half is one listing, and that is what lets it see work nobody has
  pulled.** It used to iterate the **link store** and `connector.get()` once per
  entry: 537 sequential requests on this repository's own board, about two
  minutes — and structurally blind, because a loop over the links can only ask
  about documents the board already knows. A story added to a mirrored epic in
  Jira was invisible, so "Check the tracker" ran for two minutes and correctly
  reported nothing. One paginated `connector.list()` — the same call a pull makes
  — is ~11 requests for those twins and returns the whole project, so the one
  sweep answers `behind`, `unreadable` **and** `incoming`: remote issues with no
  local document, the sixth bucket and the only one not keyed by a local id.
  `planPull` already planned a `create` for an untwinned remote issue, so only
  the report was missing. Six things are load-bearing. **`list()` is called
  once** — a connector pages internally and returns the cursor for the *next
  pull*, so treating it as a continuation token asks for the same listing twice
  (a mistake made writing this, caught by the request count in
  `test/remote-report.test.ts`). **Progress comes from inside the listing**
  (`ListProgress`, the `onPage` callback on `list`), because nothing above the
  connector can see its pages, and a read that could only report "finished" is
  how this came to be indistinguishable from a hang. **Absence is only evidence
  from a full listing**, so `--changed` suppresses `unreadable` and `incoming`
  and sets `incremental` — the same rule as a pull. **A twin outside the
  connection's project reads as absent**, which for a report is the better
  answer and is safe because nothing is written on it. **A board with nothing
  mirrored reads no tracker at all**, because every remote issue would anchor
  nowhere and a listing could only report a tracker's whole contents as work to
  import — the same judgement `coverage` makes, and it keeps "in sync with no
  request" true for a board with nothing to sync. And **scope is evaluated
  through the pull's own walk**, `anchorResolver` in `src/remote/anchor.ts`,
  shared by `planPull` and the report so the report offers precisely what a pull
  would adopt; a second copy of it would offer work the pull then declined to
  take. `computeRemoteStatus` is covered offline by `test/remote-report.test.ts`
  over the `jsonfile` provider — before that it was reachable only from
  `remote-live.test.ts`, which is opt-in and skipped on every ordinary run,
  which is why both defects shipped.
- **Two reports about a mirror, and only one of them needs a credential.**
  `computeRemoteStatus` answers "has anything drifted?" and reads the tracker.
  `computeRemoteCoverage`
  answers "is what the tracker holds a coherent piece of the plan?" from the
  board and the link store alone: no request, no credential, re-read after
  every push. They are separate calls for that reason, and the web reads
  coverage *before* it waits for drift, because the gap list is wanted exactly
  when somebody is halfway through filing a board. The rule the analysis turns
  on: a document is worth reporting because **something mirrored points at
  it** — the container above it, the work inside it, the period it was filed
  without, the far end of a dropped edge — never merely because it is unpushed.
  `unlinked` already says that, and on a board mirroring one feature it is the
  whole backlog, which is a true list nobody can act on. Two kinds are reported
  and never offered, because both were decided: a tombstoned document and one
  outside the remote's scope. The ticked gaps push as `only`, never as `scope`
  — see the next rule for what the difference costs.
- **Scope is what a remote owns; a selection is what a run is about.** They are
  different fields on `RemoteSnapshot` (`scope` and `only`) and conflating them
  is destructive, not untidy: the gone pass reads `scope`, so narrowing it to
  say "just push this one" tells the planner every other twin has left the
  mirror, and a selective push decouples the rest of the board. `only` filters
  what is created, updated, reparented, edged and commented; the gone pass and
  `refOf` never consult it — a selected child whose parent is already filed
  still names that parent. A document id given to `push` is a selection; one
  given to `pull` or `sync` is a scope, where narrowing can only ever consider
  fewer twins. `RunSyncOptions.scope` turns into a selection on the push side
  for exactly this reason.
- **Absence is only evidence when the listing was exhaustive.** Two listings are
  not: a targeted pull (`lpm remote pull PAY-31`) fetches what was named, and an
  **incremental** one holds only what changed since the cursor. Both set
  `RemoteSnapshot.partial`, and two things then stand down: `planPull` plans no
  gone-twin work, and `resolveLifecycle` assesses no twin at all
  (`assessRemote`), which is also what stops the bulk guard reading either as a
  mass deletion. The incremental half was a live bug: every ordinary second pull
  read each unchanged twin as absent, which tripped the guard on a healthy board
  — and, under the threshold, would have applied the `on_delete` policy to work
  nobody deleted. Existence is reconciled against a **full** listing only, which
  is the default — `--changed` is the opt-in incremental listing, for a remote
  big enough to want it. A targeted pull does not move the cursor either.
- **A plan is filed a piece at a time, and the shape heals.** Pushing a story
  before its feature files it at the tracker's root, which is fine and expected;
  what is not fine is leaving it there for ever. The base snapshot records the
  *local* parent, which never changes in that case, so the link entry records
  what was actually filed (`LinkEntry.parentRemoteId`: the remote id, or `null`
  for "filed at the root"). `planPush` emits a `reparent` when the board's
  parent has since become resolvable and is not what was filed — including a
  parent created in the same run, so pushing the feature moves its stories
  immediately. An older link that never recorded one reads as **unknown** and
  changes nothing; treating unknown as "rootless" would reparent every twin on
  the board the first time anybody pushed after upgrading. The CLI helps by
  always adding a named document's *linked* descendants to the selection.
- **A native parent chain is spent at one end of the board, and which end is
  the provider's to say.** A tracker holds N parent levels; a board has more.
  `hierarchyAnchor` on the capability table decides where they go: `root` (the
  default) gives them to the shallowest levels, which is right for a *type-blind*
  edge like GitHub's sub-issues, and `leaf` to the deepest, which is right for a
  hierarchy defined from the bottom up — Jira's `Subtask` < standard < `Epic`,
  where only a standard issue may sit under an Epic. This is not a preference:
  anchored at the root on a five-level board, every native edge light-plan wrote
  to a team-managed Jira project was one Jira refuses (`Epic` under `Epic`),
  while the one relationship it *would* hold — the work item under its
  container — degraded to the block, and a filed board came out flat.
  `resolveHierarchyEncoding` turns anchor + depth into `nativeFrom`/`nativeTo`,
  `parentIsNative` is the one predicate, and `HierarchyRecord.anchor` makes a
  change of anchor a **carrier switch**, so existing twins are re-parented in
  place rather than half filed one way. Two smaller traps came with it: a
  connector that cannot `reparent` reports every migration as *skipped* and the
  shape never changes (Jira had none), and a parent reference must go in the
  field the platform reads — Jira takes `{ id }`, and the remote id passed as
  `{ key }` comes back as "Please select valid parent issue", which reads like a
  hierarchy problem and is not one.
- **An encoding belongs at the wire, not in the translator.** Jira's
  description is ADF, and the conversion used to happen in `describeRequest` —
  which broke the managed block on Jira completely and silently: the executor
  composes the block *in markdown* and skips a body that is already an object,
  so the degraded parent, the degraded period levels and the block-carried
  edges never reached Jira at all, while a block rewrite sent raw markdown and
  was refused. The translator now leaves the body as markdown (block stripped,
  because composing it is the executor's job) and `fieldsOf` converts at the
  last moment. The general rule: a translator maps *vocabulary*, a connector
  owns the *format*. And when a format has exclusion rules, they belong with
  the converter — ADF's `code` mark cannot be combined with `strong`/`em`, so
  ``**`x`**`` (ordinary markdown, and all over this repo's own issues) made
  Jira reject the whole description until `addMark` learned to drop the losing
  mark.
- **What a push writes, the remote is the authority on.** `preflightPush` is
  pure and offline, which is right for the board's own values but cannot answer
  "does this project have a type called `Program`?" — a mapping can name
  anything. So a push that **creates** anything asks (`connector.vocabulary()`)
  and refuses before writing, with the names the project does have
  (`vocabularyProblems`). Only on creates: a type name is written on a create,
  and a steady-state push of updates should not pay for two requests. The claims
  it checks come from `mappingClaims`, the one definition, shared with the setup
  conversation so the two cannot disagree about what the mapping promised.
- **A connector never knows board vocabulary.** Two `Connector` contracts and
  they never meet: the provider's (`src/remote/provider.ts`) speaks board words
  (`create`/`update`/`get`/`link`/`comment`); the transport's
  (`src/remote/transport/`) speaks wire words (`request`/`paginate`/`close` over
  `method`/`path`/`query`/`body`). The provider's `translator` is the only seam
  between them. The boundary is enforced, not hoped for:
  `test/remote-transport-isolation.test.ts` fails if any file in `transport/`
  imports `src/core` or `src/shared`.
- **The base snapshot is written from the remote's response, not the request.**
  After a successful write the connector echoes the issue back as it stands
  *after* the write (`ConnectorResult.record`), and the executor recomputes the
  base snapshot from that echo — so a remote that normalises markdown, reorders
  labels or silently rejects half an update is absorbed into the base instead of
  coming back as a phantom remote edit on the next pull. **A remote whose body
  format is not markdown needs the other half of that**: Jira stores ADF, which
  has paragraphs but no source line breaks, so a hard-wrapped body comes back
  unwrapped and every document is permanently ahead — the push rewrites all of
  them and does it again next run. Such a provider declares
  `Translator.normalizeBody` (the round trip the remote will perform anyway) and
  the board's own body goes through it before hashing, so the comparison is
  like-for-like. It is applied only to a *board* body being compared against a
  base — never to prose the remote just echoed, which has already been through
  it — and it must be idempotent.
- **A document must survive its own translation, and
  `test/remote-translation.test.ts` asserts it for every provider.** The single
  property behind every spurious-drift bug: drift is decided by comparing the
  board against what the *remote reports*, so a document is reported as changed
  when nobody changed it exactly when `describeRequest` → the platform →
  `fieldsFromRecord` does not come back where it started. The suite composes the
  four things that decide a translation — the board config, the mapping, the
  platform's **known restrictions**, and the document — and asserts that
  **nothing comes back different**. Note the deliberate asymmetry: a field the
  translation does not carry at all is *not* drift, because `baseFromRecord`
  falls back to the board's own value for it, which is exactly why omitting a
  field is a complete fix and writing `null` is not. Two things keep it from
  being decorative. The `echo` double must model what the platform really does
  rather than mirror the request — a double built from the same misunderstanding
  as the connector round-trips it perfectly and passes, which is how these
  defects shipped — so every restriction it models carries its evidence in a
  comment, and a live measurement says so. And where the platform's *format* is
  real code (Jira's ADF), the double calls that code instead of imitating it.
  Check a new rail by removing the fix and watching it fail; this one was.
- **A managed-block delimiter only counts when it begins a line (LP-534).**
  `splitManagedBlock` and `scanBlocks` used to match the first `<!-- lpm:begin -->`
  *anywhere* in the body, so a document whose own prose described the delimiters
  had everything between its two mentions replaced by the block — on every push.
  Five documents on this repository's board were corrupted that way, and because
  the damage landed on the **remote** while the board was untouched, they then sat
  permanently `to push` with nothing anybody had edited: a bug whose symptom was a
  drift count. `renderManagedBlock` has always written the delimiters on lines of
  their own and every one of those prose mentions was mid-line, so the one
  predicate separates them exactly — and the read side must use it too, or the
  same corruption arrives from the other direction with the prose stripped on
  parse. What this gives up is stated in the tests: a marker glued onto the end of
  a prose line is read as prose, which loses the *fields* for one push and is
  recoverable, where the permissive reading destroyed prose and was not.
- **What the tracker cannot hold, the body carries — for every field, both
  ways.** Rung 4 of the degradation ladder is not a per-field favour, it is the
  contract that makes a board pushed from here and pulled down *somewhere else*
  arrive whole. A field that is neither native nor in the managed block is not
  degraded, it is lost. Two were. **Jira parsed the block on the way out and
  never on the way back**, so every degraded period level it wrote was pasted
  into the local body as markdown and discarded as data — github and linear had
  always parsed it. And **no provider carried an assignee it could not write**:
  no tracker can assign an issue to a pool (the assignee field is one user
  account on all three, and a "team" is not assignable anywhere), so github and
  linear encoded a pool as a `pool:` label and Jira encoded it as nothing, which
  meant a board assigning work to roles came back from Jira with an empty roster.
  `ASSIGNEE_FIELD` is now the block row, written by `assigneeEntryOf` in
  `execute.ts` whenever the request carries the value neither natively nor as a
  label — asked of the translator with a synthetic probe, because only it knows
  whether this provider writes labels, and `provisioning.labels` is about
  *creating* a label list and answers a different question. It is read back by
  `withBlockAssignee`, which folds the block's value into the labels the existing
  pool resolution already walks: one recovery path, not a second per translator.
  Two traps came with it. The body is recomposed when **`assignee`** changes and
  not only when the prose or the period does, or an assignee-only edit leaves the
  block saying what it said before. And the block value is a board **resource
  id**, the same thing the `pool:` label has always carried, so the two encodings
  cannot disagree. `test/remote-metadata.test.ts` is the guard, across all three
  trackers, on both sides.
- **A value the remote *derives* is not a remote edit, and the translator must
  not read it back.** The same family as `normalizeBody` and the other half of
  it. Jira does not let a sub-task be scheduled on its own: it reports the
  **parent's** sprint on the sub-task, the identical object, whether or not
  anything ever wrote it there. Read as the sub-task's own value it is drift
  nobody made — on this repository's board all 13 sub-tasks came back `behind` on
  `period`, permanently, because the board schedules the story and Jira echoes
  that sprint onto each child. `isSubtaskRecord` in the Jira translator omits the
  field, and **omitting is the whole fix in both directions**, because
  `baseFromRecord` falls back to the *local* value for a field the record does
  not carry: board and base agree, so nothing is ahead; there is no remote value,
  so nothing is behind. Three things about it. The field must be **absent, not
  `null`** — a null reads as "the remote cleared it". The test is the platform's
  own marker (`fields.issuetype.subtask`), never a type *name*, which a project
  may rename or localise, and never the board's type name, which says nothing
  about what Jira thinks. And pulling it would not have settled anything: it
  writes a derived sprint onto documents the plan schedules one level up, which
  changes what the periods view and the Gantt add up, and drifts again the moment
  the parent moves sprint. Before reaching for a pull to silence drift, ask
  whether the remote *owns* the value at all.
- **Editing is queued, never immediate.** Every user action goes through
  `Workspace.record`, which applies the change to the working copy *and* appends
  it to the view's queue in one call. `web/src/lib/board/working.ts` has the only
  applier, used both for live edits and for replaying a reopened view — keep it
  that way or the screen and the pending list will drift.
- **Three change kinds, because every field travels as a patch.** `create`,
  `update`, `delete`. `sync/patch.ts` decides which core operations a
  patch implies and in what order (retype/reparent, then status/period/assignee,
  then rename/body/attributes, then links); `appendChange` merges consecutive
  updates so a dragged slider pushes one change.
- **A push is partial, not atomic.** `applyChanges` tries every change, returns
  the ids that landed and the failures, and the client keeps the failures
  pending. Do not "fix" this into all-or-nothing — earlier changes are already
  on disk by the time a later one fails. What stays pending is re-queued through
  `remapChanges`, because a rejected change may point at a document the same
  push created: left naming a spent `new:` id it could never land again, however
  many times somebody pressed Push. `remapPatch` beside it is the one list of
  which patch fields carry a reference, and `PushSession.resolvePatch` is the
  same call — a new id-bearing field goes in `ID_FIELDS`/`ID_LISTS` or it will
  be remapped in one direction and not the other.
- **The push session reloads between steps.** Core operations write straight to
  disk, so every `LoadedBoard` handle is stale afterwards; `PushSession.reload()`
  is cheaper than teaching the engine about in-place updates.
- **A push takes the board lock for the whole replay, not one change at a
  time.** A push is somebody's draft of the plan — a create whose links land
  three changes later, a sprint the next four issues are scheduled into — and
  letting an agent claim work out of the middle of it would show that agent a
  board nobody ever intended. The operations inside take the same lock and find
  it already theirs. It is still partial rather than atomic in the *other*
  sense: a failing change does not roll back the ones before it.
- **A view is not board truth.** Nothing in `board/` or `validation/` may read
  one, and `pruneView` drops members the board no longer has.
- **The client mirrors the engine's rules, it does not own them.** `wouldCycle`
  and `previewReparent` exist to refuse an impossible edit before it is queued;
  the board still validates on push. If you add a rule to core, mirror it there
  or the UI will queue work that cannot land.
- **The Sync tab is three bands, and which number leads is a decision.** It was a
  flat stack of loose paragraphs — a scope line, two rows of buttons, a status
  line, a denominator sentence — each true and none grouped, so a reader had to
  assemble the meaning. It is now **the bar** (which remote, where it points, the
  controls that change the *connection*), **the status card** (what state the
  mirror is in and the two buttons that change it, first so the primary action is
  never below the evidence) and **the evidence** (the counts and the table of
  documents behind them). Two rules keep it from drifting back. The
  visual language is the drawer's own — a sticky toolbar over a scrolling body,
  hairline borders, `--surface-1` cards — and every colour is a token, so light
  and dark both work without a second palette. And the *ranking* lives in
  `remote.svelte.ts` (`primaryTiles` / `secondaryTiles` / `changeRows`), never in
  the markup: which numbers lead, and that blocked rows sort last so a first page
  is work somebody can do, are judgements with tests, not layout.
- **The changes table lists what a sync would *do*, and a tile narrows it.**
  Two rules, one lesson. The table is built from `pendingAhead`, not from
  `ahead`, so a document this remote cannot write is not in it — including all
  435 of them was a table whose own caption ("what a sync would do, document by
  document") was false for 428 rows, and which buried the five somebody had
  just clicked **to push** to find. Those documents are not lost: the *to fix*
  chip counts them and opens `BlockedDialog`, grouped by the cause they share,
  which is the only form in which hundreds of anything is readable. And a
  primary tile
  (`focusChanges`) **filters the table** rather than only selecting ids on the
  canvas — a view holds a few dozen nodes and the documents a sync would write
  are usually not among them, so a tile that only selected read as a button
  that does nothing. **And it scrolls the table into view**, because the panel
  is a scrolling body — 1156px of content in a 382px window on an ordinary
  laptop — so the evidence sits well below the counts and narrowing it from up
  there changed something nobody could see. That is the same complaint a third
  time, which is what makes it a rule rather than a tweak: a count a reader can
  click has to *bring them to* what it is a count of. Answering where they are
  looking is the whole job; selecting on the canvas is a bonus that only shows
  when those documents happen to be in the view.
- **What the tracker cannot store is a window, not a section.** It used to
  expand under the counts, and a standing list of things somebody cannot fix is
  how a true report becomes one people stop reading: most of these are not
  defects at all — a board that assigns work to pools when no tracker has
  pools, a person with no account on the platform, a field with nowhere to go —
  and they will not be closed this week, if ever. So the chip keeps the number,
  because the fact is worth having, and `BlockedDialog` holds the explanation
  for the afternoon somebody decides to deal with it. The rule generalises: a
  count belongs on the panel, an explanation nobody can act on today belongs
  one click away.
- **A saved pane size is a wish, bounded by the window it is replayed in.**
  `paneFit` in `lib/ui/scale.ts` clamps the drawer to the room there is and
  keeps `MIN_CANVAS` for the board, because a height saved on a big screen is
  destructive on a small one rather than merely large: 865px saved, opened in
  an 808px window, left the canvas at **zero** height and hung the drawer
  100px below the bottom of the screen — and since collapsing and reopening
  did exactly the same thing, it was reported as a toggle that does not work.
  The splitter's `max` is the same bound, `.shell` has `overflow: hidden` as
  the backstop, and the *saved* number is deliberately left alone so the view
  is tall again on the screen it was made for. The reveal button names the tab
  it will open (`drawerTabLabel`), because the list it used to spell out went
  stale the moment the Sync tab was added.
- **Components are presentational.** Props in, callbacks out; decisions live in
  a `.ts`/`.svelte.ts` beside them (`menus.ts`, `mutations.ts`, `graph.svelte.ts`,
  `rows.ts`, `schedule.ts`, `roster.ts`). That is what makes the web tests
  DOM-free, and it is the rule to preserve when adding a panel.
- **The canvas talks to a `GraphSource`, not to the workspace.**
  `features/canvas/source.ts` declares the handful of things `CanvasGraph` needs
  — nodes, config, members, layout, selection, collapse — and both the editor's
  `Workspace` and the viewer's `ViewerBoard` satisfy it *structurally*, so `$lib`
  never depends on `$features`. `provideGraphSource` is where a mismatch is
  caught, and it is also how `IssueNode`/`GroupNode` get their collapse and
  resize handlers (SvelteFlow builds those itself, so they cannot be props). One
  consequence worth keeping: there is exactly one implementation of "where does a
  node sit and how big is a subflow", and the two apps cannot drift apart on it.
- **Geometry is view state, and `layout.ts` owns all of it.** A `NodeLayout`
  carries a position and, only for a node someone dragged a corner of, a size.
  Three rules live in that one file and nowhere else: `fitGroups` grows a subflow
  in both directions to hold its children and treats a hand-dragged size as a
  floor (never a ceiling — nothing may clip a child out of sight); `placeNewNodes`
  gives fresh nodes a place beside the settled ones and moves nothing that
  already had one; `layoutGraph` flows left to right and asks each node for its
  own width, so a widened node keeps its neighbours at arm's length. A resize is
  in `CanvasGraph.signature()` because the subflow around it has to be measured
  again; a drag is not, because only the dragged node moved.
- **The viewer holds folding apart from positions.** A `NodeLayout` cannot say
  "collapsed, but put it wherever you like", and `CanvasGraph` treats any layout
  entry as a saved position — so seeding coordinates to express a fold would rob
  the graph of its automatic layout. `ViewerBoard` keeps a separate collapsed
  map, which is what lets "All issues" open folded and still lay itself out.
- **Appearance is the reader's, never the view's.** Theme, accent and text
  size live in `localStorage` (`lib/app/preferences.svelte.ts`), because a view
  is committed and inheriting a teammate's dark mode on pull would be absurd.
  They reach the page as three attributes on the root; every colour token in
  `app.css` is one `light-dark()` pair, so a theme is a `color-scheme` and never
  a second palette. A new colour token is a pair, and a new accent stays off
  orange, which is `--highlight`'s.
- **`statusTone` is a UI-only heuristic.** The engine knows `terminal` and
  `active`; the five colour families are derived from those plus the status name.
  Do not push that vocabulary back into the config.
- **"Now" is read off the documents, never configured.** `lib/board/periods.ts`
  calls a period current when it contains today *or* when its `active` switch
  says so, and when periods nest only the innermost running one on that chain
  counts — an epic parked on the increment is in flight for a quarter, which is
  not the same claim as a story in this week's sprint. "Innermost" is per chain
  and not the deepest period on the board, or a sprint running in one increment
  would steal the badge from another increment somebody switched on by hand.
  The date is passed into `buildGraph`, not read from the clock inside it, so a
  test can say what day it is; only `CanvasGraph` reaches for `todayIso()`.
  Because a node draws its periods' names, dates and switch, the period
  documents are part of `CanvasGraph.signature()` — renaming a sprint or
  switching one off has to redraw the badge.
- **The switch is one field, and it is not symmetric.** `active` on a period is
  `true` (running whatever the dates say), `false` (parked) or **absent**, which
  is the ordinary case and means the dates decide — so `null` in a patch removes
  the key rather than writing `false`, and nothing may default it. `off`
  cascades to everything nested inside (parking an increment parks its sprints);
  `on` speaks for the period it is written on, because a live quarter never
  meant all six of its sprints are this week. `periodStance` lives once in
  `src/shared/period-stance.ts`; `core/board/query.ts` and
  `web/src/lib/board/periods.ts` both adapt their data shapes to it, so
  `lpm task next` and the canvas cannot disagree about what is now. It steers what is *offered* and never what is
  reachable: a switched-off period's work is **withheld** by `candidatesFor`
  (`isParked` in `board/tasks.ts` is the one definition, `includeParked` asks
  for it back, and then it ranks below even unscheduled work). Ranking it last
  was not enough — "last" becomes "next" as soon as the rest of the queue empties,
  which handed a team the six sprints it had just parked. A period that merely
  *ended* still ranks first: overrunning work is the most urgent thing on a
  board, and only the switch moves work down.
- **Collapsing and badging are opposites, and `visibleTree` owns both.**
  Collapsing hides what is *inside* a node and the node stands in for it;
  badging a level (`view.display[type] === 'badge'`) hides the node itself,
  hoists its children to whatever is drawn above and hands them its id to wear.
  A badged issue's own dependencies roll up to its drawn ancestor, exactly as a
  collapsed one's do, and a badged issue with nothing under it to carry the
  badge is drawn anyway — a way of looking may not lose work. Badging changes
  every child's parent, and a saved position is relative to that parent, so
  `CanvasGraph.sync` re-arranges when the display digest changes.
- **Two ways of working, one set of documents, and the switch is board
  config.** `planning: queue` in config.yml (`lpm planning`, or the switch at the
  top of the queue panel) reads the whole board as one PI holding one sprint
  holding everything. It used to be `view.planning`, and that was the bug: the
  browser stopped drawing sprints while `lpm task next` still ranked by them, so
  the reviewer and the developer were reading two different queues. Now the
  engine reads it through `scheduleOf` in `board/tasks/ranking.ts`, the one place
  a period reaches ranking. In queue mode it returns no period, so the schedule
  rank, `isParked` and `squadBars` all stand down together. The browser reads
  the same key through `ConfigDto.planning` and `plansWithPeriods`, and every
  period surface (tabs, node badge, panel field, table column, "Schedule into",
  the digest's *Now*) asks that one predicate. Two properties are load-bearing.
  **No document is touched.** `setPlanning` edits the config as *text*, appending
  one commented line and removing exactly that line again. The `yaml` round trip
  `editConfig` does would reformat flow collections, and the shipped configs mix
  `[a, b]` with `{ remote: x }`, which no single `toString` option reproduces.
  The round trip is byte-identical, and `test/planning.test.ts` asserts it.
  **It is written straight through, like a flag** (`PUT /api/planning`), because
  it is config and not a change to the plan. A board whose config declares no
  period types is always in queue mode (`planningOf`). A view file still carrying
  `planning` opens with the key dropped.
  **A new board starts in queue mode.** `initBoard` calls `configWithPlanning`,
  the function `setPlanning` uses, so `lpm init` and `lpm planning queue` write
  the same four lines and `lpm planning periods` removes either. An absent key
  still means `periods`, so a board created before this default does not change.
  `makeBoard` in `test/helpers.ts` and `init` in `test/cli.test.ts` ask for
  `periods`, because most tests build a timeline to check what a sprint does.
- **The vocabulary of a board changes through one operation, and a rename
  reaches every file that holds the name.** `editBoardConfig` in
  `core/operations/config-edit.ts` takes a list of `ConfigEdit`
  (`src/shared/board-config.ts`). An edit adds, changes or removes a type, a
  status or an attribute. The web dialog **File ▸ Board configuration…**
  (`web/src/features/config/`) sends the list to `POST /api/config/edits`
  (`server/routes/config.ts`). The rules:

  - **The config is edited as a `yaml` document.** `parseDocument` keeps the
    comments and the key order. The operation writes the text with `lineWidth:
    0` and `flowCollectionPadding: false`. Those two options reproduce the
    text of the shipped `scrum` template, and `test/board-template.test.ts`
    asserts it. A flow mapping with padding, such as the `{ remote: x }` that
    `lpm remote add` writes, loses the padding. `setPlanning` stays a text edit
    for that reason.
  - **Each edit is validated against the result of the edits before it.**
    After each edit the operation parses the text with `parseConfigText`. A
    result that does not validate throws, and nothing is written. The first
    write happens after the last check, so a list is applied whole or not at
    all.
  - **The board is loaded inside the lock.** The operation takes paths, not a
    board handle, and calls `withBoardWrite` directly, as `claimIssue` reloads
    inside the lock. `requireUnchanged` still runs on each document before the
    first write, because an editor can write a file without the lock.
  - **A rename follows the name.** A new type name rewrites the field `type` of
    each document of the type. A registry template carries an issue type, so
    `documentsOf` counts it as a document of the issue namespace. A new status
    id rewrites `status` and `default_status`. A new attribute name moves the
    value in each document of the type. The keys of `mapping.types`,
    `mapping.statuses`, `mapping.attributes` and `fields` of each remote under
    `remotes` and `remotes_off` follow, and so does `mapping.periods.container`
    for a period type. `priority_attribute` and `effort_attribute` follow an
    attribute rename when no other issue type still declares the old name. The
    file `.lpm/templates/context/<type>.md` is renamed with its issue type.
  - **The field `updated` of a rewritten document does not change.** The
    document says what it said before.
  - **Core does not read a view file, so the server renames the keys of
    `display`.** `editBoardConfig` returns `renamedTypes`. The route passes it
    to `renameViewTypes` in `server/views/store.ts`, and the web app passes it
    to `Workspace.renameTypes` for each open tab. Without the second call, the
    next save of an open tab writes the old key again.
  - **Three edits are refused because no rewrite makes them valid.** A removed
    type or status that a document holds, a removed enum value that a document
    holds, and a new level above existing documents. A document keeps its
    folder, so a new level puts each document at that depth one level above the
    level of its type. `insert_between` is the operation that creates a parent
    document. The operation does not call it, because a config edit creates no
    document.
  - **The edit is written straight through, like the planning mode.** A view
    queues changes to the plan. A config edit changes the words that those
    changes use. `ConfigEditor.apply` first flushes every open tab and refuses
    while a tab still holds a pending change.
  - **A developer profile is out of reach.** A profile is a file outside
    `.lpm`, so `scope.types` keeps a renamed type. `ConfigEditResultDto.notes`
    says so, and the dialog shows the notes until the next action.

  The dialog reads `ConfigDto` and the snapshot. `features/config/model.ts`
  derives the rows and the document counts as pure functions, and
  `editor.svelte.ts` holds the request state. The components are presentational.
  **The dialog is the one place for the settings of the board, and
  `shell.configTab` says which tab is open.** The value is `types`, `statuses`,
  `remote` or `templates`, or null while the dialog is closed. File ▸ Board
  configuration… opens `types`. File ▸ Remote board… and the button **Mapping…**
  of the Sync tab open `remote`. A new settings surface is a tab of this dialog
  and a menu entry that calls `shell.openConfig`, not a dialog of its own.

  The tab **Remote board** (`features/config/remote/RemoteBoardTab.svelte`)
  holds no decision. It reads the three state machines of the Sync tab
  (`GitState`, `RemoteState`, `ConnectionsState`), so the two surfaces cannot
  disagree. Its section **Trackers** is drawn only when `remote.enabled` is
  true. `Workspace.svelte` mounts `GitSetupDialog` and `ConnectDialog` once,
  after the configuration dialog. The Sync tab used to mount them, and a dialog
  that the drawer mounts does not exist while the drawer is closed.

  A dialog can now open a dialog, so `Modal.svelte` keeps a module-level stack
  of the open dialogs and only the newest one closes on Escape. Before the
  stack, each dialog listened on the window and one key press closed them all.

  No CLI command and no MCP tool calls `editBoardConfig` yet. Each one that is
  added must call that function and must not edit the config another way.
- **A board template is a config file, and the user folder holds the ones a
  person saved.** `lpm init --template <name>` resolves a name in this order: a
  built-in template (`templates/<name>.yml` of the package), a user template
  (`templates/<name>.yml` of the user folder), then a path. `readBoardTemplate`
  in `operations/board-template.ts` holds that order. `saveBoardTemplate` writes
  a user template from `.lpm/config.yml`. `boardTemplateText` removes the keys
  that describe one board: `remotes`, `remotes_off`, `git_sync`,
  `default_period` and `planning`. `lpm init` without `--template` calls
  `defaultBoardTemplate`, which reads the key `default_template` of
  `settings.json` in the user folder and falls back to `scrum`. The user folder
  is `~/.light-plan`, not `~/.lpm`: `findBoardPaths` reads a `.lpm` folder as a
  board, and a board in the home folder would answer for every project below
  it. A board does not record the template that it started from. The root
  `vitest.config.ts` sets `LPM_HOME` to a folder that no test creates, so
  `initBoard` in a test never reads the `~/.light-plan` of the person who runs
  the suite.
- **A queue stays inside the part of the plan that is already moving, and
  `src/shared/cohesion.ts` is the one definition.** Two ready stories in two
  unrelated features used to be separated by priority, column and then *id*, so
  the queue handed out one story from each feature in turn and left them all
  half built — a board telling a team to context-switch. Work whose container is
  already under way now comes first. Three things in it are load-bearing. **It
  is asked of containers, from the root down**: two candidates are compared at
  the first ancestor they do not share, which is the one level at which they are
  genuinely alternatives — so an epic under way is preferred before its features
  are ever consulted, and two stories in the same feature are never separated by
  it. **In flight beats further along, and completion is a share rather than a
  count**, so nobody is pulled out of the feature somebody is inside right now
  and a large container gets no advantage from merely holding more work.
  And **it sits below the three signals a person set by hand** — the schedule,
  the priority, the column — and above the graph heuristics, because it is a
  tiebreak between work nobody has ranked and not a way to out-vote a planner.
  `TaskOptions.focusParent` is the emphatic form of the same idea and is still
  the only one that outranks the schedule; core adapts a `LoadedBoard` to
  `CohesionLookup` in `board/tasks/ranking.ts`, the browser adapts its working
  copy in `lib/board/selectors.ts` (`cohesionOrder`, read by both the queue
  board and the digest), and neither may grow a second copy of the walk.
- **The queue panel's order is the engine's, not the browser's.** It asks
  `GET /api/queue` (`simulateQueue`, with `null` for "Everyone", which is the
  whole team's queue: `nextTasks(board, null)` routes every open work unit to
  the reader). It numbers every card with the step it gets. Ranking was mirrored
  in the browser before, and it drifted: the panel dropped the schedule rank and
  the column, so it disagreed with `lpm task next` on any board that had sprints.
  `QueueSequence` asks again only when `sequenceKey` changes, which is the
  fields the order depends on, read off the *snapshot*: the engine answers for
  the disk, and the board is polled every five seconds. The local ordering in
  `queue.ts` stays, but only as the fallback for a card the engine has not seen
  (an unpushed create) and for a server that did not answer. Lanes are still
  decided locally, so Start and Finish move a card at once.
- **"What is ready?" is defined once.** The landing page's digest and the queue
  board both rank work, so `isTerminal`, `isActive`, `priorityRank`,
  `statusRank`, `isWorkUnit`/`workUnitsOf`/`workUnitsUnder` and `blockersOf`
  live in `lib/board/selectors.ts` and both import them. A board where the
  digest and the queue disagreed about what can be picked up would be worse than
  either. `isWorkUnit` is the browser's copy of the engine's rule and takes the
  `ConfigDto` for it, because `atomic` is a property of the type — every caller
  that used to test `childrenOf(...).length === 0` now goes through it, and the
  queue, the digest's pathways, the roster, the critical path, the periods
  effort sums, the Gantt's unscheduled list and `scheduleLeaves` are all of
  them.
- **Two planners rewrite dates, and nothing else does.** `planStartNow` (in
  `src/shared/plans.ts`, because all three front ends start a sprint) puts today
  inside a period, shifts everything nested in it by the same number of days,
  closes whatever was running and stretches the periods above; `planResequence`
  (in the periods view, because dragging a box is a gesture with no CLI
  equivalent) reorders a run. Both return a plan rather than making the edits,
  so a view can ask first, and both keep what the calendar means — each period's
  own length, and the gaps between them. The engine still learns dates only from
  documents.
- **Rescheduling issues in bulk is `planCompletePeriod` / `planCarryOver`, and
  only on request.** They are the two answers to a sprint that ended with work
  still in it, they act only on issues scheduled *directly* in that period (an
  increment answers for its epics, its sprints for their stories), and
  `planCarryOver` **refuses** when there is no next period rather than
  unscheduling the work. Nothing creates a period to hold the overflow: work
  piling up in the last sprint is the fact a reader needs to see.
- **Alt+drag carries an issue off the graph without moving it.** `carry.ts`
  takes the drag over from a capture-phase pointerdown, exactly as `pan.ts` does
  for Ctrl — SvelteFlow never starts a node drag, so no node moves, no position
  is written and there is no drag for the viewport to auto-pan along with. That
  is the whole design: scheduling an issue into a sprint is not a change to the
  picture, so the picture must not change. Do not reach for `onnodedrag` here;
  it fires only when a node's *position* changes, and a node inside a subflow is
  clamped to its parent, so it goes quiet exactly when it is carried out.
  Where the pointer comes up decides what the carry meant: a box in the Periods
  drawer schedules the work under it (`periodDropAt`, which lives beside the
  component emitting `data-period-drop`, because a pointer drag has no drop
  targets of its own), an edge splices it into that dependency, anything else is
  a change of mind. The two modifiers are exclusive by construction — `isCarry`
  refuses Ctrl and Cmd, `isCameraPan` requires one — so their order in the
  handler is not load-bearing.
- **Highlighting is not selection.** `highlight.ts` answers "what is one hop
  from here?" and `CanvasGraph.refreshHighlights` writes the answer onto the
  flow arrays. It never touches `Selection`, and it never rebuilds the graph —
  clicking around a large board has to stay free. An edge's selected state
  lives on the flow edge rather than in the store, which is why the pane and
  edge click handlers clear it themselves.
- **`markdown.ts` renders by escaping first.** It escapes the whole source,
  then only ever *adds* tags around already-escaped text, and links only
  `http`/`https`/`mailto` — which is what makes `{@html}` in `Markdown.svelte`
  a claim about that file alone. Do not swap it for a library that parses and
  emits, and do not use it in `web/src/viewer/`: a published board is read from
  a URL a stranger supplied, and "plain text, always" needs no argument about
  escaping to believe.
- **`server/http/static.ts` resolves `web/dist` and `web/dist-viewer` from its
  own depth**, like `operations/init.ts` and `templates/`. Moving the file breaks
  `lpm ui` and `lpm export --site`. `cli/commands/agent/assets.ts` resolves
  `assets/` the same way, and breaks the same way.
- **`assets/` is the only copy of the agents and skills.** This repo's own
  `.claude/agents` and `.claude/skills` are *generated* — `lpm agent --target
  claude --project --force` reproduces them. Edit the asset, then regenerate;
  editing `.claude/` directly means the next install ships the old text.
- **An hcm bundle is rendered, never kept.** `assets/hcm/<name>.yml` is a list
  of the same copy rules a harness mapping holds (`ruleSchema`, placed by
  `placementsFor`) plus the manifest fields a person chooses; a file that
  belongs to the bundle and to no harness (its MCP server file) ships in
  `assets/hcm/<name>/` and is copied byte for byte; `lpm hcm init`
  renders it into a per-user data folder and runs `hcm registry add`. Do not
  commit an `hcm-bundle/` folder — it would be the second copy of `assets/` the
  rule above forbids — and do not register the package folder, which under npx
  is a cache npm clears. The version comes from `package.json`, so the bundle
  cannot drift from the release. hcm is run as a command, never imported, and
  never from an install hook.
- **An install never destroys what was there.** `install.ts` adds to a directory,
  merges a JSON config leaving its other keys alone, and replaces a delimited
  block in place rather than appending a second one. Only a byte-identical file
  is "unchanged"; anything else is skipped with a reason unless `--force`. A new
  target must keep all three of those, or `lpm agent` stops being safe to re-run.
- **No harness is named anywhere in `src/`.** A layout is data:
  `assets/harnesses/<name>.yml`, a list of `{from, to}` copy rules. Adding a
  harness is a YAML file, adding an asset is a file in `assets/`, and a rule
  matching nothing (or a file no rule matches) is reported rather than fatal.
  `test/harness-mapping.test.ts` greps `install.ts`, `assets.ts`, `index.ts`,
  `prompt.ts` and `glob.ts` for harness names and fails if one appears — if you
  need a branch for one host, extend the mapping schema for everybody instead.
- **A rule with `frontmatter:` rewrites markdown; one without copies bytes.**
  `install.ts` works in `Buffer`s throughout so a rule can carry a script or a
  binary, and so "unchanged" means unchanged rather than "equal after some
  normalisation". Asking to rewrite frontmatter on a file that has none is an
  error, not a guess.
- **The assets are runtime payload, never build output.** They are resolved from
  the package root and never compiled into `dist/`, so three things keep them
  shipping: `files` in `package.json`, the `make dist` check that every file
  under `assets/` and `templates/` is in the tarball (derived from the tree, not
  a list), and `make assets` in `make verify`, which loads every mapping.
- **Each mapping emits only the frontmatter its harness understands.** A key a
  harness ignores is harmless; one it validates and rejects is not — which is why
  a Copilot agent carries no `tools` list (the vocabulary is Copilot's, not
  Claude's) and why the bodies are copied verbatim for everyone. The layouts and
  the reasoning are in `docs/harness-layouts.md`; do not re-derive them from
  memory, they move.
- **If it cannot be written safely, print it.** Reasonix keeps user-level MCP
  servers in `config.toml`, and this package has no TOML support — so that
  mapping sets `mcp.user.advice` and the command shows the entry instead of
  guessing at somebody's config file.
- **An export is the board as committed.** `toStaticBoard` publishes
  `toSnapshot`'s output plus each view narrowed to `members` + `layout`. A view's
  queued changes are somebody's unpushed draft and must never travel — a
  published board showing them would be asserting something untrue. Members
  naming a document the board does not have (a pending `new:` id, a deleted one)
  are dropped on the way out.
- **The viewer renders bodies as text, never as markup.** It will read a board
  from a URL a stranger handed the reader, so a markdown-to-HTML step there is
  handing them the page. `resolveLocation` refuses any scheme but http(s) for
  the same reason, and the fetch omits credentials.
- **The viewer bundle needs relative asset paths.** `vite.viewer.config.ts` sets
  `base: './'` and the app routes on the hash, which together are what let the
  output be copied into `owner.github.io/repo/` and work with no rewrite rules.
  Both are load-bearing; neither is a style choice.
- **A change may reference something created later in the same push.** Copying a
  structure does exactly that, and so does the queue itself: `appendChange`
  merges an edit into the pending change for that document, which sits wherever
  the document was *first* touched, possibly ahead of the sprint or the teammate
  the edit now names. So the reference decides the order and the position never
  does. `sync/patch.ts` holds a create's links, period and assignee back and
  replays them once everything exists; `applyChanges` holds back any *update*
  naming an id the push has not allocated yet, and a create waiting only on its
  parent. Do not "simplify" either away, and do not rely on plan order to avoid
  them. Note the asymmetry is deliberate: a create is held back only for its
  parent, because deferring one that merely links forward would reorder id
  allocation for nothing.
- **Temporary ids come from a counter, never from the queue.** A planner asks
  for several ids before recording any of them, so anything derived from the
  pending list hands out the same id repeatedly (`Workspace.nextTempId`,
  `counterFactory`).
- **Comments are not board state.** They live in `_comments.md`, are read on
  demand, and `load.ts` never opens them — which is why `check` ignores them and
  why the web app writes them straight through instead of queueing them in a
  view. A comment records what already happened; holding it until Push would
  risk losing it.
- **A flag is not queued either, and that is why it is not in `NodePatch`.**
  Everything in the edit protocol is a change to the *plan*, staged so somebody
  can read it before it lands. `issue.flag` says work has stopped **now**, so it
  travels the way a comment does: a route of its own
  (`server/routes/flags.ts`), an API call of its own, `Workspace.setFlag`
  patching the working copy directly. The flag event is also appended to the
  issue body's activity section so the `_issue.md` file a person reads in a file
  tree is a self-contained record. Adding `flag` to `NodePatch`, the view
  schema or `patchNode` would put the one edit that cannot wait behind a button
  nobody has pressed. It *is* on the DTO, because the canvas has to paint it red.
- **A flag rolls up the way a status does, and `src/shared/flag-rollup.ts` is
  the one definition.** Whoever runs the plan reads the board from the top, and
  a story flagged four levels down was invisible from there — so a container
  carries `DERIVED_FLAG` (`inside`) while anything inside it is flagged, and
  loses it when the last one is answered. `flagIssue`, `clearFlag` and
  `moveNode` propagate (`propagateFlag` in `operations/rollup.ts`);
  `checkFlagRollup` reports a container out of step and `--fix` writes it, which
  is also where the two cases the operations deliberately do not chase are
  repaired — a deleted subtree and an issue reparented out of the container its
  flag was standing in for, exactly the pair the status roll-up leaves to
  `check` and for the same reason. Three things hold it together. **A derived
  flag is a different word from a raised one** — the roll-up writes and clears
  `DERIVED_FLAG` and nothing else, `flagIssue` refuses it as a reason, and
  without that separation a feature nobody flagged and a feature somebody paused
  are indistinguishable, so the clear could never be safe. **A flag of the
  container's own outranks it**, because `paused` says something more specific
  than "work inside stopped". And **no comment is written on a container** —
  `_comments.md` is where a person explains a stall, and one derived entry per
  ancestor per flag would bury it; the activity section carries the note
  instead (via `setFlag`, like every other flag change), naming the issue that
  stopped. That entry is not optional decoration: it is the *whole* record for a
  flag nobody explained, and without it a container turns red and back again
  with nothing on disk to say so. Every surface that lists flags splits
  the two (`lpm flag list`, MCP `flagged_issues`), because a short list of what
  somebody has to act on is the point.
- **A flagged node is red, and a node standing in for one says so.**
  `countFlaggedInside` reads the same `representative` map that turns a
  dependency inside a collapsed feature into an edge on the feature. Folding a
  level may hide detail; it may never hide the fact that work inside has stopped.
  The edges *leaving* a flagged issue are red for the same reason and by the
  same map (`CanvasEdge.stalled`, set in `model/edges.ts`): a flag stops
  everything downstream of it, and "which part of this graph is stuck behind
  one?" is the question a plan owner opens the canvas with. So it is drawn with
  nothing selected — unlike `related`, which answers "what did I just click" and
  is written later by `refreshHighlights`. The two never fight: `stalled`
  overrides `--tone` the way `NodeShell` does for a flagged node, and the
  selection highlight sets `stroke` outright, so a live edge wins without
  either rule having to out-specify the other. It follows the *dependency*, not
  the drawn node, so an aggregated edge out of a collapsed feature is stalled
  when any one of the dependencies behind it is.
- **`related_files` is text, and it is never resolved.** An issue may name a file
  that does not exist yet — frequently that is the point of it — so nothing
  checks the filesystem, `check` only dedupes, and no path is made absolute. A
  board that failed CI because somebody renamed a module would teach people to
  stop filling the field in, which costs more than the stale entry.
- **A context template is not board state either.** `.lpm/templates/context/` is
  the one folder under `.lpm` holding no documents: `load.ts` never walks it,
  `check` does not know it exists, and no template can make a board invalid. A
  template that will not parse is a `BoardError` on one command. Keep it that
  way — the moment `check` validates templates, a board fails CI because
  somebody's brief has a typo in it.
- **A brief has a layout behind every layout.** `resolveContextTemplate` tries
  the board's `<type>.md`, then the board's `default.md`, then
  `BUILTIN_CONTEXT_TEMPLATE`. The built-in one names no type, no status and no
  attribute, because it has to render on a board whose hierarchy is a single
  `task` — that is what makes "every board gets a brief" true rather than
  aspirational, and it is why a change to it must not reach for `epic`.
  `templates/context/default.md` is deliberately the same text, so ejecting the
  starters changes nothing until somebody edits them.
- **A context template is executable code, and `analyze.ts` is the only thing
  between it and the shell.** Eta compiles a template with `new Function` and
  runs it, so a `.lpm` folder pulled from a stranger is a script. Every render
  goes through `assertTemplateSafe` *before* anything is compiled — there is no
  second path to `eta.renderString`, and adding one is the mistake this is
  arranged to prevent. Two properties keep the check honest and must survive any
  change to it: it tokenizes with **Eta's own `parse`** (their lexer skips `%>`
  inside strings, so a regex scanner would disagree with the engine about where
  code starts, and every disagreement is a hole), and it parses with **acorn**
  rather than matching text (so `x["cons"+"tructor"]` is seen for what it is).
  `computed-member` is `danger` precisely because it is the evasion route for
  every name-based rule; do not soften it to allow `list[i]`.
- **`this` is refused, and `this` is not the data.** Eta's `useWith` rebinds
  identifiers, not the `this` keyword, so `this` in a template is the Eta
  instance and `this.constructor.constructor("…")()` is a full escape. That is
  why the context calls the issue `issue`, and why `ThisExpression` is a finding
  rather than a lint.
- **Only a human may say `--unsafe`.** `allowUnsafe` exists on the CLI because a
  flat refusal with no way past it teaches people to stop using the feature. The
  MCP tool has no such input and must never gain one: an agent that can opt out
  of the check is the whole hole. `lpm instructions --audit` exits 1 on a
  finding, so a poisoned template fails CI rather than surprising somebody.
- **Say what it does not do.** The check refuses the *known* escapes; it cannot
  make an untrusted template safe. `lpm init`, `--audit` and the docs all say so
  in those terms. Do not let that caveat quietly drop out of the output — a
  security control people over-trust is worse than one they understand.
- **Missing data is a warning, never a failure.** Only a template that cannot be
  parsed, or that the safety check refuses, throws. A board with no epics still
  gets a brief, and the warnings surface on stderr (CLI) and in `warnings` (MCP)
  so a layout can be fixed without a board being broken. Note the JavaScript
  consequence of using a real engine: an empty array is truthy, so list guards
  are `.length`, and reaching through an absent value is a `TypeError` — the
  shipped starters guard, and so must any new one.
- **MCP identity is per session.** `--user` and `--profile` live in
  `BoardContext`, never in `.lpm/local.json`, so a swarm of agents on one
  checkout cannot overwrite each other's answer to "who am I" or "what is mine".
- **The queue runner decides nothing about what may be picked up.** `lpm queue
  agent` is `simulateQueue` with the pretend taken out: `loop.ts` drives
  `nextTasks` (so routing, scope, work units, blockers and parked periods are all
  the engine's call, unchanged) and writes through `moveNode`/`flagIssue`/
  `addComment` — exactly what a person does — reloading between steps because core
  operations make every handle stale. A filter added to the loop would make the
  agent work a different queue from `lpm task next`, which is the one thing it
  must not do. Cohesion (finish one parent first) is the *one* ordering it adds,
  and it lives in core as the opt-in `TaskOptions.focusParent`, off for everyone
  else, so `task next` and `simulate` rank exactly as before.
- **Carrying on is not the same question as starting, and `resumableTasks` is
  the one answer to it.** The queue never offers work in an active status — it
  has been picked up — which is right for `lpm task next` (a person sees their
  own in-flight work under `lpm task current`) and wrong for anything working the
  queue alone. A run that claims a task and does not finish it — a crash, a
  timeout, an operator pressing Ctrl-C — leaves it in progress, so a loop that
  only asked `nextTasks` could never come back to it and everything waiting on it
  was blocked for ever: one interrupted run dammed the board, and clearing the
  flag the command told the operator to clear did nothing, because the *status*
  was what withheld it. `resumableTasks` in `board/tasks/ranking.ts` is that
  licence, and it lives in core precisely because both `simulateQueue` (to seed a
  run) and `loop.ts` (to resume one) must read it: simulate had a private copy,
  and the two duly disagreed — the prediction started from work the agent could
  never pick back up. It ignores scope and the period switch exactly as
  `currentTasks` does (work already picked up stays yours), it skips containers
  in an active column (their children are the work), and it **stops at a flag**,
  which is what keeps a stalled task from being retried for ever.
- **A flag withholds work whatever column it sits in.** `candidatesFor` skips a
  flagged issue outright. Most flagged work is in progress and was already held
  back by that alone, so this only shows on a flag raised on something not yet
  started — "blocked, do not start this", which is exactly what a planner writes
  on a backlog issue — and offering that as the next thing to pick up contradicts
  the flag the board is displaying. Like the period switch and a profile's scope
  it steers what is *offered* and never what is reachable: `lpm open`,
  `lpm task start <id>` and MCP `get_document` do not consult it.
- **Nothing the agent runs may wait for a person, and `shell.ts` is where that
  is arranged.** An unattended run has nobody to close a pager, save an editor
  buffer or shut the window `start report.md` opened, so a command that waits is
  not slow — it is a queue stopped for ever, which is exactly how one run held a
  board open until somebody noticed. Three layers, in order of how much they
  save: **a per-command timeout** (`DEFAULT_COMMAND_TIMEOUT`, moved by
  `--command-timeout`), which is the only one that catches what the other two
  did not think of; **`NON_INTERACTIVE_ENV`**, which tells the tools themselves
  in their own vocabulary (`GIT_PAGER`, `GIT_EDITOR`, `CI=true` — the line that
  stops a test runner starting in watch mode); and **`blockedCommand`**, for the
  openers no variable can talk out of it. They reach the agent because `pi.ts`
  **replaces the bash tool** — a custom tool of the same name wins over pi's
  built-in — and `hardenEnvironment` covers the fallback path on a pi too old to
  build one. Say what it does not do: the guard refuses the *known* openers and
  is not a sandbox, the same caveat `instructions/analyze.ts` carries, and the
  docs and the help say so in those terms. A refusal is a shell command that
  explains itself and exits 1, so the agent reads it as an ordinary tool error
  and tries something else.
- **A run reports itself; it does not draw.** `loop.ts` and `pi.ts` emit
  `RunEvent`s — the stage of a task, the agent's text, each tool and its output —
  and `src/cli/agent-view.ts` is the only thing that decides what any of it looks
  like, over the terminal primitive in `src/cli/live.ts`. The sink is wrapped in
  `safeSink`, because a display fault must never abandon a task the agent has
  already half-written to disk, and the loop never reads an event back. Two
  shapes, chosen by where the output goes rather than by a flag: a pane that
  redraws in place on a terminal, one line per event anywhere else (a log full of
  cursor escapes is worse than no live view). It draws on **stderr** — stdout is
  the run's report, so `lpm queue agent > run.txt` stays a clean file — and the
  pane is a *window*, never the record: the whole story of a task is the comment
  on the issue and the JSON under `.lpm/runs/`.
- **`pi.ts` is the only file that imports the pi SDK, and it is never imported
  statically.** The packages are optional *and* need a newer Node than the engine,
  so they cannot be assumed installed at build time: `pi.ts` loads them through a
  **computed specifier** (`tsc` does not resolve a non-literal `import()`) behind
  a typed facade, and fails fast with a `BoardError` when they are absent. The
  loop takes an injected `PiRunner` and never sees the SDK — which is what lets
  `test/runner-loop.test.ts` drive every path with a fake. Adding a static import
  of the pi SDK anywhere, or of `pi.ts` itself, breaks the build on Node 20.
- **The agent commits the *project*, never the board.** `git.ts` runs in
  `paths.root`, so `--commit task|parent` touches the working tree the agent
  edited; the `.lpm` board's own changes (status, comments, `.lpm/runs/` logs) are
  left for the operator. `.lpm/runs/` holds no documents — `load.ts` never walks
  it and `check` never sees it, exactly like `templates/` — so a run log cannot
  make a board invalid. A flag is not a status, so a task the agent could not
  finish stays in progress *and* flagged, and neither `nextTasks` nor
  `resumableTasks` offers it again until a person clears the flag — at which
  point the run resumes it, because otherwise the remedy the command prints
  would be a dead end.

## Invariants worth knowing before you change things

- **The registry has no namespace of its own, and that is the whole design.**
  `.lpm/registry/` holds templates written in the board's *own* issue types, at
  the depth those types sit at — a template of a feature is where a feature is,
  because it is the shape of the feature it produces. So there is no
  `template_types` and no `template_hierarchy`: `templateTypes` and
  `templateHierarchy` in `config/lookup.ts` derive both from `issue_types` and
  `hierarchy`, and a second declaration could only ever drift from the first.
  Three things follow and are load-bearing. **`folder` is reserved across every
  namespace** (`config/schema.ts` refuses a board that declares one), because the
  registry adds exactly one type of its own and "which folder?" must have an
  answer. **`toTypes` walks `template` last and skips a name already claimed**,
  so `feature` keeps `kind: 'issue'` in the DTO and the canvas draws a template
  with the label, icon and attributes of the issue it will become. And **a type's
  depth is a list, not a number** — `allowedDepths`, used by `resolveParentFor`
  and `retypeNode` — because `folder` stands in for whichever level nobody
  templatized and is therefore legal at all of them. Every declared type still
  appears at exactly one level, so for the other four collections that list has
  one entry and the code reads as it always did.
- **A folder groups templates; a root is what anybody instantiates.** The two
  distinctions the registry adds, both in `board/registry.ts` and nowhere else.
  `isTemplateRoot` is "its parent is a folder, or nothing" — the three stories
  under a feature template are part of the feature, not three separate offers —
  and it is denormalized onto `TemplateDto.root` so no front end walks the
  registry to find out. `placementProblem` is the one rule the hierarchy cannot
  express: a folder never sits *inside* a template, or the issue tree it produces
  would have a level with nothing to put in it. Create, retype and `check` all
  call it. Only a root may declare `params`, for the same reason: the root is
  what somebody answers, and its children take the same answers.
- **A placeholder is replaced, never evaluated.** `{{name}}` and nothing else: no
  expressions, no logic, no escape, nothing compiled. That is the difference
  between `.lpm/registry/` and `.lpm/templates/context/`, which *is* code and has
  `analyze.ts` standing between it and the shell. Do not give the registry a
  template engine — a catalogue with conditionals in it is a programming language
  somebody has to learn before they can read the plan. `src/shared/template-params.ts`
  is the single definition, imported by core (the seventh import-free rule module)
  and by the browser.
- **A template's attributes are the produced issue's, so a placeholder sits in a
  field of the wrong type.** `story_points: "{{points}}"` is a string in an
  integer attribute, and it is exactly what a template is for. `holdsPlaceholder`
  is the one exemption, checked by `buildAttributes`, `updateNode` and
  `checkCollection`; nothing relaxes on the board itself, because the value is
  filled in before an issue is written and `planInstantiate` refuses a placeholder
  no parameter answers. A whole-string placeholder keeps the parameter's *type* on
  the way through (`fillValue`), which is what lets the 8 arrive as a number.
- **Instantiating is a planner, and the registry is read-only to it.**
  `planInstantiate` in `src/shared/plans/instantiate.ts` is the single definition
  of what applying a template means, so `lpm template apply` and MCP
  `instantiate_template` cannot disagree; it checks the target against the *issue*
  hierarchy before queueing anything, and repoints the dependencies between the
  copied templates at the issues it just created — dropping the ones that left the
  subtree, exactly as `planDuplicate` does, so a fresh copy stands on its own.
  It never writes to `.lpm/registry/`, which is what makes a template applicable
  twice; `test/templates.test.ts` asserts the root's file is byte-identical
  afterwards. Scheduling is the caller's and never the template's: a reusable
  piece of plan that pinned a sprint would be wrong the second time it was used.
- **The agents are told to read the registry before writing anything.** The MCP
  server's instructions name `list_templates` ahead of the creating tools, both
  shipped agents carry the read tools, and `lpm-templates` is in the skill map.
  That is most of the point: a template called "Database migration" is a team
  saying *this is how we do those*, and an agent that writes its own four tickets
  instead has quietly skipped a process somebody wrote down. Reading the registry
  is registered even on a read-only server; `context.run` is what refuses the
  write.
- **A view is over one collection, and `view.mode` says which.** `templates` points
  the same canvas, table and panel at the registry — which is why building a
  reusable feature-with-three-stories is the same gesture as building a real one,
  and why almost nothing in `web/` needed a second code path. Three things it
  does have to reach: `Workspace.nodeKind` (a template's `type` is an issue type,
  so only the mode says which collection a create lands in), `pruneView` (members
  checked against the wrong list come back empty every time), and the drawer,
  which offers Table alone — Periods, Gantt, Queue and Team all ask about *this*
  piece of work, and a template is the shape of one. A view never mixes the two.
- **A folder is named after its id and nothing else.** `nodeDirName` in
  `storage/paths.ts` is the whole convention, and the reason it is a function at
  all is that `create`, `move`, `retype`, `check` and `fix` must never re-derive
  it. The title used to be slugged onto the end, which reads well in a file tree
  right up until nesting produces a path git refuses to open — the board in this
  repo did exactly that. Two things follow and are load-bearing: renaming a
  document never moves its folder (so `updateNode` does no filesystem work at
  all), and `titleFromDirName` now recovers a title only from a folder an older
  version wrote. `idFromDirName` reads both spellings, which is what makes
  `check --fix` the migration.
- **`.lpm/INDEX.md` is where the titles went, and it is derived, never truth.**
  `operations/board-index.ts` renders every document as a nested list with a
  link to its file, and `load.ts` never opens it — a board with no index is a
  valid board, and `check` reports a stale one as *fixable* rather than as an
  error, exactly the way it treats an id counter that drifted. Every operation
  that can change it (create, update, move, retype, remove, init, `--fix`)
  rewrites it, because a table of contents nobody has to remember to regenerate
  is the only kind worth having. It renders from the board handle the operation
  ran against **plus the one change that operation made**, and never by
  reloading: core operations write straight to disk, so the handle is stale, and
  a reload of a real board costs ~450ms against the ~1ms the render costs. That
  is the trade the `IndexChange` type exists to make, and
  `expectAgreesWithDisk` in `test/board-index.test.ts` is what keeps the two
  paths honest — an incremental write must equal what a full reload renders.
- **`hierarchy` is the only source of parenting truth.** A type's index in the
  hierarchy list *is* the folder depth it must sit at. `create`, `move` and
  `check` all derive nesting rules from that one list — never add a second
  parent/child declaration.
- **Only forward edges are stored.** `depends_on` and a resource's `covers` live
  in the file; the inverses are derived at load time into `board.dependents` and
  `board.coveredBy`. Do not persist a reverse side. `link` refuses a dependency
  that would close a cycle (`wouldCycle`); `check` catches cycles that arrive via
  hand-editing or merges. Coverage is one hop and deliberately not transitive.
- **A dependency is inherited, and a container is finished when its contents
  are.** `src/shared/blocking.ts` is the single definition, adapted by
  `blockersOf` in `core/board/tasks/ranking.ts` and by the one in
  `web/src/lib/board/selectors.ts`. An issue waits on everything its *ancestors*
  wait on, because a story sits inside a feature and a feature that waits on
  another feature waits on it with everything in it — reading only the story's
  own `depends_on` offered the stories of a feature whose predecessor had not
  been started, which is the plan and the queue saying different things. And
  `hasOpenWork` looks *inside* a dependency rather than at its status, because
  nobody moves a feature through the columns: testing a container's own status
  would leave its dependents blocked for ever. A terminal status on the
  container is still the answer for everything under it, and an edge pointing
  back into the issue's own lineage is dropped rather than honoured — it could
  only block the work on itself. The blocker is reported as it is *written* (the
  feature, not the five stories in it), because that is the document a reader
  opens. Two consequences: `board.dependents` stays the *direct* inverse and is
  not the place to ask what is blocked, and `structureOf` in `ranking.ts` caches
  parenting and work units against the `issues` array they came from — nothing
  in that cache may start reading `status`, or `simulateQueue` would rank
  against a board it has already moved past.
- **The same edge read upward is the dependency roll-up, and
  `src/shared/dependency-rollup.ts` is the one definition.** Inheritance runs
  downward: an edge on a feature holds back every story in it. This is the
  other direction — a story waiting on a story in another feature puts those
  two features in that order, and the epics above them, up to the container
  they share, inside which there is nothing left to order. Without it every
  level above the work answered "nothing" to "what does this wait on", which is
  not true and is what makes a large plan impossible to read from the top. Core
  adapts a `LoadedBoard` in `board/dependency-rollup.ts`, the browser adapts its
  working copy in `lib/board/selectors.ts` (`dependencyRollups`,
  `rolledUpNeighbours`), and neither may grow a second copy of the pairing.
  Four things in it are load-bearing. **Nothing is written to a document** —
  unlike the status and flag roll-ups, and for two separate reasons, either of
  them decisive: a `depends_on` on a container is *inherited*, so one story
  waiting on one story would hold back a dozen waiting on nothing; and the
  reflection is not acyclic, because two features each containing a story
  waiting on the other are an ordinary plan and writing that down would produce
  a loop `linkIssue` has to refuse. So it is read and never gated — `blockerIds`,
  `candidatesFor` and the queue are untouched by it, and a loop among reflected
  edges is a fact about the plan rather than a stall. **It stops at the lowest
  common ancestor**, or a feature would be reported as waiting on itself.
  **The two chains are paired from that ancestor downward, not from the two
  ends**, because they are rarely the same length (a story may wait on a whole
  feature) and pairing from the top is what keeps the outermost pair aligned;
  when one chain runs out its last member stands for the rest. And **an edge
  somebody wrote is never reported as a reflection of another one**, so the
  containers' own dependencies keep their own meaning. Every surface names the
  written edge behind each pair (`lpm link`'s `also orders`, `lpm upstream`'s
  `via`, MCP `rolledUpBlockedBy` / `rolledUpBlocks`, `alsoOrders` on
  `link_issues`) — a relationship nobody typed has to say where it came from,
  exactly as a rolled-up status does.
- **"What has to happen first?" is the same rule asked further, and
  `upstreamWork` is the one place it is asked.** `blockerIds` stops at the
  nearest unfinished thing, which is the right answer for a queue and the wrong
  one for "show me absolutely everything required to close this". `upstreamWork`
  in `src/shared/blocking.ts` walks that same inherited graph breadth-first to
  the end of it, and is read by all three front ends: `upstreamOf` in
  `core/board/tasks/ranking.ts` (so `lpm upstream` and MCP `upstream_work`
  print it), and `blockingLookupOf` over a `BoardView` (so the canvas draws it
  off the working copy, unpushed edits included). Nothing re-implements the
  walk; a second one would be the canvas and the queue disagreeing about what
  is behind a ticket. Two things in it are load-bearing. **A blocking container
  is expanded into the open work inside it** (`openWorkUnits`, the reporting
  twin of `hasOpenWork`) and those entries are marked `contents` rather than
  `dependency` — a container is finished when its contents are, so a feature in
  the way *is* its three unfinished stories, and they are the only things
  anybody can be handed. Leaving them out would answer "what is blocked" and
  give the scheduling half nothing a queue could ever offer. And **the walk is
  breadth-first with one `seen` set**, so an issue reached two ways keeps its
  *nearest* reason and a hand-edited or merged cycle terminates instead of
  hanging a browser tab.
- **Scheduling upstream work is a planner, and it is deliberately narrow.**
  `planScheduleUpstream` / `scheduleUpstream` in
  `src/shared/plans/upstream.ts` is the single definition of what "push this
  chain into the queue" means, so `lpm upstream --schedule`, MCP
  `schedule_upstream` and the canvas menu cannot disagree. It copies the
  waiting issue's own period *and* assignee onto the upstream work in one
  patch, and touches an issue only when **nobody holds it** — an upstream
  ticket with an assignee is left completely alone, its period included,
  because it is somebody's work and moving it between sprints is a worse
  surprise than a short list. It writes only onto **work units**, for the same
  reason `scheduleLeaves` does: a period on an epic schedules nothing the queue
  can offer. Both of those come back in `decisions` with a `skipped` reason
  rather than being silently dropped, and every surface prints them — "nothing
  changed" and "nothing found" are different boards, and a command that
  reported them identically would be lying about a chain six people are already
  working.
- **A container's status is derived, and `src/shared/rollup.ts` is the one
  definition.** The other half of the rule above: `hasOpenWork` lets the *queue*
  see through a container, and this writes the same fact onto the document, so a
  reader opening `_issue.md` and the engine ranking work agree about whether a
  feature is finished. `moveNode` carries a status change up the parent chain
  (`propagateStatus` in `operations/rollup.ts`) and `createIssue` does the same,
  because adding a story is one more way for a closed feature to stop being
  true; `checkRollup` reports a container out of step and `--fix` writes it.
  Four things hold it together and none of them are style choices. **`terminal:
  true` is the whole of "done"** — no code anywhere may test for the *name* of a
  status, and a board closing into `shipped` rolls up identically. **A parent
  already terminal is left alone**, so a deliberate `cancelled` is never
  rewritten to `done`. **Reopening only ever corrects a contradiction** — a
  closed parent with open work in it — because dragging every open ancestor
  forward would churn the board each time anybody moved a card. And **the roll-up
  is never queued as a change**: the web applies it to the working copy so the
  canvas is honest before Push, and the engine derives it again on the way in,
  which is the same shape as `wouldCycle` (the client mirrors the rule, it does
  not own it). Two known edges are deliberately left to `check`: removing a
  subtree, and reparenting *out* of a container that the move completes — both
  would need the board reloaded mid-operation, which core operations do not do.
- **There are two edges between issues, and only one of them means anything to
  the engine.** `depends_on` orders work; `relates_to` implies nothing at all.
  There was a third — `informed_by`, "the research this rests on" — and it is
  gone. It gated the queue exactly as `depends_on` did (inherited from ancestors,
  cleared by the work inside a container, cycle-checked through the same
  `gate`), so it was one behaviour under two names: two arrows on the canvas, two
  fields in every DTO and patch, two tools on the MCP server, and two ways to say
  the same thing that no two people used the same way. What an issue rests on is
  prose — it belongs in the body and in `related_files`, which is where the
  reasoning already was. Do not reintroduce a second gating edge; if work cannot
  start until a question is answered, that is a dependency.
  `RETIRED_LINK_FIELD` in `validation/shared.ts` is the whole of what remains:
  `check` reports a document still carrying the key and `--fix` merges its ids
  into `depends_on`, which is what the edge already did. That migration is the
  only place the name may appear, and it can go once boards have moved.
- **Whether a resource is generic belongs to its type, not the document.** A
  resource type with `generic: true` describes a pool ("a jr. developer");
  `isGenericType` / `isGenericResource` are the only way to ask. No document
  carries a `generic` field, and the config rejects the flag on issue and period
  types.
- **The current user is per checkout, never committed.** It lives in
  `.lpm/local.json` (git-ignored via `.lpm/.gitignore`, which `init` writes and
  `writeLocal` heals), overridable with `LPM_USER`. Nothing in `board/` or
  `validation/` may depend on it — it is an input to the CLI, not a property of
  the board. Identity has three sources and the most specific wins: `LPM_USER`,
  then the profile's `user:`, then `local.json`; `currentUser` returns which one
  answered, because a profile that silently overrode `lpm me` would be a
  confusing way to be someone else.
- **A profile routes work; it is not access control, and it is not board
  truth.** `scope` decides what the board *offers* — `nextTasks` (via
  `TaskOptions.scope`), `lpm task next/start`, MCP `next_tasks` and
  `list_documents`. It never decides what is *reachable*: `get_document`,
  `lpm open`, `lpm set` and `task start <id>` ignore it, because an agent handed
  a dependency it cannot open is worse off than one shown work it should leave
  alone. `currentTasks`/`previousTasks` ignore it too — work already picked up
  stays yours if the scope moves. Only the *path* is stored (in `local.json`);
  the file lives outside `.lpm`, `load.ts` never opens one, and `check` does not
  know it exists. Say "routing" in any message about it, never "permission".
- **A stale scope fails closed, and an unknown key is an error.** `resolveScope`
  drops names the board does not have and reports them in `unknown`, but a
  declared list that resolved to nothing matches nothing — quietly widening to
  the whole board is the one failure nobody would notice. For the same reason
  `profile/schema.ts` is `.strict()`: `excludes:` must not be silently ignored.
  Wherever scoped work is shown, the scope is shown with it (`describeScope` on
  the CLI, `scope`/`scopeWarnings` in `board_overview`, `outOfScope` in
  `list_documents`) — a short list nobody can explain is worse than a short list.
- **Loading is deliberately forgiving.** A half-written or hand-made folder still
  loads: `load.ts` synthesizes missing `id`/`type`/`title`/`status`/`capacity`/
  `created`/`author`, records what it invented in `board.derived`, records undeclared
  frontmatter keys in `board.extras`, and gives id-less documents an
  `#unassigned:<dir>` placeholder (`isUnassigned`). `check` reports from those
  maps and `fix` persists them — so a new synthesized field usually means
  touching all three of `load.ts`, `check.ts`, `fix.ts`.
- **`fixable: true` on a `Problem` is a contract**: exactly the problems `check`
  marks fixable are what `--fix` repairs. Anything ambiguous (duplicate id,
  unresolvable type, wrong-typed attribute value) is reported and left alone.
- **Ids are never reused.** `allocateIds` bumps the counter in `state.json` but
  skips any id already present on disk, so a stale or merge-mangled counter
  cannot produce a duplicate; `check --fix` resyncs counters from disk. The skip
  repairs a counter that is *behind*; it cannot see an id another process is
  allocating this instant, which is why every `create` holds the board lock.
- **Frontmatter key order is fixed** by `serializeNode`: reserved fields, then
  config-declared attributes in declaration order, then unknown keys the user
  added (preserved, never dropped). Reserved fields are listed in
  `ISSUE_RESERVED_FIELDS` / `PERIOD_RESERVED_FIELDS` /
  `RESOURCE_RESERVED_FIELDS`; adding one means updating those lists, `load.ts`,
  `serializeNode`, and the config's shadowing guard — and it is a breaking config
  change, because a board declaring an attribute of that name stops validating.
- **`priority_attribute` and `effort_attribute` are the only config keys the
  engine reads out of user-defined attributes** (to rank `task next` and to add
  up `team` load). Both are optional and validated at parse time; never hard-code
  an attribute name anywhere else.
- **"What is a piece of work?" is answered once, by `isWorkUnit`/`workUnits` in
  `core/board/query.ts`.** By default that is a leaf, so `nextTasks` never
  offers an issue that has children and `resourceLoad` cannot double-count the
  stories under a feature. A board moves the floor up by declaring an issue type
  `atomic` (`isAtomicType` in `config/lookup.ts`): work of that type is offered
  *even when it has children*, and anything with an atomic **ancestor** is
  inside a unit and is never offered — which is what makes a story with
  sub-tasks one job rather than three, and what makes nesting resolve
  outermost-first. The flag is issue-only; `checkTypeFlag` in `config/schema.ts`
  refuses it on a period or resource type exactly as it refuses `generic` off
  the roster. Both `candidatesFor` and `resourceLoad` go through `workUnits`,
  and so does MCP `list_documents`' `workUnitsOnly` — a second copy of "does
  this carry work" is the mistake to avoid, and there were four before.
- **`templates/` is resolved relative to this file's depth** —
  `operations/init.ts` walks three levels up from `src/core/operations` (and
  `dist/core/operations`). Moving that file breaks `lpm init`.
  `instructions/instructions.ts` resolves `templates/context/` the same way, and
  breaks the same way.
- **`.lpm` is its own git repo** nested inside the project and added to the
  parent's `.gitignore` (deliberately not a submodule).
- **Which board a command works on is decided in `findBoardPaths`, and nowhere
  else.** Most specific first: an explicit path (`lpm mcp --root`, `lpm agent
  --project`) beats `LPM_BOARD_PATH`, which beats the walk up from the cwd — so
  passing `from` deliberately skips the environment. A variable naming no board
  **throws**, because falling back to whichever board the cwd sat in is the
  failure nobody notices. `lpm init` calls `boardPathsFor` instead and is
  therefore deaf to it: creating a board is not reading the one you work on, and
  the command says so when the two disagree. `boardPathsAt` derives `root` from
  the board folder rather than taking it separately, which is what keeps
  `displayPath` and the board's name honest when the two are far apart.

## CLI conventions

`lpm git` (`status`/`setup`/`join`/`sync`/`off`, a thin printer over
`operations/git-sync.ts`) has subcommands too, and is reachable as `lpm remote
git …`. `lpm task`, `lpm flag`, `lpm queue`, `lpm template` and `lpm remote` are the
commands with subcommands (`next`/`current`/`prev`/`start`/`done`, `clear`/`list`,
`simulate`/`agent`, `list`/`show`/`new`/`apply`, and `add`/`rm`/`off`/`on`/`push`/`pull`/
`sync`/`status`/`log`/`resolve`/`link`/`unlink`/`decouple`/`relink`/`rebase`/
`login`/`connect`/`ledger`); they dispatch inside their own `run`,
and every branch is a thin printer over `board/tasks.ts` plus at most one
`moveNode`, `flagIssue` or `clearFlag` call — except `queue agent`, which is a
thin printer over `src/runner/` (the loop there is what calls the operations).
`lpm remote` is the second whose branches are thin printers over a whole layer
rather than `board/tasks.ts` — `queue agent` over `src/runner/` is the first,
`lpm remote` over `src/remote/` the second — and its subcommand options are
documented in the parent's `help` string, because `index.ts` answers `--help`
before the command runs. Its dispatcher does one thing no other command's
does: **a first word that is a declared remote's name and not a subcommand is
moved behind the subcommand** (`lpm remote jira push LP-12` → `push jira
LP-12`), because every subcommand that acts on one remote already takes its
name as the first positional. It is a rewrite rather than a second dispatch
table, so the two spellings cannot drift. Note there is deliberately no
`unflag` alias for `lpm flag`: the id is the first positional, so `lpm unflag
LP-3` would read as "clear it" and would in fact raise one. Keep the ranking
and eligibility rules in core, not in the command. `lpm planning` is one
`setPlanning` call and a report; it decides nothing about what the mode means.
`lpm experimental` is one `setExperimental` call, one
`installMissingDependencies` call (`cli/experimental-deps.ts`) and a report.
It is the one command that starts `npm`. The runner is an argument of every
function that needs it, so `test/experimental.test.ts` passes a recorder and
no test starts npm.
`lpm period` is its sibling
for the timeline and takes flags rather than subcommands; every branch is one
`updateNode` or one planner from `src/shared/plans/`, and none of the date
arithmetic lives in the command. `lpm upstream` is the same shape again: a
report by default, one planner behind `--schedule`, and no idea of its own
about what is upstream or what may be touched — both come from
`src/shared/blocking.ts` and `src/shared/plans/upstream.ts`.

Each `src/cli/commands/*.ts` exports `help: string` and `run(args): number`, and
is registered in the `commands` + `summaries` maps in [src/cli/index.ts](../src/cli/index.ts)
(aliases go in `aliases`). Commands parse with `parseArgs`, get the board via
`requireBoard()` ([src/cli/context.ts](../src/cli/context.ts)), call one core
operation, and print via [src/cli/ui.ts](../src/cli/ui.ts) (`out`/`err` +
colour helpers that respect `NO_COLOR`). Errors are thrown as `BoardError`, not
printed locally — `index.ts` renders them and sets the exit code. Exit 1 means
"errors remain" (`lpm check` relies on this for CI).

**Except where the work outlives `run`.** `lpm ui` and `lpm mcp` hand the
process to a socket and return, so a failure that arrives afterwards lands in a
promise nobody is holding: a `BoardError` thrown from `ui`'s `.catch` was
printed by Node as an unhandled rejection — object, stack and `details: [ … ]`
— which reads as the tool falling over rather than as "something else is on
that port". Anything asynchronous calls `reportError` (`cli/ui.ts`, the same
renderer `index.ts` uses) and sets `process.exitCode` itself. Do not reach for
a second copy of that rendering; `test/cli.test.ts` holds a port and asserts
the output carries no stack frames.

`util.parseArgs` has no `--no-x` negation: a boolean that defaults on is
declared as its own `'no-thing'` option (`lpm init --no-git`, `lpm ui
--no-open`). `lpm ui` and `lpm mcp` are the commands that do not return after
doing their work — they leave the process on a socket or on stdio.

`lpm instructions` is the one command whose stdout is *content* rather than a
report: the brief and nothing else, so it can be redirected or piped into a
prompt. Which template rendered it and what the template asked for that the board
could not answer go to stderr. Do not add a heading, a summary line or colour to
its stdout.

`index.ts` answers `--help` *anywhere* in the arguments before the command
runs, so a subcommand can never show its own help (`lpm task next --help` and
`lpm mcp setup --help` both print the parent's). Document subcommand options in
the parent's `help` string rather than adding an unreachable one.

## Extending

- **New operation that writes**: wrap the exported function in `boardWrite`
  (`operations/shared.ts`) and call `requireUnchanged(board, target)` before it
  mutates anything, then write with `writeDocument` rather than `writeNode` — the
  three of them are one recipe, and skipping any of them puts a lost update back
  into a codebase that has just taken them all out. A brand-new document has no
  stamp and needs no check.
- **New `lpm queue agent` option**: the field on `AgentConfig` in
  `runner/types.ts`, a key in the zod schema in `runner/config.ts` (so `--file`
  accepts it), and the `parseArgs` option plus its validation in
  `cli/commands/queue.ts`'s `parseAgentArgs`. If the loop acts on it, thread it
  into `LoopOptions` in `runner/loop.ts`; if the pi run needs it, into
  `PiRunnerOptions` in `runner/pi.ts` and the `createPiRunner` call in the
  command. Test the behaviour in `test/runner-loop.test.ts` with a fake
  `PiRunner` — never against the real SDK, which cannot be assumed installed.
- **New thing to show while a run happens**: a case in `RunEvent`
  (`runner/types.ts`), the `emit` call in `loop.ts` or the session listener in
  `pi.ts`, and both branches of `feed` in `cli/agent-view.ts` — the pane *and*
  the plain log, or it is invisible in CI. Test the event in
  `test/runner-loop.test.ts` and the drawing in `test/cli-live.test.ts` against a
  fake TTY stream; nothing about a frame may need a real terminal to check.
- **New attribute type**: add to `ATTRIBUTE_TYPES` in `model/types.ts` and handle
  it in all of `model/attributes.ts`'s `normalizeAttributeValue`,
  `validateAttributeValue`, `parseAttributeInput`, `initialValueFor`, then the
  matching branch in `web/src/lib/ui/fields/AttributeField.svelte` and
  `initialValue` in `web/src/lib/board/working.ts`.
- **New writable field**: add it to `NodePatch` in `src/shared/changes.ts`, to the
  view schema in `server/views/schema.ts`, to the right step of
  `src/sync/patch.ts`, and to `patchNode` in `web/src/lib/board/working.ts`.
  All four, or a field will be editable on screen and silently dropped on push.
  A field that is also a *reserved* frontmatter key costs more: the list in
  `model/types.ts`, `load.ts`, `serializeNode`, `check`/`fix`, `sync/dto.ts` and
  the DTO in `src/shared/model.ts` — `related_files` is the worked example, and
  retiring `informed_by` is the same list walked backwards.
  A reserved field that must **not** be queued (`flag`) skips
  `NodePatch`, the view schema and `patchNode`, and gains a straight-through
  route instead; see the invariant above before choosing which kind you have.
- **A new piece of view state** (a pane size, a fold, a tab): the type in
  `src/shared/view.ts`, a default in `emptyView`, and the same default in the
  zod schema in `server/views/schema.ts` — a view file written before the field
  existed has to open without it. Nothing else: views are opaque to storage.
  Ask first whether it belongs in the file at all; how the table is folded and
  how the Gantt is grouped are deliberately *not* in there, because they are
  ways of reading rather than things a teammate should inherit on pull.
  (Neither is `planning`: it changes what the engine offers, so it is board
  config, not view state.) The line
  is whether it changes *the canvas someone arranged*: geometry, folding and
  `display` are saved with the view and published with it, so a pulled branch
  and an exported page show the picture that was made.
- **New API endpoint**: a handler in `server/routes/`, registered in
  `buildRouter`; DTOs go in `src/shared`, never ad-hoc object literals.
- **A field the published viewer should show**: nothing extra, if it is already
  on the DTO — `toStaticBoard` publishes whole snapshots. Only a change to
  `StaticBoard` itself costs anything, and then bump `STATIC_BOARD_VERSION` and
  widen `parseStaticBoard`: a viewer deployed months ago will still be fetching
  boards exported today, so additive changes are the cheap ones. Bump it only
  for a change that would *break* such a viewer — the version guard refuses a
  file newer than the reader, so raising it over an optional field (a node size,
  say) would strand every deployed page for nothing. The mirror image costs one
  line: because an *older* file must keep opening in a *newer* viewer, a new list
  field on `IssueDto` goes in `ISSUE_LISTS` in `shared/static.ts`, where
  `parseStaticBoard` fills it in. Without that the field arrives `undefined` and
  the first `.length` in the viewer blanks the page.
- **New multi-step edit**: a planner in `src/shared/plans/` returning
  `Plan`, then three thin callers — a command in `src/cli/commands/`, a tool in
  `src/mcp/tools/plan.ts`, and a mutation in
  `web/src/lib/workspace/mutations.ts`. Test the planner in `test/plans.test.ts`
  against a real board, applying the plan; a plan that cannot be replayed is
  worthless.
- **New value a context template can see**: a field on `NodeView` or
  `InstructionContext` in `instructions/context.ts`, plus a row in the tables in
  `docs/context-templates.md` and a line in `lpm instructions --help`. A new
  *helper* is one entry in `HELPERS` in `instructions/template.ts` —
  `HELPER_NAMES`, the CLI help and the reserved-key guard all derive from it. A
  new shipped starter is one file in `templates/context/` named after an issue
  type; `installContextTemplates` picks it up for any board declaring that type,
  and nothing else changes.
- **New template safety rule**: a name in `HOST_GLOBALS` or `ESCAPE_PROPERTIES`,
  or a case in the `walk` switch in `instructions/analyze.ts`, plus its
  `MESSAGES` entry, a case in `test/instructions.test.ts` and a row in the table
  in `docs/context-templates.md`. Test the *evasion* as well as the name — a rule
  that catches `process` but not `x["proc"+"ess"]` is not a rule.
- **New MCP tool**: `registerTool` in the matching `src/mcp/tools/*.ts` with a
  zod input schema and a description written for a model that has never seen
  this board. Wrap the body in `guard` so a `BoardError` comes back as a
  readable message with its hints rather than a transport failure.
- **New config option**: `config/schema.ts` (zod + the cross-field checks below
  it), then an accessor in `config/lookup.ts` rather than reads at the call site.
  A per-**type** flag costs more, because `typeSchema` is shared by all three
  namespaces: declare it there, restrict it with `checkTypeFlag` (the one guard
  behind both `generic` and `atomic`), add the field to `TypeDef` in
  `model/types.ts`, and — if a front end needs it — to `TypeDto` in
  `src/shared/model.ts` and `toTypes` in `sync/dto.ts`. A flag no namespace
  guard rejects is a typo nobody will ever be told about.
- **New profile scope rule**: the field in `ProfileScope` (`model/profile.ts`),
  the key in `profile/schema.ts`, and both `resolveScope` and `inScope` in
  `board/scope.ts` — plus a line in `describeScope`, since every surface that
  filters also prints what it filtered by. Nothing in the front ends changes:
  they pass a `ResolvedScope` around and never inspect it.
- **New collection**: add it to `NodeKind` and the helpers listed above, to
  `KINDS`, `BoardState`, `LoadedBoard`, `specFor` in `load.ts`, `serializeNode`,
  `SECTIONS` in `operations/board-index.ts` (or it is missing from the index),
  and give it a `check`/`fix` pass. `checkOptionalNamespace` in `config/schema.ts`
  already handles "all of the namespace or none of it". Then the wire: `NodeKind`
  and `NODE_KINDS` in `shared/model.ts`, a DTO and a `toX` in `sync/dto.ts`, a
  branch in `sync/patch.ts`'s `createNode`, and the `nodeKind` enum in
  `server/views/schema.ts`. `template` is the worked example, and the one that
  shows the namespace need not be declared at all.
- **New field on a registry template**: `TEMPLATE_RESERVED_FIELDS`, the
  `Template` interface, the reader in `load.ts`, `serializeNode`, `TemplateDto`,
  `toTemplate`, `NodePatch` + the view schema + `patchNode` if it is editable,
  and `createTemplate`/`updateNode`. A field the *produced issue* should carry
  goes through `planInstantiate` as well, or it is written in the registry and
  lost on the way to the board.
- **New parameter type**: it is an `AttributeType`, so follow that recipe — plus
  a branch in `defaultOf` in `web/src/features/panel/sections/params.ts`, which
  reads a typed default out of the editor's text field.
- **New built-in template**: a file in `templates/` plus its name in
  `BUILTIN_TEMPLATES` (`operations/board-template.ts`); templates are validated
  by `parseConfigText` at init.
- **New block in the mapping editor** (for example `attributes`): a field on
  `RemoteMappingDto` and on `RemoteMappingUpdateDto` in
  `src/shared/remote-api.ts`, a read and a `write…` function in
  `src/remote/mapping-editor.ts`, a field on `MappingDraft` with its change
  functions in `web/src/features/config/remote/mapping.svelte.ts`, and a block
  in `MappingEditor.svelte`. Ask the connector through an optional method and
  wrap the call in `ask`, so a provider without the method still opens the
  editor. Test the read against a stubbed `fetch` and the write against
  `openRemote` in `test/remote-mapping-editor.test.ts`.
- **New config edit**: a case in the union `ConfigEdit` in
  `src/shared/board-config.ts`, a function and a `switch` case in
  `operations/config-edit.ts`, and a case in `describeConfigEdit`, whose text
  is the commit message on a board shared through git. Edit the `yaml`
  document in place and do not re-create a node that exists, or its comment is
  lost. If the edit renames or removes a name, rewrite each holder: the
  documents (`work.changed`), the remote blocks (`followInRemotes`) and, for an
  issue type, `work.renamedTypes`. Then a control in `web/src/features/config/`
  and a case in `test/config-edit.test.ts` that reloads the board and asserts
  that `checkBoard` reports no error.
- **New agent or skill**: one markdown file under `assets/` with `name`
  (matching the file name), `description` and `roles` frontmatter (agents also
  carry `tools`), plus a `files:` rule in each mapping that selects it — the
  shipped patterns are `agents/*.md` and `skills/*.md`, so dropping it in one of
  those directories is enough. Then regenerate this repo's `.claude/`.
- **New non-markdown asset** (a script, a JSON template): put it under `assets/`
  and add a rule with **no** `frontmatter:`, which copies it byte for byte.
  `{path}` in `to:` mirrors a whole subtree.
- **New `lpm agent --target`**: one file, `assets/harnesses/<name>.yml`. No
  TypeScript. Check it with `lpm agent --list` and `--dry-run`, add a case to
  `test/agent.test.ts`, and document the layout in `docs/harness-layouts.md`
  with its source URL and the date you checked it.
- **New provider** (`lpm remote --provider <name>`): a folder under
  `src/remote/providers/<name>/` exporting a `Provider` — the four members in
  `src/remote/provider.ts`: `config` (a zod schema validating the provider's
  own `connection`/`mapping` blocks), `capabilities` (what the platform holds
  natively, from `capabilities.ts`), `translator` (board ↔ remote vocabulary,
  both directions, pure — no I/O), and `connector` (a factory that turns a
  validated connection block into a live connector — usually over
  `transport/`, but a provider may do its own I/O: `jsonfile` reads and
  writes a local JSON file with `node:fs` and uses no transport at all) — plus
  three optional descriptors: `credentials`, naming which connection keys hold
  secrets and their conventional env vars; `defaultConnection`, naming the
  connection values the provider can work out from the remote's *name* alone
  so nobody is ever asked for them (`jsonfile`'s `file`, which is a path
  under `.lpm/` that this tool owns); and `conditionalConnection`, naming a key
  only *part* of a mapping needs. Only a value needing **no** external
  knowledge belongs in the second: a `repo` or a `site` names somebody else's
  system and can never be guessed, and its flag stays required — the
  required/optional split in the help is derived from these members plus
  the schema, never written down twice.

  **A key only part of the mapping needs is a third case, and it is the one
  that bites.** Jira's Agile board id is optional for a remote that never
  schedules and mandatory for one whose mapping carries `periods` — a sprint
  belongs to a board, not a project. The schema cannot express that (it sees
  one declaration, not what the push will try to do), so the provider states it
  as data in `conditionalConnection` and two places act on it: `preflightPush`
  turns an unmet one into an **error before anything is written**, and the
  setup conversation tries to answer it from the remote itself through the
  optional `connector.discoverConnection()` — one candidate is written into
  `config.yml`, several become a question, none leaves the provider's own `why`
  on screen. That pairing is the rule: *the credential that can file an issue
  can usually also read the value, so ask the remote, not the person.* Getting
  this wrong is not a cosmetic failure — before it existed, a push asked for
  consent, began creating sprints, and only then discovered it had nowhere to
  create them. (A push of *work* no longer creates sprints at all — see the
  vocabulary/timeline split above — but a push that files periods still needs
  the board id, and `lpm remote setup` still reports it.)

  Two optional members decide whether first-time setup is one command or an
  afternoon in YAML, and a provider whose vocabulary is the platform's needs
  **both**: `standardVocabulary` (the platform's conventional words, so the
  scaffold writes a real mapping instead of a `TODO:` per board word) and
  `connector.vocabulary()` (the live words, so `lpm remote setup` can correct
  the convention). Declare one without the other and either the convention can
  never be checked or there is nothing to check.

  Two more connector members are optional and cheap, and both are about a
  *listing* rather than a write. `connector.describe(record)` gives the
  human-readable key and URL of a listed record with no request — the drift
  report needs it to name an incoming issue, and a provider without it falls
  back to the bare remote id, which is correct and unpleasant to read. Every
  shipped provider already had the logic inside its own `resultOf`, so it is
  three lines. And `list`'s `onPage` callback (`ListProgress`) reports the
  internal pages a caller cannot see; a provider that paginates should call it,
  or a long read is a silent one. Note `list` itself is **exhaustive** — it pages
  internally and returns every record plus the cursor for the *next pull*, never
  a continuation token — and a new provider that returns a page at a time would
  break every caller.

  The **capability table has ten cells**, and `vocabulary` is the one a new
  provider is most likely to get wrong: `fixed` means the remote's type and
  status names pre-exist and can only be discovered by asking it (Jira, Linear,
  GitHub), so the mapping scaffold writes a `TODO:` marker rather than guessing
  a real-looking value; `open` means light-plan writes the vocabulary itself
  (`jsonfile`, whose tracker file does not exist until the first sync creates
  it), so the scaffold names types and statuses after the board's own and
  leaves nothing to fill in. Declaring `fixed` when the store is really ours
  makes setup ask questions nobody can answer. Then: one line in the `providers`
  literal in `src/remote/registry.ts`, one entry in the conformance table in
  `test/remote-conformance.test.ts`, and a `docs/remote-<provider>.md` setup
  page (the token and scopes, the setup steps, what a push creates, and
  the known limitations). The conformance harness drives HTTP providers by
  stubbing `fetch` onto the in-memory tracker; a provider whose connector is
  not `fetch`-backed (a file) instead supplies `trackerAndConnection` on its
  entry — building a tracker double in `test/support/` that reads and writes
  the same backing store the connector does — which is `jsonfile`'s worked
  example. Supporting a fourth platform is a folder plus a
  registry line — never an edit to the planners, `src/sync` or core.

  **Five tables must stay complete, and each one is a place a provider has
  already been forgotten.** `pullSeamsFor` in `src/remote/sync.ts` (an if-chain
  over provider identity, whose *fallback* silently reads a field a new
  provider may not have — `jsonfile` took it for months and every pull read
  every twin as deleted), the entries in `test/remote-roundtrip.test.ts` (whose
  header claims every provider and covered two), the entries in
  `test/remote-conformance.test.ts`, `targets` in `test/remote-live.test.ts`,
  and the entries in `test/remote-translation.test.ts` (the last two have a
  registry-completeness assertion, so they fail until a new provider is added —
  give the other three one too rather than trusting a reviewer to notice).
  Everything *else* about a provider is derived: the
  `lpm remote add` flags and its help come from the provider's own zod schema
  via `connectionFlags` / `allConnectionFlags`, and the period-mapping demand in
  `openRemote` is gated on `capabilities.periods.native` — a provider with no
  native container declares no `periods` key and its schedule rides the managed
  block. Do not reintroduce a hand-written list of connection keys, provider
  names or connection targets in `src/cli` or `src/remote`; derive it, and put
  the *behavioural* coverage in the four tables above.

  **A live test reads the platform's own payload, never the adapter's.** The
  four tables above are driven by an in-memory tracker, which is the right
  default and has one blind spot: a fake is built from the same reading of the
  platform as the connector, so a shared misunderstanding round-trips perfectly
  and every test passes. Five defects reached a live Jira push that way, and
  each of them is one sentence — a created issue kept the workflow's first
  status for ever while the base recorded the status the board asked for
  (`POST /issue` takes no status, and the planner only transitions twins it
  already knows, so nothing ever disagreed); `depends_on` was filed backwards,
  because Jira's `inwardIssue` is the *blocker* and the field names invite the
  opposite reading; the link readers asked "is this end me?" of entries that
  name only the *other* end, so no dependency ever pulled back; `unlink` matched
  on a pair of endpoints no Jira record carries; and Jira had no `parentIdOf`
  seam, so a pulled issue never landed under the twin of its Jira parent. The
  fixtures encoded the same wrong shape, which is why they looked right. So
  `test/remote-live-jira.test.ts` asserts against raw REST responses rather than
  through `Connector`, and a provider whose vocabulary is subtle enough to be
  misread deserves the same. One thing the platform will teach you in return:
  **a search index is not a read** — Jira's JQL lags its own writes, so counting
  straight after a push is a race, while a read by key is not.

Scope is deliberately narrow (see the end of README.md): no terminal board
renderer, query commands, time tracking, automatic scheduling, or anything that
would make a profile into permissions (the web app shows the whole board). The
template registry is inside that line and has to stay there: `{{name}}` is
replaced with a value, and a registry with conditionals and loops in it is a
programming language somebody has to learn before they can read the plan.
"Only the plan owner clears a flag" is the same line drawn again: it is stated in
the docs, in the agent prompts and in the tools the shipped developer agent is
*not* given, and enforced nowhere — `clearFlag` refuses an unflagged issue and an
empty comment, never a caller.
`lpm queue simulate` is on the reporting side of that line and has to stay
there. It is `nextTasks` in a loop over an in-memory overlay, and **nothing in
`simulate.ts` may decide what can be picked up** — routing, scope, work units,
blockers and parked periods all live in `candidatesFor` and reach it only
through `nextTasks`, which is why `rankCandidates`, `routeOf` and `isParked` are
exported from `tasks.ts` rather than restated. A filter added here would make
the command disagree with the `lpm task next` it exists to predict; the "agrees
with the queue at every step" test in `test/simulate.test.ts` is what catches
that, and it asserts the two run *out* at the same point as well. It writes
nothing, and `today` is fixed for the whole run, so it reports an *order* and
never a schedule: the moment it starts turning steps into dates it has become
the automatic scheduler this project does not have.
The one thing `simulate.ts` adds is the *seed*: work already in flight is taken
first, because the queue never offers what has been picked up and a run that
ignored it would report its dependents blocked forever. That is not an
eligibility rule — it is what the pretend starts from — and it stops at a
**flag**. A flag says the work has stopped and needs a person; nobody else is in
a one-person run to clear it, so seeding with it assumes away the very thing
holding the queue up and reports everything gated by it as reachable. That is
exactly how `lpm queue simulate` came to list twenty-seven ready stories while
`lpm queue agent` correctly stopped with nothing to pick up. Flagged work is
reported as skipped (`SkipReason` `'flagged'`) and counted on the run, and the
counterpart is that an empty agent run says what the resource is *holding*
(`RunReport.held`, read off the handle that produced the empty queue) — neither
is a filter, both are the run explaining itself.
`lpm team` reports load, it never levels it, and neither does the web team view. The Gantt
rolls dates *up* from the periods documents already name, which is reporting in
the same sense; it never writes a date back onto a document, and nothing in the
engine learns about dates it did not read from a period. The periods view is the
other side of that line and still inside it: it writes the `period` a reader
dropped an issue into, and the dates a reader typed onto a period — both plain
edits to a document, never a date the app worked out for them.
`loadBoard()` already returns all three trees, the dependents and coveredBy
indexes, and period membership — build on it, don't widen the engine. The web
app is likewise out of scope for multi-board sessions, auth, real-time
collaboration and conflict resolution beyond "pull again". Follow YAGNI; the
codebase is meant to stay small and readable, and no file should need scrolling
to understand.
