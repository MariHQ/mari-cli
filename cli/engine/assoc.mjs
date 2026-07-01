// Semantic association across a repo — UNIFORM. Every file (code, docs, config — anything
// textual) is treated identically: split into chunks and embedded into one shared space. There
// is no code/doc distinction. Two stages:
//
//   1. EMBEDDING recall — embed every chunk; for each chunk, find its nearest neighbors in the
//      shared space (ANN). This only SHORTLISTS candidate chunk pairs, cheaply.
//   2. ATTENTION association — attention decides whether two candidate chunks are semantically
//      associated (and at what strength). This is the real signal; embeddings just bound its cost.
//
// Both models are injected (embedFn, attnFn) so this module stays pure and testable. The index
// and the vector cache persist under .mari/assoc/ so a rebuild only re-embeds changed files.

import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';
import { createHash } from 'node:crypto';

const SKIP_DIR = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage', '.mari', 'target',
  'vendor', 'vendored', 'third_party', 'third-party', '.venv', '__pycache__', '.idea',
]);
// Textual files we chunk + embed. Broad on purpose — code, docs, config, schemas all count.
const TEXT_EXT = new Set([
  '.md', '.mdx', '.mdc', '.markdown', '.txt', '.rst', '.adoc',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.py', '.rb', '.php', '.go', '.rs', '.java',
  '.kt', '.kts', '.scala', '.swift', '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.m', '.mm',
  '.sql', '.sh', '.bash', '.zsh', '.lua', '.r', '.jl', '.dart', '.ex', '.exs', '.clj',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.proto', '.graphql', '.tf', '.hcl',
]);
const TEST_FILE = /(\.|_|-)(test|spec)\.[a-z]+$|\.d\.ts$|\.min\.js$/i;
const MAX_FILE_BYTES = 512 * 1024;
const CHUNK_LINES = +(process.env.MARI_ASSOC_CHUNK_LINES || 40);
const CHUNK_OVERLAP = +(process.env.MARI_ASSOC_CHUNK_OVERLAP || 8);

const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const toPosix = (p) => String(p).split(sep).join('/');
const round = (x) => Math.round(x * 1000) / 1000;
export function cosine(a, b) { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; }

// ── file discovery (uniform — every textual file) ──────────────────────────────────────────────
export function walkFiles(root, { maxEntries = 60000 } = {}) {
  const out = [];
  let count = 0;
  (function walk(dir) {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (count++ > maxEntries) return;
      if (e.isSymbolicLink()) continue;
      if (e.name.startsWith('.') && e.name !== '.mari') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(p); continue; }
      if (TEST_FILE.test(e.name)) continue;
      if (TEXT_EXT.has(extname(e.name).toLowerCase())) out.push(toPosix(relative(root, p)));
    }
  })(root);
  return out;
}

// ── uniform chunking (common sense: ~CHUNK_LINES-line windows, small overlap) ──────────────────
export function chunkFile(text, file) {
  const all = text.split('\n');
  const chunks = [];
  const step = Math.max(1, CHUNK_LINES - CHUNK_OVERLAP);
  for (let start = 0; start < all.length; start += step) {
    const slice = all.slice(start, start + CHUNK_LINES);
    const body = slice.join('\n').trim();
    if (body.length >= 40) {
      chunks.push({ id: `L${start + 1}`, file, startLine: start + 1,
        endLine: Math.min(start + CHUNK_LINES, all.length), text: body.slice(0, 2000) });
    }
    if (start + CHUNK_LINES >= all.length) break;
  }
  return chunks;
}

// ── embedding with a persistent per-chunk vector cache ─────────────────────────────────────────
async function embedChunks(embedFn, chunks, vectorCache, onProgress) {
  const vecs = new Array(chunks.length);
  const todo = [];
  for (let i = 0; i < chunks.length; i++) {
    const cached = vectorCache.get(chunks[i].file + '#' + chunks[i].id);
    if (cached && cached.hash === chunks[i]._fhash) vecs[i] = cached.v; else todo.push(i);
  }
  const BATCH = +(process.env.MARI_ASSOC_EMBED_BATCH || 128);
  for (let b = 0; b < todo.length; b += BATCH) {
    const idxs = todo.slice(b, b + BATCH);
    const fresh = await embedFn(idxs.map((i) => chunks[i].text));
    idxs.forEach((i, k) => {
      vecs[i] = fresh[k] || [];
      vectorCache.set(chunks[i].file + '#' + chunks[i].id, { hash: chunks[i]._fhash, v: vecs[i] });
    });
    if (todo.length > BATCH) onProgress(`embedded ${Math.min(b + BATCH, todo.length)}/${todo.length} chunks`);
  }
  return vecs;
}

// ── candidate recall: nearest neighbors in the shared space (brute force; Lance ANN when wired) ─
// Returns unordered unique cross-file pairs {i, j, cos} above threshold, top-annK per chunk.
function annCandidates(vecs, chunks, { cosThreshold, annK }) {
  const pairs = new Map();
  for (let i = 0; i < chunks.length; i++) {
    const near = [];
    for (let j = 0; j < chunks.length; j++) {
      if (i === j || chunks[i].file === chunks[j].file) continue; // don't associate a file with itself
      const c = cosine(vecs[i], vecs[j]);
      if (c >= cosThreshold) near.push({ j, c });
    }
    near.sort((a, b) => b.c - a.c);
    for (const { j, c } of near.slice(0, annK)) {
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      if (!pairs.has(key) || pairs.get(key).cos < c) pairs.set(key, { i: Math.min(i, j), j: Math.max(i, j), cos: c });
    }
  }
  return [...pairs.values()];
}

