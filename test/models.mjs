#!/usr/bin/env node
// Real-model tests — downloads (once, cached) and RUNS the actual ONNX models. Slow (~30s first
// run), so it's a separate `npm run test:models`, not part of the fast default suite.

import { nliEntail, perplexity, machineScore, capabilities, slopSpans, shutdown,
  lookbackGrounding, warmupGenerative } from '../cli/engine/ml/index.mjs';
import { claudeDecomposeBatch, claudeCliAvailable } from '../cli/engine/decompose.mjs';
import { factcheckNLI, factcheckDecomposed, factcheckLookback, parseFacts } from '../cli/engine/grounding.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✓ ${name}${extra && '  ' + extra}`); } else { fail++; console.log(`  ✗ ${name}  ${extra}`); } };

const caps = capabilities();
console.log('capabilities:', JSON.stringify(caps.models));
if (!caps.available) {
  console.log('SKIP: ML sidecar unavailable (no Python with ml/requirements.txt installed).');
  console.log('      Opt in with: python3 -m venv .venv && .venv/bin/pip install -r ml/requirements.txt');
  process.exit(0);
}

// Probe the sidecar: a Python without the ml deps (e.g. bare PATH python3) should SKIP, not crash.
try {
  await nliEntail('probe', 'probe');
} catch (e) {
  if (/ModuleNotFoundError|No module named|sidecar exited|sidecar unavailable/i.test(String(e.message))) {
    console.log('SKIP: Python found but ML deps missing. Opt in with:');
    console.log('      python3 -m venv .venv && .venv/bin/pip install -r ml/requirements.txt');
    shutdown();
    process.exit(0);
  }
  throw e;
}

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

// --- Tier 2: atomic-claim decomposition (Claude-backed; needs the `claude` CLI) ---
if (!claudeCliAvailable()) {
  console.log('  ~ decompose tests SKIPPED (claude CLI not available; set MARI_CLAUDE_BIN to enable)');
} else {
  const [claims] = await claudeDecomposeBatch(['Mari, built in 2026, ships 90 rules and runs on the CPU.']);
  check('decompose returns multiple atomic claims', Array.isArray(claims) && claims.length >= 2, `(${claims.length})`);
  check('decompose preserves the number 90', claims.some((c) => /\b90\b/.test(c)));
  check('decompose preserves the year 2026', claims.some((c) => /\b2026\b/.test(c)));
  const dFacts = parseFacts('- Mari ships 90 rules.\n- Mari runs on the CPU.');
  const dFinds = await factcheckDecomposed('Mari ships 62 rules and runs on the CPU.', dFacts, { nli: nliEntail, decompose: claudeDecomposeBatch });
  check('decomposed factcheck isolates the bad atomic claim',
    dFinds.some((f) => f.ruleId === 'number-date-mismatch' || f.ruleId === 'contradicts-fact'),
    `(${dFinds.map((f) => f.ruleId).join(',') || 'none'})`);
}

// --- Tier 4: Lookback-Lens (relative ordering, robust to absolute-value drift) ---
await warmupGenerative({ lookback: true });
const lbCtx = 'Mari was built in 2026. Mari ships 90 detector rules.';
const grounded = 'Mari ships 90 detector rules.';
const madeUp = 'Mari was funded by a 14 million dollar Series A from Acme Ventures.';
const [g] = await lookbackGrounding(lbCtx, grounded, [[0, grounded.length]], 0);
const [u] = await lookbackGrounding(lbCtx, madeUp, [[0, madeUp.length]], 0);
check('lookback: grounded span attends to context more than a fabricated one', g.lookback > u.lookback, `(${g.lookback} > ${u.lookback})`);
// threshold above the observed absolute lookback so the fabricated span is actually flagged
const lbFinds = await factcheckLookback(madeUp, parseFacts('- ' + lbCtx), { lookback: lookbackGrounding, threshold: 0.95 });
check('factcheckLookback emits an ungrounded-span finding with a real offset',
  lbFinds.length >= 1 && lbFinds.every((f) => f.ruleId === 'ungrounded-span' && typeof f.offset === 'number'), `(${lbFinds.length})`);

console.log(`\nModels: ${pass + fail} checks · ${pass} passed · ${fail} failed`);
shutdown();
process.exit(fail === 0 ? 0 : 1);
