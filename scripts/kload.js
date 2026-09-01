#!/usr/bin/env node
'use strict';

/**
 * kload — knowledge loader for Claude Code.
 *
 * Reads `knowledge_files` declared in an agent or skill definition, resolves
 * them on disk, shows the operator what actually loaded, and (when enabled)
 * injects the contents into the agent's context.
 *
 * Design invariants:
 *   1. FAIL OPEN. Any error at all -> exit 0 with no output. An agent launch
 *      must never be affected by this plugin misbehaving.
 *   2. READ ONCE. The checkmark you see and the bytes the agent receives come
 *      from the same readFileSync. A green check can never mean "file exists".
 *   3. SILENCE. No declaration -> no output. Built-in agents and plugin skills
 *      declare nothing, so they stay quiet without any special-casing.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');

// ---------------------------------------------------------------- debug ----

const DEBUG = process.env.KLOAD_DEBUG === '1';
const DEBUG_LOG = path.join(CLAUDE_DIR, 'kload-debug.log');

function debug(...parts) {
  if (!DEBUG) return;
  try {
    const line = `[${new Date().toISOString()}] ${parts
      .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
      .join(' ')}\n`;
    fs.appendFileSync(DEBUG_LOG, line);
  } catch (_) {
    /* debug must never throw */
  }
}

// --------------------------------------------------------------- config ----

const DEFAULT_CONFIG = {
  // Where bare knowledge filenames are looked up, in order. First hit wins.
  // "{cwd}" and "{claude}" are expanded.
  knowledgeDirs: ['{cwd}/.claude/knowledge', '{claude}/knowledge'],
  // Where agent definitions live, in order (project beats user, matching the CLI).
  agentDirs: ['{cwd}/.claude/agents', '{claude}/agents'],
  // Where skill definitions live, in order.
  skillDirs: ['{cwd}/.claude/skills', '{claude}/skills'],
  // "declared"  -> act on anything that declares knowledge_files (default)
  // "explicit"  -> only when the user @agent-mentioned it this turn
  trigger: 'declared',
  // Phase 2. false = show the report only, inject nothing.
  inject: false,
  // Per-file token estimates. Off — line counts are the signal that matters.
  showTokens: false,
  // ANSI colour: 'auto' | 'always' | 'never'.
  color: 'auto',
  // Announce at prompt time when the user @agent-mentions an agent. The
  // SubagentStart report only surfaces once the (backgrounded) agent finishes,
  // which is too late to be useful. UserPromptSubmit renders in the foreground,
  // before the agent is spawned. Set false to keep the old after-the-fact report.
  announceOnPrompt: true,
  // How injected knowledge is delivered.
  //   'prompt'  -> prepended to the subagent's own prompt via PreToolUse
  //                updatedInput. No size cap.
  //   'context' -> SubagentStart additionalContext. The harness spills anything
  //                over ~2KB to a file and inlines only a preview, so multi-file
  //                declarations arrive silently truncated.
  injectVia: 'prompt',
};

function expand(p, cwd) {
  return p
    .replace('{cwd}', cwd)
    .replace('{claude}', CLAUDE_DIR)
    .replace(/^~(?=\/|$)/, HOME);
}

function loadConfig(cwd) {
  const cfg = Object.assign({}, DEFAULT_CONFIG);

  // 1. Config files, user-level then project-level (project wins).
  for (const f of [
    path.join(CLAUDE_DIR, 'kload.json'),
    path.join(cwd, '.claude', 'kload.json'),
  ]) {
    try {
      if (fs.existsSync(f)) {
        Object.assign(cfg, JSON.parse(fs.readFileSync(f, 'utf8')));
        debug('config loaded from', f);
      }
    } catch (e) {
      debug('config parse failed', f, String(e));
    }
  }

  // 2. Env overrides win over everything.
  if (process.env.KLOAD_KNOWLEDGE_DIRS) {
    cfg.knowledgeDirs = process.env.KLOAD_KNOWLEDGE_DIRS.split(':').filter(Boolean);
  }
  if (process.env.KLOAD_INJECT === '1') cfg.inject = true;
  if (process.env.KLOAD_INJECT === '0') cfg.inject = false;
  if (process.env.KLOAD_TRIGGER) cfg.trigger = process.env.KLOAD_TRIGGER;
  if (process.env.KLOAD_ANNOUNCE === '1') cfg.announceOnPrompt = true;
  if (process.env.KLOAD_ANNOUNCE === '0') cfg.announceOnPrompt = false;
  if (process.env.KLOAD_INJECT_VIA) cfg.injectVia = process.env.KLOAD_INJECT_VIA;

  return cfg;
}

