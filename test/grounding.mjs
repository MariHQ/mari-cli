#!/usr/bin/env node
// Tier-0 grounding tests: deterministic typed-span fact-checking.

import { parseFacts, factcheck, typedSpans, entities } from '../cli/engine/grounding.mjs';

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

// C1: dedup is by offset range, not substring — a standalone "5" survives next to "50%"
const c1 = typedSpans('All 5 nodes serve 50% of requests.');
check('standalone 5 survives near 50%', c1.some((s) => s.kind === 'count' && s.value === 5));
check('50% is still a percent span', c1.some((s) => s.kind === 'percent' && s.value === 50));

// C2: ISO and prose notations canonicalize to the same date
const isoVal = typedSpans('Released on 2024-03-15.').find((s) => s.kind === 'date')?.value;
check('ISO date canonical', isoVal === '2024-03-15');
check('prose "March 15, 2024" canonicalizes to ISO', typedSpans('Released on March 15, 2024.').find((s) => s.kind === 'date')?.value === '2024-03-15');
check('prose "15 March 2024" canonicalizes to ISO', typedSpans('Released on 15 March 2024.').find((s) => s.kind === 'date')?.value === '2024-03-15');
check('month-year canonicalizes to YYYY-MM', typedSpans('Released in March 2024.').find((s) => s.kind === 'date')?.value === '2024-03');

const DATE_FACTS = parseFacts('- The Falcon launch happened on 2024-03-15.');
check('ISO vs prose same date → no mismatch',
  !factcheck('The Falcon launch happened on March 15, 2024.', DATE_FACTS).some((f) => f.ruleId === 'number-date-mismatch'));
check('genuinely different dates still flagged',
  ruleAt(factcheck('The Falcon launch happened on March 16, 2024.', DATE_FACTS), 'number-date-mismatch'));

// C11: a lone sentence-initial capital is not an entity; real names and acronyms are
const ents = entities('The server failed. Falcon Heavy retried it after NASA called.');
check('sentence-initial "The" is not an entity', !ents.has('the'));
check('multi-word names and acronyms still extracted', ents.has('falcon heavy') && ents.has('nasa'));
check('mid-sentence single capitalized name still an entity', entities('We asked Falcon to retry.').has('falcon'));

// 6. source mode promotes unsupported to warn
const src = parseFacts('The server handles 100 sessions.', { asDocument: true });
const srcFinds = factcheck('The server handles 900 sessions.', src, { sourceMode: true });
check('source mode flags the mismatch', srcFinds.some((f) => f.severity === 'error' || f.severity === 'warn'));

console.log(`\nGrounding: ${pass + fail} checks · ${pass} passed · ${fail} failed`);
console.log(fail === 0 ? '✓ grounding green\n' : '');
process.exit(fail === 0 ? 0 : 1);
