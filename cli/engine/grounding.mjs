// Grounding — Tier 0 only (deterministic, no models). Extracts typed spans (numbers, money,
// percentages, years, dates, named entities) from each claim and from FACTS.md, retrieves the
// most relevant fact by token/entity overlap, and flags value mismatches. This is the
// "wrong-number / wrong-date / wrong-name" hallucination, with the exact evidence line cited.
//
// Tiers 1–4 (embedding retrieval, NLI entailment, attention grounding) need models and are out
// of scope here; Tier 0 is the high-precision backbone.

import { segment } from './segment.mjs';

const STOP = new Set(('a an the and or but of to in on at by for with from as is are was were be been being ' +
  'it its this that these those there their they them we our us you your he she his her i me my ' +
  'has have had do does did will would can could should may might must not no yes if then than ' +
  'so such into over under about after before between during through up down out off only just ' +
  'also more most some any all each every other another which who whom whose what when where why how').split(' '));

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december';
const MONTH_NUM = Object.fromEntries(MONTHS.split('|').map((m, i) => [m, i + 1]));
// Canonical date form: ISO. `YYYY-MM-DD` for full dates, `YYYY-MM` for month+year only, so the
// same date written as "2024-03-15" and "March 15, 2024" always compares equal.
const isoDate = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}${d ? '-' + String(d).padStart(2, '0') : ''}`;

export function contentTokens(s) {
  return (s.toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []).filter((w) => !STOP.has(w));
}

export function entities(s) {
  const out = new Set();
  // Capitalized word sequences. A LONE sentence-initial capitalized word is just the start of a
  // sentence ("The", "This"), not an entity — skip it unless it's an acronym or carries a digit.
  let m; const re = /\b([A-Z][A-Za-z0-9]+(?:\s+(?:[A-Z][A-Za-z0-9]+|of|the|and))*)\b/g;
  while ((m = re.exec(s))) {
    const e = m[1].trim();
    if (!/\s/.test(e) && !/[0-9]/.test(e) && !/^[A-Z]{2,}$/.test(e)) {
      const before = s.slice(0, m.index);
      if (/^\s*$/.test(before) || /[.!?:;]\s*$/.test(before) || /\n\s*$/.test(before)) continue;
    }
    const el = e.toLowerCase();
    if (el.length > 2) out.add(el);
  }
  // all-caps acronyms
  let a; const ar = /\b[A-Z]{2,6}\b/g;
  while ((a = ar.exec(s))) out.add(a[0].toLowerCase());
  return out;
}

// Typed numeric/date spans, normalized so we can compare like-for-like. Spans carry their
// character offsets; overlap between candidate matches is decided by OFFSET RANGE, not by raw
// substring containment — so a standalone "5" is kept even when a "50%" appears nearby.
export function typedSpans(s) {
  const spans = [];
  const push = (kind, value, raw, start) => spans.push({ kind, value, raw, start, end: start + raw.length });
  const covered = (start, end) => spans.some((sp) => start < sp.end && end > sp.start);
  let m;
  // percentages
  const pct = /(\d+(?:\.\d+)?)\s?%/g;
  while ((m = pct.exec(s))) push('percent', parseFloat(m[1]), m[0], m.index);
  // money (with optional magnitude word)
  const money = /\$\s?(\d[\d,]*(?:\.\d+)?)\s?(million|billion|thousand|k|m|b)?/gi;
  while ((m = money.exec(s))) push('money', scaleMoney(m[1], m[2]), m[0], m.index);
  // ISO date → canonical ISO
  const iso = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(s))) push('date', isoDate(m[1], +m[2], +m[3]), m[0], m.index);
  // DD Month YYYY → canonical ISO (checked before Month YYYY so "15 March 2024" isn't
  // half-consumed as a month-year span)
  const dmy = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS})\\s*,?\\s*(\\d{4})\\b`, 'gi');
  while ((m = dmy.exec(s))) { if (!covered(m.index, m.index + m[0].length)) push('date', isoDate(m[3], MONTH_NUM[m[2].toLowerCase()], +m[1]), m[0], m.index); }
  // Month DD, YYYY  /  Month YYYY → canonical ISO (YYYY-MM-DD / YYYY-MM)
  const md = new RegExp(`\\b(${MONTHS})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s*,?\\s*(\\d{4})\\b|\\b(${MONTHS})\\s+(\\d{4})\\b`, 'gi');
  while ((m = md.exec(s))) {
    if (covered(m.index, m.index + m[0].length)) continue;
    if (m[1]) push('date', isoDate(m[3], MONTH_NUM[m[1].toLowerCase()], +m[2]), m[0], m.index);
    else push('date', isoDate(m[5], MONTH_NUM[m[4].toLowerCase()]), m[0], m.index);
  }
  // years (standalone), excluding ones already inside a money/percent/date span
  const yr = /\b(19|20)\d{2}\b/g;
  while ((m = yr.exec(s))) { if (!covered(m.index, m.index + m[0].length)) push('year', parseInt(m[0], 10), m[0], m.index); }
  // plain counts (not part of the above)
  const num = /\b\d[\d,]*(?:\.\d+)?\b/g;
  while ((m = num.exec(s))) {
    if (covered(m.index, m.index + m[0].length)) continue;
    push('count', parseFloat(m[0].replace(/,/g, '')), m[0], m.index);
  }
  return spans;
}

