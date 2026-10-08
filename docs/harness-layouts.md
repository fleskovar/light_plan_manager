# Harness layouts — where each AI coding host keeps its config

`lpm agent` installs the same three things — agent definitions, skills and an MCP
server entry — into projects driven by different agentic hosts. Each host wants
them in a different place, under a different file name, with different
frontmatter.

This document records **what each host's layout actually is, and where that came
from**, so the next person to add a target does not have to re-derive it. It is
the file to read before touching
[`assets/harnesses/`](../assets/harnesses), and the file to update after.

Nothing about a layout lives in code. The assets are a neutral tree and each
harness is one declarative YAML mapping — see
[The mapping format](#the-mapping-format).

- [Sources](#sources)
- [Claude Code](#claude-code)
- [GitHub Copilot](#github-copilot)
- [Reasonix (DeepSeek)](#reasonix-deepseek)
- [What they agree on](#what-they-agree-on)
- [How light-plan maps onto all three](#how-light-plan-maps-onto-all-three)
- [The mapping format](#the-mapping-format)
- [Adding a new harness](#adding-a-new-harness)
- [Adding a new asset](#adding-a-new-asset)
- [Packaging](#packaging)

---

## Sources

Verified 2026-08-03. Re-check before trusting any of it — this is the fastest
part of the ecosystem to move.

| Host | Document |
| --- | --- |
| Claude Code | <https://code.claude.com/docs/en/claude-directory> |
| GitHub Copilot | <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference> |
| GitHub Copilot | <https://awesome-copilot.github.com/learning-hub/copilot-configuration-basics/> |
| Reasonix | <https://github.com/esengine/DeepSeek-Reasonix/blob/main-v2/docs/GUIDE.md> |

---

## Claude Code

### Layout

| Asset | Project | User |
| --- | --- | --- |
| Subagents | `.claude/agents/<name>.md` | `~/.claude/agents/<name>.md` |
| Skills | `.claude/skills/<name>/SKILL.md` | `~/.claude/skills/<name>/SKILL.md` |
| Commands | `.claude/commands/<name>.md` | `~/.claude/commands/<name>.md` |
| MCP servers | `.mcp.json` | `~/.claude.json` |
| Settings | `.claude/settings.json`, `.claude/settings.local.json` | `~/.claude/settings.json` |
| Instructions | `CLAUDE.md`, `.claude/rules/` | `~/.claude/CLAUDE.md` |

### Frontmatter

```markdown
---
name: lpm-developer
description: When to use this agent. Claude matches on this.
tools: Read, Edit, Bash, mcp__light-plan__next_tasks
---
```

Agents are one markdown file each, run in **their own context window**, and
`tools:` restricts what they may call — a **comma-separated string**, not a list.

Skills are a **folder with a `SKILL.md`**, so reference docs, templates and
scripts can be bundled beside the prompt; the skill directory path is prepended
to `SKILL.md` so the model can read them by name. `description` is what decides
when Claude auto-invokes it. `disable-model-invocation: true` makes a skill
user-only; `user-invocable: false` hides it from the `/` menu.

### Things that catch people out

- **`.mcp.json` sits at the project root, not inside `.claude/`.** This is the
  single most common mistake.
- Skills and commands are the same mechanism now; a skill is the one to write,
  because a command cannot bundle files. If both share a name, the skill wins.
- `~/.claude.json` is a large, machine-managed file that also holds session
  state. Merge into it; never rewrite it.

---

## GitHub Copilot

Copilot has **two surfaces with different config**, and this is the trap:

- **Copilot CLI / repository customisations** — `.github/` and `~/.copilot`.
- **Copilot Chat in VS Code** — reads MCP servers from `.vscode/mcp.json` under a
  `servers` key, which the CLI does *not* read.

### Layout

| Asset | Repository | User (`$COPILOT_HOME`, default `~/.copilot`) |
| --- | --- | --- |
| Agents | `.github/agents/<name>.agent.md` | `~/.copilot/agents/<name>.agent.md` |
| Skills | `.github/skills/<name>/SKILL.md` | `~/.copilot/skills/<name>/SKILL.md` |
| Instructions | `.github/instructions/<name>.instructions.md` | `~/.copilot/instructions/<name>.instructions.md` |
| Repo-wide instructions | `.github/copilot-instructions.md` | `~/.copilot/copilot-instructions.md` |
| MCP servers | `.mcp.json` or `.github/mcp.json` | `~/.copilot/mcp-config.json` |
| Settings | `.github/copilot/settings.json`, `settings.local.json` | `~/.copilot/settings.json` |
| Hooks | `.github/hooks/` | `~/.copilot/hooks/` |

Personal skills are also discovered from `~/.agents/skills/`.

### Frontmatter

```markdown
---
name: lpm-developer
description: Terraform infrastructure-as-code specialist
tools: ['filesystem', 'terminal']
---
```

Agents take `name`, `description` and `tools` — **`tools` is a YAML list**, and
its vocabulary is Copilot's own, not Claude's.

Instructions files take `description` and **`applyTo`**, a glob deciding which
files they apply to (`'**'` for everything). Skills are a folder with `SKILL.md`
taking `name` and `description`, exactly like Claude's.

### Things that catch people out

- **`.vscode/mcp.json` uses `servers`; everything else uses `mcpServers`.** The
  CLI explicitly rejects `.vscode/mcp.json` because of that top-level key.
- Repository agents take precedence over user agents; hooks from both are loaded.
- In a monorepo, Copilot CLI walks *every* directory from the working directory
  up to the git root, so customisations layer.
- `.github/copilot/settings.json` is `model` / `effortLevel` / `contextTier` and
  deny-lists — not MCP servers.

---

## Reasonix (DeepSeek)

Reasonix is the odd one out: its main config is **TOML**, and it has **one
directory for both agents and skills**.

### Layout

| Asset | Project | User |
| --- | --- | --- |
| Skills and subagents | `.reasonix/commands/<name>.md` | `~/.reasonix/commands/<name>.md` |
| MCP servers | `.mcp.json` (standard format) | `~/.reasonix/config.toml` `[[plugins]]` |
| Config | `./reasonix.toml` | `~/.reasonix/config.toml`, `%AppData%\reasonix\config.toml` |
| Instructions | `REASONIX.md`, `AGENTS.md`, `CLAUDE.md` | — |

A file at `commands/review.md` becomes `/review`; subdirectories namespace it, so
`commands/git/commit.md` becomes `/git:commit`.

### Frontmatter

```markdown
---
description: What this does
argument-hint: <usage>
runAs: subagent
invocation: manual
---
```

**`runAs: subagent` is what makes a command a subagent profile** — there is no
separate agents directory. `invocation: manual` stops the model auto-invoking it.

### Things that catch people out

- MCP resolution order is **project `.mcp.json` → project `reasonix.toml`
  `[[plugins]]` → user `config.toml` `[[plugins]]`**, with legacy
  `~/.reasonix/config.json` (`mcpServers`) as a lowest-priority fallback.
- Config resolution is `flag > ./reasonix.toml > user config > defaults`.
- It reads `CLAUDE.md` for compatibility, so a project already set up for Claude
  Code is partly set up for Reasonix.
- The user-level MCP config is TOML. **light-plan does not write it** — this
  package has no TOML support, and merging into somebody's config file blind is a
  good way to lose it. `lpm agent --target reasonix --global` prints the
  `[[plugins]]` entry to add instead.

---

## What they agree on

Worth knowing, because it is what makes one installer possible at all:

1. **Everything is markdown with YAML frontmatter.** The body is portable; only
   the frontmatter keys differ.
2. **Two of three use `<skill-name>/SKILL.md` in a folder.** Claude and Copilot
   are identical here.
3. **All three read a project `.mcp.json` in the standard format** with a
   top-level `mcpServers` object. A project set up for all three ends up with
   **one** MCP config, not three. The lone exception is VS Code's
   `.vscode/mcp.json`, which uses `servers`.
4. **Project beats user.** All three layer a repository config over a personal
   one.
5. **A `description` drives auto-invocation** in all three. It is the single most
   important field to write well — it is matched against the task, so it should
   say *when to use this*, not what it contains.

And where they differ, ranked by how likely it is to bite:

| | Claude | Copilot | Reasonix |
| --- | --- | --- | --- |
| Agent path | `.claude/agents/*.md` | `.github/agents/*.agent.md` | `.reasonix/commands/*.md` |
| Agent marker | the directory | the `.agent.md` suffix | `runAs: subagent` |
| `tools` type | comma-separated string | YAML list | not applicable |
| Skill shape | folder + `SKILL.md` | folder + `SKILL.md` | one flat `.md` |
| User MCP | `~/.claude.json` (JSON) | `~/.copilot/mcp-config.json` (JSON) | `config.toml` (TOML) |

---

## How light-plan maps onto all three

The assets are a **neutral tree** — no harness uses it directly — and one YAML
mapping per harness rearranges it:

```
assets/
  agents/<name>.md        the canonical asset, portable frontmatter
  skills/<name>.md
  harnesses/<name>.yml    where those land, for one harness
```

The directory name is the kind. Each asset carries only what every host has
somewhere to put:

```yaml
---
name: lpm-developer
description: …            # drives auto-invocation in all three
roles: [developer]        # which `--type` wants it
tools: [Read, Edit, …]    # Claude's vocabulary; other hosts mostly ignore it
---
```

The mappings then produce, per host:

| | Claude | Copilot | Reasonix |
| --- | --- | --- | --- |
| Agent file | `.claude/agents/<n>.md` | `.github/agents/<n>.agent.md` | `.reasonix/commands/<n>.md` |
| Agent frontmatter | `name`, `description`, `tools` (joined) | `name`, `description` | `description`, `runAs: subagent` |
| Skill file | `.claude/skills/<n>/SKILL.md` | `.github/skills/<n>/SKILL.md` | `.reasonix/commands/<n>.md` |
| Skill frontmatter | `name`, `description` | `name`, `description` | `description` |
| Project MCP | `.mcp.json` | `.mcp.json` | `.mcp.json` |
| User MCP | `~/.claude.json` | `~/.copilot/mcp-config.json` | *printed, not written* |
| Pointer block | — | `.github/copilot-instructions.md` | — |

**The bodies are byte-identical everywhere.** The instructions are about
light-plan, not about who is reading them, and keeping one copy is what stops the
three drifting.

### Two deliberate omissions

- **No `tools:` on Copilot agents**, even though the docs list it as required.
  Our asset carries Claude's tool names, and an agent naming tools that do not
  exist in Copilot's vocabulary is worse off than one with the default set.
  Emitting less is the safe direction.
- **No TOML writing for Reasonix**, as above.

Both follow the same principle: **emit only fields the host documents, and only
values that are true for it.** A key a host ignores is harmless; a key it
validates and rejects takes the whole file down with it.

---

## The mapping format

One file per harness in [`assets/harnesses/`](../assets/harnesses), validated
with zod when it loads, so a malformed mapping is a message rather than a bad
install. A mapping is **a list of copy rules**: each selects files from
`assets/` with `.gitignore`-style patterns and says where they land, so any file
can go to any place. `assets/harnesses/claude.yml` in full:

```yaml
name: claude                     # must match the file name
label: Claude Code
docs: https://code.claude.com/docs/en/claude-directory
verified: 2026-08-03             # when the layout was last checked
aliases: [claude-code, cc]       # what a person might type

roots:                           # the harness's own root, per scope
  project: "{project}/.claude"
  user: "{home}/.claude"

files:
  - from: agents/*.md
    to: "{root}/agents/{basename}"
    frontmatter:                 # markdown: rewrite the frontmatter
      name: "{name}"
      description: "{description}"
      tools: "{tools|join}"

  - from: skills/*.md
    to: "{root}/skills/{name}/SKILL.md"
    frontmatter:
      name: "{name}"
      description: "{description}"

mcp:
  project: { file: "{project}/.mcp.json", key: mcpServers }
  user:    { file: "{home}/.claude.json", key: mcpServers }
```

### Fields

| Field | Meaning |
| --- | --- |
| `name` | Lower-kebab-case, and must equal the file name. |
| `label` | What the command prints. |
| `docs`, `verified` | Where the layout came from, and when it was checked. Both show in `lpm agent --list`. |
| `aliases` | Extra spellings; matched ignoring case, spaces, `-` and `_`. |
| `roots.{project,user}` | A path template, or `{env: VAR, default: "…"}` when an environment variable may move it — that is how `COPILOT_HOME` is honoured. |
| `files[]` | The copy rules, applied in order. At least one. |
| `files[].from` | One `.gitignore`-style pattern or a list of them, relative to `assets/`. |
| `files[].to` | Where each matched file lands. |
| `files[].frontmatter` | **Present**: parse the source as markdown-with-frontmatter and replace its frontmatter with this. **Absent**: copy the file byte for byte. |
| `files[].roles` | Optional: narrow the rule to `developer`, `pm`, or both. Files may also declare their own `roles:`. |
| `files[].scope` | Optional: apply only for `project` or only for `user`. |
| `mcp.{project,user}` | `file` + `key` (`mcpServers` or `servers`), or `advice` when there is no file we can safely write. |
| `pointer.{project,user}` | Optional: a markdown file the harness owns, which gets a delimited block appended rather than being written. |
| `note` | Printed after an install: anything the user should judge for themselves. |

A file may be matched by several rules — that is how one source lands in two
places. A rule that matches nothing, and a shipped file that no rule matches,
are both reported by `lpm agent`, because each is nearly always a typo.

### Selecting source files

`from` works the way a `.gitignore` does: patterns are matched against paths
relative to `assets/`, later patterns win, and a leading `!` excludes.

```yaml
from:
  - "skills/**/*.md"     # everything under skills/, at any depth
  - "!skills/_*.md"      # except the ones starting with an underscore
```

| Syntax | Matches |
| --- | --- |
| `*` | any run of characters within one path segment |
| `**` | any run of characters across segments; `a/**/b` also matches `a/b` |
| `?` | exactly one character, not `/` |
| `dir` or `dir/` | everything beneath that directory |
| `!pattern` | removes what earlier patterns selected |

Deliberately no braces and no character classes: this selects files in one small
shipped directory, and a pattern language nobody can predict is worse than one
that cannot express every case. An empty `from:` selects **nothing** rather than
everything — the harmless reading of a typo.

### Placeholders

Deliberately tiny, because a configuration format that grows a language is a
program in a bad language.

| Placeholder | Expands to |
| --- | --- |
| `{project}` | The project being installed into, absolute. |
| `{home}` | The user's home directory. |
| `{root}` | This harness's root for the chosen scope. |
| `{path}` | The source path relative to `assets/` — `agents/lpm-developer.md`. |
| `{dir}` | Its directory — `agents`. Empty at the top level. |
| `{name}` | The file name without its extension — `lpm-developer`. |
| `{basename}` | The file name with it — `lpm-developer.md`. |
| `{ext}` | The extension, no dot — `md`. |
| `{description}` | From the file's frontmatter, when it has any. |
| `{tools}` | Ditto. As a **whole frontmatter value** it stays a list; anywhere else it joins with `, `. |
| `{tools\|join}` | The list, joined with `, `. Explicit, for a `to:` or a mixed string. |

Anything else is an error naming the unknown placeholder, rather than expanding
to nothing. `{description}` and `{tools}` on a file with no frontmatter are the
same error, for the same reason.

Use `{path}` to mirror a subtree wholesale:

```yaml
- from: "templates/**"
  to: "{root}/templates/{path}"    # keeps the directory structure
```

---

## Adding a new harness

The installer is deliberately dumb: it knows how to write a file, merge a JSON
config and replace a delimited block. **No TypeScript mentions a harness by
name**, and none should start.

1. **Read the host's docs and add a section above**, with the source URL and the
   date. If a path is a guess, say so — and give the mapping a `note`, the way
   Reasonix's TOML advice does.
2. **Write `assets/harnesses/<name>.yml`.** That is the whole implementation.
3. **Check it**: `lpm agent --list` shows the rules and flags any asset kind you
   did not map; `lpm agent --target <name> --project --dry-run` shows the paths.
4. **Add a test to `test/agent.test.ts`** asserting the paths, the frontmatter,
   and that Claude's tool names did *not* leak into a host that does not use
   them.
5. **Update the table in the README.** `lpm agent --help` needs no change — it
   points at `--list`.

If you find yourself wanting to edit `mapping.ts`, `install.ts` or `assets.ts`
for one harness, the schema is missing something. Extend the schema for
everybody rather than special-casing one host.

## Adding a new asset

1. **Put the file anywhere under `assets/`.** Markdown with `name`,
   `description` and `roles` frontmatter takes part in role filtering and can
   have its frontmatter rewritten per host; anything else — a script, a JSON
   template, an image — is copied byte for byte.
2. **Add a rule to each mapping** under `files:`, or widen an existing pattern.
   A file no rule matches is not an error: it is reported, so a mapping written
   before the file existed still works.
3. **Regenerate this repository's `.claude/`**, which is generated:
   `lpm agent --target claude --project --force`.

Nothing else. The tree is walked, not enumerated, and
[`assets/README.md`](../assets/README.md) is the short version of all this.

Two names under `assets/` are reserved and never copied: `harnesses/` (the
mappings themselves) and `README.md` (the note explaining the tree), so
`from: "**"` means what a person means by it.

## Packaging

The assets are **runtime payload, not build output**: they are resolved from the
package root, never compiled into `dist/`. Three things keep them in the
published package, and all three matter:

- **`package.json`'s `files`** lists `assets` alongside `templates` and `dist`.
  Without it `npm pack` silently drops them and `lpm agent` installs nothing.
- **`make dist`** unpacks the tarball listing and checks every file under
  `assets/` and `templates/` is in it, derived from the tree rather than from a
  list — so a new agent, skill or mapping cannot be forgotten.
- **`make assets`** (part of `make verify`) runs `lpm agent --list`, which loads
  and validates every mapping. A mapping that does not parse fails the build
  rather than a user's install.

### The checklist for a layout you are unsure about

- Where do **agents** go, and what marks a file as one — a directory, a suffix,
  or a frontmatter field?
- Where do **skills** go — a flat file or a folder with `SKILL.md`?
- What is the **frontmatter contract**? Which fields are required, and is `tools`
  a string or a list?
- Where do **MCP servers** go, at project and user level, and is the top-level
  key `mcpServers` or `servers`?
- Is there a **repo-wide instructions file** worth appending a pointer to?
- Is the user-level directory **overridable by an environment variable**
  (`COPILOT_HOME` is)?
- Does the host **layer project over user**, and does it walk up directories?

### The rules the installer keeps, which a new target must not break

- **Never destroy what was there.** Add to a directory, merge a JSON config
  leaving its other keys alone, replace a delimited block in place. Only a
  byte-identical file counts as unchanged; anything else is skipped with a reason
  unless `--force`.
- **Re-running changes nothing.** Every install must be idempotent.
- **A global install must not pin one project.** The MCP entry drops `cwd`.
- **If you cannot write it safely, print it.** A `mcpAdvice` string beats a
  corrupted config file.
