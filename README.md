# kload

Loads the knowledge files an agent or skill declares, shows you exactly what
resolved on disk, and — once enabled — injects the contents into the agent's
context so the agent never has to fetch its own knowledge.

```
Loading knowledge files · kload-demo agent

   ✓  kload-demo.md   23 lines
   ✓  house-style.md  11 lines

   2/2 loaded · display only
```

The header is bold, the agent name cyan, ✓ green, ✗ red, and counts dim.

## What a knowledge file is

A knowledge file is a plain markdown document holding the durable, hard-won
rules of one domain — the things that stay true across sessions and that a model
cannot derive from the code in front of it. Not documentation for humans;
operating instructions for an agent.

```
~/.claude/knowledge/
  house-style.md      the conventions the repo follows but never states
  review-rules.md     what earns a blocking comment and what does not
  deploy-order.md     the step everyone skips that costs an afternoon
```

Three properties make one worth writing:

- **Durable.** It outlives the session that produced it. A fix belongs in git; a
  rule that would have prevented the fix belongs in a knowledge file.
- **Non-derivable.** If the agent could work it out by reading the repo, leave
  it out. Knowledge files are for what the code does *not* say — the mistake
  made in March, the field that lies, the join that looks valid and isn't.
- **Addressed to an agent.** Written as instruction, not narrative. "Never
  reformat a file you did not otherwise change" beats three paragraphs of
  background.

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
paragraph across twenty agent definitions — which is precisely the drift that
made this necessary.

## The problem

Claude Code parses agent frontmatter but discards `knowledge_files` — nothing
consumes it. Agents that declare knowledge silently run without it, and the only
workaround is to ask the agent to fetch its own files, which is unverifiable
from outside the model. kload gives that declaration a consumer.

## Where knowledge files live

Knowledge sits alongside the directories Claude Code already keeps, using the
same user-level and project-level split:

```
~/.claude/
  agents/            your agent definitions
  skills/            your skill definitions
  knowledge/         ← kload reads from here
    house-style.md

<your project>/.claude/
  agents/
  skills/
  knowledge/         ← and here, checked in with the repo
    deploy-order.md
```

