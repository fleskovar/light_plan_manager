# Tutorial: share a board through git

This tutorial sets up **git sync**: one light-plan board shared by a whole team
through a git repository. When it is on, every change pulls the latest board
first and then pushes the result. Two people can therefore never both claim
the same issue.

You will:

1. share an existing board, from the command line **or** from the web UI;
2. bring a teammate onto it;
3. see what happens when two people claim the same issue;
4. learn the everyday commands, conflicts and offline work.

For the reference and the reasoning behind it, see [`git-sync.md`](git-sync.md).

---

## Before you start

You need:

- **A board.** If the project has none yet, run `lpm init` in the project
  folder. This creates `.lpm/`, which is a git repository of its own.
- **git, already able to push to your host.** light-plan does not store a
  password or token. It uses the same credentials git uses for your code: Git
  Credential Manager, a keychain or an SSH key. To test this, run the command
  below. If it prints refs or nothing, and no error, you are ready.

  ```bash
  git ls-remote <repository-url>
  ```

- **A board with no tracker remotes switched on.** A board syncs through git
  *or* mirrors onto Jira, GitHub Issues or Linear (`lpm remote`), never both.
  If `lpm remote` lists anything, `lpm git setup --turn-off-remotes` turns it
  off as part of setup. Nothing is deleted, and `lpm git off
  --turn-on-remotes` turns it back on.

### Choose where the board will live

| Option | When to use it | What you need |
| --- | --- | --- |
| **The project's own repository** (recommended) | The project folder is already a git repository with a remote | Nothing new. The board goes on its own branch, `_lpm_board_remote`. |
| **A repository of its own** | No project repository, or the board must live elsewhere | An **empty** repository on any host (create it without a README) |

The project-repository option keeps the board's history fully separate from
the code's. `.lpm` is its own repository, and the `_lpm_board_remote` branch
shares no commit with your code branches. Your `git log` on `main` never fills
with board changes.

---

## Part 1a — Set it up from the command line

Open a terminal in the project folder.

### Step 1. Check where things stand

```bash
lpm git
```

```
git sync  off — this board is not shared through git
Share it on this project's repository: lpm git setup
  git@github.com:acme/shop.git, branch _lpm_board_remote
```

If the project has no remote, the second line suggests
`lpm git setup --url <url>` instead.

### Step 2. Share the board

Run setup with no arguments and answer the one question:

```bash
lpm git setup
```

```
Where should the board live?
  1) This project's repository (default)
     git@github.com:acme/shop.git (GitHub), on its own branch _lpm_board_remote
  2) A repository of its own
     GitHub, GitLab, Bitbucket, Azure DevOps, or any git server — an empty one

Choose 1-2:
```

- Press **Enter** to use the project's repository.
- Or type **2**. Setup then shows example URLs for each host and asks for one:

  ```
  Repository URL
    GitHub        https://github.com/<owner>/<repo>.git
    GitLab        https://gitlab.com/<group>/<project>.git
    Bitbucket     https://<user>@bitbucket.org/<workspace>/<repo>.git
    Azure DevOps  https://dev.azure.com/<organization>/<project>/_git/<repo>
    Git server    https://<server>/<path>.git

  URL:
  ```

You can skip the question with flags, which is useful in scripts:

```bash
lpm git setup --project                                        # the project's repository
lpm git setup --url https://github.com/acme/plan.git           # a repository of its own
lpm git setup --url git@ssh.dev.azure.com:v3/acme/shop/plan --branch main
```

When setup works, it prints something like this:

```
Checking the repository…
shared git@github.com:acme/shop.git (GitHub), branch _lpm_board_remote
  committed 3 files that had not been
  added the git remote "origin"

Every change is now pulled before and pushed after, for everybody who works this board.
A teammate with a clone of the project runs lpm git join.
```

Setup did these things:

1. checked that git can reach the repository;
2. made `.lpm` a git repository, if it was not one already, and committed the
   board;
3. pointed `.lpm` at the repository;
4. added a `git_sync:` block to `.lpm/config.yml` and pushed everything.

The config is pushed with the board, so every teammate's checkout syncs
automatically.

### Step 3. Confirm

```bash
lpm git
```