// ---------------------------------------------------------- frontmatter ----

/** Split a definition file into [frontmatterText, body]. */
function splitFrontmatter(text) {
  if (!text.startsWith('---')) return [null, text];
  const lines = text.split('\n');
  if (lines[0].trim() !== '---') return [null, text];
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return [lines.slice(1, i).join('\n'), lines.slice(i + 1).join('\n')];
    }
  }
  return [null, text];
}

/**
 * Parse the subset of YAML that actually appears in agent/skill frontmatter:
 *   key: scalar
 *   key: [a, b, c]
 *   key: |            (block scalar)
 *   key:              (block sequence)
 *     - item
 * Anything more exotic is ignored rather than thrown on — fail open.
 */
function parseYamlSubset(src) {
  const out = {};
  if (!src) return out;
  const lines = src.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/.exec(line);
    if (!m) { i++; continue; }

    const key = m[1];
    let rest = m[2];
    i++;

    // Block scalar: `key: |` or `key: >`
    if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-') {
      const block = [];
      while (i < lines.length) {
        const l = lines[i];
        if (l.trim() === '') { block.push(''); i++; continue; }
        if (/^[ \t]/.test(l)) { block.push(l.replace(/^[ \t]{1,2}/, '')); i++; continue; }
        break;
      }
      out[key] = block.join('\n').trim();
      continue;
    }

    // Inline flow sequence: `key: [a, b]`
    if (rest.startsWith('[')) {
      out[key] = rest
        .replace(/^\[/, '')
        .replace(/\]\s*$/, '')
        .split(',')
        .map((s) => unquote(s.trim()))
        .filter(Boolean);
      continue;
    }

    // Block sequence: `key:` then `  - item`
    if (rest === '') {
      const items = [];
      let j = i;
      while (j < lines.length) {
        const l = lines[j];
        if (l.trim() === '') { j++; continue; }
        const im = /^[ \t]+-[ \t]*(.+?)[ \t]*$/.exec(l);
        if (!im) break;
        items.push(unquote(im[1]));
        j++;
      }
      if (items.length) { out[key] = items; i = j; continue; }
      out[key] = '';
      continue;
    }

    out[key] = unquote(rest.trim());
  }

  return out;
}

