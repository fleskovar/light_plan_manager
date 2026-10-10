---
name: technical-writing
description: How to write technical prose that an engineer understands after one read. Use it for replies, reports, documentation, READMEs, code comments, commit messages and pull request descriptions. Load it before you write any text for a person. It explains how to describe a setting, a stored value, an operation or a change by naming each part (the actor, the action, the object, the location and the values). It also gives the sentence and word rules from ISO 24495-1, the Google and Microsoft style guides and ASD-STE100.
---

# Technical writing

The reader of your text is an engineer who must act on it. The reader knows the
field. The reader does not know what you saw, tried or decided in your session.
Write so that this reader understands the text after one read and can check
every claim in it.

These rules apply to every text that you write for a person:

- replies in a chat or a terminal
- reports, summaries and handover notes
- documentation, READMEs and design records
- code comments, commit messages and pull request descriptions
- issue titles, issue bodies and issue comments

Code, commands, logs, error messages and quotes are exempt. Copy them exactly.

## The most frequent defect: a compressed description

Agents often compress a mechanism into a label. The reader must then rebuild
the facts from the label. This sentence is an example:

> The switch is a `planning: queue` line in `.lpm/config.yml`.

The sentence has four defects:

1. "The switch" is a name that the text never defined.
2. "Is a line" says that a setting is its storage format. A setting is a value
   that changes behaviour. A line is how a file stores that value.
3. The code span `planning: queue` holds a key and a value together. The reader
   must parse YAML to find which part is the name and which part is the value.
4. The sentence does not say what writes the key, which values the key can
   hold, or what happens when the key is absent.

Write each part:

> The `lpm planning` command writes the key `planning` in `.lpm/config.yml`.
> The key holds one of two values: `periods` or `queue`. When the key is
> absent, the board uses `periods`.

Rules 1 to 4 prevent this defect. Apply them first.

## Rules for content

### 1. Name each part of a mechanism

When you describe what a system does, name these parts:

- **Actor:** the command, function, control, service or person that acts.
- **Action:** a specific verb, such as "writes", "deletes", "reads", "sends" or
  "returns". Do not use "handles", "manages", "deals with" or "takes care of".
- **Object:** the file, key, field, record, request or message.
- **Location:** the path, the table, the endpoint or the line number.
- **Result:** what changes, and what does not change.

| Do not write | Write |
| --- | --- |
| The switch is a line in the config. | `lpm planning queue` adds the key `planning` with the value `queue` to `.lpm/config.yml`. |
| The numbers are the engine's own sequence. | Each card shows the position that `simulateQueue` gives to the issue. |
| Switching is non-destructive. | Switching the mode changes only `.lpm/config.yml`. No issue file changes. |
| The cache handles stale entries. | `resolve()` deletes an entry from the cache when the file is newer than the entry. |

### 2. Describe stored data by its structure

For a setting, a configuration key, a field or a column, give these facts:

- the file, the table or the store
- the full key path, for example `git_sync.remote` (not "the remote setting")
- the type and the allowed values
- the default value, and what an absent key means
- what writes the value, and what reads it

A table is often the clearest form for these facts:

| Key | File | Values | Default | Written by | Read by |
| --- | --- | --- | --- | --- | --- |
| `planning` | `.lpm/config.yml` | `periods`, `queue` | `periods` (key absent) | `lpm planning`, the queue panel toggle | `lpm task next`, the web app |

Write "the key `planning`" and "the value `queue`". Do not use a code span that
holds a key and a value as a noun in a sentence. To show the literal text,
explain it first, and then show it as an example in a code block:

```yaml
planning: queue
```

### 3. Do not say that a thing "is" its representation

"X is Y" is correct only when X and Y are the same kind of thing. Do not say
that a concept is its storage, its file, its format or its symptom. Use a verb
that names the relation: "stores", "contains", "writes", "shows", "causes".

| Do not write | Write |
| --- | --- |
| A flag is a field in the frontmatter. | The engine stores a flag in the `flag` field of the issue's frontmatter. |
| The queue is a list of ids. | The server returns the queue as a list of issue ids, in order. |
| The lock is a file. | A process takes the lock when it creates the file `.lpm/lock`. |
| The bug is a 409. | The request fails with status 409 when the file changed after the load. |

### 4. Define a name before you use it

Do not start a sentence with "the switch", "the engine", "the panel" or "the
fix" if the text did not define that name before. Define a new term once, in one
sentence, where it first appears:

> The planning mode is a board setting. It decides if the work queue reads the
> periods of the board.

