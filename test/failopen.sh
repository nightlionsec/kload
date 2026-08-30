#!/usr/bin/env bash
# INVARIANT 1: every one of these must print nothing and exit 0.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/.claude/agents" "$TMP/.claude/knowledge"

check() {
  local label="$1"; shift
  local out rc
  out=$(printf '%s' "$1" | node "$ROOT/scripts/kload.js" 2>&1); rc=$?
  if [ $rc -ne 0 ]; then echo "FAIL  $label — exit $rc"; return 1; fi
  if [ -n "$out" ]; then echo "FAIL  $label — produced output: ${out:0:120}"; return 1; fi
  echo "PASS  $label"
}

printf 'not yaml at all\n---\n[[[\n' > "$TMP/.claude/agents/broken.md"
printf -- '---\nname: nokb\n---\nbody\n' > "$TMP/.claude/agents/nokb.md"
printf -- '---\nname: badjson\nconfig: |\n  { not json,,, }\n---\nbody\n' > "$TMP/.claude/agents/badjson.md"

FAILED=0
check "empty stdin"          '' || FAILED=1
check "non-JSON stdin"       'garbage not json' || FAILED=1
check "unknown event"        '{"hook_event_name":"Nonsense"}' || FAILED=1
check "agent not on disk"    "{\"cwd\":\"$TMP\",\"hook_event_name\":\"SubagentStart\",\"agent_type\":\"does-not-exist\"}" || FAILED=1
check "built-in agent"       "{\"cwd\":\"$TMP\",\"hook_event_name\":\"SubagentStart\",\"agent_type\":\"Explore\"}" || FAILED=1
check "corrupt frontmatter"  "{\"cwd\":\"$TMP\",\"hook_event_name\":\"SubagentStart\",\"agent_type\":\"broken\"}" || FAILED=1
check "declares nothing"     "{\"cwd\":\"$TMP\",\"hook_event_name\":\"SubagentStart\",\"agent_type\":\"nokb\"}" || FAILED=1
check "malformed config JSON" "{\"cwd\":\"$TMP\",\"hook_event_name\":\"SubagentStart\",\"agent_type\":\"badjson\"}" || FAILED=1
check "plugin skill"         "{\"cwd\":\"$TMP\",\"hook_event_name\":\"PreToolUse\",\"tool_name\":\"Skill\",\"tool_input\":{\"skill\":\"claude-mem:make-plan\"}}" || FAILED=1
check "path traversal"       "{\"cwd\":\"$TMP\",\"hook_event_name\":\"SubagentStart\",\"agent_type\":\"../../etc/passwd\"}" || FAILED=1

echo
[ $FAILED -eq 0 ] && echo "fail-open: ALL PASS" || echo "fail-open: FAILURES PRESENT"
exit $FAILED
