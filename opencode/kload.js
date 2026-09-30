// kload for OpenCode. Install by symlinking this file into
// ~/.config/opencode/plugins/ (or a project's .opencode/plugins/).
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Resolve through the install symlink, so the shared resolver loads from the repo.
const require = createRequire(realpathSync(fileURLToPath(import.meta.url)));
const { plugin } = require('../scripts/opencode.js');

export const KloadPlugin = async (input) => plugin(input);
