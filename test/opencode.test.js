'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kload-opencode-unit-'));
const user = path.join(root, 'claude'), opencode = path.join(root, 'opencode'), data = path.join(root, 'data');
process.env.CLAUDE_CONFIG_DIR = user;
process.env.KLOAD_OPENCODE_DIR = opencode;
process.env.KLOAD_OPENCODE_DATA = data;
fs.mkdirSync(opencode, { recursive: true });
for (const leaf of ['agents', 'skills', 'knowledge']) fs.mkdirSync(path.join(user, leaf), { recursive: true });
fs.writeFileSync(path.join(opencode, 'kload.json'), JSON.stringify({ autoDiscover: false,
  agentDirs: [path.join(user, 'agents')], skillDirs: [path.join(user, 'skills')], knowledgeDirs: [path.join(user, 'knowledge')] }));
const O = require('../scripts/opencode');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const source = (kind, name, extra = '', body = 'Follow the shared instructions.') => put(
  path.join(user, kind === 'agent' ? 'agents' : 'skills', kind === 'agent' ? `${name}.md` : `${name}/SKILL.md`),
  `---\nname: ${name}\ndescription: Fixture ${name}\n${extra}\n---\n${body}\n`);
const toasts = [];
const client = { tui: { showToast: async ({ body }) => { toasts.push(body); return true; } }, app: { log: async () => true } };
const hooks = async (oc = {}) => { const h = O.plugin({ client, directory: root }); await h.config(oc); return { h, oc }; };
const skillOutput = (name, body, base = '/skills/' + name) => ({ title: `Loaded skill: ${name}`, metadata: {},
  output: [`<skill_content name="${name}">`, `# Skill: ${name}`, '', body, '', `Base directory for this skill: ${base}`,
    'Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.', '', '<skill_files>', '</skill_files>', '</skill_content>'].join('\n') });
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('agents register as native subagents; Claude model is omitted; max_turns becomes steps', async () => {
  source('agent', 'plain', 'model: claude-opus-5\nmax_turns: 12\ncolor: cyan', 'PLAIN-BODY');
  const { oc } = await hooks({ agent: {} });
  assert.deepEqual(oc.agent.plain, { description: 'Fixture plain', mode: 'subagent', prompt: 'PLAIN-BODY', steps: 12 });
});

test('runtimes.opencode and kload.json overrides apply; a non provider/model id is rejected', async () => {
  source('agent', 'tuned', 'model: claude-opus-5\nruntimes:\n  codex:\n    model: gpt-x\n  opencode:\n    model: alibaba/qwen3.8-max\n    temperature: 0.2');
  source('agent', 'badmodel', 'runtimes:\n  opencode:\n    model: opus');
  toasts.length = 0;
  const { h, oc } = await hooks({ agent: {} });
  assert.equal(oc.agent.tuned.model, 'alibaba/qwen3.8-max');
  assert.equal(oc.agent.tuned.temperature, 0.2);
  assert.equal(oc.agent.badmodel, undefined);
  // Registration problems wait for the TUI, then surface once.
  assert.equal(toasts.length, 0);
  await h.event({ event: { type: 'session.created' } });
  await h.event({ event: { type: 'session.created' } });
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].message, /badmodel: OpenCode model must be provider\/model, got opus/);
});

test('a Claude built-in whitelist becomes deny rules; foreign tool names stay untranslated', () => {
  const ro = O.translateTools({ tools: 'Read, Grep, Glob, Bash' });
  assert.equal(ro.permission.edit, 'deny');
  assert.equal(ro.permission.task, 'deny');
  assert.equal(ro.permission.read, undefined);
  assert.equal(ro.permission.bash, undefined);
  assert.equal(ro.permission.list, undefined);
  const zora = O.translateTools({ tools: ['selector_search', 'Read'] });
  assert.deepEqual(zora.permission, {});
  assert.deepEqual(zora.untranslated, ['tools']);
  assert.deepEqual(O.translateTools({ disallowedTools: ['Write'] }).permission, { edit: 'deny' });
});

test('native OpenCode agents and built-ins are never replaced', async () => {
  source('agent', 'mine', '', 'SHARED');
  source('agent', 'general', '', 'SHADOW');
  const { oc } = await hooks({ agent: { mine: { description: 'native', prompt: 'NATIVE' } } });
  assert.equal(oc.agent.mine.prompt, 'NATIVE');
  assert.equal(oc.agent.general, undefined);
});