After that, use exactly that term.

Each pronoun ("it", "this", "that", "they") must refer to one noun in the
sentence before it. Write "this setting", not "this". When the noun is more than
one sentence back, repeat the noun.

| Do not write | Write |
| --- | --- |
| It used to be a per-view setting. | Before this change, each view file stored its own planning mode. |
| This is why the order drifted. | The browser ranked work with its own copy of the rules. That copy did not use the sprint dates, so its order was different from the order of `lpm task next`. |

### 5. Put the main point first

State the result, the answer or the request in the first sentence. Put the
background after it.

- A reply starts with the answer to the question.
- A report starts with what changed and whether it works.
- A commit message starts with what the commit changes.
- A bug report starts with what is wrong and when it happens.

### 6. Give facts, not descriptions

Replace each adjective and adverb with the fact behind it.

| Vague | Specific |
| --- | --- |
| much faster | p95 latency drops from 900 ms to 120 ms |
| a large board | a board with 556 issues |
| handles errors properly | returns status 409 and `ConflictError` when the file changed after the load |
| fixed the caching bug | `resolve()` used the raw path as the cache key, so `./a` and `a` were two entries. It now normalises the path first (`src/core/cache.ts:88`). |

Give exact names: the file path and line, the function, the command, the flag,
the error text, the status name and the identifier.

### 7. Keep facts, assumptions and opinions apart

- Report what you saw. Give the command and its output.
- Label what you inferred: "Assumption: the importer runs once per day."
- Label a recommendation: "Recommendation: split the module in two."
- Say what you did not verify: "Not tested on macOS."
- Do not report a result that you did not see.

### 8. Make each text complete on its own

The reader has only your text. Do not write "as discussed", "per our
conversation", "the earlier approach" or "the user's choice". State the fact,
and say who decided it and when:

> fleskovar decided on 2026-10-05 that git sync and tracker remotes cannot be
> used together.

## Rules for sentences

### 9. Write short sentences with one idea each

- An instruction has 20 words or fewer. A description has 25 words or fewer.
  Most sentences are shorter than that.
- Put one idea in each sentence. When a sentence joins two ideas with "and", a
  semicolon or a dash, write two sentences.
- Do not use semicolons. Do not join two clauses with a dash (—).
- A paragraph has six sentences or fewer, about one topic.
- Put three or more items of the same kind in a list.

### 10. Use the active voice and name the actor

| Do not write | Write |
| --- | --- |
| The new status is written. | `moveNode` writes the new status. |
| The flag gets cleared. | The planner clears the flag. |
| A `ConflictError` is encountered. | The push fails with `ConflictError`. |

- Use the present tense for how the system works.
- Use the past tense for what you did.
- Use "must" for a requirement and "can" for a possibility or an option.
- Do not use "should", "may", "might", "could" or "would". The reader cannot
  tell if they state a requirement or a guess.

### 11. Write complete sentences

- Keep the articles ("the", "a") and the word "that". Do not write in telegraph
  style: "Ensure file exists before running."
- Do not use contractions. Write "do not", "it is" and "that is".
- After a bold label, write a full sentence. Do not write "**Non-destructive:**
  the only write is one line." Write "**Non-destructive.** Switching the mode
  changes only `.lpm/config.yml`."
- Put a condition before the instruction: "If the build fails, read the log."

### 12. Use plain words

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
| for example, that is | e.g., i.e. |

Do not use "etc.". Name the items, or write "and others".

### 13. Use one term for one thing

Use the names that the code and the product use, exactly as they are written. Do
not change to a synonym to vary the text. The reader thinks that the synonym is
a different thing. Do not call one thing "config" in one sentence and
"settings" in the next.

### 14. Write literally

Do not use metaphors, personification or idioms. The reader must translate them
back into facts.

| Figurative | Literal |
| --- | --- |
| This export is load-bearing. | `simulate.ts` imports this export. If you remove it, the build fails. |
| The engine decides the order. | `simulateQueue` in `src/core/board/simulate.ts` calculates the order. |
| One interrupted run dammed the board. | One interrupted run left LP-12 in progress. The 14 issues that depend on LP-12 were never offered. |
| The panel asks the engine. | The panel sends `GET /api/queue`. The server calls `simulateQueue` and returns the order. |

### 15. Do not use rhetorical patterns

These patterns make text sound persuasive. They make it slower to read and
harder to check.

- **Contrast frames.** Do not write "X is not Y, it is Z" or "not just X but
  Y". State what X is.
