---
name: lpm-writing-reviews
description: How to write a review request on a light-plan board, so that a senior developer or engineer can decide in a few minutes. Load this before you create or update an issue of the type `review`, before you ask a person to approve a change, to choose between options, to confirm a defect or to sign off a release, and before you record a review decision. It gives the structure of the request, the rules for context, evidence, validation steps and attachments, two complete examples and the sources.
roles:
  - developer
  - pm
---

# Writing a review request

A review request asks a senior developer or engineer for a decision. This
reader has little time and did not see your work. The request must give the
reader three things:

1. **The decision.** The reader knows what to decide, and which answers are
   possible.
2. **The context.** The reader understands the situation without reading other
   issues.
3. **The evidence.** The reader sees the results that you collected, and can
   check where each result came from.

Load `lpm-writing` first. Its rules for sentences and words apply to every
section of a request. This skill adds the structure and the content.

## The reader

- **A senior developer or engineer.** The reader knows the codebase and the
  field. The reader does not know this change.
- **Someone with 5 to 10 minutes.** The reader decides from the request. The
  reader does not rebuild your work.
- **Someone who is responsible for the answer.** The reader must be able to
  check each claim, or see exactly how to check it.

A study of code review at Microsoft found that understanding the change is the
main difficulty for a reviewer (Bacchelli and Bird, 2013). Your request does
that work for the reviewer.

## Kinds of review

Find the kind of review first. The kind decides what the request must contain.

| Kind | The reviewer decides | The request must contain |
| --- | --- | --- |
| Change review | If a change to code, configuration or data can be merged or released | The location and size of the change, the approval criteria, the test results |
| Decision review | Which option to use | The options, a comparison by the same criteria, your recommendation |
| Defect confirmation | If a behaviour is a defect, and how severe it is | The steps to reproduce, the expected result, the actual result, how often it occurs |
| Test design review | If a planned test detects the failure that it is for | The failure, the test inputs, the expected result, what the test does not cover |
| Sign-off | If a release or a test campaign can go ahead | The result for each criterion, the open defects by severity, what was not tested |

## The structure of a request

Use the headings of the board's `review` template, and add the sections that
the template does not have. The Scrum template that `lpm init` writes has four
headings: "What is being reviewed", "Approval Criteria", "Decision" and
"Follow-up". The full structure is:

| Section | Content | Limit |
| --- | --- | --- |
| Request | The decision, the possible answers, the date, the reading time, where to look first | 5 lines |
| Context | The situation, the change, why a review is necessary | 120 words |
| What is being reviewed | Each item with its location and size. What is not in the review | 1 table |
| Approval Criteria | Each claim that the reviewer checks, with the id of its evidence | 3 to 7 items |
| Evidence | The result for each claim, as a table | 1 table |
| How to validate | The steps that the reviewer can run, with the expected results | 10 steps |
| Risks and open questions | What you did not verify, and where you are least sure | 3 items |
| Decision | Empty. The reviewer writes it | |
| Follow-up | Empty. The reviewer writes it | |
| Attachments | How each result was produced, and the full steps to reproduce it | No limit |

The reviewer reads everything above "Attachments" in 5 minutes. That is about
500 words, plus the tables. The reviewer opens an attachment only to check a
result.

Leave out a section that has no content. A request for a small change can have
only "Request", "Context", "Approval Criteria" and "Evidence".

## The rules

### 1. Put the request first

The first section says what you need. Do not start with the background. This
rule is known as "bottom line up front" in the correspondence rules of the
United States Army.

The section "Request" answers five questions:

- **What decision do you need?** "Approve or reject the retry change in
  LP-87."
- **Which answers are possible?** Use the values of the board's `decision`
  attribute, for example `approved`, `changes_requested` and `rejected`.
- **When do you need it, and what waits for it?** Give the date and the ids of
  the issues that the review blocks.
- **How much time does it take?** "10 minutes to read. 10 more minutes for the
  optional check."
- **Where must the reviewer look first?** Name the file and the lines with the
  highest risk.

### 2. Ask for one decision from one reviewer

One request holds one decision. Write two requests in these cases:

- Two people must review different parts.
- The request holds two decisions that do not depend on each other.
- The change is too large to review in one session. Google's review guide
  gives 100 changed lines as a reasonable size and 1,000 lines as too large.
  GitLab's guide gives about 200 lines.

