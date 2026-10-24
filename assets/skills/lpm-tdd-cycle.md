---
name: lpm-tdd-cycle
description: Work one slice of a light-plan board in the red, green, refactor cycle, and leave a trail on the issues. Load this when you pick up a `test` issue or a build story that the lpm-tdd plan created, when a person asks you to work "test first" or "red green refactor", and before a refactor that adds an extension point. It gives each step with its board commands, the rule for failing tests on the main branch, the refactor checklist, when and how to apply the open/closed principle with a design pattern, and the comments that record assumptions, known issues and limitations. Part of the lpm-tdd skills.
roles:
  - developer
---

# Working a slice: red, green, refactor

A slice on a light-plan board has two issues: a `test` issue with the cases,
and a build story that depends on it. This skill gives the steps that a
developer follows for both issues. Each step ends with a fact on the board:
a failure output, a test result or a comment.

Load `lpm-delivery` for the general rules of picking up and closing work.
Load `lpm-tdd-tests` for the rules of a good test.

## The cycle

| Step | What you do | The step is finished when |
| --- | --- | --- |
| Red | Write the tests of the `test` issue. Run them. | Each new test fails, and the failure message names the missing behaviour |
| Green | Write the least code that makes the tests pass. | The new tests and the full suite pass |
| Refactor | Improve the structure of the code. Do not change the behaviour. | The full suite passes, and no test was changed |

Repeat the cycle for each behaviour of the slice when the slice has more than
one. A cycle takes minutes, not days.

## Step 1: Red, on the `test` issue

```
next_tasks
start_task { id: "LP-4" }
get_instructions { id: "LP-4" }
```

```bash
lpm task start LP-4
lpm instructions LP-4
```

1. **Write one test for each row of the case table.** Copy the expected
   values from the table. Do not calculate them again with code.
2. **Add the minimum code that compiles.** A function that throws "not
   implemented" is enough. Do not return a default value such as 0. A default
   value makes some tests pass before any code exists, and you then do not see
   them fail.
3. **Run the new tests.** Each one must fail with a difference in the value,
   or with the "not implemented" error. A compile error or an import error is
   not a red test.
4. **Record the output on the `test` issue.** Paste 15 lines or fewer.

```
add_comment { id: "LP-4", body: "Red: 4 of 4 tests fail.\n```\n$ npx vitest run test/late-fees.test.ts\n× an invoice paid 3 days late gets a fee of 6.00\n  Error: not implemented\n…\nTests  4 failed (4)\n```" }
finish_task { id: "LP-4", comment: "The 4 cases of the table are in test/late-fees.test.ts. Each one failed. Output in the previous comment." }
```

**When an expected value looks wrong.** Do not change it. A wrong value in the
table is a wrong requirement or a calculation error. Comment on the `test`
issue with the value, your calculation and the source. If the request does not
answer the question, flag the issue with `flag_issue`. `lpm-delivery` gives the
format of a flag.

### Failing tests and the main branch

Do not merge failing tests into the main branch. The suite then fails for
every other developer. Keep the tests on the branch of the slice, and merge
them with the build story.

When the team merges the tests before the code, mark each test as expected to
fail:

| Framework | Marker | What happens when the test starts to pass |
| --- | --- | --- |
| Vitest | `it.fails('…', …)` | The test fails, so the build story must remove the marker |
| pytest | `@pytest.mark.xfail(strict=True)` | The test fails with `XPASS(strict)` |
| Jest | `test.failing('…', …)` | The test fails |

## Step 2: Green, on the build story

```
start_task { id: "LP-5" }
```

```bash
lpm task start LP-5
```

1. **Write the least code that makes one test pass.** Run that test.
2. **Repeat for the next test.** The code can be plain, with duplication. The
   refactor step removes it.
3. **Run the full suite.** Each earlier test must still pass. An earlier test
   that fails shows that the slice changed a behaviour of an earlier slice.
4. **Do not edit a test to make it pass.** When an existing test must change,
   the behaviour changed. Write a comment that names the test, the old value,
   the new value and the reason. Record the change as an open point (step 4).

## Step 3: Refactor, on the build story

Improve the structure while the suite is green. Run the full suite after each
change. A change that makes a test fail is not a refactor. Undo it.

Checklist:

- [ ] Remove duplication that the green step added.
- [ ] Give each function, variable and file a name that states what it holds
      or does.
- [ ] Split a function that does more than one thing.
- [ ] Remove code that no test reaches.
- [ ] Apply the open/closed check below.

Do not add behaviour in the refactor step. New behaviour needs a new test
first, so it belongs in the next red step.

### The open/closed check

The open/closed principle says: code is open for extension and closed for
modification. A new variant of a behaviour adds new code. It does not change
the code of the existing variants, and it does not change their tests.

This principle makes the next slices cheap. When a slice only adds code, the
tests of the earlier slices show that the earlier behaviour did not change.

