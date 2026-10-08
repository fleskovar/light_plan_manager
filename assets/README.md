# `assets/` — the canonical tree, and where it lands

Everything `lpm agent` installs lives here, in a **neutral filesystem that no
harness uses directly**. One YAML mapping per harness says how to rearrange it.

```
assets/
  agents/<name>.md        an agent definition, portable frontmatter
  skills/<name>.md        a skill, portable frontmatter
  <anything>/...          any file at all — scripts, JSON, templates
  harnesses/<name>.yml    where all of the above lands, for one harness
  hcm/<name>.yml          the same, for one hcm bundle (`lpm hcm init`)
```

Nothing in the code knows what an "agent" or a "skill" is. The tree is walked,
not enumerated, and each mapping selects what it wants with `.gitignore`-style
patterns. **Adding an asset is a file; adding a harness is a file.**

Three names are reserved and never copied: `harnesses/`, `hcm/` and this
`README.md`. A file in `hcm/` is a bundle mapping — the same copy rules, plus
the hcm manifest fields — and a folder beside it (`hcm/light-plan/`) holds the
files only that bundle carries, such as its MCP server file, copied as they are;
see [`docs/hcm.md`](../docs/hcm.md).

## Adding an asset

Markdown takes part in role filtering and can have its frontmatter rewritten for
each host:

```markdown
---
name: lpm-delivery        # must match the file name
description: …            # one line; drives auto-invocation in every harness
roles: [developer]        # which `--type` wants it; omit for all roles
tools: [Read, Bash, …]    # optional; Claude's vocabulary, ignored elsewhere
---

The body, which is copied to every harness verbatim.
```

Anything else — a shell script, a JSON template, an image — is copied byte for
byte by any rule that has no `frontmatter:`. Write bodies for *any* reader: they
are about light-plan, not about who is reading them. That is what keeps one copy
instead of three.

Then add a rule to each mapping (or widen a pattern), and regenerate this
repository's own `.claude/`, which is generated:

```bash
lpm agent --target claude --project --force
```

## Adding a harness

One file in `harnesses/`. The full schema, the pattern syntax, the placeholder
list and the per-harness research are in
[`docs/harness-layouts.md`](../docs/harness-layouts.md); the short version:

```yaml
name: claude              # must match the file name
label: Claude Code
docs: https://…           # where the layout came from
verified: 2026-08-03      # when you last checked it
aliases: [claude-code, cc]

roots:
  project: "{project}/.claude"
  user: "{home}/.claude"

files:
  # Markdown, with the frontmatter this host understands.
  - from: agents/*.md
    to: "{root}/agents/{basename}"
    frontmatter:
      name: "{name}"
      description: "{description}"
      tools: "{tools|join}"

  # A folder per skill.
  - from: skills/*.md
    to: "{root}/skills/{name}/SKILL.md"
    frontmatter:
      name: "{name}"
      description: "{description}"

  # No `frontmatter:` — copied byte for byte, structure preserved.
  - from: "scripts/**"
    to: "{root}/scripts/{path}"

mcp:
  project: { file: "{project}/.mcp.json", key: mcpServers }
  user:    { file: "{home}/.claude.json", key: mcpServers }

pointer:                  # optional: a file the harness owns, appended to
  project: "{root}/copilot-instructions.md"

note: "Anything the user should judge for themselves."
```

Patterns follow `.gitignore`: `*` within a segment, `**` across them, `?` for
one character, a bare directory for everything beneath it, and `!` to exclude —
later patterns win. Placeholders are `{project} {home} {root} {path} {dir}
{name} {basename} {ext} {description} {tools}`.

Check your work with:

```bash
lpm agent --list                            # every file, and every rule
lpm agent --target <name> --project --dry-run
```

Both report a rule that matches nothing and a file no rule matches — each is
nearly always a typo.