```
git sync  on
remote    origin → git@github.com:acme/shop.git
branch    _lpm_board_remote  (the project's own repository)
host      GitHub
state     in step with the remote
```

Setup is done. Go to **Part 2** to bring a teammate in.

---

## Part 1b — Set it up from the web UI

### Step 1. Open the editor

```bash
lpm ui
```

Open the drawer at the bottom of the editor and select the **Sync** tab.

### Step 2. Start the setup dialog

When the board has no remote, the Sync tab shows two options:

- **Connect a remote…** mirrors the board onto a tracker. This is not what we
  want here.
- **Share through git…** is the one to click.

### Step 3. Choose where the board lives

The **Share this board through git** dialog offers:

- **This project's repository**. It is shown only when the project folder has
  a git remote, and it is selected by default. The board goes on the branch
  `_lpm_board_remote`.
- **A repository of its own**. Paste the URL of an **empty** repository. Open
  **What a URL looks like** to see the URL format for GitHub, GitLab,
  Bitbucket, Azure DevOps and other servers.

**Branch** is optional. Leave it empty to use the default shown in the field:
`_lpm_board_remote` for the project's repository, `main` for a repository of
its own.

### Step 4. Check, then share

1. Click **Check**. git tries to reach the repository with the credentials it
   already has, and nothing is changed.
   - **Reachable** — the dialog also says whether the branch will be created,
     or already exists.
   - **Could not reach it** — the dialog shows git's error, the host's
     credential hint and where to create a repository. Fix that in a terminal
     (`git ls-remote <url>`), then click **Check** again. The web UI never asks
     for a password.
2. Click **Share**. The board is committed and pushed, and the Sync tab
   switches to the **Git panel**.

### Step 5. Read the Git panel

- **The bar** shows the host, URL and branch, plus **Check the remote**
  (fetches now), **Set up…** (point it somewhere else) and **Turn off**.
- **The status card** shows one line about the state, such as
  "In step with the remote", "Out of step: 1 commit to push" or
  "Cannot reach the remote". It also has the **Sync now** button.
- **The facts** list the repository, branch, commits to push and to pull, the
  time of the last check, and any uncommitted files in the board folder.

From now on you do not need this panel for ordinary work. Each edit you make
on the canvas is committed and pushed when it is saved. Changes made by
teammates appear within about 20 seconds, while the editor is open.

---

## Part 2 — Bring a teammate onto the board

Your teammate needs git credentials that can read and write the repository.

**If the board is on the project's repository**, they clone the project as
usual and run one command in it:

```bash
git clone git@github.com:acme/shop.git && cd shop
lpm git join
```

```
joined git@github.com:acme/shop.git (GitHub), branch _lpm_board_remote
  cloned into /home/bob/shop/.lpm
  added .lpm/ to the project's .gitignore
```

**If the board has a repository of its own**, they run this in their project
folder:

```bash
lpm git join --url https://github.com/acme/plan.git
# add --branch <name> if setup used a branch other than main
```

`join` works only in a project with no `.lpm` folder yet. It never overwrites
a board. If they already have a local board, they move it aside first.

Then they set who they are, as with any board:

```bash
lpm me <resource id or name>
```

The web UI cannot join a board, because `lpm ui` needs a board to open. Join
from the command line, then use either.

---

## Part 3 — See it work: two people, one issue

Ada and Bob both look at the board while `LP-12` is free.

```bash
# Ada
lpm task start LP-12
```

Ada's command pulls the board, claims `LP-12`, commits `lpm: claim LP-12` and
pushes it.

```bash
# Bob, a moment later
lpm task start LP-12
```

Bob's command pulls first, sees Ada's claim and stops:

```
error LP-12 is already being worked on by Ada
```

The two commands can also run at the same second, so that Bob's pull happens
before Ada's push arrives. In that case Bob's push is rejected, his change is
undone, and he gets this message:

```
error Nothing was changed: LP-12 changed upstream while you were working
       Somebody else wrote the same document and pushed first. The board now shows their version.
```

Bob runs the command again and gets the first answer: Ada is already
working on it.

Changes to **different** documents never get in each other's way. If Ada edits
`LP-12` while Bob edits `LP-30`, both changes land.

The same rules apply to the web UI and to AI agents connected over MCP or
running `lpm queue agent`. They all write through the same mechanism.

---

