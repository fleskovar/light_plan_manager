# light-plan → Jira Cloud: setup guide

The page for a first-time Jira Cloud sync. It names the token to create, the
exact permissions the account needs, the setup steps, a complete config, what a
push creates in the project before it files anything, what a second sync does,
and the failure modes people actually hit. The *why* is in [`docs/remote-sync.md`](remote-sync.md);
what Jira can hold natively is in
[`docs/remote-capabilities.md`](remote-capabilities.md).

Jira is different from the other providers in one way that matters for
setup: **its "scopes" are project permissions on the account, not a token with
a scope list.** The connector authenticates with an Atlassian API token over
Basic auth (`email` + token), and what that token may do is decided by the
permissions the account has been granted on the project. So the setup question
is two questions — *make this token*, and *get this account these permissions*.

## The token

Use an **Atlassian API token**, not the account password. Create it at
**https://id.atlassian.com/manage-profile/security/api-tokens**.

The connector uses Basic auth, so the credential is a pair: the **account
email** (the address the token belongs to) and the **API token**. Both resolve
through the same chain as every other secret — a `${VAR}` reference, then
`.lpm/credentials.json`, then the conventional env var — and neither is ever
written into the committed config.

OAuth 2.0 is **not** used by the connector. If you are on a shop that only
issues OAuth apps, the equivalent Jira OAuth scopes are `read:jira-work` and
`write:jira-work` (the *classic* pair), plus `manage:jira-project` where
sprints or the workflow graph must be managed and `manage:jira-configuration`
where custom fields must be created — but an API token on an account with the
project permissions below is the supported path.

The connector also needs the `jira.js` client. Jira sync is experimental, so
the client is not installed with light-plan. `lpm experimental on` installs it,
with the other experimental packages, on the machine that runs the sync
(Node 22+ required). To install only this client yourself, put it beside
light-plan:

```bash
lpm experimental on                         # installs every experimental package
npm install -g jira.js                      # light-plan installed with -g
npm install jira.js                         # light-plan is a project dependency
npx -p light-plan -p jira.js lpm remote …   # running through npx
```

## The permissions to ask for

This is the copy-pasteable list. Send it to whoever administers the Jira
project — the person running the sync usually cannot grant these themselves.

> Please grant the account that runs our light-plan sync the following **project
> permissions** on project `PAY`:
>
> - **Browse Projects** — to list and read issues, the project, fields and screens
> - **Create Issues** — to file new issues
> - **Edit Issues** — to update title, description, labels and custom fields
> - **Transition Issues** — to move issues between statuses
> - **Schedule Issues** — to move issues into and out of sprints
> - **Assign Issues** — to set the assignee
> - **Link Issues** — to write `depends_on` ("Blocks") and `relates_to` links
> - **Add Comments** — to post comments (add **Edit Own Comments** / **Delete Own
>   Comments** to round-trip them)
> - **Browse users and groups** (a *global* permission) — to list who can be
>   assigned, which is what the pre-push check reads to say "this will file
>   unassigned" before it files anything
>
> If the sync must also **delete** issues, add **Delete Issues**. If it must
> **create sprints** (a push does this) or **create custom fields**, add
> **Manage Sprints**, and the **global permission Administer Jira**. If status
> changes should walk several workflow transitions in one push
> (`mapping.transitions.multi_hop: true`), add **Administer Projects** (or
> **View workflow**) so the sync can read the workflow graph.

The minimum for a read/write mirror is the first eight. Everything after
"delete issues" is opt-in, and each line names the feature that needs it — do
not grant `Administer Jira` to a syncing account that will never create custom
fields, because that is exactly the over-scoping this guide exists to prevent.

## Setup

