#!/usr/bin/env node
// Test runner: runs every fast suite even when an earlier one fails, prints a per-suite
// summary, and exits nonzero if any suite failed. (Replaces the old `&&` chain, which hid
// every suite after the first failure.) Slow model suites stay separate: test:models, test:grammar.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  'run.mjs',
  'integration.mjs',
  'grounding.mjs',
  'hooks.mjs',
  'strings.mjs',
  'assets.mjs',
  'i18n.mjs',
  'platforms.mjs',
  'assoc.mjs',
];

const results = [];
for (const suite of SUITES) {
  console.log(`\n═══ ${suite} ═══`);
  const r = spawnSync(process.execPath, [join(HERE, suite)], { stdio: 'inherit' });
  results.push({ suite, code: r.status ?? 1 });
}

console.log('\n─── summary ───');
let failed = 0;
for (const { suite, code } of results) {
  const ok = code === 0;
  if (!ok) failed++;
  console.log(`  ${ok ? '✓' : '✗'} ${suite}${ok ? '' : ` (exit ${code})`}`);
}
console.log(failed === 0 ? `\nAll ${results.length} suites passed.` : `\n${failed}/${results.length} suites FAILED.`);
process.exit(failed === 0 ? 0 : 1);
