---
name: kload-demo
description: Verifies that kload delivers declared knowledge files into a skill invocation. Twin of the kload-demo agent — the agent tests the subagent-spawn path, this tests the Skill path. Does no real work.
knowledge_files:
  - kload-demo.md
---

This skill is a diagnostic. It does no real work.

<knowledge>
  kload-demo.md is attached below by kload and is authoritative. If you do not
  see a "## Knowledge:" section for it in your context, kload did not deliver
  it — say so in one line and stop.
</knowledge>

Report, in three lines:

1. Whether a "## Knowledge:" section is present.
2. The kload verification phrase from kload-demo.md, quoted verbatim.
3. The names of the files you received.

Do not read the file from disk — that would defeat the test.