1. **Create the API token** (above). Copy it once.
2. **Ask for the permissions** (above), if you are not already a project admin.
3. **Install `jira.js`** beside light-plan (`npm install -g jira.js` for a global install, Node 22+).
4. **Connect the board**, which asks for the credentials and never puts them in
   the committed config. The credential is a pair, and one command asks for both:

   ```bash
   lpm remote connect              # asks for all four; nothing here is required
   #   site: acme.atlassian.net
   #   project: PAY
   #   email: you@acme.com
   #   token: ****************
   # …or pass what you already know:
   lpm remote connect jira --site https://acme.atlassian.net --project PAY
   # …or keep both in the environment instead:
   export JIRA_EMAIL=you@acme.com
   export JIRA_API_TOKEN=…
   ```

   `lpm remote connect` asks for each key in turn and stores what you type in
   the git-ignored, owner-only `.lpm/credentials.json`. The token is not echoed;
   the email is, because it is no secret to look at. A bare Enter keeps a value
   that already resolves, so replacing an expired token does not ask for the
   email again. Either half may come from the environment instead, or from a
   `${VAR}` reference in the config.

   The same command then writes the whole mapping for you — drafted from this
   board's types and statuses against Jira's default Scrum vocabulary (`Epic` /
   `Story` / `Task` / `Bug` / `Sub-task`, and `To Do` → `In Progress` → `Done`)
   — checks the project is reachable, and asks it for its *real* issue types and
   statuses. A name your project spells differently (`Subtask` for `Sub-task`)
   is corrected in `config.yml`; a name it does not have at all (`Selected for
   Development` where the draft said `To Do`) is a question, with the project's
   own names as the options. It never writes to Jira.

5. **Or do it as three commands**, which is what a CI job or an agent needs —
   nothing there can answer a question:

   ```bash
   lpm remote add jira --provider jira --site https://acme.atlassian.net --project PAY
   echo <api-token>  | lpm remote login jira
   echo you@acme.com | lpm remote login jira --key email
   lpm remote setup jira          # exits 1 while anything is unanswered
   ```

   `lpm remote setup` is also the command to re-run later, whenever anything
   about the pairing changes — a new credential, a renamed status upstream, a
   board that grew a column. `--dry-run` reports without touching `config.yml`.

6. **Read the plan, then run it:**

   ```bash
   lpm remote push --dry-run      # the plan, plus the sprints it would create
   lpm remote push --all          # everything; the first write asks once
   lpm remote push LP-12          # or one document at a time
   lpm remote status              # exit 0 when the board and the project agree
   ```

## Complete example config

```yaml
remotes:
  jira:
    provider: jira
    scope: LP-10            # optional; omit to mirror the whole board
    direction: both         # push | pull | both
    on_delete: unlink       # unlink | close | delete
    conflict: manual
    comments: push          # push | both
    connection:
      site: https://acme.atlassian.net
      project: PAY
      board: 12             # the Agile board id — sprints need it; setup finds it
      email: ${JIRA_EMAIL}
      token: ${JIRA_API_TOKEN}
      # tls_verify: false   # never set this except as a last resort
    mapping:
      types: { epic: { remote: Epic }, user_story: { remote: Story }, task: { remote: Task } }
      statuses: { backlog: "To Do", in_progress: "In Progress", done: { remote: Done, closed: true } }
      attributes: { story_points: customfield_10016, priority: priority }
      accounts: { via: jira_account_id }
      periods: { container: sprint }
      transitions: { multi_hop: false }
      transition_fields: { resolution: { name: Done } }
```

You should not have to write this block: `lpm remote connect` drafts it and
corrects it against the live project. It is here so you can read what was
written and change what you want to.

Notes on the mapping: `attributes` maps a board attribute to a Jira custom
field **id** (`customfield_10016`) — the id the instance actually has, which
you can read from the field's URL. `accounts.via: email` resolves an email to a
Jira account id through user search (and fails on privacy-restricted instances,
which is why `via: jira_account_id` is the safer choice). `statuses` uses
workflow status names, and `closed: true` marks which one is terminal.

## Sprints: filed when you ask, never behind your back

**A push of work does not create sprints.** A Jira sprint is a document on your
board — a name and dates somebody wrote down — so filing one is filing part of
the plan, and it is asked for:

```bash
lpm remote push TL-3       # file this sprint
lpm remote push --all      # everything, timeline included
```

An issue scheduled into a sprint Jira has not got is filed **unscheduled**, and
the tool records that the field was not written. The push that files the sprint
writes the assignment — and it also picks up every issue already filed into that
period, so one command repairs them all. Nothing has to be done in order.

