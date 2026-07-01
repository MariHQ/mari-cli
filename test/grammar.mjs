#!/usr/bin/env node
// Grammar pass (Harper) smoke + behavioral test. NOT in the fast `npm test` chain — it loads an
// ~18 MB WASM blob. Run with `npm run test:grammar`. Skips cleanly if harper.js isn't installed.

import { grammarAvailable, detectGrammar, DEFAULT_GRAMMAR_KINDS } from '../cli/engine/grammar.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name); } };

if (!(await grammarAvailable())) {
  console.log('');
  console.log('==================================================================');
  console.log('  SKIP: grammar tests NOT RUN — harper.js is not installed.');
  console.log('  Run `npm i harper.js` to enable the optional grammar pass.');
  console.log('==================================================================');
  console.log('');
  process.exit(0);
}

// 1. Catches a clear broken-English error and offers a suggestion.
const bad = await detectGrammar('# Title\n\nThis allows to deliver the the results to an user.\n');
check('flags at least one grammar finding', bad.length >= 1);
check('every finding has grammar family + source', bad.every((f) => f.family === 'grammar' && f.source === 'grammar'));
check('every finding has a line and offset', bad.every((f) => typeof f.line === 'number' && typeof f.offset === 'number'));
check('ruleIds are namespaced grammar-*', bad.every((f) => f.ruleId.startsWith('grammar-')));
check('catches the structural error "allows to deliver"', bad.some((f) => /allows/i.test(f.span)));
check('catches the wrong indefinite article "an user"', bad.some((f) => /indefinite article/i.test(f.message)));
check('messages carry a suggestion where Harper has one', bad.some((f) => /Suggested:/.test(f.message)));
// Repetition ("the the") is intentionally dropped from the default kinds — Mari's own
// deterministic `repeated-word` rule already covers it, so Harper shouldn't double-fire.
check('Repetition excluded from default kinds (Mari has repeated-word)', !DEFAULT_GRAMMAR_KINDS.has('Repetition'));

// 2. Code is skipped (Harper markdown parser); clean prose stays quiet.
const code = await detectGrammar('```js\nconst x = teh brokenn varr;\n```\n');
check('code fence produces no grammar findings', code.length === 0);
const clean = await detectGrammar('# Overview\n\nThe service reads the queue and writes the result. It runs once per minute.\n');
check('clean prose produces no grammar findings', clean.length === 0);

// 3. Noisy kinds are excluded by default (no Spelling/Typo/Capitalization on technical terms).
const tech = await detectGrammar('# SQL Client\n\nSet the classpath and the non-empty entrypoint for JUnit.\n');
check('technical jargon not flagged (Spelling/Typo/Capitalization dropped)', tech.length === 0);
check('default kinds exclude Spelling/Typo/Capitalization',
  !DEFAULT_GRAMMAR_KINDS.has('Spelling') && !DEFAULT_GRAMMAR_KINDS.has('Typo') && !DEFAULT_GRAMMAR_KINDS.has('Capitalization'));

console.log(`\nGrammar: ${pass + fail} checks · ${pass} passed · ${fail} failed`);
console.log(fail === 0 ? '✓ grammar green\n' : '');
process.exit(fail === 0 ? 0 : 1);