### 3. Give the context that the decision needs

The section "Context" answers four questions, in this order:

1. What is the situation today? Give a number if you have one.
2. What does the change do, or what do you propose?
3. Why is a review necessary? Name the risk.
4. Which terms does the reviewer not know? Define each one in one sentence.

Use these two tests to find the correct amount of context:

- **Too little.** After the sections "Request" and "Context", the reviewer
  must be able to say in one sentence what they decide and why it matters. If
  the reviewer must open another issue to do this, add context.
- **Too much.** Read each sentence of the context and ask one question: "Can
  this sentence change the decision?" If the answer is no, delete the
  sentence or move it to "Attachments".

Do not write these things in the context:

- the history of your work ("first I tried", "then I found")
- a description of each file that you changed
- text from the parent issue or from the issues under review
- facts that every engineer on the team knows

### 4. Say what is in the review and what is not

List each item with its location and its size: the commit, the file, the line
range and the number of changed lines. Say which item holds the new logic and
which items are mechanical. The reviewer then knows where to spend the time.

Then name what is not in the review: "Not in this review: the alert
configuration (LP-90) and the dashboard."

### 5. Write each criterion as a claim with evidence

An approval criterion is a statement that is true or false. Do not write a
topic.

| Do not write | Write |
| --- | --- |
| Error handling | A failed event is retried and is not lost. Evidence E2. |
| Performance is acceptable | The p95 latency of `POST /webhook` stays below 200 ms at 50 requests per second. Evidence E5. |
| Tests | The test suite passes on commit `3f9c2ab`. Evidence A3. |

Put the id of the evidence after each criterion. A criterion with no evidence
is a question for the reviewer. Move it to "Risks and open questions".

### 6. Give results, not the work to get them

The reviewer must not run a command to learn a fact that you already have.
Collect the facts and show them in a table.

- **Give the result and its size.** "500 of 500 events applied", not "the
  events were applied".
- **Summarise the change.** "4 files, 118 changed lines. The new logic is in
  `nextDelay`, `src/webhooks/retry.ts:41-78`. The other files are the
  migration and the tests."
- **Paste 15 lines of output or fewer.** Put longer output in a file in the
  repository, and name the file in `relatedFiles`.
- **Show a comparison as a table**, with the same criteria for each option.
- **Do not paste a log and ask the reviewer to read it.** State what the log
  shows, and give the line numbers.

### 7. State where each result came from

A result without a source is a claim that the reviewer cannot check. For each
result, the section "Attachments" gives:

- the command or the query, exactly as you ran it
- the commit, the branch or the version
- the environment (machine, database, data set)
- the date
- the path of the full output

Give each attachment an id (A1, A2) and use the id in the table of evidence.
The body stays short, and the reviewer can still check every number.

### 8. Write steps that work at the first attempt

Write steps when the reviewer must reproduce a defect or can validate a
result. These rules apply to the steps:

- **Give the start state.** Name the commit, the setup command and the access
  that the reviewer needs. If a step needs a credential, say this before step
  1.
- **Number the steps.** Put one action in each step.
- **Give the exact command or the exact control.** Do not write "start the
  service". Write "`make dev-up`".
- **Give the expected result after each step that has one.**
- **Give the time for all steps.**
- **End with the step that restores the start state.**
- **Use the shortest sequence that shows the result.** Remove each step that
  the result does not depend on.
- **Run the steps yourself, from a clean state, before you send the request.**

Say if the steps are required or optional. Most validation steps are optional:
"You do not need to run these steps to decide."

### 9. Name the risks and what you did not verify

The reviewer finds a problem faster when you say where to look. List:

- each case that you did not test, and the reason
- each assumption, with the label "Assumption"
- the part of the change that you are least sure of

Do not hide a weak point in the attachments. Put it in "Risks and open
questions", and refer to it from "Request" if it is the main risk.

### 10. In a decision review, give your recommendation

Do not send a list of options with no opinion. Give:

- the recommendation, in one sentence, with the label "Recommendation"
- a table of the options, compared by the same criteria
- what the team loses with the recommended option
- the options that you rejected, each with one reason

### 11. Make the request complete on its own

The reviewer reads the brief that `lpm instructions <id>` prints. With the
layout that light-plan ships for a review, the brief has five parts in this
order:

1. the body of the parent of the review, for example the feature
2. your request
3. the files in `relatedFiles`
4. the full body of each issue in `depends_on`
5. the issues that wait for the review

The reviewer must be able to decide after part 2. Parts 3 to 5 are for
checking. Do not repeat the parent in your context, because the brief shows it
above your request.

## The fields of a review issue

| Field | Value |
| --- | --- |
| `type` | The board's type for a review. The Scrum template names it `review`. `board_overview` lists the types |
| `title` | The decision and its object: "Approve the webhook retry change (LP-87)" |
| `dependsOn` | The ids of the issues under review. The review cannot start before these issues are finished |
| `relatedFiles` | The files that the reviewer reads: the main source file, the design document, the files with the full output |
| `assignee` | The resource id of the reviewer. `team_load` lists the resources |
| `reviewer` attribute | The name of the reviewer |
| `decision` attribute | `pending`. The reviewer changes it |

Make the work that waits for the decision depend on the review:

```
create_document {
  type: "review",
  title: "Approve the webhook retry change (LP-87)",
  parent: "LP-80",
  dependsOn: ["LP-87"],
  relatedFiles: ["src/webhooks/retry.ts", "docs/reviews/LP-91/a2-outage.log"],
  assignee: "RS-1",
  attributes: { reviewer: "Ana Ruiz", decision: "pending", priority: "high" },
  body: "## Request\n…"
}
link_issues { blocked: "LP-92", blockedBy: ["LP-91"] }
```

If the board has no type for a review, use the type of a work unit. Start the
title with "Review:" and use the same body.

Then read the request as the reviewer reads it:

```bash
lpm instructions LP-91
```

## Example 1: a change review

```markdown
## Request

Approve or reject the webhook retry change in LP-87.

- **Answer.** Set `decision` to `approved`, `changes_requested` or `rejected`.
- **Needed by.** 2026-10-16, when the release branch for 2.4 is created.
  LP-92 (release 2.4) waits for this review.
- **Your time.** 10 minutes to read. 10 more minutes for the optional check.
- **Look first at.** `nextDelay` in `src/webhooks/retry.ts:41-78`. It holds
  all of the new logic.
- **Main risk.** Events that arrive in the wrong order. See risk 1.

## Context

The payment provider sends one webhook for each payment event. Today,
`handleWebhook` processes each webhook once. If the database is unavailable,
the handler returns status 500 and the event is lost. In September 2026, 212
of 48,930 events (0.43%) were lost, and support applied them by hand.

LP-87 stores each failed event in the table `webhook_retry` and processes it
again after a delay. The delay starts at 30 seconds and doubles on each
attempt, to a maximum of 1 hour. After 8 attempts, the event moves to the
table `webhook_dead`.

A review is necessary because the handler can now process one event more than
once. A defect in this code can charge or refund a customer twice.

## What is being reviewed

All items are in commit `3f9c2ab` on the branch `lp-87-webhook-retry`.

| Item | Location | Size |
| --- | --- | --- |
| Retry logic (new) | `src/webhooks/retry.ts` | 96 lines |
| Handler | `src/webhooks/handler.ts:20-58` | 22 changed lines |
| Migration | `migrations/0042_webhook_retry.sql` | 2 new tables |
| Tests | `test/webhooks/retry.test.ts` | 14 cases |

Not in this review: the alert for `webhook_dead` (LP-90) and the dashboard.

## Approval Criteria

- [ ] The handler never applies one event twice. Evidence E1.
- [ ] A failed event is retried and is not lost. Evidence E2.
- [ ] The retries stop after 8 attempts. Evidence E3.
- [ ] The migration can be reverted. Evidence E4.

## Evidence

| Id | Result | Source |
| --- | --- | --- |
| E1 | 10,000 events, each delivered twice: 10,000 rows in `payment_event`, 0 duplicates | A1 |
| E2 | 500 events sent while the database was stopped for 90 seconds: 500 of 500 applied after the restart | A2 |
| E3 | Delays of 30, 60, 120, 240, 480, 960, 1,920 and 3,600 seconds. After attempt 8, the event is in `webhook_dead` | Test "stops after 8 attempts", A3 |
| E4 | `migrate down` deletes both tables. `migrate up` creates them again | A4 |

The test suite passes on `3f9c2ab`: 431 passed, 0 failed (A3).

## How to validate

These steps are optional. They repeat E2 with 5 events and take 10 minutes.
You need Docker and the repository at commit `3f9c2ab`. You need no
credentials.

1. Run `make dev-up`. Expected: the line `api ready on :8080`.
2. Run `docker stop pay-db`.
3. Run `scripts/send-webhooks.sh 5`. Expected: 5 lines that contain
   `202 queued`.
4. Run `docker start pay-db`.
5. Wait 40 seconds. Run `scripts/count-events.sh`. Expected:
   `applied=5 retry=0 dead=0`.
6. Run `make dev-down`.

## Risks and open questions

1. **Events in the wrong order are not tested.** A retried `refund` event can
   arrive after a later `charge` event. Assumption: `applyEvent` sorts the
   events by `created` (`src/payments/apply.ts:77`), so the order of arrival
   does not change the result. The staging environment cannot send events in
   the wrong order, so I did not test this assumption.
2. **The table `webhook_dead` has no clean-up.** Assumption: fewer than 10
   events each month fail 8 times. I did not measure this number. LP-94 adds
   the clean-up.

## Decision

## Follow-up

## Attachments

**A1. Duplicate delivery.**
Command: `npm run test:load -- --scenario duplicate --events 10000`.
Commit `3f9c2ab`, environment `staging-2`, 2026-10-09.
Full output: `docs/reviews/LP-91/a1-duplicate.log`.
The count of duplicates comes from this query:
`SELECT event_id FROM payment_event GROUP BY event_id HAVING count(*) > 1`.
The query returned 0 rows.

**A2. Database outage.**
Command: `npm run test:load -- --scenario outage --events 500 --down 90`.
Commit `3f9c2ab`, environment `staging-2`, 2026-10-09.
Full output: `docs/reviews/LP-91/a2-outage.log`. The last line is
`applied=500 retry=0 dead=0`.

**A3. Test suite.**
Command: `npm test`. Commit `3f9c2ab`, local machine, Node 22.9, 2026-10-09.
Output: `Tests 431 passed (431)`.

**A4. Migration.**
Commands: `npm run migrate down`, then `npm run migrate up`, on a copy of the
staging database from 2026-10-08. Both commands ended with exit code 0.
```