A push that files the sprint *and* the work in it in the same run schedules them
there and then; you do not have to push twice. (That was not true until the
live suite caught it: the connector caches the board's sprint list, and creating
a sprint did not empty the cache, so every issue in it was filed unscheduled and
only caught up on the next push. The self-healing above hid it — the board was
permanently one push behind its own timeline.)

This matters more on Jira than anywhere else, because Jira refuses sprint names
over **30 characters**. When sprint creation was part of every push, one
over-long period name stopped the whole board from filing. Now it stops nothing:
the sprint stays unfiled, its issues stay unscheduled, and renaming the period
fixes it whenever you get to it. `lpm remote setup jira` lists the periods that
are not filed.

**The Agile board id is not optional once you schedule anything.** A Jira sprint
belongs to an Agile *board*, not to a project, so `connection.board` is what a
sprint is created on and found in. A mapping that carries `periods` without it
is an **error at preflight** — before a push writes anything — naming the
remedy.

You should not have to go and find it: `lpm remote connect` and `lpm remote
setup` ask Jira for the project's boards and write the id into `config.yml`
(one board is filled in, several is a question). If you would rather set it by
hand, the id is the number in the board's URL:
`…/jira/software/c/projects/PAY/boards/`**`12`**.

A sprint is created with the board period's name and dates. Board dates are
**inclusive calendar days**, and a Jira sprint is a pair of instants that
requires the start to be strictly before the end — so the start is sent as the
beginning of its day and the end as the *end* of its day. That is what the board
already meant, and it is what lets a one-day sprint (`starts` and `ends` on the
same date, an ordinary thing to have) exist at all.

Filing periods is desired-minus-current, so a second push creates nothing.
`lpm remote push --dry-run` lists what it would create without writing.

Jira deliberately does **not** get custom fields created for it, or added to
screens:
that needs the *Administer Jira* global permission the syncing account usually
does not have, and guessing a field type or a screen is worse than a clear
request. A missing or off-screen custom field is reported with a
copy-pasteable administrator request naming the field, the type and the issue
types it must be added to — send that instead of handing out admin.

## The second sync

No duplicates, for the same reason as every provider: the correspondence is
recorded, not re-derived.

- **Every document is linked.** `.lpm/remotes/<name>/links.json` maps each
  local id to its Jira issue id (the numeric id — the human-facing `PAY-418`
  key is carried alongside, but never used as the key). The second push edits
  the issues it already filed and files only genuinely new documents.
- **Changes are a diff.** Each link's base snapshot means an untouched issue is
  skipped; the post-write record is read back from Jira, so Jira's own
  normalisation is absorbed rather than coming back as a phantom edit.
- **Sprints are yours to file.** A second push of the same work does not create
  or rename sprints; only a push that names a period does.
- **A pull refreshes everything.** `lpm remote pull` lists the whole project, so
  every mirrored document is brought back into step and anything new is
  imported. `--changed` asks JQL for `updated >= …` instead — cheaper on a big
  project, and partial by construction, so it can never report a deletion.

One Jira-specific caveat for the second sync: **a status change is a workflow
transition, and the target may be unreachable** from where the issue stands.
That is a refusal with the reachable statuses named, not a silent skip — and
`mapping.transitions.multi_hop: true` opts in to walking the workflow
automatically, which you should leave off unless you want automations fired and
resolutions stamped on your behalf.

## Team-managed projects

A **team-managed** ("next-gen") project is the common case for a new Jira site,
and it constrains the mapping in two ways worth knowing before the first push.
`lpm remote setup jira` reports the first; the second shows up as
`Please select valid parent issue`.

**Its issue types are project-scoped.** Custom hierarchy levels — an
`Initiative` above `Epic`, a `Program` above that — belong to *company-managed*
projects. You can create those types at the instance level and give them
hierarchy levels, and a team-managed project still will not offer them: Jira's
own create metadata is the authority, and `lpm remote setup jira` prints the
list. So the types a team-managed project can file are its own (typically
`Epic`, `Story`, `Task`, `Feature`, `Bug`, `Subtask`), and a board with more
levels than that maps several of its levels onto one of them:

```yaml
      types:
        program:    { remote: Epic }
        epic:       { remote: Epic }
        feature:    { remote: Epic }
        user_story: { remote: Story }
        sub_task:   { remote: Subtask }
```

