---
name: lpm-tdd
description: Plan a feature on a light-plan board for test-driven development, in small iterations. Load this when a person asks to plan, break down or start a feature "test first", "with TDD", "red green refactor", "in iterations" or "in slices", or asks how much design to do before the first line of code. It gives the plan that the board holds (slices of one test issue and one build story, then one open-points story), the rules for what to decide before the first slice and what to defer, the dependencies, the assignments and a registry template. Load lpm-tdd-tests, lpm-tdd-cycle and lpm-tdd-open-points for the work inside each issue.
roles:
  - pm
  - developer
---

# Planning a feature for test-driven development

This skill turns a feature request into a plan on a light-plan board. The
plan delivers the feature in small, tested iterations. Each iteration adds
behaviour and keeps every earlier test green. The last step lists what a
person must review.

Load the `lpm` skill first for the tool map. Load `lpm-planning` for the
general rules of planning, and `lpm-writing` before you write any text.

| Skill | What it covers |
| --- | --- |
| `lpm-tdd` | This skill: the plan on the board, and how much to design before the first slice |
| `lpm-tdd-tests` | How to write tests that a person can read, check and solve by hand |
| `lpm-tdd-cycle` | How a developer works one slice: red, green, refactor, and the trail on the issue |
| `lpm-tdd-open-points` | How to write the assumptions, known issues and limitations for a reviewer |

## Terms

- **Behaviour.** One rule that the feature follows, with concrete values.
  Example: "An invoice paid 3 days late gets a fee of 6.00."
- **Behaviour list.** All the behaviours of the feature, one line each. The
  list is the specification. Each line becomes one or more tests.
- **Slice.** One to three behaviours that a developer builds end to end and
  merges alone. A slice adds behaviour that a user or a caller can observe.
- **Open point.** An assumption, a known issue or a limitation that a person
  must review. `lpm-tdd-open-points` defines the three kinds.

## The plan that the board holds

A feature planned with this skill contains these issues. The type names come
from the Scrum template that `lpm init` writes. `board_overview` gives the
names on your board.

```
feature   Late fees on overdue invoices        the behaviour list, the decisions
  test        Cases for slice 1: a fee for each day late
  user_story  Charge a fee for each day an invoice is late     depends on the test above
  test        Cases for slice 2: a grace period of 5 days
  user_story  Skip the fee during the grace period             depends on the test above
  user_story  Write the open points of late fees               depends on the last slice
  review      (one for each open point, created by the story above)
```

Each pair of a `test` issue and a `user_story` is one slice:

- **The `test` issue** holds the cases of the slice, with the expected values
  that a person calculated by hand. The developer writes these tests and
  watches each one fail. This is the "red" step.
- **The `user_story`** holds the work that makes the tests pass ("green"), and
  the refactor after it. Its definition of done requires the full suite to
  pass.

The separate `test` issue puts the expected values on the board before any code
exists. A reviewer can read them, and the developer of the story cannot change
them to match the code.

## Step 1: Write the behaviour list

Write the list in the body of the feature, under "Acceptance Criteria". Each
line is one behaviour with concrete values. Take the values from the request.
When the request gives no value, choose one and mark the line as an
assumption.

```markdown
## Acceptance Criteria

1. An invoice paid on or before its due date gets no fee.
2. An invoice paid late gets 2.00 for each day after the due date.
3. The first 5 days after the due date are a grace period with no fee.
   Assumption: day 6 is the first day with a fee. The request says "after a
   grace period of 5 days".
4. The fee of one invoice is 50.00 or less.
5. A cancelled invoice gets no fee.
```

Check the list with three questions:

1. Can a person check each line with a calculator and the values in the line?
   If not, add the values.
2. Does each limit in the list have a line for the value at the limit? Line 3
   names day 5 and day 6. A list that says "after 5 days" and no day number
   has a gap.
3. Does each line say what happens, and not how the code does it? "The fee
   table has a row for each day" is a design. Move it to "Notes" or delete
   it.

Each gap that you find now costs one question. The same gap found after a
release costs a defect.

## Step 2: Decide only what is expensive to change later