test('task spawn prepends complete knowledge, tags the title, writes a receipt, toasts the report', async () => {
  const payload = 'BEGIN-' + crypto.randomUUID() + '\n' + 'full middle payload\n'.repeat(2500) + 'END-' + crypto.randomUUID() + '\n';
  put(path.join(user, 'knowledge/large.md'), payload);
  source('agent', 'large-agent', 'config: |\n  {"knowledge_files":["large.md"]}', 'BODY-MARKER');
  const { h } = await hooks({ agent: {} });
  toasts.length = 0;
  const args = { description: 'Do work', prompt: 'THE-TASK', subagent_type: 'large-agent' };
  await h['tool.execute.before']({ tool: 'task', sessionID: 's1', callID: 'c1' }, { args });
  assert.ok(args.prompt.includes(payload));
  assert.ok(args.prompt.includes(`KLOAD END large.md sha256=${sha(payload)}`));
  assert.ok(args.prompt.endsWith('## Task\n\nTHE-TASK'));
  assert.ok(!args.prompt.includes('BODY-MARKER')); // unchanged body stays in the system prompt only
  assert.equal(args.description, 'Do work · kload 1/1');
  assert.equal(toasts.at(-1).title, 'kload · large-agent agent');
  assert.match(toasts.at(-1).message, /✓ large\.md · 2502 lines\n1\/1 loaded/);
  const receipt = fs.readFileSync(path.join(data, 'kload/receipts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(receipt.call, 'c1');
  assert.equal(receipt.files[0].sha256, sha(payload));
  assert.ok(!JSON.stringify(receipt).includes('full middle payload'));
});

test('an agent edited after registration receives its current instructions', async () => {
  const p = source('agent', 'drift', 'knowledge_files: [drift.md]', 'OLD-BODY');
  put(path.join(user, 'knowledge/drift.md'), 'DRIFT-KNOWLEDGE\n');
  const { h } = await hooks({ agent: {} });
  fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('OLD-BODY', 'NEW-BODY'));
  const args = { description: 'd', prompt: 'p', subagent_type: 'drift' };
  await h['tool.execute.before']({ tool: 'task', sessionID: 's', callID: 'c' }, { args });
  assert.ok(args.prompt.includes('NEW-BODY'));
  assert.ok(args.prompt.includes('supersede your system prompt'));
});

test('missing knowledge blocks the spawn loudly; resumes and undeclared agents pass untouched', async () => {
  source('agent', 'broken', 'knowledge_files: [nope.md]');
  source('agent', 'quiet', '', 'QUIET');
  const { h } = await hooks({ agent: {} });
  toasts.length = 0;
  await assert.rejects(h['tool.execute.before']({ tool: 'task' }, { args: { subagent_type: 'broken', prompt: 'x' } }), /kload: broken: nope\.md: not found/);
  assert.equal(toasts.at(-1).variant, 'error');
  const resumed = { subagent_type: 'broken', prompt: 'x', task_id: 't1' };
  await h['tool.execute.before']({ tool: 'task' }, { args: resumed });
  assert.equal(resumed.prompt, 'x');
  const quiet = { subagent_type: 'quiet', prompt: 'x', description: 'd' };
  await h['tool.execute.before']({ tool: 'task' }, { args: quiet });
  assert.deepEqual(quiet, { subagent_type: 'quiet', prompt: 'x', description: 'd' });
  const other = { subagent_type: 'explore', prompt: 'x' };
  await h['tool.execute.before']({ tool: 'task' }, { args: other });
  assert.equal(other.prompt, 'x');
});

test('skill load gets current body and complete knowledge, keeping OpenCode\'s base directory block', async () => {
  put(path.join(user, 'knowledge/sk.md'), 'SKILL-KNOWLEDGE\n');
  source('skill', 'withk', 'knowledge_files: [sk.md]', 'CURRENT-SKILL-BODY');
  const { h } = await hooks();
  const out = skillOutput('withk', 'STALE-BODY');
  await h['tool.execute.before']({ tool: 'skill' }, { args: { name: 'withk' } });
  await h['tool.execute.after']({ tool: 'skill', args: { name: 'withk' }, sessionID: 's', callID: 'c' }, out);
  assert.ok(out.output.startsWith('<skill_content name="withk">\n# Skill: withk\n\n# kload: skill withk'));
  assert.ok(out.output.includes('CURRENT-SKILL-BODY'));
  assert.ok(!out.output.includes('STALE-BODY'));
  assert.ok(out.output.includes('SKILL-KNOWLEDGE'));
  assert.ok(out.output.includes('\n\nBase directory for this skill: /skills/withk\n'));
  assert.equal(out.title, 'Loaded skill: withk · kload 1/1');
});

test('a stale Codex view is refreshed; a plain skill is left alone; missing knowledge blocks the load', async () => {
  source('skill', 'plain-skill', '', 'FRESH');
  source('skill', 'missing-skill', 'knowledge_files: [gone.md]');
  const { h } = await hooks();
  const codex = skillOutput('plain-skill', '<!-- Generated by kload for Codex -->\n\nOLD');
  await h['tool.execute.after']({ tool: 'skill', args: { name: 'plain-skill' } }, codex);
  assert.ok(codex.output.includes('\n\nFRESH\n\nBase directory'));
  assert.ok(!codex.output.includes('OLD'));
  const native = skillOutput('plain-skill', 'AS-LOADED');
  const before = native.output;
  await h['tool.execute.after']({ tool: 'skill', args: { name: 'plain-skill' } }, native);
  assert.equal(native.output, before);
  await assert.rejects(h['tool.execute.before']({ tool: 'skill' }, { args: { name: 'missing-skill' } }), /gone\.md/);
});

test('an unrecognized skill layout still receives the payload', () => {
  assert.equal(O.replaceSkillBody('odd layout', 'x', 'PAYLOAD'), 'odd layout\n\nPAYLOAD');
});

test('internal errors never break unrelated tools', async () => {
  const h = O.plugin({ client: {}, directory: root });
  await h['tool.execute.before']({ tool: 'bash' }, { args: { command: 'ls' } });
  await h['tool.execute.after']({ tool: 'skill', args: null }, { output: 'x' });
  await h['tool.execute.before']({ tool: 'task' }, {});
});
