# Changelog

## 0.4.0: OpenCode support

- **New OpenCode adapter** (`scripts/opencode.js`, plugin entry `opencode/kload.js`).
  Install it by symlinking the plugin into `~/.config/opencode/plugins/`. There is no build
  step. See [opencode/README.md](opencode/README.md).
- **Shared agents run natively in OpenCode.** At startup, every agent in kload's
  agent roots is registered as an OpenCode subagent, with nothing copied into
  OpenCode's folders. The Claude model is dropped so the subagent inherits the
  caller's model, `max_turns` becomes `steps`, and whitelists of Claude built-in
  tools become OpenCode `permission` deny rules. Agents and built-ins already
  defined in OpenCode are never replaced.
- **Per-agent OpenCode settings.** Set them under `runtimes: opencode:` in the shared
  definition (`model`, `variant`, `temperature`, `top_p`, `steps`), or in
  `agentDefaults`/`agentOverrides` in `~/.config/opencode/kload.json` or
  `.opencode/kload.json`.
- **Knowledge delivery on agent spawn.** Each `task` call, whether from `@name` or
  from model delegation, has the complete knowledge prepended to the child's
  prompt, with SHA-256 begin/end markers. A definition edited mid-session sends
  its current instructions too.
- **Knowledge delivery on skill load.** The loaded body is replaced with the current
  source and its complete knowledge. That includes stale Codex views in
  `~/.agents/skills`, which OpenCode discovers ahead of `~/.claude/skills`.
- **Missing files block the call.** Missing, unreadable, empty, invalid-UTF-8 or
  oversized knowledge blocks the `task` or `skill` call and gives the reason.
  Anything that declares nothing is never touched.
- **Load report.** It shows as a toast listing each file, with ` · kload N/N`
  appended to the task title and to the `Loaded skill:` line. Receipts are
  written to `~/.local/share/opencode/kload/receipts.jsonl`.
- README: OpenCode install and usage directions.
- Tests: `test/opencode.test.js`.
- The Claude and Codex adapters are unchanged. Their manifests move to 0.4.0 so
  the three adapters share one release version.

Earlier versions: see the git history.