function unquote(s) {
  if (!s) return s;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Pull the knowledge_files declaration out of parsed frontmatter.
 * Preferred shape is a first-class YAML key:
 *     knowledge_files:
 *       - house-style.md
 * Alternate shape, for definitions written against a runner that carries its
 * settings as a JSON blob, is a JSON string in `config:`:
 *     config: |
 *       { "knowledge_files": ["house-style.md"] }
 */
function declaredKnowledge(fm) {
  const asList = (v) => {
    if (!v) return [];
    if (Array.isArray(v)) return v.filter((x) => typeof x === 'string' && x.trim());
    if (typeof v === 'string' && v.trim()) return [v.trim()];
    return [];
  };

  let files = asList(fm.knowledge_files);
  let source = files.length ? 'knowledge_files' : null;

  if (!files.length && typeof fm.config === 'string' && fm.config.trim()) {
    try {
      const parsed = JSON.parse(fm.config);
      files = asList(parsed && parsed.knowledge_files);
      if (files.length) source = 'config.knowledge_files';
    } catch (e) {
      debug('config JSON parse failed', String(e));
    }
  }

  return { files, source };
}

// ----------------------------------------------------------- resolution ----

function firstExisting(dirs, filename, cwd) {
  for (const d of dirs) {
    const candidate = path.join(expand(d, cwd), filename);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch (_) { /* keep looking */ }
  }
  return null;
}

function findAgentFile(name, cwd, cfg) {
  if (!name || /[\/\\]/.test(name)) return null;
  return firstExisting(cfg.agentDirs, `${name}.md`, cwd);
}

function findSkillFile(name, cwd, cfg) {
  if (!name) return null;
  // Plugin skills are namespaced (`claude-mem:make-plan`) and live in the
  // plugin cache. They never declare knowledge_files — stay out of their way.
  if (name.includes(':')) return null;
  if (/[\/\\]/.test(name)) return null;
  for (const d of cfg.skillDirs) {
    for (const rel of [path.join(name, 'SKILL.md'), `${name}.md`]) {
      const candidate = path.join(expand(d, cwd), rel);
      try {
        if (fs.existsSync(candidate)) return candidate;
      } catch (_) { /* keep looking */ }
    }
  }
  return null;
}

/**
 * Resolve one declared knowledge file to a record. Reads the content exactly
 * once — the display and the injection both render from this object.
 */
function resolveKnowledgeFile(declared, cwd, cfg) {
  const rec = {
    declared,
    resolvedPath: null,
    realPath: null,
    bytes: 0,
    lines: 0,
    tokens: 0,
    content: null,
    status: 'missing',
    detail: '',
  };

  // An explicit path (absolute, ~-prefixed, or containing a separator) is used
  // as given. Bare filenames search the configured knowledge roots.
  let candidates;
  if (declared.startsWith('/') || declared.startsWith('~') || declared.includes('/')) {
    candidates = [expand(declared, cwd)];
  } else {
    candidates = cfg.knowledgeDirs.map((d) => path.join(expand(d, cwd), declared));
  }

  let target = null;
  for (const c of candidates) {
    let link = null;
    try {
      link = fs.lstatSync(c);
    } catch (_) {
      continue; // nothing here at all — try the next root
    }
    // Something exists at this path. Commit to it, broken or not.
    if (link.isSymbolicLink() && !fs.existsSync(c)) {
      rec.resolvedPath = c;
      rec.status = 'broken-symlink';
      try {
        rec.detail = `broken symlink -> ${fs.readlinkSync(c)}`;
      } catch (_) {
        rec.detail = 'broken symlink';
      }
      return rec;
    }
    target = c;
    break;
  }

  if (!target) {
    rec.detail = declared.includes('/')
      ? 'no such file'
      : `not found in ${cfg.knowledgeDirs.map((d) => shortPath(expand(d, cwd))).join(', ')}`;
    return rec;
  }

  rec.resolvedPath = target;
  try { rec.realPath = fs.realpathSync(target); } catch (_) { rec.realPath = target; }

  let st;
  try {
    st = fs.statSync(target);
  } catch (e) {
    rec.status = 'unreadable';
    rec.detail = String(e.code || e.message);
    return rec;
  }

  if (st.isDirectory()) {
    rec.status = 'unreadable';
    rec.detail = 'is a directory';
    return rec;
  }

  let content;
  try {
    content = fs.readFileSync(target, 'utf8');
  } catch (e) {
    rec.status = 'unreadable';
    rec.detail = String(e.code || e.message);
    return rec;
  }

  if (!content.trim()) {
    rec.status = 'empty';
    rec.detail = '0 bytes of content';
    return rec;
  }

  rec.content = content;
  rec.bytes = Buffer.byteLength(content, 'utf8');
  // A trailing newline terminates the last line, it does not start a new one.
  // Must agree with `wc -l`, or the count can't be used to spot a stale symlink.
  rec.lines = content.split('\n').length - (content.endsWith('\n') ? 1 : 0);
  rec.tokens = Math.round(rec.bytes / 4);
  rec.status = 'ok';
  return rec;
}

function shortPath(p) {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

// -------------------------------------------------------------- display ----

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function colorEnabled(cfg) {
  if (cfg.color === 'never') return false;
  if (cfg.color === 'always') return true;
  // auto: honour the usual opt-outs. stdout is a pipe to the CLI, not a tty,
  // so tty detection tells us nothing here — assume the renderer can show it.
  if (process.env.NO_COLOR) return false;
  if (process.env.TERM === 'dumb') return false;
  return true;
}

const MARK = { ok: '\u2713', missing: '\u2717', 'broken-symlink': '\u2717', unreadable: '\u2717', empty: '\u2717' };

function fmtTokens(n) {
  if (!n) return '';
  if (n < 1000) return `~${n} tok`;
  return `~${(n / 1000).toFixed(n < 10000 ? 1 : 0).replace(/\.0$/, '')}K tok`;
}

function render(kind, name, records, cfg) {
  const c = colorEnabled(cfg);
  const paint = (code, s) => (c ? code + s + ANSI.reset : s);

  const lines = [];
  lines.push(
    paint(ANSI.bold, 'Loading knowledge files') +
      paint(ANSI.dim, ' \u00b7 ') +
      paint(ANSI.cyan, `${name} ${kind}`)
  );
  lines.push('');

  const ok = records.filter((r) => r.status === 'ok');

  // If every resolved file came from one real directory, say so once in the
  // summary instead of repeating the symlink target on every row.
  const realDirs = new Set(ok.filter((r) => r.realPath).map((r) => path.dirname(r.realPath)));
  const commonRealDir = realDirs.size === 1 ? [...realDirs][0] : null;
  const declaredDirs = new Set(ok.filter((r) => r.resolvedPath).map((r) => path.dirname(r.resolvedPath)));
  const showRootOnce = commonRealDir && declaredDirs.size === 1 && !declaredDirs.has(commonRealDir);

  const width = Math.max(...records.map((r) => r.declared.length));
  for (const r of records) {
    const good = r.status === 'ok';
    const mark = paint(good ? ANSI.green : ANSI.red, MARK[r.status] || '?');
    const pad = r.declared.padEnd(width);

    let meta;
    if (good) {
      meta = `${r.lines} lines`;
      if (cfg.showTokens) meta += ` \u00b7 ${fmtTokens(r.tokens)}`;
      if (!showRootOnce && r.realPath && r.realPath !== r.resolvedPath) {
        meta += ` \u2192 ${shortPath(r.realPath)}`;
      }
      meta = paint(ANSI.dim, meta);
    } else {
      meta = paint(ANSI.red, r.detail);
    }
    lines.push(`   ${mark}  ${pad}  ${meta}`);
  }

  lines.push('');

  const summary = [`${ok.length}/${records.length} loaded`];
  if (cfg.showTokens) {
    const total = ok.reduce((a, r) => a + r.tokens, 0);
    if (total) summary.push(fmtTokens(total));
  }
  if (showRootOnce) summary.push(`from ${shortPath(commonRealDir)}`);
  if (!cfg.inject) summary.push('display only');
  lines.push(paint(ANSI.dim, `   ${summary.join(' \u00b7 ')}`));

  return lines.join('\n');
}

function buildContext(name, records) {
  const ok = records.filter((r) => r.status === 'ok');
  if (!ok.length) return null;
  const parts = [
    `The following knowledge files were loaded for \`${name}\` by kload and are`,
    `authoritative for this task. You do NOT need to read them again.`,
    '',
  ];
  for (const r of ok) {
    parts.push(`## Knowledge: ${r.declared}`, '', r.content.trim(), '');
  }
  const failed = records.filter((r) => r.status !== 'ok');
  if (failed.length) {
    parts.push(
      `## kload: not delivered`,
      '',
      ...failed.map((r) => `- ${r.declared} — ${r.detail}`),
      '',
      'Work without these, and say plainly in your output that they were unavailable.',
      ''
    );
  }
  return parts.join('\n');
}

// ------------------------------------------------------- explicit gating ----

function stateFile(sessionId) {
  return path.join(CLAUDE_DIR, 'kload-state', `${String(sessionId).replace(/[^A-Za-z0-9_-]/g, '')}.json`);
}

function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(sessionId), 'utf8'));
  } catch (_) {
    return {};
  }
}

