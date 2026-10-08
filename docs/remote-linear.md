# light-plan → Linear: setup guide

The page for a first-time Linear sync. It names the token to create, the exact
permissions, the setup steps, a complete config, what a push
creates, what a second sync does, and the failure modes people actually hit.
The *why* is in [`docs/remote-sync.md`](remote-sync.md); what Linear can hold
natively is in [`docs/remote-capabilities.md`](remote-capabilities.md).

Linear is the opposite of Jira in one way that shapes this whole page: it has
**no custom fields and no issue types**, and everything is **team-scoped**. The
connection names a team, and every query and mutation carries it.

## The token

Use a **personal API key**, created at **Linear → Settings → Account →
Security & access** (admins can also allow members to create keys under
Settings → Administration → API → Member API keys).

For each key, Linear lets you grant *full access* or a restricted set of
permissions. Grant exactly these four — **not** *Admin*:

| Permission | Why |
| --- | --- |
| **Read** | List and read issues, the team, workflow states, labels, cycles, users and the estimation scale. |
| **Write** | Update issues (title, body, state, estimate, priority, labels, assignee, parent, cycle) and create/remove `blocks` and `related` relations. |
| **Create issues** | File new issues (`issueCreate`). |
| **Create comments** | Post comments on issues. |

**Admin is not needed.** It opens admin-level endpoints the sync never calls.
Over-scoping is how a planning tool becomes a security review, and Linear makes
the temptation explicit by offering *Admin* one click away — leave it off.

The connector sends the key as a raw `Authorization` header (Linear's personal
API key style, not `Bearer`), so use a **personal API key**, not an OAuth
access token. If your shop only issues OAuth apps, the equivalent scopes are
`read, write, issues:create, comments:create` — but a personal API key scoped
to the team is the supported path.

You can also **limit the key to a specific team**. Do it: scope it to the team
named in `connection.team`, and the blast radius of a leaked key is that team
rather than the workspace.

## Setup

1. **Create the key** (above), restricted to Read, Write, Create issues,
   Create comments, scoped to the team. Copy it once.
2. **Connect the board**, which asks for the key and never puts it in the
   committed config:

   ```bash
   lpm remote connect              # asks which tracker, the team, and the key
   #   team (the team key, e.g. ENG): ENG
   #   api_key: ****************
   # …or pass what you already know:
   lpm remote connect linear --team ENG
   # …or keep it in the environment instead, and it is never asked for:
   export LINEAR_API_KEY=lin_api_…
   ```

   `team` is the team key (the short, URL-friendly key, e.g. `ENG`) or its id.
   The key is stored under `api_key`, this provider's own secret key, in the
   git-ignored and owner-only `.lpm/credentials.json`; `connection.api_key` may
   instead stay `${LINEAR_API_KEY}` or be omitted, and the resolver falls back
   through `LINEAR_API_KEY` and then the credentials file.

   The same command writes the whole mapping: board types ride labels carrying
   their own names (Linear has no issue types), and the statuses are drafted
   against a Linear team's default workflow states — `Backlog` / `Todo` /
   `In Progress` / `In Review` / `Done`, which the shipped Scrum template maps
   onto one for one. It then asks the team for its *real* workflow states and
   corrects any it spells differently.

3. **Or do it as three commands**, which is what a CI job needs:

   ```bash
   lpm remote add linear --provider linear --team ENG
   echo lin_api_… | lpm remote login linear
   lpm remote setup linear
   ```

   `setup` is the same conversation `connect` has for you, and the one to
   re-run whenever the pairing changes: it checks the credential, checks the
   team is reachable, then asks the team for its workflow states and corrects
   any it spells differently — reporting, with the list of the team's actual
   states, any it does not have. Read-only on Linear.

4. **Read the plan, then run it:**

   ```bash
   lpm remote push --dry-run      # the plan, no writes
   lpm remote push --all          # first write asks once, then lands
   lpm remote push LP-12          # or one document at a time
   lpm remote status              # exit 0 when the board and the team agree
   ```

## Complete example config

```yaml
remotes:
  linear:
    provider: linear
    scope: LP-10            # optional; omit to mirror the whole board
    direction: both         # push | pull | both
    on_delete: unlink       # unlink | close | delete
    conflict: manual
    comments: push          # push | both
    connection:
      team: ENG
      api_key: ${LINEAR_API_KEY}   # or omit and set the LINEAR_API_KEY env var
      # base_url: https://api.linear.app   # default; override only for a proxy
    mapping:
      types: { feature: { remote: feature }, user_story: { remote: story } }
      statuses: { backlog: Backlog, in_progress: "In Progress", done: { remote: Done, closed: true } }
      effort: { attribute: story_points }   # → Linear's native estimate
      attributes: { priority: "Priority" }  # everything else rides labels / the block
      accounts: { via: email }              # or an attribute holding a Linear user id
      periods: { container: sprint }        # → Linear cycles
```

