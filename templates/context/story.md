<% /* The Kanban brief: Epic > Story > Task, no estimation, flow over ceremony. */ %>
# <%= issue.id %> — <%= issue.title %>

You are picking up a **story** on the **<%= board.name %>** board. Read down: the
epic says why, the story says what "done" means, the work log says what has
already been tried.

Status: <%= issue.status_label %><% if (issue.attributes.size) { %> · size <%= issue.attributes.size %><% } %><% if (issue.attributes.priority) { %> · priority <%= issue.attributes.priority %><% } %><% if (issue.period) { %> · <%= issue.period.title %><% } %>

<% if (issue.flag) { %>
> **Flagged: <%= issue.flag_label %>.** This story is in progress and stopped.
> The work log below says why. In Kanban a flagged card is the one thing the
> board is supposed to swarm on — read it before pulling anything else.

<% } %>
<% if (epic) { %>
## Epic: <%= epic.title %> (<%= epic.id %>)

<%= heading(epic.body, 3) %>

<% } %>
## The story

<%= heading(issue.body, 3) %>

<% if (related_files.length) { %>
## Files this is about

<% for (const ref of related_files) { %>
- `<%= ref %>`
<% } %>

Add anything else you end up changing with
`lpm set <%= issue.id %> --related <path>`.

<% } %>
<% if (children.length) { %>
## Tasks

<% for (const task of children) { %>
### <%= task.title %> (<%= task.id %> · <%= task.status_label %>)

<%= heading(task.body, 4) %>

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

What comes after this card. It is what your work has to be usable for.

<% for (const waiting of blocks) { %>
- **<%= waiting.id %>** <%= waiting.title %> — <%= waiting.status_label %><% if (waiting.related_files.length) { %>
  · expects to touch <%= join(waiting.related_files, ", ") %><% } %>
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

- Kanban sizes stories to be finished quickly. If this one is not going to be,
  split it rather than letting it sit in progress — and if it has stopped for a
  reason outside itself, flag it:
  `lpm flag <%= issue.id %> --comment "what stopped, what would resolve it"`.
  A card that is stuck and says so is the board working; one that is stuck
  silently is the board lying.
- Satisfy the acceptance criteria above as written; ask on <%= issue.id %> if they
  do not say enough.
- Leave a handover note: what changed, why, what you rejected, how you verified.
