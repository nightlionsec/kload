'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kload-codex-unit-'));
const user = path.join(root, 'claude'), codex = path.join(root, 'codex');
process.env.CLAUDE_CONFIG_DIR = user;
process.env.KLOAD_CODEX_DIR = codex;
process.env.KLOAD_SKILLS_DIR = path.join(root, 'registered-skills');
fs.mkdirSync(codex, { recursive: true });
for (const leaf of ['agents', 'skills', 'knowledge']) fs.mkdirSync(path.join(user, leaf), { recursive: true });
fs.writeFileSync(path.join(codex, 'kload.json'), JSON.stringify({ autoDiscover: false,
  agentDirs: [path.join(user, 'agents')], skillDirs: [path.join(user, 'skills')], knowledgeDirs: [path.join(user, 'knowledge')] }));
const C = require('../scripts/codex');
const K = require('../scripts/kload');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const source = (kind, name, extra = '', body = 'Follow the shared instructions.') => put(
  path.join(user, kind === 'agent' ? 'agents' : 'skills', kind === 'agent' ? `${name}.md` : `${name}/SKILL.md`),
  `---\nname: ${name}\ndescription: Fixture ${name}\n${extra}\n---\n${body}\n`);
const input = (event, extra = {}) => ({ cwd: root, session_id: 'unit-session', turn_id: crypto.randomUUID(), hook_event_name: event, ...extra });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('agent instructions stay shared; Claude model is omitted; child receives complete large knowledge', () => {
  const payload = 'BEGIN-' + crypto.randomUUID() + '\n' + 'full middle payload\n'.repeat(2500) + 'END-' + crypto.randomUUID() + '\n';
  put(path.join(user, 'knowledge/large.md'), payload);
  const p = source('agent', 'large-agent', 'model: claude-opus-5\nmax_turns: 10\nconfig: |\n  {"knowledge_files":["large.md"]}', 'BODY-MARKER');
  const original = fs.readFileSync(p);
  const results = C.synchronize(root);
  assert.equal(results[0].errors.length, 0);
  const entry = C.capabilities(root).get('agent:large-agent');
  const toml = fs.readFileSync(entry.view, 'utf8');
  assert.ok(toml.includes(fs.realpathSync(p)));
  assert.ok(!toml.includes('BODY-MARKER')); // Never cache a conflicting instruction body in native config.
  assert.doesNotMatch(toml, /^model\s*=/m);
  assert.deepEqual(entry.untranslated, ['max_turns']);
  const pre = C.handle(input('PreToolUse', { tool_name: 'spawn_agent', tool_input: { agent_type: 'large-agent', message: 'Do work', fork_context: false } }));
  assert.ok(!pre.hookSpecificOutput?.updatedInput);
  const out = C.handle(input('SubagentStart', { agent_type: 'large-agent', agent_id: 'child-1' }));
  assert.ok(out.hookSpecificOutput.additionalContext.includes(payload));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('BODY-MARKER'));
  assert.ok(out.hookSpecificOutput.additionalContext.includes(`KLOAD END large.md sha256=${sha(payload)}`));
  assert.deepEqual(fs.readFileSync(p), original);
  const receipt = fs.readFileSync(path.join(codex, 'kload/receipts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(receipt.agent, 'child-1');
  assert.equal(receipt.files[0].sha256, sha(payload));
  assert.ok(!JSON.stringify(receipt).includes('full middle payload'));
});

test('explicit skill prompt injects whole files with distinct extensions and ordered deduplication', () => {
  put(path.join(user, 'knowledge/same.md'), 'MARKDOWN-BYTES\n');
  put(path.join(user, 'knowledge/same.json'), '{"end":"JSON-BYTES"}\n');
  source('skill', 'delivery', 'knowledge_files: [same.md, same.json, same.md]');
  const out = C.handle(input('UserPromptSubmit', { prompt: '$delivery validate the fixture' }));
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.ok(ctx.includes('MARKDOWN-BYTES\n'));
  assert.ok(ctx.includes('{"end":"JSON-BYTES"}\n'));
  assert.equal(ctx.split('## Knowledge: same.md').length, 2);
  assert.equal(out.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
});

test('implicit truncated read gets the entire knowledge, with no command rewriting', () => {
  C.synchronize(root);
  const entry = C.capabilities(root).get('skill:delivery');
  const out = C.handle(input('PreToolUse', { tool_name: 'Bash', tool_input: { command: `head -n 1 ${entry.link}/SKILL.md` } }));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('JSON-BYTES'));
  assert.ok(!out.hookSpecificOutput.updatedInput);
  assert.ok(!out.hookSpecificOutput.permissionDecision);
});

test('UTF-8 byte-order marks are preserved so receipts hash the actual file bytes', () => {
  const bytes = Buffer.from('\ufeffComplete UTF-8 knowledge\n');
  const file = put(path.join(user, 'knowledge/bom.md'), bytes);
  const rec = K.resolveKnowledgeFile('bom.md', root, { knowledgeDirs: [path.dirname(file)], strictUtf8: true });
  assert.equal(rec.status, 'ok');
  assert.deepEqual(Buffer.from(rec.content), bytes);
  assert.equal(sha(rec.content), sha(bytes));
});

test('knowledge changes are read at invocation, including during a turn', () => {
  put(path.join(user, 'knowledge/same.md'), 'NEW-CONTENTS\n');
  const entry = C.capabilities(root).get('skill:delivery');
  const out = C.handle(input('PreToolUse', { tool_name: 'exec_command', tool_input: { cmd: `cat ${entry.view}` } }));
  assert.ok(out.hookSpecificOutput.additionalContext.includes('NEW-CONTENTS'));
  assert.ok(!out.hookSpecificOutput.additionalContext.includes('MARKDOWN-BYTES'));
  assert.ok(fs.readFileSync(entry.view, 'utf8').includes('NEW-CONTENTS'));
  assert.ok(!fs.readFileSync(entry.view, 'utf8').includes('MARKDOWN-BYTES'));
});

test('agent instruction edits reach the child without an older body in its native config', () => {
  const p = source('agent', 'fresh-body', 'skills: []', 'ORIGINAL-INSTRUCTIONS');
  C.synchronize(root);
  const entry = C.capabilities(root).get('agent:fresh-body');
  const registered = fs.readFileSync(entry.view, 'utf8');
  assert.deepEqual(entry.untranslated, []);
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('ORIGINAL-INSTRUCTIONS', 'CURRENT-INSTRUCTIONS'));
  const child = C.handle(input('SubagentStart', { agent_type: 'fresh-body' }));
  assert.ok(child.hookSpecificOutput.additionalContext.includes('CURRENT-INSTRUCTIONS'));
  assert.ok(!registered.includes('ORIGINAL-INSTRUCTIONS'));
  assert.equal(fs.readFileSync(entry.view, 'utf8'), registered);
});

