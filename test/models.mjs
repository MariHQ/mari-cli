#!/usr/bin/env node
// Real-model tests — downloads (once, cached) and RUNS the actual ONNX models. Slow (~30s first
// run), so it's a separate `npm run test:models`, not part of the fast default suite.

import { nliEntail, perplexity, machineScore, capabilities, slopSpans, shutdown } from '../cli/engine/ml/index.mjs';
import { factcheckNLI, parseFacts } from '../cli/engine/grounding.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}${extra && '  ' + extra}`); } else { fail++; console.log(`  ✗ ${name}  ${extra}`); } };

console.log('capabilities:', JSON.stringify(capabilities().models));

// --- NLI entailment ---
const contra = await nliEntail('Mari ships 90 detector rules.', 'Mari ships 62 detector rules.');
check('NLI detects contradiction', contra.label === 'contradiction', `(${(contra.scores.contradiction * 100).toFixed(0)}%)`);
const entail = await nliEntail('Mari ships 90 detector rules.', 'Mari has ninety rules.');
check('NLI detects entailment', entail.label === 'entailment', `(${(entail.scores.entailment * 100).toFixed(0)}%)`);
const neutral = await nliEntail('Mari ships 90 detector rules.', 'The weather is nice.');
check('NLI detects neutral', neutral.label === 'neutral', `(${(neutral.scores.neutral * 100).toFixed(0)}%)`);

// --- perplexity ---
const pplAI = await perplexity('It is important to note that we must delve into the tapestry of innovation.');
const pplHuman = await perplexity('I forgot my umbrella again, classic me, soaked to the bone.');
check('perplexity: predictable < surprising', pplAI < pplHuman, `(${pplAI.toFixed(0)} < ${pplHuman.toFixed(0)})`);

const ms = await machineScore('It is important to note that we must delve into the tapestry of innovation.');
check('machineScore in [0,1]', ms > 0 && ms < 1, `(${ms.toFixed(2)})`);

// --- end-to-end: semantic contradiction (no number mismatch) caught only by NLI ---
const facts = parseFacts('- The Mari detector runs entirely on the local CPU with no API key.');
const finds = await factcheckNLI('The Mari detector requires a paid cloud API key to run.', facts, { nli: nliEntail });
check('NLI factcheck catches semantic contradiction', finds.some((f) => f.ruleId === 'contradicts-fact'),
  `(${finds.map((f) => f.ruleId).join(',') || 'none'})`);

// --- GLiNER runs (real inference; zero-shot slop recall is low by design) ---
const spans = await slopSpans('Our world-class platform empowers seamless synergy.', ['marketing buzzword', 'jargon'], 0.1);
check('GLiNER returns an array of spans', Array.isArray(spans), `(${spans.length} spans)`);

console.log(`\nModels: ${pass + fail} checks · ${pass} passed · ${fail} failed`);
shutdown();
process.exit(fail === 0 ? 0 : 1);
