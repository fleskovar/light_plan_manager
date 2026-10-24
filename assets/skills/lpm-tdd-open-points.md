---
name: lpm-tdd-open-points
description: Write the assumptions, known issues and limitations of a feature as review issues on a light-plan board, as the last step of development. Each review issue has a working example that a reviewer runs in 2 minutes, the context for a senior engineer who does not know the project, why the point matters, the options and a recommendation. Load this when you work the open-points story of an lpm-tdd plan, when a person asks you to "document the assumptions", "list the known issues" or "write up the limitations" of a change, and before you hand a finished feature to a rotating pool of reviewers. Part of the lpm-tdd skills.
roles:
  - developer
  - pm
---

# Writing the open points of a feature

The last story of a feature planned with `lpm-tdd` is the open-points story.
That story produces one `review` issue for each open point. A person from a
pool of senior engineers then decides each one.

An **open point** is a fact about the finished feature that a person must
review. It has one of three kinds:

| Kind | Definition | The reviewer decides | Example |
| --- | --- | --- | --- |
| Assumption | The developer chose a behaviour that the request did not specify | Keep the behaviour, or change it | The grace period counts calendar days |
| Known issue | The code gives a wrong result for some input, and the developer did not correct it | Correct it now, later, or accept it | A payment at 23:30 in UTC-5 counts as the next day |
| Limitation | The feature does not handle an input or a case, by design, and the behaviour inside its scope is correct | Accept the limit, or extend the feature | One currency for each policy |

Load `lpm-writing-reviews` for the general rules of a review request. This
skill adds what an open point needs: the example, the context for a reviewer
with no context, and the importance.

## The reader

Write for a senior software engineer who meets this feature for the first time:

- The reviewer knows software engineering and the language. The reviewer does
  not know this project, this feature or its terms.
- The reviewer comes from a pool. Next week a different person can read the
  same issue.
- The reviewer works on other projects at the same time, and has 10 minutes
  for one open point.
- The reviewer can open the issue from a notification or from the web app,
  without the brief of `lpm instructions`.

Each review issue must therefore be complete on its own. The reviewer must be
able to decide after reading the sections "Request", "Context" and "Example".

## Step 1: Collect the open points

The build stories record each open point as a comment that starts with
"Assumption:", "Known issue:" or "Limitation:". `lpm-tdd-cycle` gives the
format. Read the comments of each story in the feature, and the assumptions in
the feature body:

```
list_documents { kind: "issue", parent: "LP-3" }
list_comments { id: "LP-5" }
list_comments { id: "LP-7" }
get_document { id: "LP-3" }
```

```bash
lpm comment LP-5 --list
lpm comment LP-7 --list
```

Then check each point against the last commit of the feature. A later slice
can resolve a point of an earlier slice. Leave out a resolved point, and name
it in the finish note of the open-points story with the slice that resolved it.

Look for open points that nobody recorded:

- `TODO`, `FIXME` and `HACK` comments in the files that the feature changed.
- Tests marked as skipped or as expected to fail.
- Values in the code that the request does not give: a timeout, a limit, a
  rounding mode, a default.

## Step 2: Rate the importance of each point

Rate each point with two questions. Use the answers to set the board's
priority attribute.

1. **What happens if the point is wrong?** Name who is affected, how many, and
   what they lose: money, stored data, access, time.
2. **What does the correction cost later, compared with now?** A correction
   that must also repair stored data or published results costs more after the
   release.

| Effect | Correction cost grows after the release | Priority |
| --- | --- | --- |
| Wrong money, lost data or a security gap for users | Yes | `critical` |
| Wrong money, lost data or a security gap for users | No | `high` |
| A wrong result that a user sees and can correct | Yes or no | `medium` |
| Only developers or operators see it | Yes or no | `low` |

Write the answers in the section "Why it matters". The reviewer must see the
reason for the priority, not only the value.

## Step 3: Build the working example

Each open point has an example that the reviewer can run. The example must:

- **Run from a clean checkout** at a commit that you name, with one command.
- **Finish in 2 minutes or less**, including the setup.
- **Show the input and the output.** The reviewer sees the value that the code
  returns, not only a pass or a fail.