function writeState(sessionId, patch) {
  const f = stateFile(sessionId);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const cur = readState(sessionId);
    fs.writeFileSync(f, JSON.stringify(Object.assign({}, cur, patch, { ts: Date.now() })));
  } catch (e) {
    debug('state write failed', String(e));
  }
}

function mentionedNames(prompt) {
  const names = new Set();
  const p = String(prompt || '');
  // `@agent-name` — typed form.
  for (const m of p.matchAll(/@agent-([A-Za-z0-9_-]+)/g)) names.add(m[1]);
  // `@"name (agent)"` / `@"name (skill)"` — what the picker inserts.
  for (const m of p.matchAll(/@"([A-Za-z0-9_-]+)\s*\((?:agent|skill)\)"/g)) names.add(m[1]);
  // `/skill-name` — slash form.
  for (const m of p.matchAll(/(?:^|\s)\/([A-Za-z0-9_-]+)/g)) names.add(m[1]);
  return [...names];
}

function recordExplicitMentions(input) {
  const names = mentionedNames(input.prompt);
  if (!names.length) return;
  writeState(input.session_id, { names });
  debug('recorded explicit mentions', names);
}

function wasExplicit(sessionId, name) {
  const raw = readState(sessionId);
  // Only honour a mention from the last 10 minutes.
  if (Date.now() - (raw.ts || 0) > 10 * 60 * 1000) return false;
  return (raw.names || []).includes(name);
}

