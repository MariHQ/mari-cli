// Tier 2: atomic-claim decomposition — done by Claude, never a local model and never a spawn.
//
// Splitting a sentence into self-contained factual claims is a generative NL task. The old path
// loaded a 0.5B instruct LM just for this — a job the model orchestrating Mari does far better.
// So there is no decomposer model, and the CLI never shells out to `claude`: decomposition is a
// skill step. Claude (running the mari skill) decomposes in-session and hands the claims back via
// `mari factcheck --claims <file>`. `mari factcheck --emit-claim-targets` prints exactly the
// sentence list to decompose, so the returned order is a stable contract with `--claims`.
//
// The consumer is `factcheckDecomposed(..., { decompose })`, where `decompose` is a batch fn:
// string[] sentences → string[][] claims aligned by index. The CLI builds that fn from the
// loaded --claims file; standalone (no --claims) there is simply no decomposition and factcheck
// falls back to whole-sentence NLI grounding.

import { readFileSync } from 'node:fs';

function dedupe(arr) {
  const seen = new Set(), out = [];
  for (const c of arr) { const k = c.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(c); } }
  return out;
}

// Normalize any parsed decomposition into `n` sentence-aligned claim-arrays. Accepts either the
// aligned form (array of claim-arrays) or the labeled form ([{ i, claims }]) — both are things the
// skill might reasonably write.
function normalizeClaims(parsed, n) {
  const out = Array.from({ length: n }, () => []);
  if (!Array.isArray(parsed)) return out;
  const clean = (claims) => dedupe((Array.isArray(claims) ? claims : []).filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim())).slice(0, 8);
  if (parsed.length && parsed.every((e) => e && typeof e === 'object' && !Array.isArray(e) && Number.isInteger(e.i))) {
    for (const e of parsed) if (e.i >= 0 && e.i < n) out[e.i] = clean(e.claims);
  } else {
    for (let i = 0; i < Math.min(n, parsed.length); i++) out[i] = clean(parsed[i]);
  }
  return out;
}

// Load a pre-decomposed claims file (the skill writes this after Claude decomposes in-session).
export function loadClaimsFile(path, nTargets) {
  return normalizeClaims(JSON.parse(readFileSync(path, 'utf8')), nTargets);
}