Notes on the mapping. **Types ride labels** — Linear has no issue type, so a
board type is one or more labels. **Statuses are workflow states**, named per
team, each carrying a type (`backlog`, `started`, `completed`, `canceled`,
`triage`); `closed: true` marks the terminal one. **`effort` maps to Linear's
native `estimate`**, which is checked against the team's estimation scale at
preflight — a value off-scale is reported with the allowed values, never
silently rounded. **`periods.container` maps a board period to a Linear cycle**,
which is *numbered* rather than named; the convention is that the period's
title is the cycle's name (`Cycle 12`), and renaming a cycle in Linear breaks
the match until the period is re-titled to follow.

## What a push creates before it files anything

Today, **nothing on Linear**. The capability is declared — cycles and labels are
creatable through the API — but the connector that resolves the board's *names*
to Linear's UUIDs and creates the missing ones is a later story (LP-333 /
LP-334), not this one. Until it lands, the cycle or label the mapping names must
already exist in Linear, and a name that does not resolve is reported rather
than guessed.

In practice this means: create the labels and the cycle in Linear's UI before
the first push, where on GitHub or Jira the push would have made them for you.
When it lands it will be the same shape the other providers already have —
created by the push, desired-minus-current, and nothing on a re-run
(`src/remote/prerequisites.ts`).

## The second sync

No duplicates, for the same reason as every provider: the correspondence is
recorded, not re-derived.

- **Every document is linked.** `.lpm/remotes/<name>/links.json` maps each
  local id to its Linear UUID (`id` — the human-facing `LIN-1` identifier is
  carried alongside but never used as the key, because a team move changes the
  identifier while the UUID survives). The second push updates what it already
  filed and files only new documents.
- **Changes are a diff.** The base snapshot means an untouched issue is skipped;
  the post-write record is read back, so Linear's own normalisation is absorbed.
- **A pull refreshes everything.** `lpm remote pull` lists the team's issues,
  so every mirrored document comes back into step and anything new is imported.
  `--changed` uses the cursor (`updatedAt >= …`, paged by relay cursor) to read
  only what moved since — cheaper on a big team, and partial by construction,
  so it can never report a deletion.

Linear is the one platform where "restore" is a real undo, which matters if a
twin ever goes away: `issueDelete` is a **trash with a 30-day grace period**,
and `issueUnarchive` restores within it. `on_delete` policies still default to
`unlink` — the sync never deletes the remote side by default.

## Known limitations

- **No custom fields, no issue types.** Every board attribute beyond `estimate`
  and `priority` rides a label or the managed block; the board type is always a
  label. This is the least capable of the three platforms for attributes.
- **Fixed scales.** `priority` is a 5-value scale (0–4) and `estimate` follows
  the team's configured estimation scale (linear, exponential, Fibonacci,
  T-shirt); a board enum that does not fit is reported at preflight.
- **Cycles are numbered, not named.** The period↔cycle match is by title
  convention, which a rename on either side breaks.
- **One parent edge.** Native sub-issues give one level; deeper boards ride the
  managed block.
- **Everything is team-scoped.** States, labels, cycles and the estimation
  scale all belong to the team named in `connection.team`.

## Failure modes, and the command that diagnoses them

| You see | It means | Diagnose / fix |
| --- | --- | --- |
| `Linear refused … (authorization)` | The key exists but lacks a permission (e.g. no `issues:read`, or the key is scoped to another team). | Check the key's permissions and team scope under Security & access. |
| `issue … null` / a field comes back empty | The key cannot see the team, or the team is private (non-members see `null`). | Check the key is scoped to the team; `lpm remote status linear`. |
| A cycle or label "does not resolve" | The mapping names a cycle/label that does not exist, and this provider cannot create them yet. | Create it in Linear, or fix the name in `mapping.periods` / `mapping.statuses` / `mapping.attributes`. |
| Estimate refused with the allowed values | A `story_points` value is off the team's estimation scale. | Fix the value or the `mapping.effort.attribute`; the report lists the allowed scale. |
| A status refuses to map | The `mapping.statuses` name is not a state on this team, or its type clashes with the board's intent. | `lpm remote setup linear` reports the team's actual states and corrects what it can; `lpm remote push --dry-run` names the mismatch. |

The one command that surfaces most of these before any write is
`lpm remote push --dry-run` (and its read-only sibling `lpm remote status`):
it runs the preflight — an unmapped type or status, an off-scale estimate, an
assignee with no account — and refuses the push rather than discovering the
permission or name gap halfway through.
