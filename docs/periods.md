# Periods: what is running, and what to do when it overruns

A period is a timebox — a sprint, an increment, a cycle. Issues are scheduled
into one through their own `period:` field, at any level of the hierarchy, so a
feature can sit in the increment while its stories sit in the sprints.

This document is about the one question everything else hangs off: **which
period is running right now?** — and about the two answers offered when one
stops running with work still in it.

- [The two controls](#the-two-controls)
- [The omni periods](#the-omni-periods)
- [The `active` switch](#the-active-switch)
- [What "running" changes](#what-running-changes)
- [Restarting a period](#restarting-a-period)
- [When a period overruns](#when-a-period-overruns)
- [Where the rules live](#where-the-rules-live)

## The two controls

Boards arrive with a calendar: `starts` and `ends` are reserved and required on
every period, and a period runs when today falls inside it. For a team that
plans in dates, that is the whole story and nothing below needs reading.

But two things happen to real teams that dates alone answer badly:

- **Some teams do not plan by date.** The sprint boundary is a decision, not a
  fortnight — work moves when the team says it moves.
- **Every team occasionally has to reroute people.** An increment is paused
  because something elsewhere became urgent; a sprint is picked back up two
  months later with the plan in it still good.

So there are two controls, and they run in parallel:

| | What it is | What it does |
| --- | --- | --- |
| **The dates** | `starts` / `ends` on the document | The default, and the only thing most boards use |
| **The switch** | `active` on the document | Overrides the dates for that period, when it is set at all |

They are not alternatives to choose between at board level. A board can run
entirely on dates, entirely on switches, or on dates with one sprint switched
off this week — that last one is the case the switch was added for.

## The omni periods

A board that never plans by the calendar still needs a running timebox, or every
ticket is "unscheduled" and the Periods and Gantt views have nothing to show. So
`lpm init` seeds one standing period per level of `period_hierarchy`, each
nested in the one above (`Omni Product Increment` > `Omni Sprint` on Scrum,
`Omni Delivery Cycle` on Kanban), dated from that day for a year, and writes
`default_period` naming the innermost into `.lpm/config.yml`. `--no-omni` skips
both. They are ordinary period documents: nothing else in the engine knows they
are special.

`default_period` is the only rule they add, and it is applied in `createIssue`,
so the CLI, the web push and the MCP tools all get it:

| The new issue's `period` | What it gets |
| --- | --- |
| A period id | That period |
| `null` (`--period none`, a pushed `period: null`) | Nothing — unscheduled |
| Not given | `defaultPeriodFor(board)` |

`defaultPeriodFor` (`src/core/board/query.ts`) answers the default period only
while **every period on the board is that period or one of its ancestors**. The
first period somebody builds outside the chain means they are planning, so new
work arrives unscheduled for them to place: ranking it in bucket 1 beside their
sprint would undo the plan. What the chain already holds stays there, because
moving scheduled work is the planner's decision, not the engine's.

Three consequences:

- **A pull never takes the default.** `planPull` always states `period` on a
  create (`null` when the tracker has none). Otherwise an unscheduled tracker
  issue would land in the omni sprint, and the next push would try to file it in
  a sprint the tracker never had.
- **Deleting the chain is the way out.** `lpm rm TL-1` removes both periods and
  unschedules whatever they still hold. A `default_period` naming a missing
  period is a `lpm check` warning and is otherwise ignored.
- **A year on, the omni sprint has ended.** Ended work still ranks first, and
  `lpm period TL-2 --start-now` renews the chain for another year.

The web app does not mirror the default in its working copy, so a node created
there shows as unscheduled until the push lands. That is cosmetic: the
default cannot refuse anything, so the canvas never queues work that cannot land.

## The `active` switch

`active` is an optional reserved field on a period document with three states:

```yaml
active: true     # running, whatever the dates say
active: false    # parked, whatever the dates say
# absent         # the dates decide — the ordinary case
```

**Absent is not false.** A board that has never touched a switch behaves exactly
as it always did, and nothing in the engine defaults the field. Removing the
switch is a distinct act from switching off, which is why the write API takes
`null` to mean "hand it back to the dates":

```bash
lpm period TL-2 --on       # active: true
lpm period TL-2 --off      # active: false
lpm period TL-2 --dates    # the key is removed
lpm period TL-2            # say how it stands, change nothing
```

In the web UI it is the toggle on every box in the Periods tab; over MCP it is
`update_document` with `active`. A value that is neither a boolean nor a
readable `yes`/`no` is reported by `lpm check` and **treated as absent** — a
typo must never park somebody's work.

### Off cascades; on does not

The two directions are deliberately asymmetric:

- **Off** applies to the period *and everything nested inside it*. Parking an
  increment parks its sprints, or "not this quarter" would mean nothing.
- **On** applies to the period it is written on, and nothing below. A live
  quarter has never meant all six of its sprints are this week.

So an increment switched off wins over a sprint inside it switched on. The
resulting three-state answer is a period's **stance**:

```
stance(period) = 'off'   if this period or any period above it is active: false
                 'on'    else if this period is active: true
                 'auto'  otherwise — the dates decide
```

`auto` then falls back to `starts <= today <= ends`, with an absent `ends`
running on indefinitely.

### Which period is drawn as "now"

Among the periods that are running, only the **innermost on its own chain** is
drawn as current: a story in this week's sprint is a different claim from an
epic parked on the quarter, and only the first is work to pick up today.

"Innermost on its own chain" is not "deepest on the board". A sprint running
inside one increment says nothing about a *different* increment somebody
switched on by hand, and that second increment keeps its badge.

## Filling a period from the canvas

Scheduling is a field on the issue, so putting work in a sprint is one update
per issue and every surface does it the same way: `lpm move <id> --period <id>`,
`update_document`, a card dragged between boxes in the Periods tab.

The canvas has a shortcut for the bulk case. **Alt+drag a node from the graph
into a period box** and the *work under it* is scheduled — an epic brings the
user stories beneath it, a feature brings only its own, a story goes in by
itself. Containers are never scheduled this way: a feature is not a thing you
pick up, it is the name of the stories you do, which is the same rule
`nextTasks` and the roster count by (`workUnitsUnder` in
`web/src/lib/board/selectors.ts`). A story whose type is declared `atomic` is one
of those units, so its sub-tasks are not scheduled separately either.

The graph itself does not move: the node stays where it is, the camera holds
still and no position is saved, because being scheduled into a sprint says
nothing about where an issue belongs on the canvas. Escape puts it down having
changed nothing, and dropping onto the unscheduled box takes the whole subtree
back out. Alt+drag onto an *edge* still splices a node into that dependency; the
two are told apart by where the pointer is when the button comes up.

## What "running" changes

The switch steers **what is offered**, never what is reachable.

**Work in a period somebody switched off is not offered at all.** `lpm task
next`, `lpm task start` with no id, MCP `next_tasks` and `lpm queue simulate`
all withhold it. Ranking it last is not enough: "last" becomes "next" the moment
the rest of the queue runs out, so a team that parked six sprints would be
handed them one by one as soon as this sprint emptied. Off means "not this one".

Asking for it back is one flag — `--parked` on the CLI, `includeParked` on
`next_tasks` — and then it ranks last, in the bucket order below. One rule, in
one place: `isParked` in `core/board/tasks.ts`, applied once in `candidatesFor`,
so no front end can disagree about whether a parked sprint is on offer.

What is left ranks in buckets:

| Bucket | Work in… |
| --- | --- |
| 1 | a period that is running — switched on, or holding today |
| 2 | no period at all |
| 3 | a period that has not started yet |
| 4 | a period somebody switched **off**, once `--parked` asked for it |

Within a bucket the board's `priority_attribute` decides, then the column
closest to done, then which part of the plan is already under way (a feature
somebody is inside, then one closest to finished, then an untouched one — see
`src/shared/cohesion.ts`), then how much each issue unblocks, then age.

Two consequences worth stating plainly:

- **A period that has not started is still the plan.** It is ranked after the
  running one, not withheld — only the switch withholds, because only the switch
  is somebody saying "not this one".
- **A period that merely *ended* still ranks first.** Overrunning work is the
  most urgent thing on a board, not the least. Only the switch moves work down.

Nothing is hidden and no document becomes unreadable: `lpm open`, `get_document`
and `lpm task start <id>` ignore all of this, exactly as they ignore a profile's
scope. This is routing, not permission.

## Squads and period ownership

A period can name the squad that owns it through its `squad` field — a reference
to a squad document under `.lpm/squads/`. When a period is owned by a squad, only
that squad's members are offered work from it (`candidatesFor` in
`src/core/board/tasks/ranking.ts`). A period with no squad is the ordinary case
and applies no filter.

### Inheritance

A sprint's squad follows the same rules as the `active` switch:

- **A sprint with an explicit squad uses it.** The squad on the sprint document
  is what decides, same as switching a sprint on says "this one runs now".
- **A sprint with no squad inherits from its nearest ancestor that has one.** An
  increment owned by squad A passes that ownership down to every sprint inside it
  that does not state its own — same as parking an increment parks its sprints.

The resolution is a single function: `effectiveSquad` in
`src/core/board/query.ts`, walking the parent chain the same way `periodStance`
walks it in `src/shared/period-stance.ts`. The CLI, the web canvas and MCP
`next_tasks` all read from it, so they cannot disagree about who owns a sprint.

```ts
effectiveSquad(board, 'TL-2')  // sprint's explicit squad, or the increment's
```

The pre-computed `periodSquadMembers` map in `LoadedBoard` resolves every period
at load time via the same walk, so the queue check is `O(1)` per issue.

## Restarting a period

The switch overrides the calendar; `--start-now` rewrites it.

```bash
lpm period TL-2 --start-now
```

The period takes today and **keeps how long it runs** — a two-week sprint
started today ends a fortnight from today. Three other things move with it,
because none of them can be left behind honestly:

1. **Everything nested inside it shifts by the same number of days**, so a
   restarted increment keeps its shape: sprint 1 still starts on day one, and
   the gaps between sprints stay where the calendar had them.
2. **Whatever else was running today is closed yesterday**, or the board would
   claim two current sprints.
3. **The periods above stretch** to reach the new dates, so a child never falls
   outside its parent.

Every front end asks before doing it, and lists exactly those changes — starting
a sprint is a sentence somebody says in a stand-up, and rewriting six documents'
dates is not. In the web UI the edits are queued like any other, so they can be
read in the pending list before a push.

Switching a period **on** while today falls outside its dates asks whether to
move the dates as well: reusing the plan in an increment that was started and
abandoned is exactly a restart. Declining still flips the switch and leaves the
dates alone, as the record of what was planned — a team that does not plan by
date should never be made to touch one.

## When a period overruns

A period is **overdue** when its `ends` has passed and it still holds issues in
a non-terminal status. It is drawn in red in the Periods tab and reported by
`lpm period <id>`. The switch has no bearing on this: parking a sprint does not
close it.

There are exactly two honest answers, and both are offered rather than one being
chosen for the reader:

```bash
lpm period TL-2 --complete    # move the open issues to the board's end state
lpm period TL-2 --carry-over  # move them into the next period beside it
```

- **Complete** records that the team *stopped*, not that the work happened. It
  is the right answer when what is left is not being done.
- **Carry over** leaves what was finished where it was delivered — that is the
  record of the sprint — and moves the rest one period along, into the next
  sibling in date order.

Three rules hold for both:

- **Only issues scheduled directly in that period are touched.** An increment
  answers for its own epics; the sprints inside it answer for their own stories.
  Correcting a quarter must not reach in and reschedule six sprints of work.
- **No period is invented.** The increment does not get any longer, so carrying
  work down a run is what makes the last sprint's backlog grow — which is the
  fact a reader needs to see, not a problem to paper over.
- **The last period refuses.** With nowhere further to push, `planCarryOver`
  fails with a message rather than quietly unscheduling somebody's work. Add a
  period beside it, or complete it where it is.

Over MCP both are `correct_period` with `mode: 'complete' | 'carry'`, and both
take `dryRun`.

## Where the rules live

| Rule | Engine | Browser |
| --- | --- | --- |
| Stance, running, overdue | `src/shared/period-stance.ts` (single copy; both adapt) | same function |
| Ranking by bucket | `src/core/board/tasks.ts` (`scheduleRank`) | `web/src/features/queue/` |
| Start now | `src/shared/plans.ts` (`planStartNow`) | the same function |
| Complete / carry over | `src/shared/plans.ts` | the same functions |

`periodStance`, `periodHoldsDate` and `isPeriodRunning` are written once in
`src/shared/period-stance.ts` against a minimal structural shape
(`PeriodNode` — `{ id, parentId, active }` plus a parent-lookup function).
The engine adapts `LoadedBoard` to that shape; the browser adapts
`WorkingNodes`. Neither imports anything from the other.

Everything else is shared. `planStartNow`, `planCompletePeriod` and
`planCarryOver` are pure functions from a board view to a list of changes, so
the CLI, the web canvas and an MCP agent reshape a timeline identically; the web
queues the result, the other two hand it straight to `src/sync`.