/**
 * Resolve one declared name to its knowledge records, without rendering.
 * Returns null when the definition is missing or declares nothing.
 */
function recordsFor(kind, name, cwd, cfg) {
  const defPath =
    kind === 'agent' ? findAgentFile(name, cwd, cfg) : findSkillFile(name, cwd, cfg);
  if (!defPath) return null;

  let text;
  try {
    text = fs.readFileSync(defPath, 'utf8');
  } catch (e) {
    debug('definition unreadable', defPath, String(e));
    return null;
  }

  const [fmText] = splitFrontmatter(text);
  const { files, source } = declaredKnowledge(parseYamlSubset(fmText));
  if (!files.length) return null;

  debug(kind, name, 'declares', files, 'via', source, 'from', defPath);
  return files.map((f) => resolveKnowledgeFile(f, cwd, cfg));
}

/**
 * Render the report at PROMPT time for any @agent-mentioned agent, so it lands
 * in the foreground before the agent is spawned. Display only — injection still
 * happens at SubagentStart, where it can reach the subagent's own context.
 */
function announceMentions(input, cfg, cwd) {
  const names = mentionedNames(input.prompt);
  if (!names.length) return null;

  const blocks = [];
  const announced = [];
  for (const name of names) {
    const records = recordsFor('agent', name, cwd, cfg) || recordsFor('skill', name, cwd, cfg);
    if (!records) continue;
    const kind = findAgentFile(name, cwd, cfg) ? 'agent' : 'skill';
    blocks.push(render(kind, name, records, cfg));
    announced.push(name);
  }
  if (!blocks.length) return null;

  writeState(input.session_id, { announced });
  debug('announced at prompt time', announced);
  return { systemMessage: blocks.join('\n\n') };
}

/**
 * True once per announcement: the prompt-time report already told the user, so
 * the SubagentStart report would only repeat it (and arrive after the fact).
 */
function consumeInjected(sessionId, name) {
  const raw = readState(sessionId);
  const injected = raw.injected || [];
  if (!injected.includes(name)) return false;
  if (Date.now() - (raw.ts || 0) > 5 * 60 * 1000) return false;
  writeState(sessionId, { injected: injected.filter((n) => n !== name) });
  return true;
}

function consumeAnnouncement(sessionId, name) {
  const raw = readState(sessionId);
  const announced = raw.announced || [];
  if (!announced.includes(name)) return false;
  if (Date.now() - (raw.ts || 0) > 5 * 60 * 1000) return false;
  writeState(sessionId, { announced: announced.filter((n) => n !== name) });
  return true;
}

// ----------------------------------------------------------------- main ----

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_) {
    return '';
  }
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

/**
 * The agent-spawn tool (Agent / Task) carries the subagent's prompt as tool
 * input. Prepending the knowledge there delivers it whole — unlike
 * additionalContext, which the harness truncates past ~2KB.
 */
function handleSpawn(input, cfg, cwd) {
  const ti = input.tool_input || {};
  const name = ti.subagent_type || ti.agent_type;
  if (!name) return null;

  const records = recordsFor('agent', name, cwd, cfg);
  if (!records) return null;

  const out = {};
  if (!consumeAnnouncement(input.session_id, name)) {
    out.systemMessage = render('agent', name, records, cfg);
  }

  if (cfg.inject && cfg.injectVia === 'prompt' && typeof ti.prompt === 'string') {
    const ctx = buildContext(name, records);
    if (ctx) {
      out.hookSpecificOutput = {
        hookEventName: 'PreToolUse',
        updatedInput: Object.assign({}, ti, {
          prompt: ctx + '\n\n---\n\n' + ti.prompt,
        }),
      };
      const prior = readState(input.session_id).injected || [];
      writeState(input.session_id, { injected: prior.concat([name]) });
      debug('agent', name, 'injected into spawn prompt', String(ctx.length), 'bytes');
    }
  }

  return Object.keys(out).length ? out : null;
}

