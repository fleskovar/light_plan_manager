# Git sync: sharing a board through its own git repository

A `.lpm` board is already a git repository of its own. **Git sync** makes git
the board's remote. Every change made from the CLI, the web UI or an agent
pulls the latest board first, then commits and pushes. A whole team, and any
number of agents on any number of machines, can then work one board without
anybody running `git` by hand. Two people also cannot both claim the same
issue.

A step-by-step walkthrough, from the CLI and from the web UI, is in
[`git-sync-tutorial.md`](git-sync-tutorial.md). This page is the user guide
(sections 1 to 6) and the design record (section 7).
The code is in `src/core/gitsync/` (the mechanism) and
`src/core/operations/git-sync.ts` (the operations built on it).

---

## 1. Quick start

```bash
# In a project that pushes its code somewhere: put the board on its own branch
# of that same repository.
lpm git setup                      # asks: this project's repository, or another?
lpm git setup --project            # the same, without asking

# Or a repository of the board's own, on any host:
lpm git setup --url https://github.com/acme/plan.git

# A teammate, in their clone of the project:
lpm git join                       # clones the board branch into .lpm
lpm git join --url https://github.com/acme/plan.git
```

That is all. From then on, use the board as you always did:

```bash
lpm task start LP-12               # pulls, claims, commits "lpm: claim LP-12", pushes
lpm git                            # where the shared board stands
lpm git sync                       # commit stray edits, pull, push, now
```

In the web UI, the **Sync** tab offers **Share through git…** when the board has
no remote yet. When git sync is on, the tab shows the Git panel.

## 2. What happens on every change

```
fetch + bring in upstream   →   load the board   →   write   →   commit   →   push
      (before reading)                                            (one commit per change)
```

- **Before reading**, every front end pulls. This includes the CLI (in
  `requireBoard`), the server (behind the five-second board poll, and before
  every write route), MCP sessions, and `lpm queue agent` before each pick.
  This pull is best effort. A command that only reads still answers when you
  are offline, from the board as it was last pulled, and prints one warning on
  stderr.
- **A write** is committed with exactly the files it changed. The message is
  the operation (`lpm: claim LP-12`, `lpm: push 4 change(s)`). Then it is
  pushed. A web **Push** of queued edits is one commit, because it is one draft.
- **When somebody else pushed first**, light-plan fetches and compares files:
  - **different files**: your commit is laid on top of theirs and pushed
    again. History stays a straight line, and both changes stand.
  - **the same file**: your change is **undone**. The board shows their
    version, and the command fails with "Nothing was changed: LP-12 changed
    upstream while you were working". Read the board again and repeat the
    change if it still makes sense.
- **When the remote cannot be reached**, the change is undone and refused.
  Nothing is written.

### Why claiming is safe

Two people claiming `LP-12` both write `board/LP-12/_issue.md`. Whoever pushes
second sees that file changed upstream, so the claim is undone and refused.
Running `lpm task start LP-12` again then answers "LP-12 is already held by
Ada", because the board now shows her claim. An agent running
`lpm queue agent` reads the same `ConflictError` as "somebody got there first"
and takes the next task.

### Two files that never conflict

`INDEX.md` is derived, so it is rendered again from the result.
`state.json` holds the id counters, which merge by keeping the higher of each.
So an issue created here and a sprint created there both land. Two issues
created at the same moment do collide: both allocated `LP-51`, which is the
same folder. The second is refused, and running the command again gives it
`LP-52`.

## 3. Using the project's own repository

When the project folder is a git repository with a remote, setup offers that
remote by default and puts the board on a branch called **`_lpm_board_remote`**.

- `.lpm` stays a repository of its own, ignored by the project's
  `.gitignore`. The board branch shares no commit with the code: it is an
  *orphan* branch. Board history and code history never mix, and nobody's
  `git log` on `main` fills up with `lpm: claim …` commits.
- There is one repository to create, one set of permissions, and one place to
  clone from.
- A teammate with a clone of the project runs `lpm git join` with no
  arguments: the project's remote and the board branch are the defaults.

## 4. Any git host, and credentials

Setup recognises **GitHub, GitLab, Bitbucket and Azure DevOps** URLs, in both
the HTTPS and SSH forms. For each one it shows example URLs, where to create an
empty repository, and how git authenticates. Any other URL that git can push
to also works: a self-hosted server, `ssh://…`, or a bare repository on a
shared drive.

| Host | URL forms |
| --- | --- |
| GitHub | `https://github.com/<owner>/<repo>.git`, `git@github.com:<owner>/<repo>.git` |
| GitLab | `https://gitlab.com/<group>/<project>.git`, `git@gitlab.com:<group>/<project>.git` |
| Bitbucket | `https://<user>@bitbucket.org/<workspace>/<repo>.git`, `git@bitbucket.org:<workspace>/<repo>.git` |
| Azure DevOps | `https://dev.azure.com/<org>/<project>/_git/<repo>`, `git@ssh.dev.azure.com:v3/<org>/<project>/<repo>` |
| Anything else | `https://<server>/<path>.git`, `ssh://<user>@<server>/<path>.git`, `/path/to/board.git` |

**light-plan stores no git credential.** It runs git, and git uses its own
credential helper: Git Credential Manager, the macOS keychain, an SSH key. That
is the same helper that answers when you push code.

**Nothing light-plan runs in the background ever prompts.** It runs with
`GIT_TERMINAL_PROMPT=0` and SSH in `BatchMode`. So if a push needs a password
git has not stored, the command fails with the host's hint instead of hanging.
Run `git ls-remote <url>` once in a terminal: whatever makes that work makes
light-plan work. `lpm git setup` and `join` at a terminal are the only
exceptions, and are allowed to ask once.

