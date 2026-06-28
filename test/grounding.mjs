#!/usr/bin/env node
// Tier-0 grounding tests: deterministic typed-span fact-checking.

import { parseFacts, factcheck, typedSpans } from '../cli/engine/grounding.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name); } };
const ruleAt = (finds, rule) => finds.some((f) => f.ruleId === rule);

const FACTS = parseFacts(`# FACTS
- Mari ships 90 deterministic detector rules.
- The Mari project launched in 2026.
- A Mari scan costs 0 dollars and needs no API key.
`);

// typed-span extraction sanity
const spans = typedSpans('We raised $30 million in 2021 with 12% growth.');
check('extracts money', spans.some((s) => s.kind === 'money' && s.value === 30000000));
check('extracts year', spans.some((s) => s.kind === 'year' && s.value === 2021));
check('extracts percent', spans.some((s) => s.kind === 'percent' && s.value === 12));

// 1. number contradiction → error
check('number contradiction fires',
  ruleAt(factcheck('Mari ships 62 deterministic detector rules.', FACTS), 'contradicts-fact'));

// 2. date/year contradiction → number-date-mismatch
check('year contradiction fires',
  ruleAt(factcheck('The Mari project launched in 2019.', FACTS), 'number-date-mismatch'));

// 3. consistent claim → no finding
check('consistent claim is silent',
  factcheck('Mari ships 90 deterministic detector rules.', FACTS).length === 0);

// 4. unrelated numeric claim → unsupported (advisory)
const uns = factcheck('The web server handles 500 concurrent sessions.', FACTS);
check('unsupported numeric claim is advisory', uns.some((f) => f.ruleId === 'unsupported-claim' && f.severity === 'advisory'));

// 5. opinion (no typed span) → ignored
check('opinion is ignored', factcheck('Mari is genuinely delightful to use.', FACTS).length === 0);

// 6. source mode promotes unsupported to warn
const src = parseFacts('The server handles 100 sessions.', { asDocument: true });
const srcFinds = factcheck('The server handles 900 sessions.', src, { sourceMode: true });
check('source mode flags the mismatch', srcFinds.some((f) => f.severity === 'error' || f.severity === 'warn'));

console.log(`\nGrounding: ${pass + fail} checks · ${pass} passed · ${fail} failed`);
console.log(fail === 0 ? '✓ grounding green\n' : '');
process.exit(fail === 0 ? 0 : 1);