## Part 4 — Everyday use

There is nothing new to learn. Use `lpm` and the web UI as before. These
commands are for the occasional check:

| You want to | CLI | Web UI (Sync tab) |
| --- | --- | --- |
| See where the board stands | `lpm git` | Git panel |
| Check the remote right now | `lpm git status` (it fetches) | **Check the remote** |
| See it without the network | `lpm git status --local` | — |
| Commit stray edits, pull and push now | `lpm git sync` | **Sync now** |
| Keep my version in a conflict | `lpm git sync --ours` | **Keep mine** |
| Take the remote's version | `lpm git sync --theirs` | **Take theirs** |
| Stop sharing, for everybody | `lpm git off` | **Turn off** |

`lpm remote git <subcommand>` is another spelling of `lpm git <subcommand>`.

### Stray edits

Changes made through light-plan are committed automatically. Two other kinds
of change are not:

- files you edit by hand in `.lpm`;
- saved canvas views.

These stay as uncommitted files. `lpm git` lists them under `local`, and the
Git panel lists them under its facts. Use **Sync now** or `lpm git sync` to
commit and push them.

### Conflicts

A conflict happens only when your checkout and the remote both changed the
same document and one of the two was not pushed straight away. The usual
causes are offline work, or a hand edit sitting in the way of an incoming
change. `lpm git` shows it like this:

```
This checkout and the remote both changed:
  LP-12
Keep this checkout's version: lpm git sync --ours
Take the remote's version:     lpm git sync --theirs
```

The Git panel shows **Conflict**, lists the documents, and replaces
**Sync now** with **Keep mine** and **Take theirs**. If you prefer, you can
resolve it with plain git inside `.lpm`. light-plan never writes conflict
markers into a document.

### Working offline

When the remote cannot be reached, light-plan **refuses** the change and
nothing is written. A claim that nobody else can see is not a claim.

To work offline on purpose, set `LPM_GIT_OFFLINE`. Your changes are then
committed locally, and you push them when you are back online:

```bash
export LPM_GIT_OFFLINE=1      # PowerShell: $env:LPM_GIT_OFFLINE = '1'
lpm task start LP-12          # committed locally, not pushed
# …later, online again…
unset LPM_GIT_OFFLINE
lpm git sync                  # pushes, or reports a conflict if somebody else changed the same documents
```

Commands that only read the board, such as `lpm task next` or `lpm open`,
still work offline without the variable. They print one warning and show the
board as it was last pulled.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Could not reach <url>` during setup or join | git cannot authenticate, or the repository does not exist. Run `git ls-remote <url>` in a terminal and fix whatever it complains about. The message also shows the host's credential hint and where to create a repository. |
| `This board mirrors onto a tracker, so it cannot also be shared through git` | Run `lpm git setup --turn-off-remotes` to turn the trackers off and share through git. They are kept, and `lpm git off --turn-on-remotes` swaps back. Or keep the trackers and do not use git sync. |
| `Cannot add remote … — this board is shared through git` | The same rule from the other side. To switch to trackers, run `lpm git off` first. |
| `… already has a branch "…" holding a different board` | That branch holds somebody else's board. Join it (`lpm git join`) from a project with no `.lpm`, or choose another branch with `--branch`. |
| `This board is shared through git, but the board folder is not a git repository…` | The `.lpm` folder was copied rather than cloned. Run `lpm git setup` to connect it, or move it aside and run `lpm git join`. |
| `Nothing was changed: the board could not be shared through origin` | The push failed: network, credentials or permissions. Check with `lpm git status`. To carry on offline on purpose, use `LPM_GIT_OFFLINE=1`. |
| `The board is busy: … is doing "…"` | Another process on this checkout is writing, and pushes take a moment over a slow network. Retry, or raise `LPM_LOCK_TIMEOUT_MS` (in milliseconds). |
| A push hangs or times out | Network commands time out after 60 seconds. Raise it with `LPM_GIT_TIMEOUT_MS`. |

---

## Turning it off

```bash
lpm git off
```

Or use **Turn off** in the Git panel. This removes `git_sync:` from the config
and pushes that change, so every teammate's checkout stops syncing at its next
pull. The repository, its history and its remote are left exactly as they
were. `lpm git setup` turns syncing back on.
