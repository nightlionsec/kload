#!/usr/bin/env node
'use strict';
/**
 * Covers the two behaviours that have no visible failure mode in production:
 *
 *   1. Directory auto-discovery. If the walk-up stops finding a project root,
 *      kload just reports "not found" — indistinguishable from a genuinely
 *      absent file. Nothing tells you the search path collapsed.
 *   2. Stale self-load detection. It is advisory, so a regression here is pure
 *      silence: either the warning stops firing, or it starts firing on every
 *      definition and gets tuned out. Both ends are asserted below.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const K = require(path.join(__dirname, '..', 'scripts', 'kload.js'));

let fail = 0;
function ok(label, cond, detail) {
  if (cond) { console.log(`PASS  ${label}`); return; }
  fail++;
  console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
}

// ------------------------------------------------------------- fixtures ----

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kload-discovery-'));
const proj = path.join(root, 'proj');
const deep = path.join(proj, 'a', 'b', 'c');
fs.mkdirSync(deep, { recursive: true });
fs.mkdirSync(path.join(proj, '.claude', 'knowledge'), { recursive: true });
fs.mkdirSync(path.join(proj, '.claude', 'agents'), { recursive: true });
fs.writeFileSync(path.join(proj, '.claude', 'knowledge', 'notes.md'), 'MARKER\n');

process.on('exit', () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} });

// ------------------------------------------------------------ discovery ----

const cfg = { autoDiscover: true, discoverDepth: 12 };

const fromDeep = K.discoverDirs(deep, 12, 'knowledge').map((p) => fs.realpathSync(p));
ok('walks up from a subdirectory to the project knowledge root',
   fromDeep.includes(fs.realpathSync(path.join(proj, '.claude', 'knowledge'))),
   JSON.stringify(fromDeep));

ok('walk-up also finds definition roots',
   K.discoverDirs(deep, 12, 'agents')
    .map((p) => fs.realpathSync(p))
    .includes(fs.realpathSync(path.join(proj, '.claude', 'agents'))));

// A narrowed config must not be able to lose the project root.
const narrowed = K.effectiveDirs(['{claude}/knowledge'], deep, cfg, 'knowledge');
ok('a narrowed knowledgeDirs still reaches the project root (discovery appends)',
   narrowed.map((p) => fs.realpathSync(p))
           .includes(fs.realpathSync(path.join(proj, '.claude', 'knowledge'))),
   JSON.stringify(narrowed));

// ORDER IS THE CONTRACT: configured roots must stay ahead of discovered ones,
// or enabling discovery could silently change where an existing file resolves.
const ordered = K.effectiveDirs([path.join(proj, 'explicit')], proj, cfg, 'knowledge');
ok('configured roots are searched before discovered roots',
   ordered[0] === path.join(proj, 'explicit'), JSON.stringify(ordered));

// Dedupe by realpath — a root reached twice under two names is searched once.
const linked = path.join(root, 'link-to-knowledge');
let dedupeTested = false;
try {
  fs.symlinkSync(path.join(proj, '.claude', 'knowledge'), linked);
  dedupeTested = true;
} catch (_) { /* symlinks unavailable — skip */ }
if (dedupeTested) {
  const deduped = K.effectiveDirs([linked, path.join(proj, '.claude', 'knowledge')], proj, cfg, 'knowledge');
  const real = fs.realpathSync(linked);
  ok('a symlinked root is not searched twice',
     deduped.filter((p) => { try { return fs.realpathSync(p) === real; } catch (_) { return false; } }).length === 1,
     JSON.stringify(deduped));
}

ok('discovery off leaves the configured list alone',
   K.effectiveDirs(['{claude}/knowledge'], deep, { autoDiscover: false }, 'knowledge').length === 1);

ok('a nonexistent cwd does not throw',
   Array.isArray(K.discoverDirs(path.join(root, 'nope', 'nope'), 12, 'knowledge')));

// ----------------------------------------------------------- staleness ----

const STALE = `
<load_first>
STOP. Before anything else, run:

    cat ~/git/my-project/knowledge/notes.md

**Nothing loads these for you.** There is no mechanism that attaches them.

    KNOWLEDGE READ: notes.md (1 lines)
</load_first>`;

const stale = K.detectStaleSelfLoad(STALE, ['notes.md']);
ok('flags the old self-load block', !!stale && stale.length >= 3, JSON.stringify(stale));

// The fallback kload's own preamble recommends must NOT be flagged.
const CONDITIONAL = `
Your knowledge arrives as \`## Knowledge: <name>\` sections.
  - Absent -> load it yourself:  cat ~/git/my-project/knowledge/notes.md
Never guess at the contents of a knowledge file you could not obtain.`;
ok('does not flag a conditional fallback read',
   K.detectStaleSelfLoad(CONDITIONAL, ['notes.md']) === null,
   JSON.stringify(K.detectStaleSelfLoad(CONDITIONAL, ['notes.md'])));

ok('does not flag a definition that says nothing about loading',
   K.detectStaleSelfLoad('Just do the work.', ['notes.md']) === null);

ok('does not flag a read of an undeclared file',
   K.detectStaleSelfLoad('Run: cat ~/some/other.md', ['notes.md']) === null);

ok('empty body is safe', K.detectStaleSelfLoad('', ['notes.md']) === null);

console.log(fail ? `\ndiscovery/staleness: ${fail} FAILED` : '\ndiscovery/staleness: ALL PASS');
process.exit(fail ? 1 : 0);
