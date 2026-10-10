---
name: lpm-writing
description: How to write titles, bodies, comments, flag reasons and handover notes on a light-plan board, in plain technical English for engineers. Load this before you create or update a document, add a comment, raise or clear a flag, or finish a task with a note. The rules come from ISO 24495-1 (plain language), the Google and Microsoft style guides, Google's guide to change descriptions, Mozilla's bug-writing guidelines, the Summary and Test Plan convention of Meta's code review, and ASD-STE100.
roles:
  - developer
  - pm
---

# Writing on a light-plan board

Engineers read what you write on a board, and they must act on it. The reader
can be a developer who starts the work or a reviewer who checks it. It can also
be a maintainer who reads the issue months later to find out why the code
changed. Write so that this reader understands the text after one read.

These rules apply to every text you put on a board:

- titles and bodies of issues, periods and templates
- comments (`add_comment`, `lpm comment`)
- the comment on `flag_issue`, `clear_flag` and `finish_task`
- commit messages and pull request descriptions about board work

Code, commands, logs, error messages and quotes are exempt. Copy them exactly.

## Who reads it

- **An engineer.** The reader is not a customer, a manager or a buyer. Do not
  try to persuade, sell or entertain.
- **Someone who was not in your session.** They know the codebase in general.
  They do not know what you saw, tried or decided.
- **Someone reading the brief.** `lpm instructions <id>` shows the issue below
  all of its ancestors. The reader sees the epic and the feature before your
  story.

ISO 24495-1 gives four tests for a plain-language document. Use them on every
paragraph:

1. **Relevant:** the reader gets the information they need.
2. **Findable:** the reader can find it quickly.
3. **Understandable:** the reader understands it after one read.
4. **Usable:** the reader can act on it.

If a sentence passes none of the four tests, delete it.

## The rules

### 1. Put the main point first

State the result or the request first. Put background after it.

- A title says what changes or what is broken.
- The first sentence of a body says what the issue delivers.
- The first sentence of a comment gives the result: done, blocked, or a change
  of plan.

### 2. Write short sentences with one idea each

- An instruction has 20 words or fewer. A description has 25 words or fewer.
  Most sentences are shorter than that.
- Put one idea in each sentence. If a sentence joins two ideas with "and",
  ";" or a dash, make two sentences.
- A paragraph has five sentences or fewer, about one topic.
- Put three or more items of the same kind in a list.

### 3. Use the active voice and name the actor

| Write | Do not write |
| --- | --- |
| `moveNode` writes the new status. | The new status is written. |
| The planner clears the flag. | The flag gets cleared. |
| The push fails with `ConflictError`. | A `ConflictError` is encountered. |

Use the present tense for how the system works. Use the past tense for what
you did. Use **must** for a requirement and **may** for an option. Do not use
"should" in a requirement, because the reader cannot tell if it is required.

### 4. Give facts, not descriptions

Replace each adjective or adverb with the fact behind it.

| Vague | Specific |
| --- | --- |
| much faster | p95 latency drops from 900 ms to 120 ms |
| handles errors properly | returns 409 and `ConflictError` when the file changed after the load |
| a large board | a board with 537 documents |
| fixed the caching bug | `resolve()` used the raw path as the cache key, so `./a` and `a` were two entries. It now normalises the path first (`src/core/cache.ts:88`). |
| improve error handling | name each error and the behaviour for it |

Give exact names: the file path and line, the function, the command, the flag,
the error text, the status name and the issue id.

### 5. Use plain words

| Use | Do not use |
| --- | --- |
| use | utilise, leverage, make use of |
| start, end | initiate, commence, terminate |
| help, let | facilitate, enable, empower |
| show | showcase, surface, highlight |
| change, improve (with the number) | enhance, transform, streamline, revamp |
| to | in order to |
| because | due to the fact that, since |
| if | in the event that |
| before, after | prior to, subsequent to |
| now | at this point in time, going forward |
| some, three | a number of, various |

### 6. Use one term for one thing

Use the board's own type and status names, and the code's names, exactly as
they are written. Do not change to a synonym to vary the text. The reader will
think the synonym is a different thing. If you must use a new term, define it
once, in one sentence, where it first appears.

### 7. Write literally

Do not use metaphors, personification or idioms. They make the reader
translate the text back into facts. These examples come from a real board:

