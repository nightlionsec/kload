#!/usr/bin/env python3
"""Exercise the real Codex CLI against a deterministic local Responses server.

No API key or external model is used. Temporary Codex configuration, Claude
sources, registrations, and receipts are isolated from the user's installation.
The test inspects model requests, rather than trusting a model's load receipt.
Run: python3 test/codex-runtime.py
"""
import gzip
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid

REPO = Path(__file__).resolve().parents[1]


def text_values(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from text_values(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from text_values(item)


class Fixture:
    def __init__(self, project, payload):
        self.project = project
        self.payload = payload
        self.mode = "explicit"
        self.requests = []
        self.delivered = []
        self.errors = []
        self.child_delivered = threading.Event()
        self.parent_calls = 0

    def answer(self, request):
        self.requests.append(request)
        text = "\n".join(text_values(request.get("input", [])))
        # The random bytes are only in the knowledge fixture, not user prompts.
        complete = self.payload in text
        if complete:
            self.delivered.append(self.mode)
        if self.mode == "explicit":
            assert complete, "explicit skill knowledge absent from actual model input"
            return self.message("Explicit skill delivery verified.")
        if self.mode == "implicit":
            if complete:
                return self.message("Implicit skill delivery verified.")
            assert self.parent_calls == 0, "implicit skill read did not deliver complete knowledge"
            self.parent_calls += 1
            command = "head -n 2 " + str(self.project / ".agents/skills/delivery-skill/SKILL.md")
            tools = {t.get("name"): t for t in request.get("tools", [])}
            if "exec_command" in tools:
                return self.call("exec_command", {"cmd": command, "max_output_tokens": 40})
            if "shell_command" in tools:
                return self.call("shell_command", {"command": command})
            raise AssertionError("No native shell tool: " + str(list(tools)))
        if self.mode in ("agent", "agent-missing"):
            if self.mode == "agent-missing" and self.parent_calls:
                assert "AGENT_BODY_MARKER" not in text, "missing knowledge did not block native spawning"
                assert "kload:" in text and "payload.md" in text, "missing-knowledge denial was not returned to the parent"
                self.delivered.append(self.mode)
                return self.message("Missing knowledge blocked before spawning.")
            if complete:
                assert "AGENT_BODY_MARKER" in text
                assert request.get("model") == "kload-fixture", "child did not inherit the Codex model"
                self.child_delivered.set()
                return self.message("Native child agent delivery verified.")
            if self.parent_calls == 0:
                self.parent_calls += 1
                tools = {t.get("name"): t for t in request.get("tools", [])}
                namespace = next((t for t in request.get("tools", []) if t.get("type") == "namespace" and any(c.get("name") == "spawn_agent" for c in t.get("tools", []))), None)
                tool = tools.get("spawn_agent") or next((t for t in (namespace or {}).get("tools", []) if t.get("name") == "spawn_agent"), None)
                assert tool, "Native spawn_agent tool not available"
                props = tool.get("parameters", {}).get("properties", {})
                message_key = "message" if "message" in props else "prompt"
                args = {message_key: "Report the injected fixture; do not read any files.", "agent_type": "delivery-agent"}
                if "fork_context" in props:
                    args["fork_context"] = False
                if self.mode == "agent-missing":
                    (self.project / ".claude/knowledge/payload.md").unlink()
                call = self.call("spawn_agent", args)
                if namespace:
                    call["namespace"] = namespace["name"]
                return call
            assert self.child_delivered.wait(15), "child did not send a model request with complete knowledge"
            return self.message("Parent observed child completion.")
        raise AssertionError(self.mode)

    @staticmethod
    def message(text):
        return {"id": "msg_" + uuid.uuid4().hex, "type": "message", "role": "assistant", "status": "completed",
                "content": [{"type": "output_text", "text": text, "annotations": []}]}

    @staticmethod
    def call(name, args):
        return {"id": "fc_" + uuid.uuid4().hex, "type": "function_call", "status": "completed",
                "call_id": "call_" + uuid.uuid4().hex, "name": name, "arguments": json.dumps(args)}


def handler(fixture):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"data":[]}')

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            encoding = self.headers.get("Content-Encoding", "")
            try:
                if encoding == "gzip":
                    raw = gzip.decompress(raw)
                elif encoding == "zstd":
                    raw = subprocess.run(["zstd", "-d", "-q", "-c"], input=raw, capture_output=True, check=True).stdout
                request = json.loads(raw)
                output = fixture.answer(request)
            except Exception as exc:
                fixture.errors.append(str(exc))
                self.send_response(400)
                self.end_headers()
                self.wfile.write(json.dumps({"error": {"message": str(exc)}}).encode())
                return
            rid = "resp_" + uuid.uuid4().hex
            response = {"id": rid, "object": "response", "status": "completed", "output": [output],
                        "usage": {"input_tokens": 100, "output_tokens": 10, "total_tokens": 110}}
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Connection", "close")
            self.end_headers()
            events = [
                {"type": "response.created", "response": {**response, "status": "in_progress", "output": []}},
                {"type": "response.output_item.added", "output_index": 0, "item": output},
                {"type": "response.output_item.done", "output_index": 0, "item": output},
                {"type": "response.completed", "response": response},
            ]
            for event in events:
                self.wfile.write(("event: " + event["type"] + "\ndata: " + json.dumps(event) + "\n\n").encode())
            self.wfile.flush()
            self.close_connection = True
    return Handler


def main():
    if not shutil.which("codex") or not shutil.which("node"):
        raise SystemExit("codex and node must be on PATH")
    with tempfile.TemporaryDirectory(prefix="kload-runtime-") as directory:
        root = Path(directory).resolve()
        project, config_dir, claude_dir = root / "project", root / "codex-config", root / "claude-config"
        for p in [project / ".claude/agents", project / ".claude/skills/delivery-skill", project / ".claude/knowledge", config_dir, claude_dir]:
            p.mkdir(parents=True, exist_ok=True)
        subprocess.run(["git", "init", "-q", str(project)], check=True)
        payload = "START-" + uuid.uuid4().hex + "\n" + "full-context-payload\n" * 2400 + "MIDDLE-" + uuid.uuid4().hex + "\n" + "second-half\n" * 1000 + "END-" + uuid.uuid4().hex + "\n"
        (project / ".claude/knowledge/payload.md").write_text(payload)
        skill = "---\nname: delivery-skill\ndescription: Apply the delivery fixture workflow.\nknowledge_files: [payload.md]\n---\nSKILL_BODY_MARKER\nReport the injected knowledge. Do not reopen its source.\n"
        agent = "---\nname: delivery-agent\ndescription: A diagnostic agent for the delivery fixture.\nmodel: claude-opus-5\nknowledge_files: [payload.md]\n---\nAGENT_BODY_MARKER\nReport the injected knowledge. Do not call any tools.\n"
        (project / ".claude/skills/delivery-skill/SKILL.md").write_text(skill)
        (project / ".claude/agents/delivery-agent.md").write_text(agent)
        cfg = {"autoDiscover": False, "agentDirs": [str(project / ".claude/agents")],
               "skillDirs": [str(project / ".claude/skills")], "knowledgeDirs": [str(project / ".claude/knowledge")]}
        (config_dir / "kload.json").write_text(json.dumps(cfg))
        (project / ".codex").mkdir(exist_ok=True)
        (project / ".codex/kload.json").write_text(json.dumps(cfg))
        # A child-only Codex configuration is intentional test isolation; the
        # interactive shell and the user's real config are never changed.
        env = dict(os.environ, CODEX_HOME=str(config_dir), CLAUDE_CONFIG_DIR=str(claude_dir),
                   KLOAD_CODEX_DIR=str(config_dir), KLOAD_SKILLS_DIR=str(root / "user-skills"))
        subprocess.run(["node", str(REPO / "scripts/codex.js"), "sync", str(project)], env=env, check=True, capture_output=True)
        hooks = json.loads((REPO / "codex/hooks.json").read_text())
        for groups in hooks["hooks"].values():
            for group in groups:
                for hook in group["hooks"]:
                    hook["command"] = 'node "' + str(REPO / "scripts/codex.js") + '"'
        (config_dir / "hooks.json").write_text(json.dumps(hooks))
        fixture = Fixture(project, payload)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler(fixture))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        config = f'''model = "kload-fixture"
model_provider = "fixture"
approval_policy = "never"
sandbox_mode = "danger-full-access"
[features]
hooks = true
memories = false
plugins = false
[model_providers.fixture]
name = "Local kload delivery test"
base_url = "http://127.0.0.1:{server.server_port}/v1"
wire_api = "responses"
requires_openai_auth = false
'''
        (config_dir / "config.toml").write_text(config)
        try:
            prompts = {"explicit": "$delivery-skill report its delivered knowledge.",
                       "implicit": "Apply the delivery fixture workflow by reading its registered skill file.",
                       "agent": "Spawn the delivery-agent agent for the diagnostic, without forking context, and wait for it.",
                       "agent-missing": "Spawn the delivery-agent agent for the diagnostic and report any dependency failure."}
            for mode, prompt in prompts.items():
                if len(sys.argv) > 1 and mode != sys.argv[1]:
                    continue
                fixture.mode, fixture.parent_calls = mode, 0
                fixture.child_delivered.clear()
                start = len(fixture.requests)
                result = subprocess.run(["codex", "--dangerously-bypass-hook-trust", "exec", "--ephemeral", "--skip-git-repo-check", "--json", prompt],
                                        cwd=project, env=env, capture_output=True, text=True, timeout=55)
                if result.returncode or mode not in fixture.delivered or fixture.errors:
                    # Only synthetic fixture data is captured in this test.
                    debug = root / "failure.json"
                    debug.write_text(json.dumps({"errors": fixture.errors, "stdout": result.stdout, "stderr": result.stderr,
                                                 "requests": fixture.requests[start:]}, indent=2))
                    print(result.stdout[-7000:])
                    print(result.stderr[-3000:])
                    print("Errors:", fixture.errors)
                    print("Tool names:", [t.get("name") for r in fixture.requests[start:start+1] for t in r.get("tools", [])])
                    print("Agent tool schema:", json.dumps([t for r in fixture.requests[start:start+1] for t in r.get("tools", []) if 'agent' in t.get('name', '')])[:14000])
                    raise AssertionError(f"{mode} delivery failed (CLI exit {result.returncode})")
                if mode == "agent-missing":
                    print("PASS missing knowledge blocked native agent spawning before any child model request")
                else:
                    print(f"PASS {mode}: complete {len(payload.encode())}-byte payload in actual Codex model request; sha256={hashlib.sha256(payload.encode()).hexdigest()}")
            if "agent" in fixture.delivered:
                print("PASS native child received knowledge with fork_context=false; no Claude model copied")
        finally:
            server.shutdown()


if __name__ == "__main__":
    main()