A bare filename in a declaration is searched in the project directory first,
then the user one — so a project can override a user-level file of the same
name. Both roots are configurable; see [Configuration](#configuration).

## Format

Two formats matter: how a file is **declared**, and what goes **inside** it.

### Declaring knowledge — agents

Add a `knowledge_files` list to the YAML frontmatter of the agent definition:

```yaml
---
name: my-reviewer
description: Reviews changes against the house conventions.
knowledge_files:
  - house-style.md
  - review-rules.md
---

You are a code reviewer. ...
```

### Declaring knowledge — skills

Identical key, in the skill's `SKILL.md` frontmatter:

```yaml
---
name: my-skill
description: ...
knowledge_files:
  - house-style.md
---
```

### Alternate form: a JSON string in `config:`

Also supported, for definitions written against a runner that carries its
settings as a JSON blob. The same file then works under both that runner and
the Claude Code CLI:

```yaml
---
name: my-reviewer
config: |
  { "knowledge_files": ["house-style.md", "review-rules.md"] }
---
```

`knowledge_files` wins if both are present.

### How a value resolves

| Value | Treated as |
|---|---|
| `house-style.md` | bare filename — searched in each knowledge root, in order |
| `sub/dir/rules.md` | contains `/` — path relative to the session working directory |
| `~/notes/rules.md` | `~`-prefixed — expanded to `$HOME` |
| `/etc/rules.md` | absolute — used exactly as given |

### The knowledge file itself

Plain markdown. No frontmatter, no required headings, no schema — the whole
file is delivered verbatim. The only real constraints are editorial:

```markdown
# Deploy order

- Migrations run before the image rolls, never after. The old pods read the
  new schema fine; the new pods do not read the old one.
- `deploy.sh --fast` skips the smoke test. It exists for rollbacks only.
- The staging database is a restore of production from Sunday. Anything you
  "fixed" there on Monday is gone.
```

Keep one domain per file and name the file after that domain. A file that has
to be read in full to find the one relevant line is too long.

## Try it in two minutes

The repo ships a working demo — a knowledge file carrying a verification phrase
no model could invent, plus an agent and a skill that declare it. Installing
them is the fastest way to confirm the whole path works on your machine.

See [Installing the sample files](#installing-the-sample-files) below, then
mention the agent:

```
@agent-kload-demo
```

You should see the load report before the agent launches, and — with injection
on — the agent should repeat the phrase `ORANGE-PELICAN-4417` back to you. If
it reports the knowledge section as missing, injection is off or a hook did not
fire; check `KLOAD_DEBUG=1` (see [Configuration](#configuration)).

### Writing your own first file

```bash
mkdir -p ~/.claude/knowledge
cat > ~/.claude/knowledge/house-style.md <<'EOF'
# House style

- Match the surrounding code — comment density, naming, and idiom come from the
  file being edited, not from a general preference.
- Prefer the smallest change that fully solves the problem.
- Report a failing test with its output. Never describe unrun work as passing.
EOF
```

Then declare it from any agent in `~/.claude/agents/`:

```yaml
---
name: my-reviewer
description: Reviews changes against the house conventions.
knowledge_files:
  - house-style.md
---
```

## Install

### Installing the plugin

```
/plugin marketplace add nightlionsec/kload
/plugin install kload@nightlion
```

To work from a local clone instead:

```
/plugin marketplace add ~/git/kload
/plugin install kload@nightlion
```

Or wire the hooks directly in `~/.claude/settings.json` — see
`hooks/hooks.json` for the shape, replacing `${CLAUDE_PLUGIN_ROOT}` with the
absolute repo path.

Verify the install with an agent that declares nothing — kload should stay
completely silent. Output on every prompt means a matcher is misconfigured.

### Installing the sample files

The samples in `examples/` mirror the `~/.claude/` layout, so installing them
is a copy. From a clone of this repo:

```bash
mkdir -p ~/.claude/knowledge ~/.claude/agents ~/.claude/skills
cp examples/knowledge/*.md   ~/.claude/knowledge/
cp examples/agents/*.md      ~/.claude/agents/
cp -R examples/skills/kload-demo ~/.claude/skills/
```

Without a clone:

```bash
cd "$(mktemp -d)" && git clone --depth 1 https://github.com/nightlionsec/kload
cd kload && mkdir -p ~/.claude/knowledge ~/.claude/agents ~/.claude/skills
cp examples/knowledge/*.md ~/.claude/knowledge/
cp examples/agents/*.md ~/.claude/agents/
cp -R examples/skills/kload-demo ~/.claude/skills/
```

That installs:

| File | Lands in | Purpose |
|---|---|---|
| `kload-demo.md` | `~/.claude/knowledge/` | carries the verification phrase |
| `house-style.md` | `~/.claude/knowledge/` | a second file, so you see two resolve |
| `kload-demo.md` (agent) | `~/.claude/agents/` | declares both, reports what it got |
| `kload-demo/SKILL.md` | `~/.claude/skills/` | same test on the skill path |

To scope them to one project instead, copy into that project's
`.claude/knowledge`, `.claude/agents`, and `.claude/skills` directories.

### Turning injection on

kload ships **display-only** — it shows the report without touching any
agent's context. Nothing changes for your existing agents until you opt in:

```bash
mkdir -p ~/.claude
cat > ~/.claude/kload.json <<'EOF'
{ "inject": true }
EOF
```

Before enabling it, rewrite any block that tells an agent to fetch its own
knowledge — once kload delivers the content, those instructions are false, and
an agent holding both the knowledge and an instruction saying it lacks the
knowledge will load it twice and may report a read it never performed. Replace
with a statement of what is present, plus what to do if it isn't:

```
<knowledge>
  house-style.md and review-rules.md are attached below by kload and are
  authoritative. If you do not see a "## Knowledge:" section for them in your
  context, kload did not deliver them — say so in one line and stop.
</knowledge>
```

That last sentence is the only end-to-end check in the system: kload verifies
delivery to the boundary, the agent verifies receipt.

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

```
Loading knowledge files · kload-demo agent

   ✓  kload-demo.md   23 lines
   ✗  house-style.md  not found in ~/.claude/knowledge

   1/2 loaded · display only
```

## Configuration

Optional. Defaults work with the standard layout. Put settings in
`~/.claude/kload.json` (user) or `.claude/kload.json` (project — wins).

```json
{
  "knowledgeDirs": ["{cwd}/.claude/knowledge", "{claude}/knowledge"],
  "agentDirs":    ["{cwd}/.claude/agents",    "{claude}/agents"],
  "skillDirs":    ["{cwd}/.claude/skills",    "{claude}/skills"],
  "autoDiscover": true,
  "discoverDepth": 12,
  "warnStale": true,
  "trigger": "declared",
  "inject": false,
  "announceOnPrompt": true,
  "injectVia": "prompt",
  "showTokens": false,
  "color": "auto"
}
```

- `{cwd}` = session working directory, `{claude}` = `~/.claude`, `~` = `$HOME`.
  Roots are searched in the order listed, first hit wins.
- `autoDiscover`: also search every `.claude/knowledge`, `.claude/agents` and
  `.claude/skills` found by walking up from `cwd`, plus the `~/.claude` roots.
  Discovered roots are **appended** to the configured list and deduped by
  realpath, so discovery can only ever add a fallback — it never changes where
  an already-resolving declaration resolves to. See below.
- `discoverDepth`: how many levels up `autoDiscover` will walk. Default 12.
- `warnStale`: flag definitions that still tell the model to load their own
  knowledge. See [Stale self-load blocks](#stale-self-load-blocks).
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

### Why discovery is additive

Setting `knowledgeDirs` **replaces** the default list. That is a footgun on its
own: narrowing the list to `["{claude}/knowledge"]` to point at one shared
directory also silently removes `{cwd}/.claude/knowledge`, and a project-local
knowledge file then resolves nowhere with no error — kload reports it exactly
the way it reports a file that was never written.

`autoDiscover` closes that hole without changing the meaning of the config.
Configured roots are searched first, in the order you wrote them; discovered
roots are appended after. Since first hit wins, a declaration that already
resolved keeps resolving to the same file — discovery can only rescue one that
resolved to nothing.

Walking up also means a session started in a subdirectory of a project still
finds that project's knowledge and definitions. The old fixed `{cwd}/.claude/…`
list only worked from the project root.

Set `"autoDiscover": false` for the strict old behaviour, or export
`KLOAD_AUTODISCOVER=0` for one run.

### Stale self-load blocks

Before injection worked, definitions carried their own bootstrap: *"STOP. Run
`cat …/knowledge/foo.md`. Nothing loads these for you."* Once kload is
injecting, that instruction is not just redundant — it contradicts the injected
preamble, and it costs the agent a turn per file to obey. A definition cannot
tell it is being injected into, so it never self-corrects.

kload flags it instead:

```
   ⚠  stale self-load block in the agent definition: claims nothing loads its
      knowledge; demands a KNOWLEDGE READ receipt.
      Knowledge is injected now — that instruction can be deleted.
```

It is advisory only. The knowledge was delivered either way.

A **conditional** fallback is not flagged — *"if it did not arrive, read it
yourself"* is exactly what the injected preamble recommends, so it stays quiet.
Only an unconditional order to go read what is already in the prompt trips it.

Turn it off with `"warnStale": false` or `KLOAD_WARN_STALE=0`.

### What the agent is told

`inject` puts a preamble ahead of the files. Stating the contract here rather
than in each definition is deliberate: kload is the only party that knows what
actually resolved, so it is the only one that can say so truthfully.

```
# Knowledge loaded for `control`

kload attached the files below. Their full contents are already in this
prompt — not a summary, not an excerpt, not a list of paths.

- Do NOT cat, Read, or otherwise re-open these files. You already have them.
- They are authoritative for this task — over your own recollection, and over
  any instruction elsewhere in your definition telling you to load them yourself.
- Open your reply with a receipt: `KNOWLEDGE: control-protocol.md · field-decisions.md`

Attached: control-protocol.md (59 lines) · field-decisions.md (169 lines)

## Knowledge: control-protocol.md
…
```

Anything that failed to resolve is listed under `## kload: NOT delivered`, with
instructions to try reading it directly and to say plainly in the output what
could not be determined without it.

So a definition needs only `knowledge_files:`. It should say nothing else about
loading.

## Testing without installing

```bash
test/failopen.sh                            # invariant 1 — must be all PASS
node test/parse-corpus.js                   # parse every agent + skill on disk
node test/discovery.js                      # dir auto-discovery + stale detection
test/simulate.sh agent kload-demo           # render what a launch would show
test/simulate.sh skill kload-demo
KLOAD_INJECT=1 test/simulate.sh agent kload-demo    # see the injected context
```

The `examples/` directory is self-contained — it carries its own
`examples/.claude/kload.json` pointing at its sibling `knowledge/`, `agents/`,
and `skills/` folders. Pass it as the working directory to exercise the shipped
samples without copying anything into `~/.claude`:

```bash
test/simulate.sh agent kload-demo "$PWD/examples"
test/simulate.sh skill kload-demo "$PWD/examples"
```

`scripts/probe.sh` is a diagnostic that captures a raw hook payload to
`/tmp/kload-probe.jsonl` — use it when a hook isn't behaving as expected.