function scaleMoney(numStr, mag) {
  let v = parseFloat(numStr.replace(/,/g, ''));
  const u = (mag || '').toLowerCase();
  if (u === 'thousand' || u === 'k') v *= 1e3;
  else if (u === 'million' || u === 'm') v *= 1e6;
  else if (u === 'billion' || u === 'b') v *= 1e9;
  return v;
}

// Parse FACTS.md (or a --source doc) into fact records.
export function parseFacts(text, { asDocument = false } = {}) {
  if (asDocument) {
    const ctx = segment(text);
    return ctx.sentences.map((s) => ({ text: s.text.trim(), line: ctx.locate(s.start).line }))
      .filter((f) => f.text.length > 0);
  }
  const facts = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    let ln = lines[i].trim();
    if (!ln || ln.startsWith('#') || ln.startsWith('<!--')) continue;
    ln = ln.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '');
    let source = null;
    const sm = ln.match(/\s*[(\[]([^)\]]*(?:https?:\/\/|source:|\d{4})[^)\]]*)[)\]]\s*$/i);
    if (sm) { source = sm[1]; ln = ln.slice(0, sm.index).trim(); }
    if (ln) facts.push({ text: ln, line: i + 1, source });
  }
  return facts;
}

function relevance(claimTokens, claimEnts, fact) {
  const ft = new Set(contentTokens(fact.text));
  const fe = entities(fact.text);
  let shared = 0;
  for (const t of claimTokens) if (ft.has(t)) shared++;
  let sharedEnt = 0;
  for (const e of claimEnts) if (fe.has(e)) sharedEnt++;
  return { score: shared + 2 * sharedEnt, sharedTokens: shared };
}

// Two canonical dates agree when equal, or when one is a coarser truncation of the other
// ("2024-03" is compatible with "2024-03-15" — different granularity, not a contradiction).
const datesCompatible = (a, b) => a === b || a.startsWith(b + '-') || b.startsWith(a + '-');

// Compare typed spans by kind; a shared kind with disjoint value sets is a mismatch.
function findMismatch(claimSpans, factSpans) {
  for (const kind of new Set(claimSpans.map((s) => s.kind))) {
    const cv = claimSpans.filter((s) => s.kind === kind);
    const fv = factSpans.filter((s) => s.kind === kind);
    if (!fv.length) continue;
    const overlap = kind === 'date'
      ? cv.some((c) => fv.some((f) => datesCompatible(String(c.value), String(f.value))))
      : cv.some((c) => fv.some((f) => String(c.value) === String(f.value)));
    if (!overlap) return { kind, claim: cv[0], fact: fv[0] };
  }
  return null;
}

