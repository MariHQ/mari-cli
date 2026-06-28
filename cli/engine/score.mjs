// Document slop score 0–100 (PITCH §18) — deterministic terms only (the "--no-models" blend).
// A weighted density of findings, minus a human-signal discount (contractions / first-person /
// genuine voice correlate with human writing). The breakdown is always returned so the number is
// explainable — Mari never asserts "this is AI-written," it shows why a passage reads machine-made.

import { segment } from './segment.mjs';

const SEV_WEIGHT = { error: 3, warn: 2, advisory: 1 };
// families contribute differently: AI-slop and grounding dominate; style/clarity are softer signals
const FAM_WEIGHT = { 'ai-slop': 1.0, grounding: 1.0, inclusive: 0.5, clarity: 0.4, style: 0.3 };

// `machine` (optional) is a 0–1 model-derived machine-likelihood (GPT-2 perplexity); when present
// it contributes one weak term to the score, never dominating, exactly as PITCH §18 specifies.
export function scoreDocument(text, findings, { machine = null } = {}) {
  const ctx = segment(text);
  const words = Math.max(ctx.wordCount, 1);

  let weighted = 0;
  const byFamily = {};
  for (const f of findings) {
    const w = (SEV_WEIGHT[f.severity] || 1) * (FAM_WEIGHT[f.family] ?? 0.3);
    weighted += w;
    byFamily[f.family] = (byFamily[f.family] || 0) + 1;
  }
  const per1k = (weighted / words) * 1000;

  // human-signal discount: contractions + first-person voice
  const contractions = (ctx.masked.match(/\b\w+['’](t|s|re|ve|ll|d|m)\b/gi) || []).length;
  const firstPerson = (ctx.masked.match(/\b(I|I'm|we|we're|my|our|me|us)\b/g) || []).length;
  const humanPer1k = ((contractions + firstPerson) / words) * 1000;
  const discount = Math.min(15, humanPer1k * 1.5);

  // saturating map: a lot of slop approaches 100 without ever exceeding it
  const base = 100 * (1 - Math.exp(-per1k / 35));
  // optional model term: blend in machine-likelihood (weak — at most ~20% pull)
  const deterministic = Math.max(0, base - discount);
  const score = Math.round(Math.max(0, Math.min(100,
    machine == null ? deterministic : 0.8 * deterministic + 0.2 * (machine * 100))));

  return {
    score,
    band: score >= 60 ? 'heavy' : score >= 30 ? 'moderate' : score >= 12 ? 'light' : 'clean',
    breakdown: {
      words,
      findings: findings.length,
      weightedDensityPer1k: +per1k.toFixed(2),
      byFamily,
      humanSignals: { contractions, firstPerson, discount: +discount.toFixed(2) },
      ...(machine == null ? {} : { machineLikelihood: +machine.toFixed(3) }),
    },
  };
}

export function renderScore(file, s) {
  const b = s.breakdown;
  const fam = Object.entries(b.byFamily).map(([k, v]) => `${k}:${v}`).join(' ');
  return [
    `${file} — slop score ${s.score}/100 (${s.band})`,
    `  ${b.findings} findings · weighted density ${b.weightedDensityPer1k}/1k words · ${b.words} words`,
    `  families: ${fam || '(none)'}`,
    `  human-signal discount: −${b.humanSignals.discount} (${b.humanSignals.contractions} contractions, ${b.humanSignals.firstPerson} first-person)`,
  ].join('\n');
}