| Figurative | Literal |
| --- | --- |
| This export is load-bearing. | `simulate.ts` imports this export. Removing it breaks the build. |
| A flag with no comment is a red box nobody can act on. | A flag with no comment does not say why the work stopped. |
| It is the first provider to light up rung 1 of the ladder. | It is the first provider that stores `type` and `status` as native fields. |
| One interrupted run dammed the board. | One interrupted run left LP-12 in progress, and the 14 issues that depend on it were never offered. |
| The ticket is a needle in the board. | Nobody can find the ticket, because no list shows it. |
| Naming the risk is a gift to a reviewer. | Name the risk, so the reviewer knows where to look first. |

### 8. Do not use rhetorical patterns

These patterns make text sound persuasive. They also make it slower to read
and harder to check. Do not use them:

- **Contrast frames.** "X is not Y, it is Z", "not just X but Y", "never X,
  always Y". State what X is.
- **Slogans.** A last sentence that repeats the paragraph as a saying ("a
  promise nobody keeps is not a promise"). Delete it.
- **Rhetorical questions.** "So what does this mean?" Give the answer.
- **Stories.** "It was written, shipped and taken back out." Keep history only
  when it explains a decision. Then write it as a decision, a reason and the
  rejected option.
- **Lists of three for rhythm.** "Fast, safe and simple." Keep a list only if
  each item is a separate fact the reader needs.
- **Announcements.** "Here is the thing", "the key insight is", "it turns out",
  "note that", "it is worth noting". Delete them and state the fact.
- **Drama.** "trap", "for ever", "the one unrecoverable mistake", "the whole
  point", "nobody would notice". State the consequence and its size.

### 9. Do not use intensifiers, hedges or praise

Delete these words, or replace them with a fact:

- genuinely, really, truly, actually, very, quite, simply, just, clearly,
  obviously, of course, honest, honestly, quietly, deliberately (unless you
  name the decision)
- crucial, critical (except as a severity value), key, vital, pivotal,
  essential, significant (without a number)
- robust, seamless, powerful, elegant, clean, beautiful, great, smart,
  comprehensive, best-in-class, cutting-edge, next-generation

If you are not sure of something, say exactly what you are not sure of: "Not
tested on Windows." Do not write "this should probably work".

### 10. Format for finding, not for emphasis

- Use the headings of the type's template from `.lpm/config.yml`. Write
  headings in sentence case.
- Use bold only for the label at the start of a list item, or for one term a
  reader must not miss. Do not bold phrases inside running text.
- Do not use emoji or exclamation marks.
- Do not join clauses with a dash (—). Use a full stop, a colon or
  parentheses.
- Put code, paths, commands, ids and error text in backticks.
- Do not repeat the parent issue. The brief already shows it above yours.

### 11. Keep facts, assumptions and opinions apart

- Report what you saw, with the command and its output.
- Label what you inferred: "Assumption: the importer runs once per day."
- Label a recommendation: "Recommendation: split LP-42 into schema and API."
- Do not report a result that you did not see.

### 12. Make each text complete on its own

The reader has only the issue. Do not write "as discussed", "see above", "per
our conversation" or "the user's choice". Write the fact, and say who decided
it: "fleskovar decided on 2026-10-05 that git sync and tracker remotes cannot
be used together."

## Templates

A board defines a body template for each type. Use the headings of that
template, and use the rules above for the text in each section.

### Titles

- About 60 characters or fewer.
- Work item: a verb and its object. "Refuse a claim when another clone pushed
  first."
- Bug: the symptom and the condition. "`lpm remote pull` marks every twin
  deleted after an incremental listing."
- Do not write a topic ("Guest checkout") or a sales line ("Supercharge the
  sync engine").

### Bodies

Two skills give the content of a body for each type of item, with complete
examples:

| To write | Load |
| --- | --- |
| An epic, a feature, a user story, a task, a bug, a test, a research issue or a sub-task | `lpm-writing-items` |
| A review request, or the decision of a review | `lpm-writing-reviews` |

### Comments

**When you claim an issue.** State what you will do, so someone else can take
over if you stop.

```markdown
Started. Plan:
- <step>
- <step>

Assumptions:
- <what the issue does not say, and what you assumed>
```

**While you work.** Comment only when the plan or the facts change.

```markdown
<What happened.>
Tried <X>: <result>. Using <Y> instead, because <reason>.
```

**When you flag an issue.** Write it so the person who answers it can reply
once.

```markdown
Blocked: <what stopped the work>.
Tried: <what you did, and the result>.
Needed: <the decision, access or change that unblocks it>.
Who can answer: <role or person>.
```

**When you finish.** This uses the Summary and Test Plan fields of Meta's code
review. It also follows Google's rule: a change description says what changed
and why.

```markdown
## Summary
<One sentence: what changed.>
- `src/core/cache.ts:88`: normalise the path before the lookup.
- `test/cache.test.ts`: add the case for `./a` and `a`.

## Why this way
<The reason, in one to three sentences.>
Rejected: <option>, because <reason>.

## Test plan
$ npm test
Tests  430 passed (430)

Not verified: <what you could not run, and why>.

## Follow-ups
- LP-57: <the work you found, already on the board>
```

Leave out a section that has no content. Do not add text to make a section
look complete.

**When you clear a flag.** Say what changed and where it is written.

```markdown
Decision: use the existing `pool:` label. Recorded in the body of LP-42 under
Requirements. The work can continue.
```

## Before and after

Each "after" keeps every fact of its "before". Only the style changes.

### A handover comment

Before:

> Shipped the **fourth provider, `jsonfile`**, as the proof of the authoring
> kit — and, per the story's note, kept it (a local JSON-file tracker is
> genuinely useful for demos and tests). I chose the **JSON-file tracker**,
> fs-backed, because it is the only one of the two that proves something Gitea
> does not: the provider contract is not HTTP-shaped. Its connector does
> `node:fs` against a file — no token, no server — and it is the first provider
> whose `type` and `status` are native fields (the degradation ladder's rung 1,
> which no shipped platform lights up).

After:

> Added a fourth remote provider, `jsonfile`. It stores a tracker in a local
> JSON file. The story allowed us to keep it, so it stays in the registry for
> demos and tests.
>
> Why `jsonfile` and not Gitea:
> - The `jsonfile` connector uses `node:fs`. It needs no HTTP, no token and no
>   server, so it tests that the provider contract does not depend on HTTP. A
>   Gitea provider would not test this.
> - `jsonfile` stores `type` and `status` as native fields. No other shipped
>   provider does.

### A requirement

Before:

> No change to what a *view* stores unless the feature genuinely reshapes "the
> canvas someone arranged". A way of *reading* (a sort order, a column set, a
> drawer filter) is deliberately not persisted into the view file unless a
> story argues otherwise.

