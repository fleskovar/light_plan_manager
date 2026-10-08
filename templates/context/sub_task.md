<% /* A sub-task is a step inside a story. It is short on purpose, so its brief */ %>
<% /* leans on the story around it and on the siblings either side.            */ %>
<% /*                                                                          */ %>
<% /* On a board where the story level is declared `atomic` this brief is read  */ %>
<% /* by somebody already working the whole story -- the queue never hands a    */ %>
<% /* sub-task out on its own -- so it points back at the story rather than     */ %>
<% /* treating this step as a ticket of its own.                                */ %>
# <%= issue.id %> — <%= issue.title %>

You are looking at a **sub-task** on the **<%= board.name %>** board. It is one
step of a larger story, so the story is the requirement and this is one slice of
it. If the board hands work out a story at a time, this step is not a ticket of
its own: it is part of what you already picked up.

Status: <%= issue.status_label %><% if (issue.attributes.estimate_hours) { %> · about <%= issue.attributes.estimate_hours %>h left<% } %>

<% if (issue.flag) { %>
> **Flagged: <%= issue.flag_label %>.** This step is in progress and stopped;
> the work log below says why. A flagged sub-task usually means the boundary
> between it and a sibling is wrong — check that before restarting it.

<% } %>
<% if (parent) { %>
## The story it belongs to: <%= parent.title %> (<%= parent.id %>)

<%= heading(parent.body, 3) %>

<% } %>
<% if (feature) { %>
## Feature: <%= feature.title %> (<%= feature.id %>)

<%= heading(feature.body, 3) %>

<% } %>
## This step

<%= heading(issue.body, 3) %>

<% if (related_files.length) { %>
## Files this step is about

<% for (const ref of related_files) { %>
- `<%= ref %>`
<% } %>

<% } %>
<% if (siblings.length) { %>
## The other steps

Yours is one of these. Do not do the neighbours' work — if a boundary is wrong,
say so on <%= issue.id %>.

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

The step before yours left these behind. Read them: a sub-task usually continues
in exactly the file the one before it opened.

<% for (const trail of upstream_files) { %>
- **<%= trail.issue.id %>**: <%= join(trail.files, ", ") %>
<% } %>

<% } %>
<% if (blocks.length) { %>
## Where this is going

The step after yours cannot start until this one lands.

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

- Stay inside this step while you are on it. Scope that belongs to a sibling is
  the sibling's — do it in its turn, not here.
- Close it when its own checklist is done, even if the story is not. Its status
  is how the story reports progress.
- If it has stopped, flag it — `lpm flag <%= issue.id %> --comment "..."` — so the
  story it belongs to does not sit silently half-finished.
- Note anything the next step needs to know on <%= issue.id %> while it is fresh,
  and list the files you touched with
  `lpm set <%= issue.id %> --related <path>`: the next step reads them in its brief.
