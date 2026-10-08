# light-plan → GitHub: setup guide

The page for a first-time GitHub sync. It names the exact token to create, the
minimum permissions, the setup steps, a complete config, what a push creates
before it files anything, what a second sync does, and the failure modes people
actually hit. The reasoning behind *why* a sync behaves this way — the link
store, the base snapshot, the degradation ladder — is in
[`docs/remote-sync.md`](remote-sync.md); what GitHub can and cannot hold
natively is in [`docs/remote-capabilities.md`](remote-capabilities.md).

## The token

Use a **fine-grained personal access token** (fine-grained PAT), scoped to the
one repository the board mirrors. A classic token works too, but it cannot be
scoped per-repository, so it is the fallback, not the recommendation.

Create it at **GitHub → Settings → Developer settings → Personal access
tokens → Fine-grained tokens**.

**Repository access** — *Only select repositories*, and pick the repository
named in `connection.repo` (`owner/repo`).

**Repository permissions** — grant exactly these two, and nothing else:

| Permission | Level | Why |
| --- | --- | --- |
| **Issues** | Read and write | Issues, comments, labels, milestones and sub-issues — the entire sync surface. |
| **Metadata** | Read-only | Granted automatically and required; GitHub will not let you set it to *No access*. |

**Pull requests — leave at *No access*.** The sync reads the issues listing,
which returns pull requests too, and drops them; it never reads a PR, so the
`pull-requests` permission would be scope for nothing.

Three optional permissions, each gated behind a feature the mapping may not
use. Grant them only when the board actually needs them:

| Permission | Where | Level | When |
| --- | --- | --- | --- |
| **Projects** | Repository (or Organization, for an org-owned Project) | Read and write | `mapping.project` + `mapping.fields` is set — a Projects v2 status or iteration field. |
| **Issue types** | Organization | Read | the board maps native GitHub issue types (org-level, opt-in per repository). |
| **Issue fields** | Organization | Read | `mapping.attributes` points at org-level issue fields. |

For the two organization permissions, *write* is only needed if a push must
create them. Most boards map attributes onto labels instead and need neither.

**Classic token (fallback).** If you must use one, the scope is `repo` (or
`public_repo` for a public repository). Add `read:org` only to *list* org issue
fields, `admin:org` only to *create* them — neither is needed for a labels-only
board. Do not grant `admin:repo_hook`, `workflow` or `actions`: none of them is
used, and every one of them widens the blast radius of a leaked token.

## Setup

1. **Create the token** (above). Copy it once — GitHub shows it only once.
2. **Connect the board.** One command declares the remote, takes the token, and
   checks the repository can be seen:

   ```bash
   lpm remote connect              # asks which tracker, the repo, and the token
   #   repo (owner/repo): acme/payments
   #   token: ****************
   # …or pass what you already know:
   lpm remote connect github --repo acme/payments --name upstream
   ```

   The mapping is drafted from this board's own types and statuses — on GitHub
   both ride labels whose names this board chooses, so there is nothing to look
   up and nothing to fill in. The token is stored in the git-ignored,
   owner-only `.lpm/credentials.json`; `export GITHUB_TOKEN=github_pat_…`
   beforehand and it is found there instead and never asked for. `connection.token`
   stays `${GITHUB_TOKEN}` or omitted either way — a literal token in
   `config.yml` is refused.

3. **Or do it as three commands**, which is what a CI job needs:

   ```bash
   lpm remote add upstream --provider github --repo acme/payments
   echo github_pat_… | lpm remote login upstream
   lpm remote setup upstream      # credential + reachability + what is missing
   ```

4. **Read the plan, then run it.** A GitHub issue can only carry labels the
   repository already defines, and the push creates the ones the mapping names
   before it files anything — there is no separate step to remember:

   ```bash
   lpm remote push --dry-run      # the plan, and the labels it would create
   lpm remote push --all          # creates the labels, then files the issues
   lpm remote push LP-12          # or one document at a time
   lpm remote status              # exit 0 when the board and the repo agree
   ```

   `lpm remote setup` is the one to re-run whenever the pairing changes: it
   reports whether the token resolves (and if not, where to create one),
   whether the repository can be seen, and what the push will have to create.

## Complete example config

```yaml
remotes:
  upstream:
    provider: github
    scope: LP-10            # optional; omit to mirror the whole board
    direction: both         # push | pull | both
    on_delete: unlink       # unlink | close | delete
    conflict: manual
    comments: push          # push | both
    connection:
      repo: acme/payments
      token: ${GITHUB_TOKEN}      # or omit and run `lpm remote login upstream`
      # base_url: https://ghe.example.com/api/v3   # GitHub Enterprise only
    mapping:
      types: { feature: { remote: feature }, user_story: { remote: story } }
      statuses: { backlog: "To Do", in_progress: "In Progress", done: { remote: Done, closed: true } }
      attributes: { story_points: "Points" }   # "story_points: 3" → label "Points:3"
      accounts: { via: github_login }
      # periods: milestones          # or: { container: sprint, carrier: milestones | iteration }
```

