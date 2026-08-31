# kload

Loads the knowledge files an agent or skill declares, shows you exactly what
resolved on disk, and — once enabled — injects the contents into the agent's
context so the agent never has to fetch its own knowledge.

```
Loading knowledge files · data-review agent

   ✓  profiling-method.md  275 lines
   ✓  field-decisions.md   169 lines
   ✗  bak-extract.md       not found

   2/3 loaded · from ~/git/zora/knowledge · display only
```

The header is bold, the agent name cyan, ✓ green, ✗ red, and counts dim.

## The problem

Claude Code parses agent frontmatter but discards `knowledge_files` — nothing
consumes it. Agents that declare knowledge silently run without it, and the only
workaround is to ask the agent to fetch its own files, which is unverifiable
from outside the model. kload gives that declaration a consumer.

## How it works

| Hook | Fires on | What kload does |
|---|---|---|
| `SubagentStart` | every subagent launch | resolve `agent_type` → definition → knowledge files |
| `PreToolUse` (`Skill`) | every skill invocation | resolve skill name → `SKILL.md` → knowledge files |
| `UserPromptSubmit` | every prompt | records `@agent-*` mentions (only used by `trigger: "explicit"`) |

Both hooks return a `systemMessage` (what you see) and, when injection is on,
`hookSpecificOutput.additionalContext` (what the agent receives).

## Design invariants

1. **Fail open.** Any error — missing file, corrupt YAML, bad JSON, no stdin —
   exits 0 with no output. An agent launch is never affected by kload failing.
   Enforced by `test/failopen.sh`.
2. **Read once.** The checkmark you see and the bytes the agent receives come
   from the same `readFileSync`. A green check can never mean "the file exists" —
   it means the content was read and delivered.
3. **Silence.** No declaration, no output. Built-in agents (`Explore`,
   `general-purpose`) and plugin skills declare nothing, so they stay quiet
   without any special-casing.

## Declaring knowledge

Preferred — a first-class YAML key:

```yaml
---
name: data-review
knowledge_files:
  - field-decisions.md
  - merge-quality.md
---
```

Also supported — the Zora shape, a JSON string in `config:`, so the same
definition works under both the Zora runner and the CLI:

```yaml
---
name: data-review
config: |
  { "knowledge_files": ["field-decisions.md", "merge-quality.md"] }
---
```

Bare filenames are searched in the knowledge roots. A value containing `/`, or
starting with `/` or `~`, is used as an exact path instead.

## Statuses

| Mark | Status | Meaning |
|---|---|---|
| ✓ | `ok` | read, non-empty, delivered |
| ✗ | `missing` | not found in any knowledge root |
| ✗ | `broken symlink` | the link exists, its target does not |
| ✗ | `empty` | resolved but has no content — a delivery failure |
| ✗ | `unreadable` | permissions, or it's a directory |

A ✗ never blocks the launch. The agent runs without that file and, when
injection is on, is told in-context which files were unavailable.

## Configuration

Optional. Defaults work with the standard layout. Put settings in
`~/.claude/kload.json` (user) or `.claude/kload.json` (project — wins).

```json
{
  "knowledgeDirs": ["{cwd}/.claude/knowledge", "{claude}/knowledge"],
  "agentDirs":    ["{cwd}/.claude/agents",    "{claude}/agents"],
  "skillDirs":    ["{cwd}/.claude/skills",    "{claude}/skills"],
  "trigger": "declared",
  "inject": false,
  "showTokens": false,
  "color": "auto"
}
```

- `{cwd}` = session working directory, `{claude}` = `~/.claude`, `~` = `$HOME`.
- `trigger`: `"declared"` acts on anything declaring knowledge files (default);
  `"explicit"` acts only on agents you `@agent-`mentioned in the last 10 minutes.
- `inject`: `false` shows the report without touching the agent's context.
- `showTokens`: adds a `~N tok` estimate per file and a total. Off by default —
  line counts are the signal that matters.
- `color`: `"auto"` emits ANSI unless `NO_COLOR` is set or `TERM=dumb`;
  `"never"` if your terminal shows the escape codes literally.

Env overrides: `KLOAD_KNOWLEDGE_DIRS` (colon-separated), `KLOAD_INJECT=1|0`,
`KLOAD_TRIGGER`, `KLOAD_DEBUG=1` (appends to `~/.claude/kload-debug.log`).

## Install

As a plugin:

```
/plugin marketplace add ~/git/kload
/plugin install kload@nightlion
```

Or wire the hooks directly in `~/.claude/settings.json` — see
`hooks/hooks.json` for the shape, replacing `${CLAUDE_PLUGIN_ROOT}` with the
absolute repo path.

## Testing without installing

```bash
test/failopen.sh                          # invariant 1 — must be all PASS
node test/parse-corpus.js                 # parse every agent + skill on disk
test/simulate.sh agent data-review        # render what a launch would show
test/simulate.sh skill es-field-mapper
KLOAD_INJECT=1 test/simulate.sh agent data-review   # see the injected context
```

`scripts/probe.sh` is a diagnostic that captures a raw hook payload to
`/tmp/kload-probe.jsonl` — use it when a hook isn't behaving as expected.

## Turning injection on

Injection is built and off by default. Before enabling it, rewrite any
`<load_first>`-style block that tells the agent to fetch its own knowledge —
once kload delivers the content, those instructions are false, and an agent
holding both the knowledge and an instruction saying it lacks the knowledge will
load it twice and may report a read it never performed. Replace with a statement
of what is present, plus what to do if it isn't:

```
<knowledge>
  field-decisions.md and merge-quality.md are attached below by kload and are
  authoritative. If you do not see a "## Knowledge:" section for them in your
  context, kload did not deliver them — say so in one line and stop.
</knowledge>
```

That last sentence is the only end-to-end check in the system: kload verifies
delivery to the boundary, the agent verifies receipt.