Apply the principle when one of these signals is in the code:

| Signal | Example |
| --- | --- |
| The slice added a branch to a `switch` or an `if` chain that selects a kind | A third `case` for a third payment method |
| A function has a boolean parameter that selects a behaviour | `lateFee(invoice, policy, applyCap: boolean)` |
| A change for one variant needed a change in the test of another variant | The cap broke the test of the grace period |
| The behaviour list of the feature names the next variant | Behaviour 5 adds a second rule to the same calculation |

Do not apply the principle for a variant that nobody asked for. One variant
needs no extension point. An extension point costs each reader one more step
to find the code that runs.

Choose the pattern by the kind of variation:

| Variation | Pattern | Shape |
| --- | --- | --- |
| One of several ways to do the same job | Strategy | A function or object for each way. A map from the kind to the function |
| A list of rules that each change a result | Pipeline of rules | An ordered list of functions. Each takes the result and returns a new result |
| A new data source or target (database, HTTP, file) | Ports and adapters | An interface in the logic. One adapter for each source, outside the logic |
| An extra behaviour around an existing one (log, cache, retry) | Decorator | A function that takes the original and returns a new one with the same interface |
| Objects created by kind from configuration | Factory | One function that maps the kind to the constructor |

Example: the late-fee calculation after slice 2 has two rules in one function.
Slice 3 adds a cap and the rule for cancelled invoices.

Before the refactor (end of slice 2):

```ts
export function lateFee(invoice: Invoice, policy: Policy): number {
  const days = daysLate(invoice);
  if (days <= policy.graceDays) return 0;
  return (days - policy.graceDays) * policy.perDay;
}
```

After the refactor (start of slice 3):

```ts
type Rule = (fee: number, invoice: Invoice, policy: Policy) => number;

const rules: Rule[] = [dailyFee, graceRule];

export function lateFee(invoice: Invoice, policy: Policy): number {
  return rules.reduce((fee, rule) => rule(fee, invoice, policy), 0);
}
```

The tests of slices 1 and 2 pass with no change. Slice 3 then adds `capRule`
and `cancelledRule`, each a new function with new tests. The functions of the
earlier rules do not change.

Record the reason for the extension point in the finish comment: "Moved the
fee rules into a list, because slice 3 adds two rules (behaviours 4 and 5)."

## Step 4: Record each open point when it occurs

An open point is an assumption, a known issue or a limitation that a person
must review. `lpm-tdd-open-points` defines the three kinds.

Write a comment on the build story when the open point occurs. Do not wait for
the end of the slice. Start the comment with the kind, so the open-points story
finds it:

```markdown
Assumption: the grace period counts calendar days, not business days.
Source: the request says "5 days" and names no calendar.
Where: `graceRule`, src/late-fees.ts:18.
Test: "day 5 after the due date is in the grace period".
Effect if wrong: invoices due before a weekend get the fee 2 days early.
```

```markdown
Known issue: an invoice paid at 23:30 in UTC-5 counts as paid the next day.
Where: `daysLate`, src/late-fees.ts:7. The function compares UTC dates.
Example: the test "known issue: an invoice paid at 23:30 UTC-5 on its due
date gets a fee of 2.00" pins the current output. The correct fee is 0.00.
Run it with `npx vitest run -t "known issue"`.
Not fixed because: the invoice record stores no time zone.
```

```markdown
Limitation: the fee uses one currency. An invoice in a second currency gets
the fee in the currency of the policy.
Where: `Policy.perDay`, src/late-fees.ts:3.
```

Write one comment for each open point. Each comment names the file and line,
and the test or the command that shows the point.

## Step 5: Close the build story

Use the finish note of `lpm-writing`. Add a section for the open points.

```
finish_task { id: "LP-5", comment: "## Summary\nAdded the late fee for each day after the due date.\n- `src/late-fees.ts`: `lateFee`, `daysLate`.\n\n## Test plan\n$ npm test\nTests  48 passed (48)\n\nRed evidence: the comment on LP-4.\nNo existing test was changed.\n\n## Open points\n- 1 assumption, 1 known issue. See the comments on this issue." }
```

```bash
lpm comment LP-5 --file ./finish-note.md
lpm task done LP-5
```

## Mistakes to avoid

| Mistake | Result |
| --- | --- |
| Code written before the test | The test confirms the code, and nobody saw it fail |
| A stub that returns 0 at red | Some tests pass before the code exists, so their failure was never seen |
| A test edited to pass | A behaviour changed and no person decided it |
| Behaviour added in the refactor step | The behaviour has no test |
| An extension point for a variant that nobody asked for | Code that each reader must follow, for no behaviour |
| No extension point at the third `case` of the same `switch` | Each new variant changes the code and the tests of the old ones |
| Open points kept for a final note | The facts are lost, and the reviewer gets a summary with no example |
