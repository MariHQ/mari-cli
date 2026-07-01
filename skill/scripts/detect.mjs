#!/usr/bin/env node
// Bundled detector wrapper for the skill — runs the deterministic engine directly (no npx, no
// network). Thin pass-through to the CLI engine so command flows can ground edits in findings.
//   node detect.mjs <path|.> [--json] [--style=<guide>] [--quiet]

import { existsSync } from 'node:fs';
import { loadConfig } from '../../cli/engine/config.mjs';
import { detectTarget } from '../../cli/engine/index.mjs';
import { renderHuman, renderJSON, summarize } from '../../cli/engine/findings.mjs';

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const styleOpt = args.find((a) => a.startsWith('--style='));
const targets = args.filter((a) => !a.startsWith('--'));
if (!targets.length) targets.push('.');

// Exit codes: 0 = clean, 1 = findings present, 2 = engine/usage fault. An engine crash must
// not masquerade as "findings present".
try {
  const root = process.cwd();
  const config = loadConfig(root);
  if (styleOpt) config.styleGuide = styleOpt.split('=')[1];

  const results = [];
  for (const t of targets) {
    if (!existsSync(t)) { console.error(`No such path: ${t}`); process.exit(2); }
    results.push(...detectTarget(t, { config, root }));
  }

  console.log(flags.has('--json') ? renderJSON(results) : renderHuman(results, { quiet: flags.has('--quiet') }));
  process.exit(summarize(results).error > 0 ? 1 : 0);
} catch (e) {
  console.error(`mari detect fault: ${e?.message || e}`);
  process.exit(2);
}