// Shared retrieval: the best-matching fact for a claim (shared content tokens, not just a name).
export function retrieve(cTokens, cEnts, facts) {
  let best = null, bestScore = 0, bestShared = 0;
  for (const fact of facts) {
    const { score, sharedTokens } = relevance(cTokens, cEnts, fact);
    if (score > bestScore) { bestScore = score; bestShared = sharedTokens; best = fact; }
  }
  return { best, score: bestScore, shared: bestShared, relevant: best && bestScore >= 3 && bestShared >= 1 };
}

const SEV_RANK = { error: 0, warn: 1, advisory: 2 };
export const sortFindings = (fs) => [...fs].sort((a, b) => (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || a.line - b.line);

// Tier 0 (sync, deterministic): typed-span mismatch + unsupported checkable claims.
export function factcheck(docText, facts, { sourceMode = false } = {}) {
  const ctx = segment(docText);
  const findings = [];
  const emit = (f) => { const { line, col } = ctx.locate(f.offset); findings.push({ ...f, line, col, family: 'grounding', source: 'grounding' }); };

  for (const s of ctx.sentences) {
    const claim = s.text.trim();
    const cSpans = typedSpans(claim);
    const cTokens = contentTokens(claim);
    const cEnts = entities(claim);
    if (!(cSpans.length > 0 && (cTokens.length >= 2 || cEnts.size >= 1))) continue;
    const { best, relevant } = retrieve(cTokens, cEnts, facts);
    const span = claim.slice(0, 70).replace(/\s+/g, ' ').trim();

    if (relevant) {
      const mismatch = findMismatch(cSpans, typedSpans(best.text));
      if (mismatch) {
        const ruleId = mismatch.kind === 'date' || mismatch.kind === 'year' ? 'number-date-mismatch' : 'contradicts-fact';
        emit({ ruleId, severity: 'error', offset: s.start, length: Math.min(claim.length, 70), span,
          message: `Says "${mismatch.claim.raw}" but FACTS.md says "${mismatch.fact.raw}"${best.source ? ` (${best.source})` : ''}: ${best.text}` });
      }
    } else {
      const sev = sourceMode ? 'warn' : 'advisory';
      const valued = cSpans.find((sp) => ['money', 'percent', 'year', 'date'].includes(sp.kind)) || cSpans[0];
      emit({ ruleId: 'unsupported-claim', severity: sev, offset: s.start, length: Math.min(claim.length, 70), span,
        message: `Claim "${valued.raw}" is not supported by ${sourceMode ? 'the source' : 'FACTS.md'} — verify or cite it.` });
    }
  }
  return sortFindings(findings);
}

// Tier 0 + Tier 3 (async): adds real NLI entailment so SEMANTIC contradictions and unsupported
// claims are caught, not just numeric ones. `nli` is the async (premise,hyp)→{label,scores} fn.
export async function factcheckNLI(docText, facts, { sourceMode = false, nli }) {
  const ctx = segment(docText);
  const findings = [];
  const emit = (f) => { const { line, col } = ctx.locate(f.offset); findings.push({ ...f, line, col, family: 'grounding', source: 'grounding' }); };

  for (const s of ctx.sentences) {
    const claim = s.text.trim();
    const cSpans = typedSpans(claim);
    const cTokens = contentTokens(claim);
    const cEnts = entities(claim);
    // a checkable claim has either a typed value OR enough substance to entail-check
    const checkable = (cSpans.length > 0 || cTokens.length >= 3) && (cTokens.length >= 2 || cEnts.size >= 1);
    if (!checkable) continue;
    const { best, relevant } = retrieve(cTokens, cEnts, facts);
    const span = claim.slice(0, 70).replace(/\s+/g, ' ').trim();

    // typed-span mismatch is the highest-precision signal — keep it as a hard error
    if (relevant) {
      const mismatch = findMismatch(cSpans, typedSpans(best.text));
      if (mismatch) {
        const ruleId = mismatch.kind === 'date' || mismatch.kind === 'year' ? 'number-date-mismatch' : 'contradicts-fact';
        emit({ ruleId, severity: 'error', offset: s.start, length: Math.min(claim.length, 70), span,
          message: `Says "${mismatch.claim.raw}" but FACTS.md says "${mismatch.fact.raw}"${best.source ? ` (${best.source})` : ''}: ${best.text}` });
        continue;
      }
    }

    if (relevant) {
      const verdict = await nli(best.text, claim); // premise=fact, hypothesis=claim
      const c = verdict.scores.contradiction ?? 0, e = verdict.scores.entailment ?? 0;
      if (c >= 0.6 && c > e) {
        emit({ ruleId: 'contradicts-fact', severity: 'error', offset: s.start, length: Math.min(claim.length, 70), span,
          message: `Contradicts FACTS.md (NLI ${(c * 100).toFixed(0)}%)${best.source ? ` (${best.source})` : ''}: ${best.text}` });
      } else if (e >= 0.55) {
        /* entailed → supported, no finding */
      } else {
        emit({ ruleId: 'unsupported-claim', severity: sourceMode ? 'warn' : 'advisory', offset: s.start, length: Math.min(claim.length, 70), span,
          message: `Related fact exists but doesn't support this claim (NLI neutral): ${best.text}` });
      }
    } else if (cSpans.length > 0) {
      const valued = cSpans.find((sp) => ['money', 'percent', 'year', 'date'].includes(sp.kind)) || cSpans[0];
      emit({ ruleId: 'unsupported-claim', severity: sourceMode ? 'warn' : 'advisory', offset: s.start, length: Math.min(claim.length, 70), span,
        message: `Claim "${valued.raw}" is not supported by ${sourceMode ? 'the source' : 'FACTS.md'} — verify or cite it.` });
    }
  }
  return sortFindings(findings);
}

// A sentence worth decomposing: long enough, and carrying a typed span (number/date/…) or
// enough content words to hold a checkable fact. Shared so `--emit-claim-targets` prints exactly
// the sentences `factcheckDecomposed` will ground — index alignment between the two is free.
function isClaimCandidate(parent) {
  return parent.length >= 12 && (typedSpans(parent).length > 0 || contentTokens(parent).length >= 4);
}

// The candidate sentences (in document order) that decomposition should split. Claude decomposes
// these in-session (via the mari skill); the returned order is the contract for `--claims`.
export function claimTargets(docText) {
  return segment(docText).sentences.map((s) => s.text.trim()).filter(isClaimCandidate);
}

// Tier 0 + Tier 2 + Tier 3: decompose sentences into atomic claims (via `decompose`, an async
// batch fn: string[] sentences → string[][] claims aligned by index), then ground EACH atomic
// claim with the same retrieve→typed-span→NLI pipeline. Decomposition is NOT a local model — it's
// done by Claude (the mari skill feeds pre-split claims via `--claims`), so `decompose` is just
// whatever the caller supplies. Atomic claims have no source offset, so every finding is anchored
// to its PARENT sentence and carries the atomic claim in the message. Falls back to whole-sentence
// grounding when decomposition yields nothing for a sentence.
export async function factcheckDecomposed(docText, facts, { sourceMode = false, nli, decompose }) {
  const ctx = segment(docText);
  const findings = [];
  const emit = (f) => { const { line, col } = ctx.locate(f.offset); findings.push({ ...f, line, col, family: 'grounding', source: 'grounding' }); };

  // Pre-filter to the same candidates `claimTargets` emits, so supplied claims align by index.
  const candidates = [];
  for (const s of ctx.sentences) {
    const parent = s.text.trim();
    if (isClaimCandidate(parent)) candidates.push({ s, parent });
  }

  // Decompose all candidates at once (the caller decides how — the CLI passes claims Claude wrote).
  let claimsByIdx = [];
  try { claimsByIdx = await decompose(candidates.map((c) => c.parent)); } catch { claimsByIdx = []; }

  for (let i = 0; i < candidates.length; i++) {
    const { s, parent } = candidates[i];
    let claims = claimsByIdx[i] || [];
    if (!claims.length) claims = [parent];

    const at = { offset: s.start, length: Math.min(parent.length, 70) };
    for (const claim of claims) {
      const cSpans = typedSpans(claim);
      const cTokens = contentTokens(claim);
      const cEnts = entities(claim);
      const checkable = (cSpans.length > 0 || cTokens.length >= 3) && (cTokens.length >= 2 || cEnts.size >= 1);
      if (!checkable) continue;
      const { best, relevant } = retrieve(cTokens, cEnts, facts);
      const span = claim.slice(0, 70).replace(/\s+/g, ' ').trim();

      if (relevant) {
        const mismatch = findMismatch(cSpans, typedSpans(best.text));
        if (mismatch) {
          const ruleId = (mismatch.kind === 'date' || mismatch.kind === 'year') ? 'number-date-mismatch' : 'contradicts-fact';
          emit({ ruleId, severity: 'error', ...at, span,
            message: `Claim "${span}" says "${mismatch.claim.raw}" but FACTS.md says "${mismatch.fact.raw}"${best.source ? ` (${best.source})` : ''}: ${best.text}` });
          continue;
        }
        const verdict = await nli(best.text, claim);
        const c = verdict.scores.contradiction ?? 0, e = verdict.scores.entailment ?? 0;
        if (c >= 0.6 && c > e) {
          emit({ ruleId: 'contradicts-fact', severity: 'error', ...at, span,
            message: `Atomic claim "${span}" contradicts FACTS.md (NLI ${(c * 100).toFixed(0)}%): ${best.text}` });
        } else if (e >= 0.55) {
          /* entailed → supported */
        } else {
          emit({ ruleId: 'unsupported-claim', severity: sourceMode ? 'warn' : 'advisory', ...at, span,
            message: `Atomic claim "${span}" not supported by ${sourceMode ? 'the source' : 'FACTS.md'} (NLI neutral): ${best.text}` });
        }
      } else if (cSpans.length > 0) {
        const valued = cSpans.find((sp) => ['money', 'percent', 'year', 'date'].includes(sp.kind)) || cSpans[0];
        emit({ ruleId: 'unsupported-claim', severity: sourceMode ? 'warn' : 'advisory', ...at, span,
          message: `Atomic claim "${valued.raw}" is unsupported by ${sourceMode ? 'the source' : 'FACTS.md'} — verify or cite it.` });
      }
    }
  }
  // collapse identical findings produced by sibling atomic claims of the same sentence
  const seen = new Set();
  const deduped = findings.filter((f) => { const k = `${f.ruleId}|${f.offset}|${f.message}`; return seen.has(k) ? false : (seen.add(k), true); });
  return sortFindings(deduped);
}

// Tier 4 (opt-in, generative): Lookback-Lens. `lookback(contextText, candidateText, spans)`
// returns [{start,end,lookback,grounded}] over candidate char-offsets. A low-lookback span is
// one the model didn't attend to the facts for — advisory, never an assertion of falsehood.
export async function factcheckLookback(docText, facts, { lookback, threshold = 0.10 }) {
  const ctx = segment(docText);
  const contextText = facts.map((f) => f.text).join('\n');
  if (!contextText.trim()) return [];
  const spans = ctx.sentences
    .filter((s) => s.text.trim().length >= 12)
    .map((s) => ({ s, span: [s.start, s.start + s.text.length] }));
  if (!spans.length) return [];
  const scored = await lookback(contextText, docText, spans.map((x) => x.span), threshold);
  const byStart = new Map(scored.map((r) => [r.start, r]));
  const findings = [];
  for (const { s } of spans) {
    const r = byStart.get(s.start);
    if (!r || r.grounded) continue;
    const { line, col } = ctx.locate(s.start);
    findings.push({ ruleId: 'ungrounded-span', severity: 'advisory', family: 'grounding', source: 'grounding',
      offset: s.start, length: Math.min(s.text.trim().length, 70), line, col, span: s.text.trim().slice(0, 70),
      message: `Reads as ungrounded in the provided facts (attention lookback ${(r.lookback * 100).toFixed(0)}%, threshold ${(threshold * 100).toFixed(0)}%) — verify it traces to a fact.` });
  }
  return sortFindings(findings);
}