test('missing knowledge denies native spawning and explicit skill use', () => {
  source('agent', 'unavailable', 'knowledge_files: [absent.md]');
  source('skill', 'unavailable-skill', 'knowledge_files: [absent.md]');
  C.synchronize(root);
  const denied = C.handle(input('PreToolUse', { tool_name: 'spawn_agent', tool_input: { agent_type: 'unavailable' } }));
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(denied.hookSpecificOutput.permissionDecisionReason, /absent.md/);
  assert.equal(C.handle(input('UserPromptSubmit', { prompt: '$unavailable-skill' })).decision, 'block');
  const child = C.handle(input('SubagentStart', { agent_type: 'unavailable' }));
  assert.match(child.hookSpecificOutput.additionalContext, /KLOAD DELIVERY FAILED/);
});

test('broken local symlink never falls through to a global file with the same name', () => {
  const local = path.join(root, 'project-kb'); fs.mkdirSync(local);
  fs.symlinkSync(path.join(root, 'absent'), path.join(local, 'same.md'));
  const rec = K.resolveKnowledgeFile('same.md', root, { knowledgeDirs: [local, path.join(user, 'knowledge')] });
  assert.equal(rec.status, 'broken-symlink');
  assert.equal(rec.content, null);
});

test('relative subpaths fall back to knowledge roots after the session cwd', () => {
  const rooted = put(path.join(user, 'knowledge/map/searching.md'), 'ROOTED-MAP-KNOWLEDGE\n');
  const cfg = { knowledgeDirs: [path.join(user, 'knowledge')], strictUtf8: true };
  let rec = K.resolveKnowledgeFile('map/searching.md', root, cfg);
  assert.equal(rec.status, 'ok');
  assert.equal(rec.realPath, fs.realpathSync(rooted));
  assert.equal(rec.content, 'ROOTED-MAP-KNOWLEDGE\n');

  const local = put(path.join(root, 'map/searching.md'), 'CWD-MAP-KNOWLEDGE\n');
  rec = K.resolveKnowledgeFile('map/searching.md', root, cfg);
  assert.equal(rec.realPath, fs.realpathSync(local));
  assert.equal(rec.content, 'CWD-MAP-KNOWLEDGE\n');
});

test('a large/empty/non-UTF8 required file is rejected rather than partially delivered', () => {
  for (const [name, bytes] of [['oversize', Buffer.alloc(C.MAX_CONTEXT + 1, 65)], ['empty', Buffer.from(' ')], ['invalid-utf8', Buffer.from([0xc3, 0x28])]]) {
    put(path.join(user, `knowledge/${name}.md`), bytes);
    source('skill', name, `knowledge_files: [${name}.md]`);
    const out = C.handle(input('UserPromptSubmit', { prompt: `$${name}` }));
    assert.equal(out.decision, 'block');
    assert.ok(!out.hookSpecificOutput);
  }
});