Before the first slice, decide the items that cost more than one slice of work
to change. Defer every other decision. Record each deferred decision as an
assumption, so a person can review it at the end.

| Decide before the first slice | Defer to the slice that needs it |
| --- | --- |
| A data format that other systems or other teams read | The internal structure of a module |
| A schema for data that is stored and must be migrated to change | The names of private functions and files |
| A public API that callers outside the repository use | The number of classes or modules |
| A security or permission boundary | An abstraction for a variant that nobody asked for |
| The behaviour list and its values | The order of slices after the first two |

Use this test for each decision: "If this decision is wrong, what does the
correction cost?"

- **The correction is one slice or less.** Choose the simplest option now.
  Write it as an assumption in the feature body or in a comment.
- **The correction is more than one slice** (stored data, a published contract,
  a migration). Put a `research` issue or a decision `review` before the slice
  that depends on the answer. `lpm-planning` explains where a research issue
  goes.

Do not design for variants that the behaviour list does not contain. Each
slice adds the structure that its behaviours need. The refactor step of a later
slice adds an extension point when a second variant arrives. `lpm-tdd-cycle`
explains that step. This approach keeps the first slices small. The tests of
the earlier slices make the later changes safe.

## Step 3: Cut the behaviour list into slices

Rules for a slice:

- **One to three behaviours.** A developer finishes a slice in one or two days.
- **End to end.** The slice goes through each layer that the behaviour needs:
  input, logic, storage, output. "The database part of late fees" is a layer,
  not a slice.
- **Mergeable alone.** After the merge, the product works and every test
  passes.
- **The first slice is the simplest complete path.** For late fees, slice 1 is
  "a fee for each day late" with no grace period and no cap. The first slice
  shows where the code goes and how the tests run.
- **Order by what the next slice needs, then by risk.** Put a behaviour with
  an unknown value or an unknown dependency early. The answer then changes the
  plan before many slices depend on it.

For the list in step 1:

| Slice | Behaviours | Why in this place |
| --- | --- | --- |
| 1 | 1, 2 | The simplest complete path |
| 2 | 3 | Changes the calculation of slice 1 |
| 3 | 4, 5 | Two limits on the result of slice 2 |

## Step 4: Create the issues

Create the feature first, with the behaviour list. Then create each slice: the
`test` issue, then the `user_story` that depends on it. Omit `body` to get the
type's template, then fill in the template.

```
create_document { type: "feature", title: "Late fees on overdue invoices", parent: "LP-2",
                  body: "## Summary\n…\n## Acceptance Criteria\n1. …" }

create_document { type: "test", title: "Cases for slice 1: a fee for each day late",
                  parent: "LP-3", assignee: "RS-2",
                  attributes: { test_level: "unit", automated: true } }
create_document { type: "user_story", title: "Charge a fee for each day an invoice is late",
                  parent: "LP-3", assignee: "RS-2", dependsOn: ["LP-4"],
                  attributes: { story_points: 3 } }
```

```bash
lpm new test -t "Cases for slice 1: a fee for each day late" -p LP-3 \
  --set test_level=unit --set automated=true --assignee RS-2
lpm new user_story -t "Charge a fee for each day an invoice is late" -p LP-3 \
  --depends-on LP-4 --set story_points=3 --assignee RS-2
```

What each issue contains:

| Issue | Body |
| --- | --- |
| `test` | The behaviours of the slice, by number from the feature. One table row for each case: the input, the expected output and the hand calculation. `lpm-tdd-tests` gives the format |
| `user_story` | "Make the tests of LP-4 pass." The definition of done below |
| Open-points story | "Write one review issue for each open point of the feature." `lpm-tdd-open-points` gives the format |

The definition of done of each build story:

```markdown
## Definition of Done

- [ ] Each test of LP-4 failed once, and the comment on LP-4 shows the failure.
- [ ] Each test of LP-4 passes. The full suite passes: `npm test`.
- [ ] No existing test was edited to make this slice pass, or the comment
      names the test and the reason.
- [ ] The refactor step is done, and the suite passed after it.
- [ ] Each assumption, known issue and limitation is a comment on this issue
      that starts with "Assumption:", "Known issue:" or "Limitation:".
```

