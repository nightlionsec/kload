#!/usr/bin/env node
'use strict';

// One authored resolver, two host adapters. Build a self-contained Codex plugin
// without changing Claude's manifest/hooks or depending on the source checkout.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist', 'kload');
const files = {
  'codex/plugin.json': '.codex-plugin/plugin.json',
  'codex/hooks.json': 'hooks/hooks.json',
  'scripts/codex.js': 'scripts/codex.js',
  'scripts/kload.js': 'scripts/kload.js',
  'codex/README.md': 'README.md',
};
fs.mkdirSync(output, { recursive: true });
const hashes = {};
for (const [source, destination] of Object.entries(files)) {
  const bytes = fs.readFileSync(path.join(root, source));
  const target = path.join(output, destination);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  hashes[source] = crypto.createHash('sha256').update(bytes).digest('hex');
}
fs.writeFileSync(path.join(output, 'build.json'), JSON.stringify({ sources: hashes }, null, 2) + '\n');
console.log(output);