test('per-host settings override defaults without changing shared frontmatter', () => {
  const text = 'runtimes:\n  claude:\n    model: sonnet\n  codex:\n    model: inherit # keep the parent selection\n    model_reasoning_effort: high\n';
  assert.deepEqual(C.runtimeSettings(text, K.parseYamlSubset(text), { agentDefaults: { model: 'fixture' } }, 'x'), { model_reasoning_effort: 'high' });
  assert.deepEqual(C.runtimeSettings('runtimes: |\n  {"codex":{"model":"fixture-model"}}', { runtimes: '{"codex":{"model":"fixture-model"}}' }, {}, 'x'), { model: 'fixture-model' });
  assert.throws(() => C.runtimeSettings('', {}, { agentDefaults: { model: 'claude-opus-5' } }, 'x'), /Claude model/);
  assert.throws(() => C.runtimeSettings('', {}, { agentDefaults: { permissionMode: 'bypassPermissions' } }, 'x'), /Unsupported/);
});

test('symlinked SKILL file keeps the wrapper assets instead of copying its knowledge directory', () => {
  const p = source('skill', 'linked');
  const backing = path.join(user, 'knowledge/linked-body.md');
  fs.renameSync(p, backing); fs.symlinkSync(backing, p);
  const helper = put(path.join(path.dirname(p), 'helper.js'), 'helper');
  C.synchronize(root);
  const entry = C.capabilities(root).get('skill:linked');
  assert.equal(fs.realpathSync(path.join(entry.target, 'helper.js')), fs.realpathSync(helper));
  assert.ok(!fs.existsSync(path.join(entry.target, 'large.md')));
});

test('skill containers are ignored while broken skill links remain visible', () => {
  put(path.join(user, 'skills/synced/bucket/nested/SKILL.md'), 'managed container fixture');
  fs.symlinkSync(path.join(user, 'skills/absent-target'), path.join(user, 'skills/broken-skill'));
  const result = C.synchronize(root)[0];
  assert.ok(!result.entries['skill:synced']);
  assert.match(result.entries['skill:broken-skill'].error, /ENOENT/);
  assert.ok(result.errors.some((error) => error.startsWith('skill:broken-skill:')));
});

test('foreign registrations are left alone; removed owned sources cannot run cached agents', () => {
  source('agent', 'foreign');
  const file = put(path.join(codex, 'agents/foreign.toml'), 'EXISTING CONTENT');
  C.synchronize(root);
  assert.equal(fs.readFileSync(file, 'utf8'), 'EXISTING CONTENT');
  assert.equal(C.handle(input('SubagentStart', { agent_type: 'foreign' })), null);
  const p = source('agent', 'removed'); C.synchronize(root); fs.unlinkSync(p); C.synchronize(root);
  const out = C.handle(input('PreToolUse', { tool_name: 'spawn_agent', tool_input: { agent_type: 'removed' } }));
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
});

test('two project scopes with the same names retain independent sources and knowledge', () => {
  for (const name of ['project-a', 'project-b']) {
    const project = path.join(root, name), local = path.join(project, '.claude');
    put(path.join(local, 'agents/scoped.md'), `---\nname: scoped\ndescription: Scoped\nknowledge_files: [local.md]\n---\n${name}`);
    put(path.join(local, 'knowledge/local.md'), `KNOWLEDGE-${name}`);
    put(path.join(project, '.codex/kload.json'), JSON.stringify({ autoDiscover: false,
      agentDirs: [path.join(local, 'agents')], skillDirs: [], knowledgeDirs: [path.join(local, 'knowledge')] }));
    C.synchronize(project);
    const out = C.handle(input('SubagentStart', { cwd: project, agent_type: 'scoped' }));
    assert.ok(out.hookSpecificOutput.additionalContext.includes(`KNOWLEDGE-${name}`));
  }
  const a = C.capabilities(path.join(root, 'project-a')).get('agent:scoped');
  const b = C.capabilities(path.join(root, 'project-b')).get('agent:scoped');
  assert.notEqual(a.view, b.view);
  assert.match(fs.readFileSync(a.view, 'utf8'), /project-a/);
});

test('built-in agents and unrelated tools stay silent', () => {
  assert.equal(C.handle(input('SubagentStart', { agent_type: 'explorer' })), null);
  assert.equal(C.handle(input('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git status' } })), null);
  assert.equal(C.handle(input('Nonsense')), null);
});

test('generated TOML is parsed by a standards parser', () => {
  const entry = C.capabilities(root).get('agent:large-agent');
  const result = spawnSync('/opt/homebrew/bin/python3', ['-c', 'import sys,tomllib; d=tomllib.load(open(sys.argv[1],"rb")); assert d["name"] == "large-agent"; assert "model" not in d', entry.view], { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') return; // Real-CLI acceptance also validates it.
  assert.equal(result.status, 0, result.stderr);
});
