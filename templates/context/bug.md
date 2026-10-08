<% /* The brief for a defect. Reproduce before you fix; the ancestry is here    */ %>
<% /* because a bug's severity only means something against what it breaks.     */ %>
# <%= issue.id %> — <%= issue.title %>

You are picking up a **bug** on the **<%= board.name %>** board.

Status: <%= issue.status_label %><% if (issue.attributes.severity) { %> · severity <%= issue.attributes.severity %><% } %><% if (issue.attributes.priority) { %> · priority <%= issue.attributes.priority %><% } %><% if (issue.period) { %> · <%= issue.period.title %><% } %>

<% if (issue.flag) { %>
> **Flagged: <%= issue.flag_label %>.** Somebody stopped work on this and said
> why in the work log below — very often "could not reproduce". Read it before
> starting: repeating an investigation that already failed is the most common way
> to waste a day on a bug.

<% } %>
<% if (epic) { %>
## Epic: <%= epic.title %> (<%= epic.id %>)

<%= heading(epic.body, 3) %>

<% } %>
<% if (feature) { %>
## The feature this breaks: <%= feature.title %> (<%= feature.id %>)

Read this first. It is what the code is *supposed* to do, and it is what your fix
has to keep true.

<%= heading(feature.body, 3) %>

<% } %>
## The defect

<%= heading(issue.body, 3) %>

<% if (related_files.length) { %>
## Where it lives

The files this bug was filed against — the stack frame, the module, the fixture
that should have caught it. Start here, and remember that a report can be wrong
about where the fault is: this is a lead, not a diagnosis.

<% for (const ref of related_files) { %>
- `<%= ref %>`
<% } %>

<% } %>
<% if (children.length) { %>
## Broken down into

<% for (const task of children) { %>
### <%= task.title %> (<%= task.id %> · <%= task.status_label %>)

<%= heading(task.body, 4) %>

<% } %>
<% } %>
<% if (blocked_by.length) { %>
## Where this comes from

The work this bug was sequenced after. When one of these is the change that
introduced the defect, its files below are the first place to look.

<% for (const blocker of blocked_by) { %>
- **<%= blocker.id %>** <%= blocker.title %> — <%= blocker.status_label %><% if (blocker.done) { %> (done)<% } else { %> (**not finished**)<% } %>
<% } %>

<% } %>
<% if (upstream_files.length) { %>
### What that work touched

<% for (const trail of upstream_files) { %>
- **<%= trail.issue.id %>**: <%= join(trail.files, ", ") %>
<% } %>

<% } %>
<% if (blocks.length) { %>
## What is waiting on the fix

<% for (const waiting of blocks) { %>
- **<%= waiting.id %>** <%= waiting.title %> — <%= waiting.status_label %>
<% } %>

<% } %>
<% if (comments.length) { %>
## Work log

<% for (const note of comments) { %>
### <%= note.at %> — <%= note.author %>

<%= heading(note.body, 4) %>

<% } %>
<% } %>
## How to finish it

1. **Reproduce it first.** If you cannot, flag it rather than closing it:
   `lpm flag <%= issue.id %> --reason help --comment "..."` with exactly what you
   tried. An unreproducible bug closed as fixed is worse than an open one, and a
   flagged one gets somebody who knows the area to look.
2. Write the failing test before the fix, so the regression cannot come back
   silently.
3. Name the root cause in your handover note, not just the change. "Guarded the
   null" is not a diagnosis.
4. Say whether anything else shares the cause, and put it on the board if so.
5. Record the files the fix actually touched with
   `lpm set <%= issue.id %> --related <path>` — the next defect in that code
   arrives with this one attached.
