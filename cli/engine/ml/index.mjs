// Model layer (PITCH §17) — REAL local inference via a Python sidecar (torch + transformers +
// gliner). No stubs: every call here drives an actual model running in ml/mari_ml.py.
//
//   • NLI       — cross-encoder/nli-deberta-v3-xsmall : sentence-pair entailment (grounding T3)
//   • LM/ppl    — Qwen/Qwen3.5-0.8B                   : token perplexity → machine-likelihood
//   • GLiNER    — urchade/gliner_multi-v2.1           : zero-shot slop-span extraction
//
// The sidecar is a long-lived child process spoken to over JSON lines, so models load once.
// Models are opt-in (MARI_MODELS=1 / CLI --models): the deterministic core and the editor hook
// never spawn Python, staying instant. Availability is gated on a usable Python interpreter with
// the deps installed (the project .venv by default, or $MARI_PYTHON).

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');
const SCRIPT = join(ROOT, 'ml', 'mari_ml.py');

let _pyCache;
function pythonPath() {
  if (_pyCache !== undefined) return _pyCache;
  if (process.env.MARI_PYTHON && existsSync(process.env.MARI_PYTHON)) return (_pyCache = process.env.MARI_PYTHON);
  // venv candidates: package-root .venv, then cwd .venv; POSIX bin/ and Windows Scripts/ layouts
  for (const base of [ROOT, process.cwd()]) {
    for (const rel of [['bin', 'python'], ['Scripts', 'python.exe']]) {
      const p = join(base, '.venv', ...rel);
      if (existsSync(p)) return (_pyCache = p);
    }
  }
  // last resort: python3 on PATH (deps may still be missing; the sidecar reports that on spawn)
  for (const name of process.platform === 'win32' ? ['python', 'python3'] : ['python3']) {
    try {
      const r = spawnSync(name, ['--version'], { stdio: 'ignore' });
      if (r.status === 0) return (_pyCache = name);
    } catch { /* not on PATH */ }
  }
  return (_pyCache = null);
}

export function modelsEnabled() {
  return ['1', 'true', 'on'].includes(process.env.MARI_MODELS || '');
}

export function capabilities() {
  return {
    enabled: modelsEnabled(),
    python: pythonPath(),
    available: !!pythonPath() && existsSync(SCRIPT),
    runtime: 'python sidecar (torch/transformers/gliner)',
    models: { nli: 'cross-encoder/nli-deberta-v3-xsmall', ppl: process.env.MARI_PPL_MODEL || 'Qwen/Qwen3.5-0.8B', gliner: process.env.MARI_GLINER_MODEL || 'urchade/gliner_multi-v2.1',
      decomp: process.env.MARI_DECOMP_MODEL || 'Qwen/Qwen2.5-0.5B-Instruct', lookback: process.env.MARI_LOOKBACK_MODEL || 'Qwen/Qwen3-0.6B',
      embed: process.env.MARI_EMBED_MODEL || 'Qwen/Qwen3.5-0.8B' },
  };
}

// --- persistent sidecar with a request queue --------------------------------

let _proc = null, _rl = null;
const _queue = [];

function ensureProc() {
  if (_proc) return _proc;
  const py = pythonPath();
  if (!py || !existsSync(SCRIPT)) throw new Error('Mari ML sidecar unavailable: no Python venv (.venv) or ml/mari_ml.py. Run: python3.12 -m venv .venv && .venv/bin/pip install -r ml/requirements.txt');
  _proc = spawn(py, [SCRIPT], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] });
  _proc.on('exit', () => { _proc = null; _rl = null; while (_queue.length) _queue.shift().reject(new Error('sidecar exited')); });
  _rl = createInterface({ input: _proc.stdout });
  _rl.on('line', (line) => {
    const waiter = _queue.shift();
    if (!waiter) return;
    try { const obj = JSON.parse(line); obj.error ? waiter.reject(new Error(obj.error)) : waiter.resolve(obj); }
    catch (e) { waiter.reject(e); }
  });
  return _proc;
}

function request(payload) {
  ensureProc();
  return new Promise((resolve, reject) => {
    _queue.push({ resolve, reject });
    _proc.stdin.write(JSON.stringify(payload) + '\n');
  });
}

// Front-load only the models the caller will actually use. Each model is ~0.5-2 GB to load
// (and downloads on first ever use), so touching all three when the run needs one is the
// difference between "instant" and "looks hung". Defaults to none — pass what you need.
export async function warmup({ ppl = false, nli = false, spans = false } = {}) {
  await request({ task: 'ping' });
  const jobs = [];
  if (nli) jobs.push(request({ task: 'nli', premise: 'a', hypothesis: 'a' }).catch(() => {}));
  if (ppl) jobs.push(request({ task: 'perplexity', text: 'warm up the model' }).catch(() => {}));
  if (spans) jobs.push(request({ task: 'spans', text: 'warm up the model', labels: ['x'] }).catch(() => {}));
  await Promise.all(jobs);
}

