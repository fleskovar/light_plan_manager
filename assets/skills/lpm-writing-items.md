---
name: lpm-writing-items
description: What each type of item on a light-plan board must contain, with a complete example for each type. Load this before you write or rewrite the body of an epic, a feature, a user story, a task, a bug, a test, a research issue or a sub-task. For each type it names the reader, the question that each section answers, the limits, the frequent defects and the sources (INVEST, Given/When/Then, Mozilla's bug guidelines, the minimal reproducible example). For an issue of the type `review`, load `lpm-writing-reviews`.
roles:
  - developer
  - pm
---

# Writing each type of board item

Each type of item has a different reader and a different purpose. An epic
explains why the work exists. A bug shows how to reproduce a defect. A review
asks for a decision. This skill says what the body of each type must contain.

Load `lpm-writing` first. Its rules for sentences and words apply to every
section. For an issue of the type `review`, load `lpm-writing-reviews`.

## How to use this skill

1. **Find the types of the board.** A board declares its own types in
   `.lpm/config.yml`. `board_overview` lists them. Do not assume that a board
   has an "epic" or a "story".
2. **Find the kind of the type** in the table below. The names in the table
   come from the Scrum and Kanban templates that `lpm init` writes.
3. **Keep the headings of the board's template.** When you create a document
   with no `body`, the board writes the template of the type. Fill in that
   template. You can add a section. Do not rename or delete a heading of the
   template, except a section with no content.
4. **Write the sections** with the rules for that kind.

| Kind | Types in the shipped templates | The reader | The body answers |
| --- | --- | --- | --- |
| Container for a goal | `program`, `epic` | Each developer below it, and the planner | Why does this work exist, and when is it finished? |
| Capability | `feature` | The developers of its stories | What can the system do when this is finished? |
| Work unit for a user | `user_story`, `story` | The developer who builds it | What must be true, and how do I check it? |
| Technical work unit | `task` | The developer who does it | What do I change, where, and when do I stop? |
| Defect | `bug` | The developer who corrects it | How do I see the defect, and what is the correct behaviour? |
| Test | `test` | The developer who writes or runs it | Which failure does this test detect? |
| Question | `research` | The planner, and the developers who wait for the answer | What is the answer, and how sure are we? |
| Decision | `review` | A senior developer or engineer | What do I decide, and on which evidence? |
| Step | `sub_task` | The developer of the parent | Which one action is this? |

The examples in this skill are about one feature: a retry for payment webhooks
that fail. The examples use the headings of the Scrum template.

## Rules for every type

- **The brief shows the ancestors.** `lpm instructions <id>` shows the bodies
  of the programme, the epic and the feature above your item. Do not repeat
  them.
- **Put order in `depends_on`.** A sentence such as "do this after LP-40" does
  not change the queue. Use `link_issues`.
- **Put files in `relatedFiles`.** The brief shows them above the body.
- **Put values in attributes.** The priority, the effort, the severity and the
  reviewer have attributes. Do not write them only in the body.
- **Write each criterion as a statement that is true or false.** Another
  person must be able to check it without you.
- **Leave out a section with no content.** Do not write "N/A" or "None" to
  fill a section, except "Out of scope", where "None" is information.

## Titles

A title has about 60 characters or fewer. A reader must understand it in a
list of 40 titles.

| Kind | Form of the title | Example |
| --- | --- | --- |
| Container | The outcome | Apply every payment event that the provider sends |
| Capability | What the system can do | Retry payment webhooks that fail |
| Work unit | A verb and its object | Store a failed webhook and process it again |
| Defect | The symptom and the condition | `handleWebhook` loses the event when the database is down |
| Test | The behaviour under test | A webhook that arrives twice is applied one time |
| Question | The question | How many webhook events were lost in September 2026? |
| Decision | The decision and its object | Approve the webhook retry change (LP-87) |
| Step | One action | Add the migration for the retry tables |

Do not write these titles:

- a topic ("Webhooks")
- a solution in the title of a bug ("Add a try/catch to the handler")
- a sales line ("Bulletproof payments")

## Epic and programme

**The reader.** Each developer who works below the epic reads its body at the
top of the brief. The epic is the only place that explains why the work
exists.

| Section | Content |
| --- | --- |
| Summary | One or two sentences: what is true when the epic is finished |
| Business Value | The problem today, with a number, and what it costs |
| Success Criteria | Statements with a measure and a target that a person can check |
| Out of Scope | Work that a reader can expect here, and that this epic does not do |

**Limits.** The prose has 150 words or fewer. Write 2 to 5 success criteria.

**Frequent defects.**

- The body lists the features. The board already shows them.
- The body describes the solution. The solution belongs in the features and
  the stories.
- A success criterion has no number ("the service is more reliable").

```markdown
## Summary

The payment service applies every event that the payment provider sends, also
when the database is unavailable for 1 hour or less.

## Business Value

In September 2026, the service lost 212 of 48,930 webhook events (0.43%). Each
lost event left an order with the wrong payment status. Support corrected each
order by hand, in about 6 minutes for each event. That was 21 hours in
September.

## Success Criteria

- [ ] The service loses 0 events in a month that has a database outage of 1
      hour or less.
- [ ] Support applies 0 events by hand in a month.
- [ ] An event that fails 8 times causes an alert in 5 minutes or less.

## Out of Scope

- Events that the provider does not send.
- Changes to the statuses of an order.
```

## Feature

**The reader.** The developers of the stories below the feature.

| Section | Content |
| --- | --- |
| Summary | What the system can do when the feature is finished. Two or three sentences |
| Acceptance Criteria | What a person can observe in the finished system. Not the tasks |
| Dependencies | Only what is outside the board: a vendor, an access, a date. Put issues in `depends_on` |

**Limits.** Write 3 to 6 acceptance criteria. If a criterion needs more than
one story, that is correct. If a criterion is one story, do not repeat the
story's own criteria.

```markdown
## Summary

The webhook handler stores an event that it cannot process, and processes the
event again later. An operator can see each event that failed 8 times.

## Acceptance Criteria

- [ ] The handler processes a failed event again after 30 seconds. The delay
      doubles on each attempt, to a maximum of 1 hour.
- [ ] The handler applies one event to an order one time only.
- [ ] After 8 failed attempts, the event is in the table `webhook_dead`.

## Dependencies

- The operations team must give the service the permission to create tables
  in the production database. Requested on 2026-10-06, ticket OPS-311.
```

## User story

**The reader.** The developer who builds the story, and the reviewer who
checks it.

A story passes the INVEST test (Bill Wake, 2003): it is independent,
negotiable, valuable, estimable, small and testable. "Negotiable" means that
the story states the outcome and does not prescribe the code.

| Section | Content |
| --- | --- |
| The first sentence | "As a (role), I want (capability), so that (benefit)." The role is a person or a system that uses the capability |
| Acceptance Criteria | One criterion for each behaviour, in the form Given, When, Then |
| Definition of Done | Which tests, which documents, which review. Each item has a yes or no answer |
| Notes | The file to start in, decisions that are made, what is not in the story |

Rules for the acceptance criteria:

- **Given** names the state before the action. **When** names one action or
  one event. **Then** names a result that a person can observe: a response, a
  message, a status or a row.
- Write the values. "Returns status 202", not "returns the correct status".
- Write one criterion or more for a failure: wrong input, a missing
  permission, a service that is unavailable.
- Write 3 to 7 criteria. If a story needs more than 7, split it.

**Frequent defects.**

- The role is "developer" or "user". Name the person who gets the benefit. For
  technical work with no user, use a task.
- A criterion restates the title ("the retry works").
- The requirements are steps to write the code. Put a suggestion in "Notes".
- The story has no "Definition of Done". The developer then cannot know when
  to stop.

```markdown
As a **support agent**, I want **the service to apply a failed payment
event**, so that **I do not correct orders by hand**.

## Acceptance Criteria

- [ ] **Given** the database is unavailable **when** the provider sends a
      `charge.succeeded` event **then** the handler returns status 202 and the
      table `webhook_retry` has one row for the event.
- [ ] **Given** an event in `webhook_retry` **when** the database is available
      and the delay has passed **then** the order has the status `paid` and
      the row is deleted.
- [ ] **Given** an event that is applied **when** the provider sends the same
      event again **then** the order does not change and the handler returns
      status 200.
- [ ] **Given** an event with 7 failed attempts **when** attempt 8 fails
      **then** the event is in `webhook_dead` and not in `webhook_retry`.

## Definition of Done

- [ ] Unit tests cover the four criteria (`test/webhooks/retry.test.ts`).
- [ ] The load scenario `outage` applies 500 of 500 events.
- [ ] `docs/webhooks.md` describes the two tables and the delays.
- [ ] The review LP-91 has the decision `approved`.

## Notes

- Start in `handleWebhook`, `src/webhooks/handler.ts:20`.
- The review LP-86 decided on 2026-10-12 to store the queue in PostgreSQL.
- Not in this story: the alert for `webhook_dead` (LP-90).
```

## Task

**The reader.** The developer who does the work. A task is technical work
with no direct user: a migration, an upgrade, a clean-up.

| Section | Content |
| --- | --- |
| Description | What changes, where, and why. Three sentences or fewer |
| Checklist | The results that must be true at the end. Each item has a yes or no answer |

A task passes the SMART test from the same article as INVEST: it is specific,
measurable, achievable, relevant and time-boxed.

**Frequent defect.** The checklist is a list of actions ("look at the table",
"think about indexes"). Write the result of each action.

```markdown
## Description

Delete rows from the table `webhook_dead` that are older than 90 days. The
table has no clean-up today. Add the deletion to the nightly job in
`src/jobs/nightly.ts`.

## Checklist

- [ ] The nightly job deletes each row with `failed_at` older than 90 days.
- [ ] The job writes the number of deleted rows to the log.
- [ ] A unit test covers a row of 89 days (kept) and a row of 91 days
      (deleted).
```

## Bug

**The reader.** The developer who corrects the defect. This reader must see
the defect on their own machine before they can correct it.

| Section | Content |
| --- | --- |
| Summary | One sentence: what is wrong, and in which condition |
| Steps to Reproduce | The start state, then numbered steps with exact commands or controls |
| Expected Behaviour | What the system must do, with values |
| Actual Behaviour | What the system does. Paste the output or the error text. Give the frequency |
| Environment | The version or the commit, the platform, the configuration that matters |
| Notes | The effect on users, a workaround, and a suspected cause with the label "Assumption" |

Rules for the steps:

- The steps are minimal, complete and reproducible. Remove each step that the
  defect does not depend on. Include each value and each file that the reader
  needs.
- Start from a state that the reader can create: a commit and a setup command.
- Write one action in each step.
- Run the steps from a clean state before you save the bug.
- Give the frequency: "5 of 5 attempts" or "2 of 20 attempts".

Write one defect in each bug. Do not write the solution in the summary. The
`severity` attribute needs two facts in "Notes": who the defect affects, and if
a workaround exists.

**Frequent defects.**

- "Does not work" or "is broken" with no actual result.
- The actual result is a description of the output, and not the output.
- The steps start from the author's own state ("with my test board").
- A guess about the cause is written as a fact.

```markdown
## Summary

`handleWebhook` returns status 500 and loses the event when the database is
unavailable.

## Steps to Reproduce

Start state: commit `a41c9d7`, and the local stack is running (`make dev-up`).

1. Run `docker stop pay-db`.
2. Run `scripts/send-webhooks.sh 1`.
3. Run `docker start pay-db`.
4. Run `scripts/count-events.sh`.

## Expected Behaviour

Step 2 prints `202 queued`. Step 4 prints `applied=1`.

## Actual Behaviour

Step 2 prints `500 Internal Server Error`. Step 4 prints `applied=0`. The
service log shows:

    error: connect ECONNREFUSED 127.0.0.1:5432
        at handleWebhook (src/webhooks/handler.ts:31)

The defect occurred in 5 of 5 attempts.

## Environment

- Version: 2.3.1 (commit `a41c9d7`)
- Platform: Docker 27 on Ubuntu 24.04, PostgreSQL 16.4

## Notes

- Effect: the service lost 212 events in September 2026 (LP-85).
- Workaround: support applies the event by hand.
- Assumption: `handleWebhook` does not catch connection errors
  (`src/webhooks/handler.ts:31`). I did not confirm this.
```

## Test

**The reader.** The developer who writes or runs the test, and the reviewer
who checks if the test is sufficient.

| Section | Content |
| --- | --- |
| Objective | The behaviour that the test verifies, the story or the bug it belongs to, and the failure that it detects |
| Preconditions | The state, the data and the accounts that the test needs |
| Steps | Numbered steps, one action in each step |
| Expected Result | The exact values that must be true for the test to pass |
| Test Data | The fixtures and the files, with their paths |

Rules:

- **Name the failure that the test detects.** "This test fails if the handler
  writes a second row for one event." A test with no such sentence cannot be
  reviewed.
- **Write expected results as values.** "1 row", not "the correct number of
  rows".
- **Say what the test does not cover**, and name the issue that covers it.
- Set the attributes for the test level and for automation, if the board has
  them.

```markdown
## Objective

Verify criterion 3 of LP-87: the handler applies one event one time. This
test fails if a retry writes a second row for an event that is already
applied.

## Preconditions

- The local stack is running (`make dev-up`) with an empty database.
- The order `ord_1001` exists with the status `pending`.

## Steps

1. Send the event `evt_1` (`charge.succeeded` for the order `ord_1001`).
2. Send the event `evt_1` again.
3. Read the order `ord_1001`.
4. Count the rows for `evt_1` in the table `payment_event`.

## Expected Result

- Step 1 and step 2 return status 200.
- The order has the status `paid`.
- The table `payment_event` has 1 row for `evt_1`.

## Test Data

- `test/fixtures/webhooks/charge-succeeded.json`

Not covered: two requests for `evt_1` that arrive at the same time. LP-95
covers this case.
```

## Research

**The reader.** The planner who decides what to build, and the developers of
the issues that wait for the answer.

A research issue has two states. Before the work, it holds the question and
the method. After the work, it also holds the answer. Write the first three
sections when you create the issue. Write the last two when you finish it.

| Section | Content |
| --- | --- |
| Question | One question. Say which form the answer has: yes or no, a number, or one of a list of options |
| Why this is blocking | The decision or the issues that wait for the answer |
| Method | How you get the answer, what counts as an answer, and the timebox |
| Findings | The answer in the first sentence. Then the data, the confidence, and the source of the data |
| What this produced | The issues that the answer created, and the finding that each one depends on |

Rules for the findings:

- **Answer the question in the first sentence.** Do not start with the method.
- **Show the data as a table**, with totals.
- **Give the confidence and its reason.** Say what limits the result.
- **Give the source**: the script or the query, the commit, the date and the
  path of the full output. Another person must be able to produce the numbers
  again.
- **Keep the findings apart from the recommendation.** Use the label
  "Recommendation".

Set the attributes for the question, the method, the timebox and the
confidence, if the board has them.

**Frequent defects.**

- The question has no end ("investigate the webhooks").
- The issue has no timebox.
- The findings describe the work and do not state the answer.
- A number has no source.

```markdown
## Question

How many webhook events did the payment service lose in September 2026, and
what caused each loss? The answer is a count for each cause.

## Why this is blocking

The team cannot decide if a retry is worth 13 story points before it knows the
number of lost events. The feature LP-80 waits for this answer.

## Method

Compare the list of events from the provider's API with the table
`payment_event`, for 2026-09-01 to 2026-09-30. An event that is in the list
and not in the table is lost. Group the lost events by the error in the
service log. Timebox: 4 hours.

## Findings

The service lost 212 of 48,930 events (0.43%).

| Cause | Lost events |
| --- | --- |
| The database was unavailable (`ECONNREFUSED`) | 198 |
| The request ended after the timeout of 10 seconds | 14 |
| Total | 212 |

- The 198 events were lost in 3 outages, on 2026-09-04, 2026-09-17 and
  2026-09-26.
- Confidence for the count: high. The provider keeps the full list of events
  for 30 days.
- Confidence for the causes: medium. 9 of the 14 timeouts have no line in the
  log.
- Source: `scripts/compare-events.mjs`, commit `77be012`, run on 2026-10-02.
  Full output: `docs/research/LP-85/lost-events.csv`.

Recommendation: build the retry for database outages first. It covers 198 of
the 212 lost events (93%).

## What this produced

- LP-87: store a failed webhook and process it again. It depends on the count
  of 198 events.
- LP-96: find the cause of the 14 timeouts.
```

## Review

A review asks a senior developer or engineer for a decision. The request has
four properties:

- It puts the decision first.
- It gives the context in 120 words or fewer.
- It shows the results that you collected.
- It gives the steps to reproduce each result in an attachment.

Load `lpm-writing-reviews`. It has the structure, the rules and two complete
examples.

## Sub-task

**The reader.** The developer of the parent, who is often the author.

| Section | Content |
| --- | --- |
| Description | One action and its location. Two sentences or fewer |
| Checklist | The results that show that the action is complete |

Do not repeat the parent. A sub-task has 10 lines or fewer. If it needs more,
it is a story.

```markdown
## Description

Add the migration `migrations/0042_webhook_retry.sql`. It creates the tables
`webhook_retry` and `webhook_dead`.

## Checklist

- [ ] Both tables have the columns `event_id`, `payload`, `attempt` and
      `next_at`.
- [ ] The column `event_id` is unique in each table.
- [ ] `npm run migrate down` deletes both tables.
```

## Other documents

| Document | Where the rules are |
| --- | --- |
| A comment, a flag reason, a handover note | `lpm-writing`, section "Comments" |
| A template in the registry (`.lpm/registry/`) | Write it as the type that it produces, with `{{name}}` placeholders. See `lpm-templates` |

## Check before you save

- [ ] The type is the correct kind for the content. A decision is a review. A
      question is a research issue. A defect is a bug.
- [ ] The body has the headings of the board's template.
- [ ] The title has the form for its kind.
- [ ] Each criterion is a statement that is true or false, with values.
- [ ] A bug or a test has steps that you ran from a clean state.
- [ ] Each number has a source.
- [ ] The order is in `depends_on`, the files are in `relatedFiles`, and the
      values are in attributes.
- [ ] The body does not repeat an ancestor.
- [ ] `lpm instructions <id>` shows a brief that the reader can act on.

## Sources

- B. Wake, INVEST in good stories, and SMART tasks, 2003.
  <https://xp123.com/articles/invest-in-good-stories-and-smart-tasks/>
- Cucumber, Gherkin reference (Given, When, Then. "Then" is an observable
  output). <https://cucumber.io/docs/gherkin/reference/>
- Microsoft, Azure Boards, Agile process work item types and workflow
  (acceptance criteria before the work starts).
  <https://learn.microsoft.com/azure/devops/boards/work-items/guidance/agile-process-workflow>
- Mozilla, Bug writing guidelines.
  <https://bugzilla.mozilla.org/page.cgi?id=bug-writing.html>
- Stack Overflow, How to create a minimal, reproducible example.
  <https://stackoverflow.com/help/minimal-reproducible-example>
- Chromium DevTools, Issues guidelines.
  <https://chromium.googlesource.com/devtools/devtools-frontend/+/main/docs/contributing/issues.md>
- Scaled Agile Framework, Spikes (research with a question, an estimate and a
  result that is demonstrated). <https://framework.scaledagile.com/spikes>
- M. Ubl, Design docs at Google (goals, non-goals, alternatives considered).
  <https://www.industrialempathy.com/posts/design-docs-at-google/>