The last line feeds the open-points story. The developer records each open
point when it occurs, with its facts. The open-points story collects them at
the end.

## Step 5: Link the slices

- **Inside a slice, the story depends on its test issue.** The tests and their
  expected values exist before the code.
- **Chain two slices when the second changes the code of the first.** Slice 2
  of late fees changes the calculation of slice 1, so the test issue of slice 2
  depends on the story of slice 1.
- **Do not chain slices that change different code.** Two independent slices
  can run in parallel. `lpm-planning` explains why a wide graph is better.
- **The open-points story depends on the last story of each chain.**

```
link_issues { blocked: "LP-6", blockedBy: ["LP-5"] }    # slice 2 waits for slice 1
link_issues { blocked: "LP-8", blockedBy: ["LP-7"] }    # open points wait for the last slice
```

For a slice with high risk (money, stored data, security), add a test design
review between the test issue and the story. A senior developer then confirms
that the tests detect the failure before anyone writes the code:

```
insert_between { source: "LP-4", target: "LP-5", type: "review",
                 title: "Approve the test design of slice 1 (LP-4)" }
```

Assign this review to the human supervisor. Do not add it to every slice. It
stops the chain until a person answers.

## Step 6: Assign the work

| Issue | Assign to |
| --- | --- |
| `test`, `user_story`, open-points story | The developer, or the AI agent pool |
| Each `review` | The human supervisor, or the senior developer who decides |

The test issue and the story of one slice can go to the same developer.

## Step 7: Check the plan

```
check_board
next_tasks { assignee: "RS-3" }     # the developer gets the test issue of slice 1
```

```bash
lpm instructions LP-4               # read the brief of slice 1 as the developer reads it
```

The brief of the first test issue must give the developer the behaviours and
the expected values without another document. If it does not, add them to the
test issue.

## After the review: the next iteration

The reviewer decides each open point. Each decision that changes the behaviour
becomes a new slice under the same feature. The slice has a `test` issue with
the new cases, and a story that depends on it. The feature then has open work again, and its
status follows its contents. The earlier tests stay, so the new slice cannot
break the behaviour that the reviewer approved.

## Make the plan a registry template

When the team plans more than one feature this way, store the plan in the
board's registry. `lpm-templates` is the full reference. A feature template
needs a `folder` at each level above the feature:

```bash
lpm template new folder -t "Delivery" -d "Delivery patterns"
lpm template new folder -t "Epic slot" --parent TPL-1
lpm template new feature -t "{{name}}" --parent TPL-2 \
  -d "A feature built test first: slice 1, then the open-points story" \
  --param name:string:required
lpm template new test -t "Cases for slice 1 of {{name}}" --parent TPL-3
lpm template new user_story -t "Build slice 1 of {{name}}" --parent TPL-3
lpm template new user_story -t "Write the open points of {{name}}" --parent TPL-3
lpm link TPL-5 --depends-on TPL-4
lpm link TPL-6 --depends-on TPL-5

lpm template apply TPL-3 --set name="Refunds" --under LP-2 --dry-run
```

Put the definition of done from step 4 in the body of the story template. Each
feature then gets the same rules.

## Mistakes to avoid

| Mistake | Result | Correction |
| --- | --- | --- |
| A design document for every variant before the first slice | Work on variants that nobody asked for, and a design that the tests never checked | Decide only the items in the table of step 2 |
| No decisions before the first slice | A stored format or a public API that needs a migration later | Use the cost test of step 2 for each decision |
| A slice for each layer ("schema", "API", "UI") | No slice works alone, and the tests of the first one test nothing that a user sees | Cut by behaviour, end to end |
| "Implement late fees (with tests)" as one story | The tests are written after the code, or not at all | One `test` issue and one story for each slice |
| Expected values written by the developer of the code | The tests confirm what the code does, not what the request says | Put the values in the test issue before the story starts |
| Assumptions kept in the developer's memory | The reviewer never sees them | A comment that starts with "Assumption:" when the assumption is made |
| Every slice chained after the previous one | One developer at a time | Chain only slices that change the same code |