- **Show the other value beside it.** For a known issue, give the correct
  value. For an assumption, give the value under the other reading. Calculate
  it by hand and show the calculation.

Put the example in the test suite, as a test whose name starts with
"open point" and the id of the review issue. The test pins the current
output. The suite stays green. When a person changes the behaviour, the test
fails, and its name points to the review issue and its decision.

| Kind | The test checks | Test name |
| --- | --- | --- |
| Assumption | The output under the assumption, for an input where the two readings differ | `open point LP-12: an invoice due Thu 2026-03-05 and paid Thu 2026-03-12 gets a fee of 4.00` |
| Known issue | The current wrong output | `open point LP-13: an invoice paid at 23:30 UTC-5 on its due date gets a fee of 2.00 (correct: 0.00)` |
| Limitation | What the code does with the input outside the scope: an error, or the result it gives | `open point LP-14: an invoice in USD with a policy in EUR gets a fee of 2.00 EUR` |

Create the review issue first, to get its id. Then name the test, run it and
paste the output into the issue. When the recording comment already named a
test, rename that test.

Run each example yourself from a clean checkout before you send the review.
An example that fails for the reviewer costs the review.

## Step 4: Write one review issue for each point

One issue holds one decision. Do not put two open points in one issue, even
when they are small. Two reviewers from the pool can then take them in
parallel.

### The fields

| Field | Value |
| --- | --- |
| `type` | The board's type for a review. The Scrum template names it `review` |
| `title` | "Decide:" or "Confirm:", then the question. "Decide which days the grace period of late fees counts" |
| `parent` | The feature |
| `dependsOn` | The build story where the point occurred. The brief then shows that story to the reviewer |
| `relatedFiles` | The code, with the line range, and the file of the example test |
| `assignee` | The pool of senior engineers, or the human supervisor |
| `reviewer` attribute | The person, when the decision needs a specific person |
| `decision` attribute | `pending`. The reviewer changes it |
| `priority` attribute | The value from step 2 |

```
create_document {
  type: "review",
  title: "Decide which days the grace period of late fees counts",
  parent: "LP-3",
  dependsOn: ["LP-7"],
  relatedFiles: ["src/late-fees.ts#L18-L24", "test/late-fees.test.ts"],
  assignee: "RS-1",
  attributes: { decision: "pending", priority: "high" },
  body: "## Request\n…"
}
```

### The sections

| Section | Content | Limit |
| --- | --- | --- |
| Request | The decision, the possible answers, what waits for it, the reading time | 5 lines |
| Context | What the feature does, the terms, the point, where the code is | 150 words |
| Example | The commit, the command, the output, and a table of the two values | 15 lines of output |
| Why it matters | Who is affected, how many, what they lose, and the cost of a later correction | 5 lines |
| Options | Each option with the same criteria, and your recommendation | 1 table |
| How to validate | Optional steps to run the example and read the code | 6 steps |
| Decision | Empty. The reviewer writes it | |
| Follow-up | Empty. The reviewer writes it | |

The section "Context" repeats one sentence about the feature, even though the
brief shows the feature above the request. A reviewer who opens the issue from
a notification does not see the brief. Define each term that is specific to
the project in one sentence.

### A complete example

