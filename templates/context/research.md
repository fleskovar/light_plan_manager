<% /* The brief for a spike or measurement: one question, a timebox, and a       */ %>
<% /* finding that other work will be built on.                                 */ %>
# <%= issue.id %> — <%= issue.title %>

You are picking up a **research / measurement** issue on the **<%= board.name %>**
board. This one exists to answer a question, not to build something. Producing a
half-implementation instead of an answer is the way to get it wrong.

Status: <%= issue.status_label %><% if (issue.attributes.method) { %> · <%= issue.attributes.method %><% } %><% if (issue.attributes.timebox_hours) { %> · timebox <%= issue.attributes.timebox_hours %>h<% } %><% if (issue.period) { %> · <%= issue.period.title %><% } %>

<% if (issue.flag) { %>
> **Flagged: <%= issue.flag_label %>.** The investigation stopped; the work log
> below says where. Note that "we could not tell" is a finding, not a flag —
> if that is what happened, record it and close this instead.

<% } %>
<% if (issue.attributes.question) { %>
## The question

> <%= issue.attributes.question %>

<% } %>
<% if (ancestors.length) { %>
## Why it is being asked

<% for (const parent of ancestors) { %>
### <%= parent.type_label %>: <%= parent.title %> (<%= parent.id %>)

<%= heading(parent.body, 4) %>

<% } %>
<% } %>
## The issue

<%= heading(issue.body, 3) %>

<% if (related_files.length) { %>
## Where to look

The code, data or documents this question is about. Read them; do not change
them. A research issue that leaves a diff behind has answered a different
question from the one it was asked.

<% for (const ref of related_files) { %>
- `<%= ref %>`
<% } %>

<% } %>
<% if (blocks.length) { %>
## What is waiting on the answer

These cannot be estimated, designed or committed to until this is answered:

<% for (const waiting of blocks) { %>
- **<%= waiting.id %>** <%= waiting.title %> — <%= waiting.status_label %><% if (waiting.related_files.length) { %>
  · expects to touch <%= join(waiting.related_files, ", ") %><% } %>
<% } %>

Where those name files, your answer has to be good enough for somebody to change
them on the strength of it.

<% } %>
<% if (comments.length) { %>
## Work log

<% for (const note of comments) { %>
### <%= note.at %> — <%= note.author %>

<%= heading(note.body, 4) %>

<% } %>
<% } %>
## How to finish it

- **Answer the question, and stop.** The timebox is the point: research without a
  cap does not end.
- Write the finding into the issue body under *Findings*, with the confidence you
  have in it and **what would falsify it**.
- "We could not tell" is a real answer. Record it rather than padding.
- Work that cannot start until this question is answered should say so with
  `lpm link <id> --depends-on <%= issue.id %>`. That is the whole of what a
  finding gates; the reasoning itself belongs in the bodies.
- Name the files you actually read with
  `lpm set <%= issue.id %> --related <path>`. Whoever builds on this finding gets
  them in their brief, and that is most of what "show your working" means here.
- If the timebox runs out with the question still open, flag it rather than
  quietly extending: `lpm flag <%= issue.id %> --reason help --comment "..."`.