After:

> - The feature must not add fields to the view file, unless it changes the
>   layout of the canvas (positions, sizes, folding).
> - Sort order, visible columns and drawer filters are not saved in the view
>   file. To save one, write a separate story.

### A note on priority

Before:

> Worth running before anything else in PI-2 — the answer decides whether id
> allocation and folder naming need to change, and both are load-bearing for
> every other pending item.

After:

> Do this first in PI-2. The result decides if id allocation and folder naming
> must change. Every other open item in PI-2 depends on those two.

## Check before you save

Read the text once as the reader. Then check:

- [ ] The first sentence states the result or the request.
- [ ] No sentence is longer than 25 words, or 20 for an instruction.
- [ ] Every requirement uses "must" and can be tested.
- [ ] Each claim has a number, a name, a path or a pasted output.
- [ ] No metaphor, slogan, rhetorical question, or "X is not Y, it is Z".
- [ ] None of the words in rule 9.
- [ ] No dash joins two clauses. Bold is used only for labels.
- [ ] Assumptions and things you did not verify are labelled.
- [ ] Nothing depends on "see above" or on your session.
- [ ] Nothing repeats the parent issue.

For a long text, `lpm instructions <id>` shows the brief the developer will
read. Read your text there, below its ancestors.

## Sources

- ISO 24495-1:2023, Plain language, Part 1: Governing principles and
  guidelines. <https://www.iso.org/standard/78907.html>. A practical skill set
  based on it: <https://github.com/GaZmagik/iso-24495>.
- Google developer documentation style guide, Voice and tone.
  <https://developers.google.com/style/tone>
- Google Technical Writing One (words, active voice, clear and short
  sentences). <https://developers.google.com/tech-writing/one>
- Google engineering practices, Writing good CL descriptions.
  <https://google.github.io/eng-practices/review/developer/cl-descriptions.html>
- Microsoft Writing Style Guide, Use simple words, concise sentences.
  <https://learn.microsoft.com/style-guide/word-choice/use-simple-words-concise-sentences>
- Mozilla, Bug writing guidelines.
  <https://bugzilla.mozilla.org/page.cgi?id=bug-writing.html>
- Meta's Phabricator review fields, Summary and Test Plan.
  <https://frantic.im/test-plan/>
- GOV.UK style guide, Words to avoid.
  <https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/style-guides/a-to-z-style-guide/>
- ASD-STE100 Simplified Technical English (20-word procedural and 25-word
  descriptive sentence limits). <https://www.asd-ste100.org/>