```markdown
## Request

Decide if the grace period of late fees counts calendar days or business
days. Answers: `approved` keeps calendar days. `changes_requested` with
"business days" adds a slice to LP-3. The release of billing on 2026-11-15
ships the current behaviour. Reading time: 5 minutes. Optional check: 2
minutes.

## Context

The billing service charges a late fee when a customer pays an invoice after
its due date (feature LP-3). The fee is 2.00 for each day late. A grace period
of 5 days comes first, with no fee. The request says "a grace period of 5
days" and does not say which days count. The code counts calendar days
(`graceRule`, `src/late-fees.ts:18-24`). This is an assumption. It was made in
LP-7 on 2026-10-20.

- Calendar day: each day, Saturday and Sunday included.
- Business day: Monday to Friday. The code has no calendar of public holidays.

## Example

Commit `a1b2c3d`.

    $ npx vitest run -t "open point LP-12"
    ✓ open point LP-12: an invoice due Thu 2026-03-05 and paid Thu 2026-03-12 gets a fee of 4.00
    Tests  1 passed (1)

| Reading | Days late | Days after the grace period | Fee |
| --- | --- | --- | --- |
| Calendar days (current) | 7 (Fri 6 to Thu 12) | 7 - 5 = 2 | 2 x 2.00 = 4.00 |
| Business days | 5 (Fri 6, Mon 9 to Thu 12) | 5 - 5 = 0 | 0.00 |

## Why it matters

- Affected: each invoice paid after its grace period, when the grace period
  contains a weekend. A grace period of 5 calendar days contains a weekend
  day unless the due date is a Sunday.
- Effect: under business days, these customers pay 4.00 less for each
  invoice. Not measured: the number of such invoices for each month.
- Cost of a later correction: one slice now. After the release, the same slice
  and a refund of the fees already charged.

## Options

| Option | Fee in the example | Work | Risk |
| --- | --- | --- | --- |
| A. Calendar days (current) | 4.00 | None | Customers who read "5 days" as business days dispute fees |
| B. Business days, no holidays | 0.00 | 1 slice, about 1 day | A public holiday counts as a day with a fee |
| C. Business days with a holiday calendar | 0.00 | 2 slices and a holiday data source | The data source needs an owner |

Recommendation: option A. The billing policy (`docs/billing-policy.md`)
counts its other periods in calendar days.

## How to validate

Optional. 2 minutes.

1. `git checkout a1b2c3d`
2. `npm ci`
3. `npx vitest run -t "open point LP-12"`. Expected: 1 test passes, with the
   fee 4.00 in its name.
4. Read `src/late-fees.ts:20`. The line subtracts two dates in calendar days.
5. `git checkout -` to return to your branch.

## Decision

## Follow-up
```

## Step 5: List the open points on the feature

Add a section "Open points" to the body of the feature. A reviewer from the
pool then sees all the points of the feature and their priority in one place.

```markdown
## Open points

| Review | Kind | Point | Priority |
| --- | --- | --- | --- |
| LP-12 | Assumption | The grace period counts calendar days | high |
| LP-13 | Known issue | A payment at 23:30 in UTC-5 counts as the next day | medium |
| LP-14 | Limitation | One currency for each policy | low |
```

Then close the open-points story with a finish note that names each review
issue and each resolved point that you left out.

## After the decision

The reviewer writes the decision in the section "Decision" and sets the
`decision` attribute. Each decision has a result on the board:

| Kind | `approved` | `changes_requested` |
| --- | --- | --- |
| Assumption | The behaviour stays. Rename the test: remove "open point" and keep the behaviour in the name. Move the statement into the user documentation | A new slice under the feature, with the other behaviour. `lpm-tdd` step 4 |
| Known issue | The issue stays. Record it as a limitation in the user documentation | A `bug` issue, or a new slice. The test of the open point becomes the test of the correction |
| Limitation | The limit stays. Record it in the user documentation | A new slice, or a new feature when the change is large |

For `rejected`, the reviewer writes the reason in "Decision", and the planner
decides the next step.

## Check before you send each review issue

- [ ] The issue holds one open point and asks for one decision.
- [ ] A senior engineer who does not know the project can decide after
      "Request", "Context" and "Example".
- [ ] Each project term has a definition of one sentence.
- [ ] The example names a commit, runs with one command, and finishes in 2
      minutes.
- [ ] The example shows the current value and the other value, with the
      calculation.
- [ ] You ran the example from a clean checkout.
- [ ] "Why it matters" names who is affected, what they lose and the cost of a
      later correction.
- [ ] The options use the same criteria, and the recommendation has a reason.
- [ ] The priority attribute matches the table of step 2.

## Mistakes to avoid

| Mistake | Result |
| --- | --- |
| One review for all the open points of a feature | One reviewer must decide everything, and one question stops the others |
| "See LP-7 for the context" | The reviewer opens three issues before the decision |
| An example that describes the input in words | The reviewer cannot confirm the value |
| An example that needs a database, credentials or a running service | The reviewer does not run it |
| Open points written from memory at the end | Missing points, and no file, line or test for the others |
| No recommendation | The reviewer does the analysis again |
| A known issue described as an assumption | The reviewer accepts a defect as a choice |