## 5. Conflicts, offline work, and turning it off

**Offline on purpose.** Set `LPM_GIT_OFFLINE=1` to work without the remote.
Changes are committed locally, and the next `lpm git sync` pushes them. Without
it, a change that cannot be pushed is refused. The reason is that a claim
nobody else can see is not a claim.

**Conflicts** come from two places. Offline commits can touch files somebody
else also changed. Edits made outside light-plan (a hand edit, a view the web
app saved) can sit in the way of incoming work. `lpm git` and the Git panel
list the documents involved. Settle it the way you would in any repository:

```bash
lpm git sync --ours      # keep this checkout's version of the contested files
lpm git sync --theirs    # take the remote's
```

The Git panel has the same choice as two buttons, **Keep mine** and
**Take theirs**. Or resolve it with plain git inside `.lpm`. light-plan never
merges lines inside a document and never leaves conflict markers in one.

**Uncommitted files.** Saved views and hand edits are not committed by
ordinary changes. Each change commits only what it wrote. `lpm git sync`
commits them all.

**Turning it off.** `lpm git off` removes `git_sync` from the config, commits
that, and pushes it, so every teammate stops syncing at their next pull. The
repository and its remote are left alone.

## 6. Git sync or trackers, not both

A board either syncs through git or mirrors onto trackers (`lpm remote`: Jira,
GitHub Issues, Linear), **never both**. Git replicates the whole `.lpm` folder,
so "one remote per document" can only be decided for the whole board.
Enforcement:

- `config.yml` with both `git_sync:` and `remotes:` does not validate.
- `lpm git setup` refuses while a tracker remote is on, unless it is asked to
  turn them off (below). `lpm remote add` / `connect` (and the web connect
  form) refuse while git sync is on.
- `git` is reserved as a tracker remote name, because `lpm remote git …` is
  another spelling of `lpm git …`.

### Swapping a tracker for git, and back

Moving a board that mirrors onto Jira (say) to git sharing does not mean
removing the mirror. **Turning a remote off** moves its declaration, unchanged
and with its comments, from `remotes:` to `remotes_off:` in `config.yml`. Its
link store, base snapshots, audit log and credentials under
`.lpm/remotes/<name>/` are not touched. Nothing reads `remotes_off:` except the
commands that turn a remote back on, so a turned-off mirror is simply not
synced. A turned-off remote does not count against the rule above.

```bash
lpm git setup --turn-off-remotes   # Jira off, git on — one commit
lpm git off --turn-on-remotes      # git off, Jira back on — one commit
lpm remote off <name>              # just turn a mirror off
lpm remote on <name>               # just turn one on (refused while git is on)
```

- `lpm git setup` without the flag refuses and names it. At a terminal it asks
  first: *Turn off jira and share through git instead? [y/N]*.
- In the web UI, **Share** on a board with a tracker opens a warning that names
  the mirror and asks before anything is sent. **Turn off git sharing** offers
  a *Turn jira back on* checkbox.
- The swap is a single config write and a single commit, so it is pushed to
  everybody at once and cannot half-happen.
- Turning a mirror back on carries on from its last sync. Whatever changed on
  the board while it was off is ordinary drift: `lpm remote status <name>` shows
  it, and the next push or pull handles it.
- Credentials are git-ignored, so they stay on the machine that stored them. A
  teammate who turns the mirror on runs `lpm remote login <name>` once.
- `lpm remote rm <name>` removes a turned-off remote for good, like any other.

## 7. Design record

**Correctness is in core; freshness is in the front ends.** The transaction
lives in `boardWrite` (`operations/shared.ts` → `withBoardWrite` →
`sharedWrite`) and in the web push replay (`sync/apply.ts`). Every write in
every front end therefore goes through it, and none of them carries git logic.
The pull before loading is what keeps refusals rare. A front end that forgot
it still cannot overwrite anybody: the refusal happens at the push.

**Refuse, never merge, inside a document.** This is the same rule
`requireUnchanged` enforces on one checkout. light-plan cannot know whether
your title change and their status change belong together. Git's line merge
would happily combine a claim and a counter-claim into one frontmatter. So the
unit of conflict is the **file**: different files are combined, the same file
is refused. The two exceptions (`INDEX.md`, `state.json`) are files nobody
writes by hand.

**Plumbing, not porcelain.** Integration uses `checkout <commit> -- <paths>`
and `update-ref`, not `merge`, `rebase` or `stash`. It touches exactly the
files it names, and never leaves a half-finished rebase, a stash or conflict
markers in a folder people open in an editor. A commit is built in a private
index (`GIT_INDEX_FILE`), so whatever the person staged, and whatever else is
dirty (views the web app keeps saving), is neither swept in nor disturbed.

**Undo is surgical.** A refused write puts back only the files that write
changed, each to what it held before the write: committed content, or the
uncommitted edit it carried. Nothing like `reset --hard` runs in a working
tree.

**Pushed under the board lock.** The lock covers commit and push, so writers
on one checkout queue behind the network round trip as well as the write.
This is the price of a claim that is decided on the remote rather than on this
disk.

**Board-wide, committed configuration.** The claim guarantee only holds if
everybody follows the protocol, so `git_sync` lives in `config.yml` and
travels with the board. The URL does not: git keeps it in `.lpm/.git/config`,
per clone, where a teammate's clone already has it.

**Known limits.** The comparison is per file, so a decision that *read*
another document (a blocker, say) is not re-checked if only that other
document changed upstream. The pull before every command makes the window
seconds wide. A subtree deleted on one side while a document is created inside
it on the other merges into an orphan, which `lpm check` reports. The lock is
held across the push, so its timeout (`LPM_LOCK_TIMEOUT_MS`) may need raising
on a slow network with many local writers.