function handle(kind, name, input, cfg, cwd, hookEventName) {
  const defPath =
    kind === 'agent' ? findAgentFile(name, cwd, cfg) : findSkillFile(name, cwd, cfg);
  if (!defPath) { debug(kind, name, 'no definition file found'); return null; }

  let text;
  try {
    text = fs.readFileSync(defPath, 'utf8');
  } catch (e) {
    debug('definition unreadable', defPath, String(e));
    return null;
  }

  const [fmText] = splitFrontmatter(text);
  const fm = parseYamlSubset(fmText);
  const { files, source } = declaredKnowledge(fm);
  debug(kind, name, 'declares', files, 'via', source, 'from', defPath);

  // SILENCE RULE: nothing declared, nothing said.
  if (!files.length) return null;

  if (cfg.trigger === 'explicit' && !wasExplicit(input.session_id, name)) {
    debug(kind, name, 'skipped: trigger=explicit and no mention recorded');
    return null;
  }

  const records = files.map((f) => resolveKnowledgeFile(f, cwd, cfg));
  const out = {};
  if (hookEventName === 'SubagentStart' && consumeAnnouncement(input.session_id, name)) {
    debug(kind, name, 'report suppressed: already announced at prompt time');
  } else {
    out.systemMessage = render(kind, name, records, cfg);
  }

  // Only stand down if the spawn hook actually delivered. If its matcher never
  // fired, falling back to additionalContext is lossy — but silence is worse.
  const viaPrompt =
    cfg.injectVia === 'prompt' &&
    hookEventName === 'SubagentStart' &&
    consumeInjected(input.session_id, name);

  if (cfg.inject && !viaPrompt) {
    const ctx = buildContext(name, records);
    if (ctx) {
      out.hookSpecificOutput = { hookEventName, additionalContext: ctx };
      if (cfg.injectVia === 'prompt') {
        debug(kind, name, 'FALLBACK: spawn hook did not deliver, using additionalContext');
      }
    }
  } else if (viaPrompt) {
    debug(kind, name, 'injection already delivered via the spawn prompt');
  }

  return Object.keys(out).length ? out : null;
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) return;

  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    debug('stdin not JSON', String(e));
    return;
  }

  const cwd = input.cwd || process.cwd();
  const cfg = loadConfig(cwd);
  const event = input.hook_event_name;
  debug('event', event, 'cwd', cwd, 'trigger', cfg.trigger, 'inject', cfg.inject);

  if (event === 'UserPromptSubmit') {
    if (cfg.trigger === 'explicit') recordExplicitMentions(input);
    if (cfg.announceOnPrompt) {
      const out = announceMentions(input, cfg, cwd);
      if (out) emit(out);
    }
    return;
  }

  if (event === 'SubagentStart') {
    const out = handle('agent', input.agent_type, input, cfg, cwd, 'SubagentStart');
    if (out) emit(out);
    return;
  }

  if (event === 'PreToolUse' && (input.tool_name === 'Agent' || input.tool_name === 'Task')) {
    const out = handleSpawn(input, cfg, cwd);
    if (out) emit(out);
    return;
  }

  if (event === 'PreToolUse' && input.tool_name === 'Skill') {
    const ti = input.tool_input || {};
    const name = ti.skill || ti.name || ti.skill_name;
    const out = handle('skill', name, input, cfg, cwd, 'PreToolUse');
    if (out) emit(out);
    return;
  }

  debug('unhandled event', event);
}

// INVARIANT 1: fail open. Nothing below this line may reach the user.
if (require.main === module) {
  try {
    main();
  } catch (e) {
    debug('FATAL (suppressed)', e && e.stack ? e.stack : String(e));
  }
  process.exit(0);
} else {
  // Required as a library (tests) — expose the internals, run nothing.
  module.exports = {
    splitFrontmatter,
    parseYamlSubset,
    declaredKnowledge,
    resolveKnowledgeFile,
    findAgentFile,
    findSkillFile,
    render,
    buildContext,
    loadConfig,
    DEFAULT_CONFIG,
  };
}
