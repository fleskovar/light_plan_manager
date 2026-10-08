<% /* A task is the leaf: whatever sits above it is the requirement.            */ %>
# <%= issue.id %> — <%= issue.title %>

You are picking up a **task** on the **<%= board.name %>** board.

Status: <%= issue.status_label %><% if (issue.period) { %> · <%= issue.period.title %><% } %><% if (issue.assignee) { %> · assigned to <%= issue.assignee.title %><% } %>

<% if (issue.flag) { %>
> **Flagged: <%= issue.flag_label %>.** This task is in progress and stopped.
> The work log below says why.

<% } %>
<% if (ancestors.length) { %>
## Where it comes from

<% for (const parent of ancestors) { %>
### <%= parent.type_label %>: <%= parent.title %> (<%= parent.id %>)

<%= heading(parent.body, 4) %>

<% } %>
<% } %>
## The task

<%= heading(issue.body, 3) %>

<% if (related_files.length) { %>
## Files this is about

<% for (const ref of related_files) { %>
- `<%= ref %>`
<% } %>

<% } %>
<% if (siblings.length) { %>
## The other tasks alongside it

<% for (const step of siblings) { %>
- **<%= step.id %>** <%= step.title %> — <%= step.status_label %>
<% } %>

<% } %>
<% if (blocked_by.length) { %>
## Where this comes from

<% for (const blocker of blocked_by) { %>
- **<%= blocker.id %>** <%= blocker.title %> — <%= blocker.status_label %><% if (blocker.done) { %> (done: build on this)<% } else { %> (**not finished**)<% } %>
<% } %>

<% } %>
<% if (upstream_files.length) { %>
### What that work touched

<% for (const trail of upstream_files) { %>
- **<%= trail.issue.id %>**: <%= join(trail.files, ", ") %>
<% } %>

<% } %>
<% if (blocks.length) { %>
## Where this is going

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

- Do this task, not the neighbours'. Scope that belongs elsewhere goes back on
  the board as its own issue.
- If the task does not say enough to build from, comment on <%= issue.id %> with
  the precise question rather than guessing.
- If it has stopped for a reason outside itself, flag it —
  `lpm flag <%= issue.id %> --comment "..."` — instead of leaving it open.
- Leave a handover note: what changed, why, and how you verified it. Record the
  files with `lpm set <%= issue.id %> --related <path>`.