**And it nests by type, not by depth** — which light-plan handles for you.
Jira's hierarchy is defined from the bottom up (`Subtask` < standard < `Epic`)
and only a standard issue may sit under an Epic, so the provider declares
itself **leaf-anchored**: the native parent edge is spent on the *deepest* board
levels, where Jira accepts it, and the levels above ride the managed block.

For the five-level board above that means:

| Board edge | Carrier |
| --- | --- |
| `sub_task` under its story | native (`Subtask` under a standard issue) |
| `user_story` / `bug` / `test` under its `feature` | **native** (standard under `Epic`) |
| `feature` under its `epic` | managed block (`Epic` may not sit under `Epic`) |
| `epic` under its `program` | managed block |

So the work shows up nested under its feature in Jira's backlog, and only the
two container levels above are block-carried. Nothing needs setting. If you want
to override it, `mapping.hierarchy: labels` puts *every* parent in the block and
`sub-issues` forces the native edge as far as the probed depth allows.

Nothing is lost either way. A block-carried parent round-trips exactly, and the
issue body shows it:

```
<!-- lpm:begin -->
| light-plan |  |
| --- | --- |
| parent | 10002 |
| period:increment | PI - 6 - Remote Services |
<!-- lpm:end -->
```

## Known limitations

- **Status is transition-mediated.** A push to `done` may need a transition the
  workflow does not offer from the current status; multi-hop is opt-in and off
  by default.
- **Hierarchy is the project's type scheme.** Epic → Story → Sub-task is the
  classic ceiling, and levels above Epic are a paid feature; the depth is
  detected against the project's actual scheme, never assumed.
- **Custom fields are global, "scoped" by visibility.** A field lives on the
  whole instance and is addressed by a per-instance id; two projects can share
  one with different options.
- **A team-managed project cannot use custom hierarchy levels**, whatever types
  the instance defines — see above.
- **Sprint names are capped at 30 characters.** A longer board period is
  reported and left unfiled; nothing else is blocked.
- **A sub-task inherits its parent's sprint**, whether or not anybody asked, so
  light-plan does not mirror a sub-task's period at all. Jira reports the
  parent's sprint on the sub-task — the identical object — and a sub-task cannot
  be scheduled independently, so that value is derived rather than stored and is
  never read back as the sub-task's own. Without this every sub-task under a
  scheduled story sat permanently `behind` on `period`; the sprint is still
  mirrored, by the story that owns it. Pulling it instead would have written a
  derived sprint onto documents the plan deliberately schedules one level up —
  changing what the periods view and the Gantt add up — and every one of them
  would drift again the moment the parent moved sprint.
- **`depends_on` is filed as a "Blocks" link, and Jira names it from the other
  end.** `LP-9 depends_on LP-8` shows in Jira as *LP-9 is blocked by LP-8* —
  correct, and worth stating, because Jira's API calls the blocker the
  `inwardIssue`, which reads the opposite way round to most people's first
  guess and had the direction reversed until a live test measured it.
- **Cloud only.** A Server/Data Center URL is indistinguishable from a Cloud
  custom domain by URL alone, and is reported as "not supported" rather than a
  confusing 401/404.
- **Deletion is hard.** `DELETE /rest/api/3/issue/{id}` is permanent, with no
  recycle bin in Cloud; `on_delete: delete` asks for confirmation every run for
  that reason.

## Testing against a real project

The Jira pairing has an end-to-end suite, `test/remote-live-jira.test.ts`. It is
skipped unless you opt in, so `npm test` never needs a token:

```bash
LPM_LIVE=1 \
JIRA_EMAIL=you@acme.com JIRA_API_TOKEN=… \
LPM_LIVE_JIRA_SITE=https://acme.atlassian.net \
LPM_LIVE_JIRA_PROJECT=SCRATCH \
npx vitest run test/remote-live-jira.test.ts
```

It builds a five-level board in a temp directory — the shape matters, because
Jira holds two native parent levels and the ones above have to ride the managed
block, so a shallower board tests only half the hierarchy — files it, and then
asks **Jira** what it holds: the parent of each issue and which carrier it came
through, the status a created issue landed in, the direction of each Blocks
link, the sprint each issue sits in. Nothing is read back through the connector.
That is the point: a fake tracker is built from the same reading of Jira as the
adapter, so a shared misunderstanding round-trips perfectly — which is how a
reversed link direction and a status that was never written passed every offline
test.

