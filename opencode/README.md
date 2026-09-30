# kload for OpenCode

Run shared Claude agents and skills natively in OpenCode, with their declared
knowledge delivered by an OpenCode plugin. Nothing is copied into OpenCode's
folders.

The authored sources remain in `.claude/agents`, `.claude/skills`, and the
configured knowledge roots. The shared resolver is `scripts/kload.js`;
`scripts/opencode.js` is the OpenCode adapter and `opencode/kload.js` is the
plugin entry. Claude's and Codex's adapters are unchanged.

## Install

Requires OpenCode 1.18 or later. No npm dependencies and no build step.

```bash
mkdir -p ~/.config/opencode/plugins
ln -s ~/git/kload/opencode/kload.js ~/.config/opencode/plugins/kload.js
```

OpenCode auto-loads every `*.js` in that folder. For one project only, link it
into `<project>/.opencode/plugins/` instead. Restart OpenCode after installing
or after changing plugin code. Edits to existing agents, skills and knowledge
files take effect at the next spawn or skill load; a newly added agent needs a
restart to be registered.

Verify with:

```bash
opencode agent list          # shared agents appear as (subagent)
opencode debug agent <name>  # translated model, steps and permission
```

Do not symlink Claude agent files into `~/.config/opencode/agents/`. OpenCode
reads that frontmatter as its own: `model: claude-opus-5` becomes a provider
id with an empty model, the missing `mode` makes every agent a Tab-cycled
primary, and unknown keys are passed to the provider as options.

## Agents

OpenCode reads `.claude/skills` natively but never `.claude/agents`. The
plugin's `config` hook reads every agent in kload's agent roots and adds it to
OpenCode's live config as a native subagent:

| Claude frontmatter | OpenCode agent |
|---|---|
| body | `prompt` |
| `description` | `description` |
| — | `mode: subagent` |
| `model` | never copied; the subagent inherits the caller's model |
| `max_turns` / `maxTurns` | `steps` |
| `tools` of Claude built-ins only | `permission` denying every OpenCode tool not granted |
| `tools` naming anything else | untranslated (written for another runner) |
| `disallowedTools` | `permission` deny for the mapped tools |

An agent already defined in OpenCode (config or its agents folder), or named
like a built-in (`build`, `plan`, `general`, `explore`), is never replaced.
Definitions that fail to parse are skipped and reported in a toast when the
first session starts.

Per-agent OpenCode settings go in the shared definition, beside Codex's:

```yaml
runtimes:
  codex:
    model: gpt-daybreak-blue-latest
  opencode:
    model: alibaba/qwen3.8-max
    temperature: 0.2
```

Allowed keys: `model` (`provider/model`, or `inherit`), `variant`,
`temperature`, `top_p`, `steps`. `~/.config/opencode/kload.json` or a
project's `.opencode/kload.json` can also set `agentDefaults` and
`agentOverrides`, and only there a `permission` object:

```json
{
  "agentOverrides": {
    "data-review": { "permission": { "bash": "ask" } }
  }
}
```

Precedence: `max_turns` < `agentDefaults` < `agentOverrides` < `runtimes.opencode`.

## Knowledge delivery

- **Agents.** `@name` in a prompt makes OpenCode call its `task` tool, as does
  the model delegating on its own, so one hook covers both.
  `tool.execute.before` re-reads the declared files and prepends them to the
  child's prompt, with no size cap other than `maxContextBytes`. If the
  definition changed since registration, its current instructions are sent too
  and supersede the registered prompt. A resumed child (`task_id`) gets
  nothing new.
- **Skills.** `tool.execute.before` preflights the declared files.
  `tool.execute.after` replaces the body OpenCode loaded with the current
  source and its complete knowledge, keeping OpenCode's base directory and file
  list. OpenCode discovers `~/.agents/skills` (Codex's generated views) ahead
  of `~/.claude/skills`, so a skill often loads from a Codex view only as fresh
  as Codex's last refresh. kload replaces that too, even for skills without
  knowledge.

Payloads use the Codex format: beginning and end markers per file with SHA-256
and byte counts, and a `KNOWLEDGE:` receipt line the model is told to open
with. `~/.local/share/opencode/kload/receipts.jsonl` records hashes, byte counts,
session and call IDs, but no knowledge contents.

Missing, unreadable, empty, invalid UTF-8 and oversized files block the `task`
or `skill` call with the reason, which the model sees as the tool error. An
agent or skill that declares nothing is never touched, and an internal kload
error never blocks an unrelated tool.

## What you see

OpenCode has no equivalent of Claude's `systemMessage` panel. kload uses every
surface it has:

- a toast listing each file and its line count when an agent spawns or a skill
  loads (a warning toast when the definition still tells the model to load its
  own knowledge, an error toast when delivery is blocked)
- ` · kload 3/3` appended to the task's title, visible while the agent runs
- ` · kload 3/3` appended to the `Loaded skill:` line

Toasts need the TUI. Under `opencode run` only the titles and receipts show.

## Configuration

OpenCode reuses `~/.claude/kload.json`, project `.claude/kload.json`, and the
shared resolver's environment and search-path rules. `~/.config/opencode/kload.json`
and project `.opencode/kload.json` override those, and `{opencode}` expands to
the OpenCode config directory. As with Codex, OpenCode always delivers:
Claude's display-only `inject` switch does not apply. Remove the plugin link to
turn it off.

## Tests

```bash
node --test test/opencode.test.js
```
