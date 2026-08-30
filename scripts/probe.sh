#!/usr/bin/env bash
# Diagnostic: captures the real hook payload and proves the display channel.
# Wire this in place of kload.js when you need to see what a hook actually receives.
OUT="${KLOAD_PROBE_OUT:-/tmp/kload-probe.jsonl}"
PAYLOAD=$(cat)
printf '%s\n' "$PAYLOAD" >> "$OUT"
EVENT=$(printf '%s' "$PAYLOAD" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).hook_event_name||"?")}catch{console.log("?")}})' 2>/dev/null)
printf '{"systemMessage":"KLOAD PROBE: %s fired — payload appended to %s"}' "$EVENT" "$OUT"
exit 0
