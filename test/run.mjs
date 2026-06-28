#!/usr/bin/env node
// Zero-dependency fixture runner. For each case: assert `bad` raises the rule and `good` does not.

import { detectText } from '../cli/engine/index.mjs';
import { RULES } from '../cli/engine/rules.mjs';
import { CASES } from './cases.mjs';

const NBSP = String.fromCharCode(0x00A0);
const optsFor = (pack) => ({ config: { ignoreRules: new Set(), ignoreValues: {}, ignoreFiles: [], styleGuide: pack || 'microsoft' }, useInlineIgnores: false });
const has = (text, rule, pack) => detectText(text, optsFor(pack)).some((f) => f.ruleId === rule);

// Some characters don't survive cleanly as source literals; inject them here deterministically.
function badText(c) {
  if (c.rule === 'unicode-artifact') return 'A paragraph with a stray' + NBSP + 'space in it.';
  return c.bad;
}

let pass = 0, fail = 0;
const failures = [];

for (const c of CASES) {
  if (has(badText(c), c.rule, c.pack)) pass++; else { fail++; failures.push(`${c.rule}: BAD did not raise the rule`); }
  if (!has(c.good, c.rule, c.pack)) pass++; else { fail++; failures.push(`${c.rule}: GOOD false-positived`); }
}

const covered = new Set(CASES.map((c) => c.rule));
const uncovered = RULES.map((r) => r.id).filter((id) => !covered.has(id));

console.log(`\nFixture pairs: ${CASES.length} · assertions: ${pass + fail} · ${pass} passed · ${fail} failed`);
if (uncovered.length) console.log(`Uncovered rules (${uncovered.length}): ${uncovered.join(', ')}`);
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log('  ✗ ' + f); }
const ok = fail === 0 && uncovered.length === 0;
console.log(ok ? '\n✓ all green\n' : '');
process.exit(ok ? 0 : 1);
