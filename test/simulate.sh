#!/usr/bin/env bash
# Simulate a hook firing, without installing the plugin.
#
#   test/simulate.sh agent data-review
#   test/simulate.sh skill validate-ai
#   KLOAD_INJECT=1 test/simulate.sh agent data-review
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KIND="${1:-agent}"; NAME="${2:-data-review}"; CWD="${3:-$PWD}"

if [ "$KIND" = "agent" ]; then
  PAYLOAD=$(printf '{"session_id":"sim","cwd":"%s","hook_event_name":"SubagentStart","agent_id":"sim-1","agent_type":"%s"}' "$CWD" "$NAME")
else
  PAYLOAD=$(printf '{"session_id":"sim","cwd":"%s","hook_event_name":"PreToolUse","tool_name":"Skill","tool_input":{"skill":"%s"}}' "$CWD" "$NAME")
fi

OUT=$(printf '%s' "$PAYLOAD" | node "$ROOT/scripts/kload.js")
if [ -z "$OUT" ]; then
  echo "(kload produced no output — silence rule: nothing declared, or definition not found)"
  exit 0
fi
printf '%s' "$OUT" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
  const o=JSON.parse(d);
  console.log("\n--- systemMessage (what you would see) ---");
  console.log(o.systemMessage||"(none)");
  const ac=o.hookSpecificOutput&&o.hookSpecificOutput.additionalContext;
  console.log("\n--- additionalContext (what the agent would receive) ---");
  console.log(ac?`${ac.length} chars, ~${Math.round(ac.length/4)} tokens\n${ac.slice(0,400)}\n...[truncated]`:"(injection off)");
});'
