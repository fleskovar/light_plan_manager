# light-plan → jsonfile: setup guide

The page for a first-time sync to the **jsonfile** provider — a local JSON-file
issue tracker with no account, no token and no server. It is the demo and test
target: you can run a whole push/pull cycle against a file on disk, which is
what the conformance suite does, and what makes it useful for trying the sync
without touching a real backlog.

The *why* is in [`docs/remote-sync.md`](remote-sync.md); what the file can
hold natively is in [`docs/remote-capabilities.md`](remote-capabilities.md).

The file tracker is the **minimum a tracker can be**: an issue is a flat JSON
object with a `title`, a `body`, a native `type` field, a native `status` field,
a native `depends_on` edge list, a `labels` list, an `assignee` string and a
`comments` array. It is the only provider whose `type` and `status` are *native
fields* (rung 1 of the degradation ladder), and the only one whose `delete`
hard-removes the issue rather than closing it.

## The token

There is none. The connection is a single path:

```yaml
connection:
  file: .lpm/remotes/demo/tracker.json   # the file is the whole tracker
```

A missing file is an empty tracker; the first sync creates it (and its
directory). No credentials, no `.lpm/credentials.json`, no environment
variable. Nothing can leak because nothing is a secret.

## Setup

1. **Connect it.** There is no account, no credential and nothing to look up,
   so this asks nothing at all: it declares the remote, drafts the whole mapping
   from the board's own types and statuses — the one provider that leaves
   nothing to fill in, because the file's vocabulary is ours to write — and
   confirms the file is reachable. `--file` is optional: the default is
   `.lpm/remotes/<name>/tracker.json`.

   ```bash
   lpm remote connect jsonfile --name demo
   ```

   The two commands underneath, for a script that would rather be explicit:

   ```bash
   lpm remote add demo --provider jsonfile
   lpm remote setup demo
   ```

2. **Read the plan, then run it:**

   ```bash
   lpm remote push --dry-run      # the plan, no writes
   lpm remote push --all          # first write asks once, then lands
   lpm remote push LP-12          # or one document at a time
   lpm remote status              # exit 0 when the board and the file agree
   ```

The file is committed-able or git-ignored at your choice. For a demo, commit it
so the team can `lpm remote pull` the same mirrored board; for a scratch pad,
leave it out of git.

## Complete example config

```yaml
remotes:
  demo:
    provider: jsonfile
    scope: LP-10            # optional; omit to mirror the whole board
    direction: both         # push | pull | both
    on_delete: unlink       # unlink | close | delete
    conflict: manual
    comments: push          # push | both
    connection:
      file: .lpm/remotes/demo/tracker.json
    mapping:
      types:
        program:    { remote: program }
        epic:       { remote: epic }
        feature:    { remote: feature }
        user_story: { remote: story }
      statuses:
        backlog:    Backlog
        in_progress: "In Progress"
        done: { remote: Done, closed: true }
      attributes: { story_points: "Points" }   # → a `Points:3` label (rung 3)
```

Notes on the mapping. **`types` and `statuses` both name their counterpart
under `remote:`.** A type names one remote type; a status may name several (a
list) when the remote has more than one word for the same thing, and `push:`
then says which one a push writes. Where the value *lands* is the provider's
business, not the mapping's: here both are native fields, so the type is written
to `type` and the status to `status`, and neither is duplicated onto a label.
`closed: true` marks the terminal status (the board's `terminal` flag must
agree, exactly as on the other providers). **Attributes ride label prefixes** (rung 3), the
same convention GitHub uses — the file has no typed custom-field registry.

`depends_on` needs no mapping entry: it is a native field, and the connector's
`link` / `unlink` write it. **There is no `periods:` and no `accounts:` block
here.** Every other provider's page shows both, because every other provider has
a native container to map a sprint onto and an account to resolve a person to;
this schema declares neither key, so either one written by hand is stripped on
the way in and states a mapping that can never fire. `lpm remote add` does not
draft them for this provider, and `lpm check` reports one already in the file:

    warn  remotes.demo.mapping.periods: provider "jsonfile" has no "periods"
          mapping, so this block does nothing (it accepts: types, statuses, attributes)

An assignee is an arbitrary string the file stores but the sync does not resolve,
and a period rides the managed block (rung 4) rather than a native container —
see the limitations below.

## What a push creates before it files anything

Nothing. `provisioning` is `{ customFields: false, periods: false, labels:
false }` — the file *is* the whole API, and there is nothing to create through
one. On the other providers a push creates labels or sprints first; here it
goes straight to filing.

## The second sync

No duplicates, for the same reason as every provider: the correspondence is
recorded, not re-derived.

- **Every document is linked.** `.lpm/remotes/demo/links.json` maps each local
  id to its file issue number (the `number` field). The second push updates
  what it already filed and files only new documents.
- **Changes are a diff.** The base snapshot means an untouched issue is skipped;
  the post-write record is read back, so the file's exact contents are absorbed.
- **A pull is a full read filtered by `updated_at`** — the file is small, and
  the cursor is the newest timestamp seen.

## Known limitations

- **Flat hierarchy.** There is no native parent field (`hierarchyDepth: 0`), so
  a document's parent rides the managed block (`rung 4`) and is recovered on
  pull from the block — not from a native edge.
- **No typed custom fields.** Attributes are label-prefix strings; there is no
  type registry, so an attribute round-trips as text.
- **No period container and no account mapping.** A period degrades to the
  managed block on push (a `period:<type>` row) — but **is not read back**: the
  provider's translator ignores periods on pull, so a fresh board pulling this
  tracker recovers no schedule. An assignee is stored as an opaque string and is
  likewise not resolved against the roster. Both are tracked by **LP-533**; a
  board mirrored here and pulled elsewhere loses its sprints, so do not treat
  this provider as a backup.
- **No `relates_to` edge.** `depends_on` is native; `relates_to` rides the
  managed block.
- **Single file, no locking.** A write is a whole-file rewrite, and two
  processes pointed at the same file would race. The board lock does not cover
  the file. For a demo this is fine; it is the reason the provider is a
  *mirror target*, never a shared tracker.

## Failure modes, and the command that diagnoses them

| You see | It means | Diagnose / fix |
| --- | --- | --- |
| `Cannot parse … tracker.json` | The file is not valid JSON, or not a jsonfile store. | Repair the JSON, or delete the file to start an empty tracker. |
| `issue #N not found` | The twin was deleted from the file by hand, or the file replaced. | `lpm remote pull` re-links, or re-push if the local side is the source of truth. |
| A status refuses to map | `mapping.statuses` names a status the file has never seen, or `closed` disagrees with the board's `terminal`. | `lpm remote push --dry-run` names the mismatch. |

The one command that surfaces most of these before any write is
`lpm remote push --dry-run` (and its read-only sibling `lpm remote status`).
