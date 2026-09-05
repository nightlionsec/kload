# kload for Codex

Run shared Claude agents and skills natively in Codex, with their declared
knowledge delivered by a Codex-side loader. No Zora service is needed.

The authored sources remain in `.claude/agents`, `.claude/skills`, and the
configured knowledge roots. Folder and file symlinks are supported. The shared
resolver is `scripts/kload.js`; `scripts/codex.js` is the Codex adapter. Claude's
existing hook configuration is unchanged.

## Build and install

Requires Node.js 18 or later; no npm dependencies or Python environment.

```bash
node scripts/build-codex.js
```

Install the resulting `dist/kload` plugin through a local Codex marketplace.
The installed bundle contains its own scripts. Do not install the repository
root as a Codex plugin: its `hooks/hooks.json` is for Claude.

For a personal marketplace whose `kload` entry uses `./plugins/kload`, point
`~/plugins/kload` at this repository's `dist/kload`, then run:

```bash
codex plugin add kload@personal
```

Review/trust the four kload hooks in `/hooks`, and start a new Codex thread.
After changing plugin code, rebuild, assign a new plugin cachebuster/version,
and reinstall. Editing authored agent/skill/knowledge files only needs refresh.

## Discovery and updates

SessionStart and UserPromptSubmit refresh generated views. Manual refresh:

```bash
node scripts/codex.js sync /path/to/project
```

User skill views and manifests live under `~/.codex/kload/generated`, with
skill symlinks in `~/.agents/skills`. Generated agent TOML is written directly
into `~/.codex/agents`: Codex 0.153.2 lists symlinked agent TOML but rejects it
at launch. These files are generated adapters, never separately authored agents.
Project skill views live under
`<project>/.codex/kload/generated`, with project-local registrations. Project
scopes are directories containing `.claude`, `.codex/kload.json`, or native
agent/skill registration folders; their views
use the same ordered discovery/resolution rules as kload. Nested invocation
discovers ancestor project scopes. Independent projects do not overwrite each
other's generated files.

Generated skill files contain instructions and complete knowledge as a fallback.
Supporting scripts/assets remain symlinks to the source skill folder. Generated
agent TOML carries the source pointer and Codex runtime settings; the child hook
loads the current instruction body, avoiding a conflicting cached copy. Edit the
original source, never these disposable views. Unrelated existing registrations
are not overwritten. Deleted/invalid sources lose their owned registrations.

Changes during a turn are read again at invocation. New agent names may require
a new thread because Codex's native agent catalog is created at thread startup.
Source changes that affect agent model settings also require a fresh thread.

Invoke a skill with `$skill-name`, or ask Codex to use it. For an agent, ask
Codex to delegate to the named native agent, for example, “Use the data-review
agent to review this dataset.” Reading an agent's Markdown in the main thread
is not an agent invocation and does not trigger SubagentStart.

## Knowledge delivery

- Explicit `$skill-name`: UserPromptSubmit attaches the complete skill and its
  declared knowledge, including when the skill name is typed as plain text.
- Implicit skill use: PreToolUse recognizes a read referring to a registered
  skill's source/generated path and attaches the complete payload before the
  read. A short `head`/`sed` read therefore does not truncate the knowledge.
  Arbitrarily computed/obfuscated paths cannot be recognized; the full generated
  file remains the fallback. Skills read through unknown paths must be read in
  full, rather than claiming the invocation hook ran.
- Native agents: PreToolUse validates dependencies before `spawn_agent`.
  SubagentStart independently reads and injects into the child agent's own
  context. Parent context or session memory is not used as a substitute.
- Full payloads have beginning/end markers and SHA-256 receipts. The hooks use
  `additionalContextLimit: 0` to prevent Codex's default preview/file spilling,
  with a kload-enforced default cap of 192 KiB for the complete payload. Oversized
  inputs are rejected explicitly, never silently truncated.

Missing, unreadable, empty, invalid UTF-8, and oversized files block an explicit
skill prompt or a recognized skill/agent tool call. SubagentStart cannot cancel
a child in Codex; if a file disappears between preflight and startup, it injects
an explicit failure instruction instead. Disabling/untrusting hooks disables the
invocation guarantees. Generated views alone do not prove runtime delivery.

Selecting a skill as a native Codex skill attachment can also supply its full
generated file. The invocation hook favors reliable delivery and may duplicate
that attachment; only selected capabilities are injected, never the entire library.

`~/.codex/kload/receipts.jsonl` records source/file hashes, byte counts, channel,
session, turn, and child ID, but no knowledge contents. Receipts record what the
hook emitted, not whether the model reasoned correctly. Runtime acceptance tests
also inspect actual model requests for complete fixture contents.

## Configuration and models

Codex reuses `~/.claude/kload.json`, project `.claude/kload.json`, and the shared
resolver's environment/search-path rules. Optional `~/.codex/kload.json` and
project `.codex/kload.json` override those settings. Codex always loads required
knowledge; Claude's display-only `inject` switch and `injectVia` do not disable
the Codex delivery contract. Disable the Codex plugin to turn it off.

Example Codex-specific configuration:

```json
{
  "maxContextBytes": 196608,
  "agentDefaults": {"model": "inherit"},
  "agentOverrides": {
    "data-review": {"model_reasoning_effort": "medium"}
  }
}
```

An agent can override those defaults in its shared frontmatter:

```yaml
model: claude-opus-5
runtimes:
  codex:
    model: inherit
    model_reasoning_effort: high
```

The legacy `model` stays with Claude/Zora. `inherit` omits Codex's model key,
allowing Codex's normal spawn/default/parent selection. An explicit Codex model
must be available to that Codex installation; kload does not guess a model-family
equivalence. Settings resolve: Codex defaults, per-agent override, agent's own
`runtimes.codex`. Runtime blocks support `model` and `model_reasoning_effort`.
Other keys fail validation instead of silently applying unsafe translations.

Claude/Zora tool names, turn limits, permissions, MCP declarations, and agent
skill lists are not translated. Nonempty unsupported fields are recorded in the
generated manifest under `untranslated`; Codex inherits its native permissions
and tool configuration. Delivery parity is not execution/tool parity.

## Validation

```bash
node --test test/codex.test.js
node test/discovery.js
bash test/failopen.sh
node test/parse-corpus.js
```

The real-CLI delivery acceptance test is documented in `test/codex-runtime.py`.
It uses a local deterministic Responses fixture; no API key or external model
calls are needed, and it captures exactly what Codex sends to the model.

## Removal

Remove/disable `kload@personal`, then remove only skill symlinks pointing into
the corresponding `.codex/kload/generated` directory and agent TOML files
whose first line identifies them as generated by kload. Source definitions and
knowledge files remain untouched. Do not run this alongside the earlier
`zora-shared` prototype, which owns competing skill registrations.