- **Slogans.** Delete a last sentence that repeats the paragraph as a saying.
- **Rhetorical questions.** Give the answer instead of the question.
- **Stories.** Keep history only when it explains a decision. Then write the
  decision, the reason and the rejected option.
- **Lists of three for rhythm.** Keep a list only if each item is a separate
  fact that the reader needs.
- **Announcements.** Delete "here is the thing", "the key insight is", "it turns
  out" and "note that". State the fact.
- **Drama.** Delete "trap", "for ever", "the whole point" and "nobody would
  notice". State the consequence and its size.

### 16. Do not use intensifiers, hedges or praise

Delete these words, or replace them with a fact:

- genuinely, really, truly, actually, very, quite, simply, just, clearly,
  obviously, of course, honestly, basically
- crucial, critical (except as a severity value), key, vital, essential,
  significant (without a number)
- robust, seamless, powerful, elegant, clean, great, smart, comprehensive

If you are not sure of a fact, say exactly what you are not sure of.

## Rules for format

### 17. Format for finding, not for emphasis

- Write headings in sentence case.
- Use bold only for the label at the start of a list item, or for one term that
  the reader must not miss.
- Do not use emoji or exclamation marks.
- Put code, paths, commands, identifiers, keys, values and error text in
  backticks. Put one identifier in each code span.
- Use a table when you compare items by the same attributes.
- Use a numbered list for steps in order. Use a bulleted list for items in no
  order.

## Before and after

These examples come from one real reply. Each "after" keeps every fact of its
"before".

**A setting.**

Before:

> The switch is a `planning: queue` line in `.lpm/config.yml`.

After:

> The `lpm planning` command and the toggle at the top of the queue panel write
> the key `planning` in `.lpm/config.yml`. The key holds `periods` or `queue`.
> When the key is absent, the board uses `periods`.

**A guarantee.**

Before:

> **Non-destructive:** the only write is one commented line, and switching back
> removes exactly that line.

After:

> **Non-destructive.** A switch to `queue` adds four lines to the end of
> `.lpm/config.yml`: a blank line, two comment lines and the line
> `planning: queue`. A switch back to `periods` deletes the same four lines. No
> other file changes.

**A cause.**

Before:

> It used to be a per-view setting. That's why the browser could stop showing
> sprints while `lpm task next` still ranked by them.

After:

> Before this change, each view file stored its own planning mode, and only the
> web app read it. In queue mode the web app hid the sprints, but
> `lpm task next` still ranked work by sprint.

**A behaviour.**

Before:

> One numbering runs through all sections.

After:

> The card numbers continue from one section to the next. If the "In progress"
> section shows cards 1 to 3, the "Up next" section starts at 4.

## Check before you send

Read the text once as the reader. Then check each item:

- [ ] The first sentence gives the answer, the result or the request.
- [ ] Each sentence about a mechanism names the actor, the action, the object
      and the location.
- [ ] Each setting or stored value has its file, key, allowed values and
      default.
- [ ] No sentence says that a thing "is" its file, format or storage.
- [ ] Each name is defined before it is used. Each pronoun has one referent.
- [ ] No sentence is longer than 25 words, or 20 for an instruction.
- [ ] No semicolon, no dash between clauses, no contraction.
- [ ] Each claim has a number, a name, a path or a pasted output.
- [ ] No metaphor, slogan, rhetorical question or "X is not Y, it is Z".
- [ ] None of the words in rule 16.
- [ ] Assumptions and things that you did not verify have a label.
- [ ] Nothing depends on "see above" or on your session.

## Sources

- ISO 24495-1:2023, Plain language, Part 1: Governing principles and
  guidelines. <https://www.iso.org/standard/78907.html>
- ASD-STE100 Simplified Technical English, Issue 9 (sentence limits, one word
  for one meaning, approved modal verbs, no semicolons).
  <https://www.asd-ste100.org/>
- Google developer documentation style guide.
  <https://developers.google.com/style>
- Google Technical Writing One (words, active voice, clear and short
  sentences). <https://developers.google.com/tech-writing/one>
- Google engineering practices, Writing good CL descriptions.
  <https://google.github.io/eng-practices/review/developer/cl-descriptions.html>
- Microsoft Writing Style Guide, Use simple words, concise sentences.
  <https://learn.microsoft.com/style-guide/word-choice/use-simple-words-concise-sentences>
- GOV.UK style guide, Words to avoid.
  <https://guidance.publishing.service.gov.uk/writing-to-gov-uk-standards/style-guides/a-to-z-style-guide/>
