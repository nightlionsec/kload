#!/usr/bin/env node
'use strict';
/**
 * Runs the frontmatter parser over every agent and skill definition on disk.
 * Because kload fails open, a parser bug is INVISIBLE in production — it exits
 * 0 and shows nothing, indistinguishable from "declares nothing". This test is
 * what closes that hole.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude');
const { splitFrontmatter, parseYamlSubset, declaredKnowledge } = require(
  path.join(__dirname, '..', 'scripts', 'kload.js')
);

const targets = [];
for (const d of [path.join(CLAUDE, 'agents')]) {
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) if (f.endsWith('.md')) targets.push(['agent', f.replace(/\.md$/, ''), path.join(d, f)]);
}
for (const d of [path.join(CLAUDE, 'skills')]) {
  if (!fs.existsSync(d)) continue;
  for (const s of fs.readdirSync(d)) {
    for (const rel of [path.join(s, 'SKILL.md'), `${s}.md`]) {
      const p = path.join(d, rel);
      if (fs.existsSync(p)) { targets.push(['skill', s, p]); break; }
    }
  }
}

let fail = 0, declaring = 0;
const rows = [];
for (const [kind, name, p] of targets) {
  try {
    const [fm] = splitFrontmatter(fs.readFileSync(p, 'utf8'));
    const parsed = parseYamlSubset(fm);
    const { files, source } = declaredKnowledge(parsed);
    if (files.length) declaring++;
    rows.push([kind, name, parsed.name === name ? 'ok' : `name=${parsed.name || '-'}`, source || '-', files.join(', ') || '-']);
  } catch (e) {
    fail++;
    rows.push([kind, name, 'THREW', String(e.message), '-']);
  }
}

const w = [0, 1, 2, 3, 4].map((i) => Math.max(...rows.map((r) => String(r[i]).length)));
console.log(rows.map((r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ')).join('\n'));
console.log(`\n${targets.length} definitions · ${declaring} declare knowledge_files · ${fail} parse failures`);
process.exit(fail ? 1 : 0);