**It empties the project before each run**, not after; a killed run must not
leave wreckage for the next one. Two things keep that away from real data: the
project key is explicit and has no default, and a key that any board in the
working tree mirrors is refused before a single request is made. Point it at a
scratch team-managed project, never at one you care about.

## Failure modes, and the command that diagnoses them

| You see | It means | Diagnose / fix |
| --- | --- | --- |
| `the Jira account email was rejected` | The 401 body blames the *email* half (Basic auth read as a password pair). | Check `connection.email` matches the account that owns the token; set it via `JIRA_EMAIL` or `${JIRA_EMAIL}`. |
| `the Jira API token was rejected` | The 401 blames the *token* half. | Regenerate at id.atlassian.com, then `lpm remote login jira` (a bare Enter keeps the email). |
| `Jira refused … (permission denied)` (403) | The credential is valid but lacks a project permission. | Check Browse/Create/Edit issues on the project — see the list above. |
| `Jira answered 404` | The site is not a Cloud site, the issue is gone, or the account cannot see it (Jira conflates these). | Check `connection.site` is `*.atlassian.net`; `lpm remote status jira`. |
| `the Jira client (jira.js) is not available` | The client is not installed beside light-plan (a standard install leaves it out), or Node < 22. | `npm install -g jira.js` beside a global install, `npm install jira.js` in a project. |
| `the mapping carries "periods" and this remote has no board` | A Jira sprint belongs to an Agile board, not a project, and `connection.board` is unset. | `lpm remote setup jira` finds it and writes it in; or set `connection.board` to the number in the board URL. |
| `Sprint name must be shorter than 30 characters` | Jira's limit; the board period's title is longer. | Rename the period. Nothing else is blocked — the sprint stays unfiled and its issues stay unscheduled until you do. |
| The pre-push check says the people could not be listed | The account lacks the global *Browse users and groups* permission. | Ask for it, or accept the offline half of the check: it still reports a person with no account on file, just not one Jira has never heard of. |
| `issuetype: Specify a valid issue type` | The mapping names a type this project does not offer — on a team-managed project, instance-level types are not available. | `lpm remote setup jira` lists the types it does have. A push that creates anything now refuses *before* writing, with the same list. |
| `parent: Please select valid parent issue` | The parent's mapped type cannot hold the child's — two board levels on `Epic`, say. | Handled: Jira is leaf-anchored, so the native edge is only used where the types allow. `mapping.hierarchy: labels` forces every parent into the block if you want that. |
| `description: The field value is not valid ADF content` | A body whose markdown produced a mark combination ADF forbids (bold code was the one found). | Fixed in the converter; if you see it again, the body has a construct worth reporting. |
| Every document reads as `changed` on every push | Jira stores the description as ADF, which has paragraphs but no source line breaks, so a hard-wrapped body comes back unwrapped. | Handled: the board's body is put through the same round trip before it is compared, so re-wrapping is not an edit. A body still reported ahead after two clean pushes is worth reporting. |
| An issue arrives in Jira with no sprint | Expected when the sprint has no twin yet: the issue is filed unscheduled and the field recorded as unset. A push that files the sprint in the *same* run schedules it immediately. | `lpm remote push <period-id>` — it files the sprint and writes the assignments, for that issue and every other one already waiting on it. |
| `Cannot move … to "Done"` (unreachable / multi-hop refused) | The workflow has no single transition to that status. | Set `mapping.transitions.multi_hop: true`, or move the issue one status at a time. |
| `the transition requires field …` | A transition screen needs a value the config did not provide. | Set `mapping.transition_fields.<key>`. |
| A push refuses: the project has no issue type `Story` | The drafted convention does not match this project's scheme (a team-managed Kanban project has `Task` and no `Story`). | `lpm remote setup jira` — it reports the types the project does have and corrects what it can. |

The one command that surfaces most of these before any write is
`lpm remote push --dry-run` (and its read-only sibling `lpm remote status`):
it runs the preflight — an unmapped type or status, a custom field that will
not coerce — lists the sprints it would create, and refuses the push rather than
discovering the permission gap halfway through.
