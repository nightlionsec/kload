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

## What a knowledge file is

A knowledge file is a plain markdown document holding the durable, hard-won
rules of one domain — the things that stay true across sessions and that a model
cannot derive from the code in front of it. Not documentation for humans;
operating instructions for an agent.

```
~/.claude/knowledge/
  field-decisions.md     which columns are PII and which get dropped
  merge-quality.md       what makes a join key trustworthy
  catalog.md             resolve datasets in the catalog before searching
```

Three properties make one worth writing:

- **Durable.** It outlives the session that produced it. A fix belongs in git; a
  rule that would have prevented the fix belongs in a knowledge file.
- **Non-derivable.** If the agent could work it out by reading the repo, leave
  it out. Knowledge files are for what the code does *not* say — the mistake
  made in March, the field that lies, the join that looks valid and isn't.
- **Addressed to an agent.** Written as instruction, not narrative. "Scope by
  `breach`, never by `country` — `country` is un-normalised on the raw path"
  beats three paragraphs of background.

### Why this is worth a plugin

An agent definition is a job description. A knowledge file is the training the
job assumes. Without a mechanism, every agent starts its first day having read
neither — and the usual workaround, telling the agent to fetch its own files,
is unverifiable from outside the model: it may read them, skim them, or claim
to and not. You cannot audit an instruction; you can audit a delivery.

Andrej Karpathy's framing of an LLM as an operating system is the useful lens
here — the model as CPU, the context window as RAM, and everything else as
storage that must be explicitly paged in to be usable at all. Nothing in
storage affects the computation until something loads it. Knowledge files are
the pages; kload is the loader. The agent stops being responsible for fetching
its own memory, which is the part it was never able to do reliably.

(That analogy is Karpathy's; the file convention here is not his — it is a
local one, and the correspondence is a borrowed lens, not a cited standard.)

The economics follow: one file, written once, read by every agent that declares
it. Fixing a rule means editing one document rather than hunting the same
paragraph across twenty-two agent definitions — which is precisely the drift
that made this necessary.

## The problem

Claude Code parses agent frontmatter but discards `knowledge_files` — nothing
consumes it. Agents that declare knowledge silently run without it, and the only
workaround is to ask the agent to fetch its own files, which is unverifiable
from outside the model. kload gives that declaration a consumer.

## How it works

| Hook | Fires on | What kload does |
|---|---|---|
| `UserPromptSubmit` | every prompt | if you mentioned an agent, **show the report before it launches** |
| `PreToolUse` (`Agent`\|`Task`) | every subagent spawn | **inject** the knowledge into the subagent's prompt |
| `SubagentStart` | every subagent launch | inject via `additionalContext` — fallback only |
| `PreToolUse` (`Skill`) | every skill invocation | show the report and inject, in one step |

Each returns a `systemMessage` (what you see) and, when injection is on, the
knowledge itself (what the agent receives).

### Why it takes four hooks

Two harness behaviours force the split, and both were found the hard way:

**`SubagentStart` output arrives too late.** A subagent runs backgrounded, so
its hook's `systemMessage` only surfaces when that stream flushes — after the
agent has finished. Correct content, useless timing. `UserPromptSubmit` runs in
the foreground *before* the spawn, so that is where the report is rendered. It
fires on `@agent-name`, the picker's `@"name (agent)"`, and `/name`. When the
model spawns an agent on its own initiative there is no prompt to read it from,
and the late `SubagentStart` report is all you get.

**`additionalContext` is capped.** Anything past roughly 2KB is written to a
file and only a preview is inlined. A three-file declaration totalling 11.6KB
delivered its first file whole, truncated the second mid-document, and dropped
the third entirely — while the agent, seeing a `## Knowledge:` heading and its
marker, correctly reported the injection as present. Silent, order-dependent
loss with a confident receipt on top: the worst failure shape available.

A subagent's prompt has no such cap, so injection goes through `PreToolUse`
`updatedInput` on the spawn tool instead, and `SubagentStart` stands down —
but *only* once the spawn hook has recorded that it actually delivered. If that
matcher never fires, `SubagentStart` still injects the truncated payload.
Lossy beats silent.

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
  "announceOnPrompt": true,
  "injectVia": "prompt",
  "showTokens": false,
  "color": "auto"
}
```

- `{cwd}` = session working directory, `{claude}` = `~/.claude`, `~` = `$HOME`.
- `trigger`: `"declared"` acts on anything declaring knowledge files (default);
  `"explicit"` acts only on agents you `@agent-`mentioned in the last 10 minutes.
- `inject`: `false` shows the report without touching the agent's context.
- `announceOnPrompt`: render the report at prompt time, before the agent spawns.
  Set `false` for the old after-the-fact `SubagentStart` report.
- `injectVia`: `"prompt"` prepends the knowledge to the subagent's own prompt
  via `PreToolUse` `updatedInput` — no size cap. `"context"` uses
  `SubagentStart` `additionalContext`, which the harness truncates past ~2KB.
  Prefer `"prompt"` unless you have a reason not to.
- `showTokens`: adds a `~N tok` estimate per file and a total. Off by default —
  line counts are the signal that matters.
- `color`: `"auto"` emits ANSI unless `NO_COLOR` is set or `TERM=dumb`;
  `"never"` if your terminal shows the escape codes literally.

Env overrides: `KLOAD_KNOWLEDGE_DIRS` (colon-separated), `KLOAD_INJECT=1|0`,
`KLOAD_TRIGGER`, `KLOAD_ANNOUNCE=1|0`, `KLOAD_INJECT_VIA=prompt|context`,
`KLOAD_DEBUG=1` (appends to `~/.claude/kload-debug.log` — the fastest way to
see which hooks actually fired, and the only way to catch a matcher that never
registered).

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