## Example 2: a decision review

```markdown
## Request

Choose where the retry queue for webhooks is stored: a PostgreSQL table or a
Redis stream.

- **Answer.** Write the chosen option in "Decision" and set `decision` to
  `approved`. Set it to `changes_requested` if you need a third option.
- **Needed by.** 2026-10-12. LP-87 (build the retry) waits for this review.
- **Your time.** 5 minutes.
- **Recommendation.** Option A, the PostgreSQL table.

## Context

LP-87 adds a retry for webhooks that fail. The retry needs a queue that keeps
its content when the service restarts. The service already uses PostgreSQL 16
for payments and Redis 7 for sessions. The expected load is 250 failed events
each month, with a peak of 500 events in 2 minutes during a database outage.

## Options

| Criterion | A: PostgreSQL table | B: Redis stream |
| --- | --- | --- |
| Content after a restart | Kept | Kept only if persistence is on. It is off today |
| Same transaction as the payment write | Yes | No |
| New infrastructure | None | A change to the Redis configuration, and a backup |
| Time for 500 events (attachment A1) | 1.8 seconds | 0.3 seconds |
| Effort | 2 story points | 5 story points |

## Recommendation

Use option A. The queue and the payment write are in one transaction, so an
event cannot be applied and stay in the queue. Option B is 1.5 seconds faster
for 500 events. That difference has no effect on a retry that waits 30 seconds
or more.

Option A puts the queue in the same database that causes most of the failures.
The handler therefore keeps a failed event in memory and writes it when the
database is available again. See risk 1.

## Risks and open questions

1. **Events in memory are lost if the service stops during an outage.** I did
   not measure how often this occurs. If this risk is not acceptable, option B
   is the alternative.

## Decision

## Attachments

**A1. Timing.**
Command: `node scripts/bench-queue.mjs --events 500`, 5 runs for each option.
Commit `8c1d0e4`, local machine, PostgreSQL 16.4 and Redis 7.2 in Docker,
2026-10-08. The table shows the median. All runs:
`docs/reviews/LP-86/a1-bench.csv`.
```

## Before and after

Before:

