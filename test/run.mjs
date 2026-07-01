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

// ---- substring false-positive regression (A1) ------------------------------
// Word-boundary guards on phraseList: clean prose whose words *contain* rule keys
// ("fetch"→etc, "information"→inform, "via" inside words, "blamed"→lame, "adjust"→just,
// "attends to"→tends to) must yield ZERO findings from the phrase-map rules.
{
  const clean = 'We fetch more information via the API. He blamed the tool, so adjust it; she attends to the weekend results.';
  const substringRules = new Set([
    'word-swap', 'ms-wordiness', 'latinism-abbreviation', 'ableist-language',
    'minimizing-words', 'hedge-overuse', 'redundant-pair', 'complex-word', 'wordy-phrase',
  ]);
  {
    const fps = detectText(clean, optsFor('microsoft')).filter((f) => substringRules.has(f.ruleId));
    if (fps.length === 0) pass++;
    else { fail++; failures.push(`clean-prose (microsoft): substring FPs: ${fps.map((f) => `${f.ruleId}:"${f.span}"`).join(', ')}`); }
  }
  // Under google, "via" *inside* words (obviously, deviating, trivial) must not flag latinism.
  {
    const fps = detectText('The deviating survival case was blamed on the tool.', optsFor('google'))
      .filter((f) => substringRules.has(f.ruleId));
    if (fps.length === 0) pass++;
    else { fail++; failures.push(`clean-prose (google): substring FPs: ${fps.map((f) => `${f.ruleId}:"${f.span}"`).join(', ')}`); }
  }
  // …while real hits still fire: "etc." (word-swap, microsoft) and standalone "via"
  // (latinism-abbreviation, google).
  if (has('Bring cables, adapters, etc. to the meeting.', 'word-swap', 'microsoft')) pass++;
  else { fail++; failures.push('word-swap: real "etc." no longer fires'); }
  if (has('Deploy the app via the console.', 'latinism-abbreviation', 'google')) pass++;
  else { fail++; failures.push('latinism-abbreviation: standalone "via" no longer fires'); }
}

const covered = new Set(CASES.map((c) => c.rule));
const uncovered = RULES.map((r) => r.id).filter((id) => !covered.has(id));

console.log(`\nFixture pairs: ${CASES.length} · assertions: ${pass + fail} · ${pass} passed · ${fail} failed`);
if (uncovered.length) console.log(`Uncovered rules (${uncovered.length}): ${uncovered.join(', ')}`);
if (failures.length) { console.log('\nFailures:'); for (const f of failures) console.log('  ✗ ' + f); }
const ok = fail === 0 && uncovered.length === 0;
console.log(ok ? '\n✓ all green\n' : '');
process.exit(ok ? 0 : 1);
