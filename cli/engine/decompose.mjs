// Tier 2: atomic-claim decomposition — done by Claude, never a local model.
//
// Splitting a sentence into self-contained factual claims is a generative NL task. The old path
// loaded a 0.5B instruct LM just for this — a job the model orchestrating Mari does far better.
// So there is no decomposer model; there are two ways to reach Claude, picked by context:
//
//   • embedded (Mari running inside a live Claude session, e.g. the mari skill): Claude decomposes
//     in-session and hands the claims back via `mari factcheck --claims <file>`. NO subprocess —
//     spawning `claude -p` from within a session would be a wasteful nested/recursive call.
//   • standalone (a human runs `mari factcheck --decompose` with no session around it): we shell
//     out to `claude -p` once for the whole document. This is top-level, not nested.
//
// The consumer is `factcheckDecomposed(..., { decompose })`, where `decompose` is a batch fn:
// string[] sentences → string[][] claims aligned by index. `mari factcheck --emit-claim-targets`
// prints exactly the sentence list the skill should decompose, so the returned order is a stable
// contract with `--claims`.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const CLAUDE_BIN = process.env.MARI_CLAUDE_BIN || 'claude';

const SYS =
  'You split sentences into atomic factual claims. An atomic claim states exactly one fact, is ' +
  'self-contained, and resolves every pronoun/reference to an explicit name from the sentence. ' +
  'Copy numbers, dates, names, and quantities verbatim — never invent or alter them. Ignore ' +
  'opinions, questions, instructions, and hedges; a sentence with no checkable fact gets [].';

// Are we running as a Bash tool call inside a Claude Code session? If so, `claude -p` would nest,
// so the decompose path must instead come from the skill via --claims (never a spawn from here).
export function insideClaudeSession() {
  return ['1', 'true'].includes(process.env.CLAUDECODE || '') || !!process.env.CLAUDE_CODE_ENTRYPOINT;
}

// Is the standalone `claude` CLI usable? (Cached — spawning `--version` per call is wasteful.)
let _cliOk;
export function claudeCliAvailable() {
  if (_cliOk !== undefined) return _cliOk;
  try { _cliOk = spawnSync(CLAUDE_BIN, ['--version'], { stdio: 'ignore', timeout: 5000 }).status === 0; }
  catch { _cliOk = false; }
  return _cliOk;
}

// Pull the first top-level JSON array out of a blob of model text (it may be fenced or prosey).
function firstJsonArray(text) {
  const start = text.indexOf('[');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) { try { return JSON.parse(text.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

function dedupe(arr) {
  const seen = new Set(), out = [];
  for (const c of arr) { const k = c.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(c); } }
  return out;
}

// Normalize any parsed decomposition into `n` sentence-aligned claim-arrays. Accepts either the
// aligned form (array of claim-arrays) or the labeled form ([{ i, claims }]) — both are things a
// skill or `claude -p` might reasonably produce.
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

function buildPrompt(sentences) {
  const numbered = sentences.map((s, i) => `${i}: ${s.replace(/\s+/g, ' ').trim()}`).join('\n');
  return `${SYS}\n\nFor each numbered sentence below, output its atomic factual claims. Respond with ` +
    `ONLY a JSON array whose elements are {"i": <the sentence number>, "claims": [<claim strings>]}. ` +
    `Include an entry for every sentence (use "claims": [] when there is no checkable fact). No prose.\n\n${numbered}`;
}

// Drive `claude -p` once and return its result text. Throws on a missing/broken CLI so the caller
// can fall back to whole-sentence grounding.
function runClaudeCli(prompt) {
  const r = spawnSync(CLAUDE_BIN, ['-p', prompt, '--output-format', 'json'],
    { encoding: 'utf8', timeout: Number(process.env.MARI_DECOMPOSE_TIMEOUT) || 120000, maxBuffer: 8 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`claude -p exited ${r.status}: ${(r.stderr || '').trim().slice(0, 200)}`);
  // --output-format json wraps the turn: { type, result, ... }. result holds the model's text.
  try { const obj = JSON.parse(r.stdout); return typeof obj.result === 'string' ? obj.result : r.stdout; }
  catch { return r.stdout; }
}

// Standalone decomposer: one top-level `claude -p` call for the whole batch of sentences.
export async function claudeDecomposeBatch(sentences) {
  if (!sentences.length) return [];
  return normalizeClaims(firstJsonArray(runClaudeCli(buildPrompt(sentences))), sentences.length);
}
