<% /* ------------------------------------------------------------------------ */ %>
<% /* The brief a developer gets when they pick up a user story.                 */ %>
<% /*                                                                            */ %>
<% /* It follows the Scrum hierarchy this board declares:                        */ %>
<% /*   Program > Epic > Feature > User Story > Sub-task                         */ %>
<% /* Each ancestor type is available by its own name, and resolves to the       */ %>
<% /* nearest one above this issue — so `epic` is *this story's* epic. A story    */ %>
<% /* that has no epic simply skips the section.                                 */ %>
<% /* ------------------------------------------------------------------------ */ %>
# <%= issue.id %> — <%= issue.title %>

You are picking up a user story on the **<%= board.name %>** board. Everything
below is the context that exists for it. Read it in order: the outer levels say
why the work is wanted, the story says what "done" means, and the work log says
what has already been tried.

Status: <%= issue.status_label %><% if (issue.period) { %> · <%= issue.period.title %> (<%= issue.period.starts %> → <%= issue.period.ends %>)<% } %><% if (issue.attributes.story_points) { %> · <%= issue.attributes.story_points %> points<% } %><% if (issue.attributes.priority) { %> · priority <%= issue.attributes.priority %><% } %>

<% if (issue.flag) { %>
> **Flagged: <%= issue.flag_label %>.** Work on this story has stopped and the
> reason is in the work log below. Read it first. Clearing the flag is the plan
> owner's call — if you are picking this up because you think you can unblock
> it, say so on the issue rather than quietly restarting.

<% } %>
<% if (program) { %>
## Programme: <%= program.title %> (<%= program.id %>)

<%= heading(program.body, 3) %>

<% } %>
<% if (epic) { %>
## Epic: <%= epic.title %> (<%= epic.id %>)

<%= heading(epic.body, 3) %>

<% } %>
<% if (feature) { %>
## Feature: <%= feature.title %> (<%= feature.id %>)

<%= heading(feature.body, 3) %>

<% } %>
## The story: <%= issue.title %>

<%= heading(issue.body, 3) %>

<% if (related_files.length) { %>
## Files this story is about

Open these before writing anything: they are the requirement it was written from
and the code it expects to change. A reference may carry a line range, and it may
name a file that does not exist yet — that is often exactly what the story is
asking you to create.

<% for (const ref of related_files) { %>
- `<%= ref %>`
<% } %>

If you end up changing something that is not on this list, add it with
`lpm set <%= issue.id %> --related <path>` before you hand the story back. The
next person to touch that code finds it through this issue.

<% } %>
<% if (children.length) { %>
## Sub-tasks

The story is already broken down, and **all of this is yours**: the board hands
out the story, not its steps, so nobody else is going to pick one of these up.
Work through them in order; they are the definition of done in practice.

<% for (const task of children) { %>
### <%= task.title %> (<%= task.id %> · <%= task.status_label %>)

<%= heading(task.body, 4) %>

<% } %>
<% } %>
<% if (blocked_by.length) { %>
## Where this comes from

The work this story was sequenced after — the history you are continuing. A
finished one is something to build on: read it rather than re-deriving what it
decided. An unfinished one is a reason to ask, not a reason to guess.

<% for (const blocker of blocked_by) { %>
- **<%= blocker.id %>** <%= blocker.title %> — <%= blocker.status_label %><% if (blocker.done) { %> (done: build on this)<% } else { %> (**not finished**)<% } %>
<% } %>

<% } %>
<% if (upstream_files.length) { %>
### What that work touched

The files the issues above named. Anything here that also appears in this story's
own list is code you are about to change a second time — read what was done to it
before you change it again.

<% for (const trail of upstream_files) { %>
- **<%= trail.issue.id %>**: <%= join(trail.files, ", ") %>
<% } %>

<% } %>
<% if (blocks.length) { %>
## Where this is going

The work sequenced after this story. This is what you are building *towards*:
what you leave behind has to be something these can be built on, so a shortcut
that closes this story and blocks one of them has not finished the job.

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

- Satisfy the acceptance criteria above, not an adjacent interpretation of them.
<% if (children.length) { %>
- Finish **every** sub-task listed above before you close the story. They are
  steps in one job rather than separate tickets, so closing the story with one
  of them still open leaves work nobody will ever be offered again.
<% } %>
- If the story does not say enough to build from, comment on <%= issue.id %> with
  the precise question and leave it — a returned ticket beats an invented
  requirement.
- If the work **stops** — you need a decision, an access you do not have, or
  something outside this story has to happen first — flag it rather than leaving
  it open in progress:
  `lpm flag <%= issue.id %> --reason blocked|help --comment "what stopped, what would resolve it"`.
  It stays assigned to you and turns red on the board so the plan owner sees it.
- Record the files you actually touched with
  `lpm set <%= issue.id %> --related <path>`, so the next story that touches them
  arrives with this one in its brief.
- Put work you discover on the board rather than absorbing it silently.
- Leave a handover note on <%= issue.id %> saying what changed, why, what you
  rejected and how you verified it.
