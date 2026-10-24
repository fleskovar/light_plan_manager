---
name: lpm-tdd-tests
description: Write tests that a person can read, check and solve by hand, so the tests show that a feature behaves as the request says. Load this before you write the body of a `test` issue for a slice, before you write the tests of a slice in code, and when you review a test suite that nobody can read. It gives the rules for test names, expected values, input size, boundaries, assertions and determinism, the case table for the `test` issue, examples in TypeScript and Python, and the check that a test can fail. Part of the lpm-tdd skills.
roles:
  - developer
  - pm
---

# Writing tests that a person can solve by hand

A useful test fails when the behaviour breaks. A person can also read it and
confirm its expected value without running the code. This skill
gives the rules for such tests, and the format of the `test` issue that holds
them on a light-plan board.

Load `lpm-tdd` for the plan that the tests belong to. Load `lpm-tdd-cycle` for
how the developer runs them.

## The reader of a test

A test has three readers:

1. **The reviewer** of the slice. The reviewer checks that each expected value
   matches the request. The reviewer has a calculator and 5 minutes.
2. **The developer of the next change.** When the test fails, this developer
   must understand from the test name and the failure message which rule broke.
3. **A new member of the team.** The tests show how the code is used and what
   it returns. A test with small known inputs is the first place to set a
   breakpoint.

Each rule below serves one of these readers.

## The rules

### 1. One behaviour in each test, and a name that states it

The name is a sentence with the values of the case. The list of test names
reads as the specification of the feature.

| Do not write | Write |
| --- | --- |
| `test_fee_1` | `an invoice paid 3 days late gets a fee of 6.00` |
| `calculates fee correctly` | `an invoice paid on its due date gets no fee` |
| `handles edge cases` | `day 5 after the due date is in the grace period` |

A test that checks two behaviours fails with one message for two causes. Split
it.

### 2. Expected values are literals that a person calculated

Write the expected value as a literal in the test. Write the calculation next
to it, in a comment or in the case table.

```ts
// 3 days late x 2.00 per day = 6.00
expect(fee).toBe(6.0);
```

Do not calculate the expected value with the code under test. Do not copy the
formula of the code into the test. A copied formula repeats the defect of the
code, and the test then passes with the defect.

### 3. Small inputs with round values

- Use 5 records or fewer. One record is enough for most rules.
- Use round values: 100.00, not 137.42. Use 2.00 per day, not 1.85.
- Choose dates that make the arithmetic visible. Due on 2026-03-01, paid on
  2026-03-04: 3 days late.
- Give each field that the behaviour does not use a default value from a
  builder. The test then shows only the fields that matter.

```ts
const invoice = anInvoice({ dueDate: '2026-03-01', paidOn: '2026-03-04' });
```

### 4. Show the input in the test

Use three parts in each test: the input, the action, the check. A reader must
see the input without opening another file. Shared fixtures that many tests
change are the most frequent reason why nobody can read a test.

Exception: a case folder (rule 10) keeps its input in files, because the
files are the documentation.

### 5. Test each limit at, below and above the limit

A behaviour with a limit needs three cases. For a grace period of 5 days:

| Case | Days late | Expected fee | Calculation |
| --- | --- | --- | --- |
| Last day of the grace period | 5 | 0.00 | In the grace period |
| First day with a fee | 6 | 2.00 | 1 day after the grace period x 2.00 |
| Inside the grace period | 1 | 0.00 | In the grace period |

Add a case for empty input and a case for each error. "A negative amount fails
with `InvalidAmount`" is a behaviour.

### 6. Check results, not calls

Check what a caller or a user can observe: the return value, the stored state,
the output, the error. Do not check which internal function the code called.

A check of internal calls fails when the code is refactored, and the behaviour
did not change. The refactor step of `lpm-tdd-cycle` then becomes expensive.

Replace a dependency only at a boundary that the project owns: the clock, the
network, the filesystem, an external service. Use a small fake with the same
interface, not a mock that records calls.

### 7. Give each test the same result on each run

Pass the clock, the random seed and the generated ids into the code. A test
that reads the system clock passes today and fails at the end of the month.
A test that fails 1 time in 50 runs is a defect. Record it with a `bug` issue.

### 8. Compare full values, so the failure message names the rule

| Do not write | Failure message | Write | Failure message |
| --- | --- | --- | --- |
| `expect(fee > 0).toBe(true)` | `expected false to be true` | `expect(fee).toBe(6.0)` | `expected 4 to be 6` |
| `expect(result.ok).toBe(true)` | `expected false to be true` | `expect(result).toEqual({ ok: true, fee: 6.0 })` | the difference between the two objects |

### 9. Make sure that the test can fail

A test that you never saw fail can contain a defect that makes it pass always.
Two checks:

1. **Red.** Run the test before the code exists. Read the failure message. The
   message must name the missing behaviour, for example `expected 0 to be 6`.
   A compile error or an import error is not a red test. Add the minimum code
   that compiles, then run the test again.
2. **Break the code on purpose** after the test passes. Change one operator,
   for example `>` to `>=` in the grace check. The test "day 5 is in the grace
   period" must fail. Undo the change.

`lpm-tdd-cycle` records the output of the red step on the board.

### 10. Keep 2 to 5 cases of each feature as case folders

Unit tests cover each branch. A case folder documents the feature for a person.
Choose the 2 to 5 cases that explain the feature best, and store each one as a
folder:

```
test/cases/late-fee-after-grace/
  README.md          what the case shows, and the calculation step by step
  inputs/
    invoices.json
    policy.json
  expected/
    fees.json
```

The `README.md` of a case has three parts:

1. **What the case shows.** One sentence, with the behaviour numbers of the
   feature.
2. **The calculation.** Each step, with the values from `inputs/`, to the
   values in `expected/`. A person follows it with a calculator.
3. **How to run this case alone.** The exact command, for example
   `npx vitest run -t "late-fee-after-grace"`.

One test runner reads each folder, runs the code on `inputs/` and compares the
result with `expected/`. Write the runner once for each project.

## The `test` issue of a slice

The `test` issue holds the cases before the code exists. Use the headings of
the board's `test` template. The Scrum template has "Objective",
"Preconditions", "Steps", "Expected Result" and "Test Data". `lpm-writing-items`
gives the general rules for a `test` issue.

```markdown
## Objective

Verify behaviours 1 and 2 of LP-3: an invoice paid late gets 2.00 for each
day after the due date, and an invoice paid on time gets no fee. These tests
fail if the code counts the due date as a late day, or if it charges a fee
for an invoice paid early.

## Preconditions

- The fee policy is 2.00 for each day late, with no grace period and no cap.
  Slice 2 (LP-6) adds the grace period.

## Steps

1. Write one unit test for each case in the table, in
   `test/late-fees.test.ts`.
2. Run the tests before any code exists. Each test must fail with a
   difference in the fee. Paste the output in a comment on this issue.

## Expected Result

| Case | Due date | Paid on | Expected fee | Calculation |
| --- | --- | --- | --- | --- |
| Paid before the due date | 2026-03-01 | 2026-02-27 | 0.00 | Not late |
| Paid on the due date | 2026-03-01 | 2026-03-01 | 0.00 | 0 days late |
| Paid 1 day late | 2026-03-01 | 2026-03-02 | 2.00 | 1 x 2.00 |
| Paid 3 days late | 2026-03-01 | 2026-03-04 | 6.00 | 3 x 2.00 |

## Test Data

- `test/late-fees.test.ts`
- `test/cases/late-fee-3-days/` (the case folder for row 4)

Not covered: payments in a different currency. No behaviour of LP-3 covers
them.
```

Set the attributes of the type. The Scrum template has `test_level` (`unit`,
`integration`, `system`, `acceptance`) and `automated` (`true` or `false`).

## Examples in code

TypeScript with Vitest:

```ts
import { describe, expect, it } from 'vitest';
import { lateFee } from '../src/late-fees';

const policy = { perDay: 2.0, graceDays: 0, cap: null };

describe('late fees, behaviours 1 and 2 of LP-3', () => {
  it('an invoice paid on its due date gets no fee', () => {
    const fee = lateFee({ dueDate: '2026-03-01', paidOn: '2026-03-01' }, policy);
    expect(fee).toBe(0); // 0 days late
  });

  it('an invoice paid 3 days late gets a fee of 6.00', () => {
    const fee = lateFee({ dueDate: '2026-03-01', paidOn: '2026-03-04' }, policy);
    expect(fee).toBe(6.0); // 3 days late x 2.00 per day = 6.00
  });
});
```

Python with pytest:

```python
from late_fees import late_fee

POLICY = {"per_day": 2.00, "grace_days": 0, "cap": None}

def test_an_invoice_paid_on_its_due_date_gets_no_fee():
    fee = late_fee(due_date="2026-03-01", paid_on="2026-03-01", policy=POLICY)
    assert fee == 0  # 0 days late

def test_an_invoice_paid_3_days_late_gets_a_fee_of_6():
    fee = late_fee(due_date="2026-03-01", paid_on="2026-03-04", policy=POLICY)
    assert fee == 6.00  # 3 days late x 2.00 per day = 6.00
```

## Which level for which test

| Level | Use it for | Number for a feature |
| --- | --- | --- |
| Unit | Each rule and each branch of the logic, with no I/O | Most of the tests |
| Case folder | The 2 to 5 cases that document the feature | 2 to 5 |
| Integration | Each adapter against the real dependency: the database, the HTTP client, the files | One or more for each adapter |
| End to end | The few user journeys whose failure stops the business | 0 to 3 |

Test a rule at the lowest level that can show it. A rule tested through HTTP
is slow, and its failure names the request, not the rule.

## Check a test before you send it

- [ ] The name states one behaviour, with its values.
- [ ] The expected value is a literal, and the calculation is beside it.
- [ ] The input has 5 records or fewer, with round values.
- [ ] The input is visible in the test, or in the case folder.
- [ ] Each limit has a case at, below and above it.
- [ ] The test checks a result, not an internal call.
- [ ] The test reads no clock, no random value and no network.
- [ ] You saw the test fail, and the message named the missing behaviour.

## Mistakes to avoid

| Mistake | Result |
| --- | --- |
| The expected value comes from the code under test | The test passes with the defect |
| A fixture of 200 rows for a rule about one invoice | Nobody can check the expected value |
| One test for "all the edge cases" | One failure message for many causes |
| A mock for each collaborator | The test breaks on each refactor and shows no behaviour |
| A test edited to pass after a code change | The behaviour changed and nobody decided it. Record it as an open point |
| Coverage as the goal | Lines run with no check of their result |