export function shutdown() { if (_proc) { try { _proc.stdin.end(); } catch {} _proc = null; } }

// --- public API (same shape the rest of the engine expects) -----------------

export async function nliEntail(premise, hypothesis) {
  const r = await request({ task: 'nli', premise, hypothesis });
  return { label: r.label, scores: r.scores };
}

export async function perplexity(text) {
  const r = await request({ task: 'perplexity', text });
  return r.ppl;
}

// Sentence embeddings for code<->doc association. Returns an array of L2-normalized vectors
// (one per input string), so cosine similarity is a plain dot product. Batched in the sidecar.
export async function embed(texts, { instruct } = {}) {
  const arr = Array.isArray(texts) ? texts : [texts];
  if (!arr.length) return [];
  const r = await request({ task: 'embed', texts: arr, ...(instruct ? { instruct } : {}) });
  return r.vectors || [];
}
export function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }

// Tier 2: atomic-claim decomposition (instruct LM). A sentence → array of self-contained claims.
export async function decomposeClaims(text) {
  const r = await request({ task: 'decompose', text });
  return r.claims || [];
}

// Tier 4: Lookback-Lens attention grounding. spans = [[start,end],…] char offsets into
// `candidate`. Returns [{start,end,lookback,grounded}] — low lookback = the model didn't attend
// to the provided context at that span.
export async function lookbackGrounding(context, candidate, spans, threshold = 0.10) {
  const r = await request({ task: 'lookback', context, candidate, spans, threshold });
  return r.spans || [];
}

// Opt-in warmup for the heavy generative models — only touched when the caller asks for the
// corresponding tier, so the default `--models` path (NLI/ppl/GLiNER) never loads them.
export async function warmupGenerative({ decompose = false, lookback = false } = {}) {
  await request({ task: 'ping' });
  const jobs = [];
  if (decompose) jobs.push(request({ task: 'decompose', text: 'Mari was built in 2026.' }).catch(() => {}));
  if (lookback) jobs.push(request({ task: 'lookback', context: 'Mari was built in 2026.', candidate: 'Mari was built in 2026.', spans: [[0, 24]] }).catch(() => {}));
  await Promise.all(jobs);
}

export async function machineScore(text) {
  const ppl = await perplexity(text);
  if (ppl == null) return null;
  return 1 / (1 + Math.exp((ppl - 50) / 22)); // Qwen ppl ~20 → ~0.8 ; ~100 → ~0.1
}

// GLiNER slop spans — returns [{text,label,score,start,end}]. Real model; may be empty.
// GLiNER slop-span confidence gate. gliner_multi on concrete slop labels scores real buzzwords
// ~0.2-0.35 and tops out around ~0.12 on clean technical prose, so 0.15 is the separation point.
// (Override with MARI_SLOP_THRESHOLD; the sidecar also pre-filters at this level.)
export const SLOP_THRESHOLD = Number(process.env.MARI_SLOP_THRESHOLD) || 0.15;
export async function slopSpans(text, labels, threshold = SLOP_THRESHOLD) {
  const r = await request({ task: 'spans', text, labels, threshold });
  return r.spans || [];
}

// Map GLiNER spans → findings, deduped against deterministic hits: an overlapping span is a
// confidence boost (skipped to avoid double-reporting); a non-overlapping span is a paraphrased
// buzzword the wordlists missed → advisory `ml-slop-span` (PITCH §17). Locations resolved by caller.
export async function mlSlopFindings(text, deterministic, locate) {
  const spans = await slopSpans(text);
  const covered = deterministic.filter((f) => f.family === 'ai-slop').map((f) => [f.offset, f.offset + (f.length || 0)]);
  const out = [];
  for (const s of spans.slice(0, 12)) {
    if (s.score < SLOP_THRESHOLD) continue;
    // GLiNER's value here is multi-word paraphrased slop the single-token wordlists miss
    // ("our offering", "next-generation architecture"); lone words are noise or already covered.
    if (!/\s/.test(s.text.trim())) continue;
    const overlaps = covered.some(([a, b]) => s.start < b && s.end > a);
    if (overlaps) continue; // already caught deterministically; boost is implicit
    const { line, col } = locate(s.start);
    out.push({ ruleId: 'ml-slop-span', family: 'ai-slop', severity: 'advisory', source: 'ml-span',
      offset: s.start, length: s.end - s.start, line, col, span: s.text,
      message: `Reads as ${s.label} (model, ${(s.score * 100).toFixed(0)}%) — a paraphrased tell the wordlists miss.` });
  }
  return out;
}