// ── build ───────────────────────────────────────────────────────────────────────────────────────
export async function buildAssoc(root, {
  embedFn, attnFn = null, vectorCache = new Map(), lanceDir = null,
  // Embeddings are loose RECALL — shortlist candidate pairs cheaply; attention (or the cosine
  // itself, without --attn) decides the association. A permissive floor suits recall, especially
  // with the Qwen base LM whose cosines run compressed. Tune with MARI_ASSOC_COS.
  cosThreshold = +(process.env.MARI_ASSOC_COS || 0.35), annK = 8, attnThreshold = 0.3, onProgress = () => {},
} = {}) {
  if (typeof embedFn !== 'function') throw new Error('buildAssoc needs embedFn — associations are built on embeddings.');
  const rels = walkFiles(root);
  onProgress(`scanning ${rels.length} files`);
  const chunks = [];
  const files = {};
  for (const rel of rels) {
    const abs = join(root, rel);
    let text; try { if (statSync(abs).size > MAX_FILE_BYTES) continue; text = readFileSync(abs, 'utf8'); } catch { continue; }
    const hash = sha1(text);
    const cs = chunkFile(text, rel);
    for (const c of cs) { c._fhash = hash; chunks.push(c); }
    files[rel] = { hash, chunks: cs.length };
  }

  // Vectors + nearest-neighbor recall go through Lance when a lanceDir is given (the CLI path);
  // tests/fallback use an in-memory cache + brute-force cosine.
  let lance = null;
  if (lanceDir) {
    lance = await import('./assoc-lance.mjs');
    const cached = await lance.lanceLoadCache(lanceDir);
    for (const [k, v] of cached) if (!vectorCache.has(k)) vectorCache.set(k, v);
  }
  onProgress(`chunked into ${chunks.length} chunks; embedding`);
  const vecs = await embedChunks(embedFn, chunks, vectorCache, onProgress);

  let cands;
  if (lance) {
    onProgress('storing vectors in Lance + ANN recall');
    await lance.lanceWrite(lanceDir, chunks, vecs);
    cands = await lance.lanceRecall(lanceDir, chunks, vecs, { annK, cosThreshold });
  } else {
    onProgress('recall: nearest neighbors');
    cands = annCandidates(vecs, chunks, { cosThreshold, annK });
  }
  onProgress(`${cands.length} candidate pairs`);

  let associations = [];
  if (attnFn) {
    onProgress(`attention: associating ${cands.length} candidate pairs`);
    for (const { i, j, cos } of cands) {
      const a = chunks[i], b = chunks[j];
      const r = await attnFn(a.text, b.text); // { score, associated }
      if (r && r.associated && (r.score ?? 0) >= attnThreshold) {
        associations.push(mkAssoc(a, b, round(r.score ?? cos), 'attention'));
      }
    }
  } else {
    for (const { i, j, cos } of cands) associations.push(mkAssoc(chunks[i], chunks[j], round(cos), 'embedding'));
  }
  associations.sort((x, y) => y.score - x.score);

  const index = { version: 2, root: '.', files: Object.keys(files).length, chunks: chunks.length,
    via: attnFn ? 'attention' : 'embedding', builtAt: null, filesMeta: files, associations };
  return { index, vectorCache, stats: { files: rels.length, chunks: chunks.length, candidates: cands.length, associations: associations.length } };
}

function mkAssoc(a, b, score, via) {
  return { a: { file: a.file, span: a.id, lines: [a.startLine, a.endLine] },
    b: { file: b.file, span: b.id, lines: [b.startLine, b.endLine] }, score, via };
}

// ── persistence ────────────────────────────────────────────────────────────────────────────────
export function assocDir(root) { return join(root, '.mari', 'assoc'); }
export function saveAssoc(root, index, vectorCache = null) {
  const dir = assocDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  if (vectorCache && vectorCache.size) {
    const obj = {}; for (const [k, v] of vectorCache) obj[k] = v;
    writeFileSync(join(dir, 'vectors.json'), JSON.stringify(obj));
  }
}
export function loadAssoc(root) {
  try { return JSON.parse(readFileSync(join(assocDir(root), 'index.json'), 'utf8')); } catch { return null; }
}
export function loadVectorCache(root) {
  const m = new Map();
  try { const o = JSON.parse(readFileSync(join(assocDir(root), 'vectors.json'), 'utf8')); for (const k of Object.keys(o)) m.set(k, o[k]); } catch { /* none */ }
  return m;
}

// ── lookup (symmetric — either side may be the edited file) ─────────────────────────────────────
export function associationsForFile(index, relPath) {
  if (!index?.associations) return [];
  const rel = toPosix(relPath);
  return index.associations
    .filter((x) => x.a.file === rel || x.b.file === rel)
    .map((x) => (x.a.file === rel ? x : { ...x, a: x.b, b: x.a })); // normalize edited file to `a`
}