> Please review LP-87 when you have a moment. The retry logic is done and all
> tests pass. Everything is on the branch. Let me know if it looks good or if
> you want changes.

The reviewer cannot learn these facts from the request:

- what LP-87 changes, and why the change needs a review
- which files and lines to read, and how large the change is
- which criteria decide the answer
- which tests ran, on which commit, and with which result
- what was not tested
- when the answer is necessary, and what waits for it

Example 1 is the "after" of this request.

## Writing the decision

The reviewer writes the section "Decision" and sets the `decision` attribute.
The decision is a record that other engineers read later. It contains:

- **The outcome.** One of the values of the `decision` attribute.
- **The date and the name of the reviewer.**
- **What the reviewer checked.** Name the criteria, and say how you checked
  each one: "I read the evidence" or "I ran the steps".
- **What the reviewer did not check.**
- **For `changes_requested`:** a numbered list of the changes. Each change
  names the location and says what must be true for approval.
- **For `rejected`:** the reason, and what a new request must show.

```markdown
## Decision

`changes_requested`, 2026-10-10, Ana Ruiz.

Checked: criteria 1 to 4 against the evidence. I ran the validation steps, and
the result was `applied=5 retry=0 dead=0`. I did not review the migration SQL.

Changes:
1. `src/payments/apply.ts:77` sorts by `created`, and two events can have the
   same value. Sort by `created` and then by `event_id`. Add a test with two
   events that have the same `created` value.
2. Add the test for events in the wrong order from risk 1. Approval needs this
   test to pass.
```

Put each problem that does not block the approval on the board as an issue,
and list its id in "Follow-up". If you cannot decide, flag the review:

```bash
lpm flag LP-91 --reason help --comment "..."
```

## Check before you send

- [ ] The first section states the decision, the answers, the date and the
      reading time.
- [ ] The request holds one decision for one reviewer.
- [ ] The context is 120 words or fewer, and each sentence can change the
      decision.
- [ ] Each item under review has a location and a size. The items that are not
      under review are named.
- [ ] Each criterion is a statement that is true or false, and has evidence.
- [ ] Each result has a number and a source in "Attachments".
- [ ] Each attachment gives the command, the commit, the environment and the
      date.
- [ ] You ran the validation steps from a clean state. Each step has one action
      and an expected result.
- [ ] The risks name what you did not verify.
- [ ] The text above "Attachments" is about 500 words or fewer.
- [ ] `dependsOn`, `relatedFiles`, `assignee` and `reviewer` have values, and
      the waiting work depends on the review.
- [ ] `lpm instructions <id>` shows a request that the reviewer can decide
      from.

## Sources

- Google engineering practices, The CL author's guide: Small CLs.
  <https://google.github.io/eng-practices/review/developer/small-cls.html>
- Google engineering practices, Writing good CL descriptions.
  <https://google.github.io/eng-practices/review/developer/cl-descriptions.html>
- Google engineering practices, What to look for in a code review.
  <https://google.github.io/eng-practices/review/reviewer/looking-for.html>
- Microsoft, Engineering Fundamentals Playbook, Author guidance for code
  reviews.
  <https://microsoft.github.io/code-with-engineering-playbook/code-reviews/process-guidance/author-guidance/>
- GitLab, Code review guidelines (the responsibility of the author).
  <https://docs.gitlab.com/development/code_review/>
- A. Bacchelli and C. Bird, Expectations, outcomes, and challenges of modern
  code review, ICSE 2013.
  <https://www.microsoft.com/en-us/research/publication/expectations-outcomes-and-challenges-of-modern-code-review/>
- Bottom line up front (BLUF), from Army Regulation 25-50.
  <https://en.wikipedia.org/wiki/BLUF_(communication)>
- Institute for Healthcare Improvement, SBAR (situation, background,
  assessment, recommendation), a format for a short request to a senior
  person. <https://www.ihi.org/resources/tools/sbar-tool-situation-background-assessment-recommendation>
- M. Ubl, Design docs at Google (context, goals, alternatives considered).
  <https://www.industrialempathy.com/posts/design-docs-at-google/>
- Stack Overflow, How to create a minimal, reproducible example.
  <https://stackoverflow.com/help/minimal-reproducible-example>
- Mozilla, Bug writing guidelines.
  <https://bugzilla.mozilla.org/page.cgi?id=bug-writing.html>