`statuses` accepts a single remote state (`backlog: "To Do"`), a list
(`done: [Done, "Won't Fix", Duplicate]`), or the object form
(`done: { remote: Done, closed: true }`). Only the object form's `closed: true`
closes the remote issue — the short spellings do not, and a board status whose
`terminal` flag disagrees with `closed` is reported as a warning. See
`lpm remote --help` for the full `connection` / `mapping` vocabulary.

## What a push creates before it files anything

A GitHub issue can only carry labels the repository already defines, so a push
creates what the mapping needs and the repository has not got, before it writes
an issue — and names each one it made. It is *desired minus current*, so a
second push creates nothing:

- **The missing labels** — every type, status and attribute label the mapping
  will write, derived through the translator so a created label is exactly a
  label a later push applies. Each gets a colour derived from its name.
- **Projects v2 fields and single-select options** — only when
  `mapping.project` and `mapping.fields` are set; the field names and option
  values come from the mapping, resolved against the live project.
- **Milestones**, on demand, when the push schedules an issue into one.

`lpm remote push --dry-run` lists all of it without writing.

## The second sync

This is where people expect duplicates. There are none, because the
correspondence is recorded, not re-derived:

- **Every document is linked.** After the first push, `.lpm/remotes/<name>/links.json`
  maps each local id to its GitHub issue number. The second push updates the
  issues it already filed; it files a new issue only for a document with no
  link (one created locally since).
- **Changes are a diff, not a re-send.** Each link carries a base snapshot of
  what both sides agreed on; a push sends only the fields that moved, so an
  untouched issue is skipped, not rewritten.
- **A pull refreshes everything.** `lpm remote pull` lists the repository's
  issues, so every mirrored document is brought back into step and anything new
  is imported. It never re-files: a pulled issue that matches a link is an
  update to the linked document, not a new one. `--changed` uses the cursor
  (the newest `updated_at` it saw) to list only what moved since — cheaper on a
  big repository, and partial by construction, so it can never report a
  deletion.

If the two sides ever disagree, `lpm remote status` says per document whether
it is ahead, behind or conflicted, and `lpm remote resolve <id>` records the
decision — nothing is silently clobbered or duplicated.

## Known limitations

- **Deletion is a close, not a delete.** GitHub cannot hard-delete an issue
  over the REST API, so `delete` closes the issue. `on_delete: delete` is
  therefore "close the twin" on GitHub, whatever the name suggests.
- **No native dependency or "relates" edge.** `depends_on` and `relates_to`
  have no GitHub home; they ride the managed block in the issue body, which
  round-trips but is not clickable in the GitHub UI.
- **Hierarchy is one parent edge.** Native sub-issues give one level (and their
  availability is probed, since it varies by plan); deeper boards ride the
  managed block.
- **Type is a label unless you opt in.** Native issue types are org-level and
  per-repository; where they are not enabled, the board type is a label.
- **Pull requests are never stories.** The issues listing returns PRs and the
  sync drops them — a repository's PRs will not become tickets.

## Failure modes, and the command that diagnoses them

| You see | It means | Diagnose / fix |
| --- | --- | --- |
| `Pull skipped — GET /repos/… → 404` | The token cannot see the repository (wrong scope, private repo not selected, or the repo moved). | `lpm remote status upstream`; check *Repository access* on the token. |
| The repository is missing mapped labels | The mapping writes labels the repository does not define. | Nothing — `lpm remote push` creates them first and reports each one. |
| `GitHub POST /repos/…/labels failed (422)` | A label already exists — two pushes racing. | Re-run the push; creating labels is idempotent. |
| `GitHub PATCH … failed (403)` | The credential is valid but cannot write. | Grant **Issues: read and write** on the token. |
| First push stops and asks | The first write to a remote always confirms the target and counts. | Confirm, or re-run with `--yes` (CI, an agent). |
| Push refuses: "more than the threshold" | The plan would create/close more than `write_threshold` (default 25) — a scope typo looks like a mass delete. | Read `lpm remote push --dry-run`; re-run with `--yes` if it is genuinely intended. |

A scope typo is the classic first-week failure: `scope: LP-1` mirrors the whole
board instead of one feature, and the threshold guard is what stops that from
becoming four hundred filed issues. Read the dry-run before the first `--yes`.
