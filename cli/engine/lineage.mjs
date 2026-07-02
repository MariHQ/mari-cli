// Semantic lineage — a curated knowledge graph of span↔span associations (code↔doc, doc↔doc,
// code↔code) persisted in an embedded DuckDB at .mari/lineage.duckdb. Candidates come from the
// assoc index (embedding/attention) and from symbol mentions (symbols.mjs); a human or LLM then
// reviews each candidate and confirms/rejects it with a relation label. Confirmed edges carry a
// content hash of each span, so when either side later changes we can tell REAL drift (the
// curated text changed) from mere line movement — that drift is what `impact` reports and what
// the post-edit hook injects into the working session.

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';

const sha1 = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const toPosix = (p) => String(p).split(sep).join('/');

export const RELATIONS = ['documents', 'implements', 'describes', 'duplicates', 'derives-from', 'related'];
export const STATUSES = ['proposed', 'confirmed', 'rejected'];

export function lineagePath(root) { return join(root, '.mari', 'lineage.duckdb'); }
export function lineageExists(root) { return existsSync(lineagePath(root)); }

// ── connection (lazy native import — the rest of mari never pays for DuckDB) ───────────────────
const SCHEMA = `
CREATE SEQUENCE IF NOT EXISTS lineage_id START 1;
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY DEFAULT nextval('lineage_id'),
  src_file TEXT NOT NULL, src_start INTEGER NOT NULL, src_end INTEGER NOT NULL,
  dst_file TEXT NOT NULL, dst_start INTEGER NOT NULL, dst_end INTEGER NOT NULL,
  src_symbol TEXT, dst_symbol TEXT,
  rel TEXT DEFAULT 'related',        -- documents | implements | describes | duplicates | derives-from | related
  score DOUBLE, via TEXT,            -- embedding | attention | symbol | manual
  status TEXT DEFAULT 'proposed',    -- proposed | confirmed | rejected
  note TEXT, curated_by TEXT,        -- who confirmed/rejected: 'human' | 'llm' | free text
  src_hash TEXT, dst_hash TEXT,      -- normalized span-content hashes at last reconcile
  src_text TEXT, dst_text TEXT,      -- span text at curation time (capped; review display + relocation)
  created_at TIMESTAMP DEFAULT now(), updated_at TIMESTAMP DEFAULT now()
);`;

export async function openLineage(root, { readOnly = false } = {}) {
  const { DuckDBInstance } = await import('@duckdb/node-api');
  const path = lineagePath(root);
  if (!readOnly) mkdirSync(join(root, '.mari'), { recursive: true });
  const instance = await DuckDBInstance.create(path, readOnly ? { access_mode: 'READ_ONLY' } : {});
  const conn = await instance.connect();
  if (!readOnly) await conn.run(SCHEMA);
  const all = async (sql, params = []) => (await conn.runAndReadAll(sql, params)).getRowObjects();
  // Close the INSTANCE too, not just the connection — a lingering instance leaves the WAL
  // un-checkpointed and a subsequent open (this process or the hook's) can read stale state.
  const close = () => { try { conn.closeSync(); } finally { instance.closeSync?.(); } };
  return { conn, all, run: (sql, params = []) => conn.run(sql, params), close };
}

// ── span content: read, normalize, hash ─────────────────────────────────────────────────────────
// Normalization makes the hash robust to whitespace-only churn; the hash is what decides drift.
const normalize = (text) => String(text).split('\n').map((l) => l.trim()).filter(Boolean).join('\n').replace(/[ \t]+/g, ' ');
export function spanHash(text) { return sha1(normalize(text)); }

export function readSpan(root, file, start, end) {
  try {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    if (start > lines.length) return null;
    return lines.slice(start - 1, Math.min(end, lines.length)).join('\n');
  } catch { return null; }
}

// A span whose stored hash no longer matches at its stored lines may simply have MOVED (edits
// above it shifted line numbers). Slide a same-length window over the file and look for the
// stored hash; a match means "moved, not changed" and yields the new location.
export function relocateSpan(root, file, start, end, hash) {
  let lines; try { lines = readFileSync(join(root, file), 'utf8').split('\n'); } catch { return null; }
  const len = end - start + 1;
  if (len <= 0 || len > lines.length) return null;
  for (let s = 0; s + len <= lines.length; s++) {
    if (spanHash(lines.slice(s, s + len).join('\n')) === hash) return { start: s + 1, end: s + len };
  }
  return null;
}

// ── proposals ───────────────────────────────────────────────────────────────────────────────────
// Insert candidate edges as 'proposed', skipping pairs the graph already knows (any status —
// a rejected pair must NOT resurface on the next propose run). "Already knows" = same file pair
// with overlapping spans on both sides.
const overlaps = (a1, a2, b1, b2) => a1 <= b2 && b1 <= a2;

export async function proposeEdges(root, proposals) {
  const db = await openLineage(root);
  try {
    const existing = await db.all('SELECT src_file, src_start, src_end, dst_file, dst_start, dst_end, src_symbol FROM edges');
    // Overlap dedupe applies within a symbol (or among symbol-less edges) — two DIFFERENT
    // symbols documented by the same doc paragraph are two edges, not one.
    const known = (p) => existing.some((e) =>
      (e.src_symbol ?? null) === (p.src.symbol ?? null)
      && ((e.src_file === p.src.file && e.dst_file === p.dst.file
        && overlaps(Number(e.src_start), Number(e.src_end), p.src.start, p.src.end)
        && overlaps(Number(e.dst_start), Number(e.dst_end), p.dst.start, p.dst.end))
      || (e.src_file === p.dst.file && e.dst_file === p.src.file
        && overlaps(Number(e.src_start), Number(e.src_end), p.dst.start, p.dst.end)
        && overlaps(Number(e.dst_start), Number(e.dst_end), p.src.start, p.src.end))));
    let inserted = 0;
    for (const p of proposals) {
      if (known(p)) continue;
      const srcText = readSpan(root, p.src.file, p.src.start, p.src.end);
      const dstText = readSpan(root, p.dst.file, p.dst.start, p.dst.end);
      if (srcText == null || dstText == null) continue; // span fell off the file — stale candidate
      await db.run(
        `INSERT INTO edges (src_file, src_start, src_end, dst_file, dst_start, dst_end,
           src_symbol, dst_symbol, rel, score, via, status, src_hash, dst_hash, src_text, dst_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, ?)`,
        [toPosix(p.src.file), p.src.start, p.src.end, toPosix(p.dst.file), p.dst.start, p.dst.end,
          p.src.symbol ?? null, p.dst.symbol ?? null, p.rel ?? 'related', p.score ?? null, p.via ?? 'manual',
          spanHash(srcText), spanHash(dstText), srcText.slice(0, 1200), dstText.slice(0, 1200)]);
      existing.push({ src_file: toPosix(p.src.file), src_start: p.src.start, src_end: p.src.end,
        dst_file: toPosix(p.dst.file), dst_start: p.dst.start, dst_end: p.dst.end, src_symbol: p.src.symbol ?? null });
      inserted++;
    }
    return inserted;
  } finally { db.close(); }
}

// Candidates from the assoc index — every embedding/attention association becomes a proposal.
export function assocProposals(index, { minScore = 0 } = {}) {
  return (index?.associations || [])
    .filter((a) => a.score >= minScore)
    .map((a) => ({
      src: { file: a.a.file, start: a.a.lines[0], end: a.a.lines[1] },
      dst: { file: a.b.file, start: a.b.lines[0], end: a.b.lines[1] },
      score: a.score, via: a.via, rel: 'related',
    }));
}

// ── curation ────────────────────────────────────────────────────────────────────────────────────
export async function listEdges(root, { status = null, file = null, limit = 0 } = {}) {
  const db = await openLineage(root, { readOnly: lineageExists(root) });
  try {
    const where = [], params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (file) { where.push('(src_file = ? OR dst_file = ?)'); params.push(toPosix(file), toPosix(file)); }
    const sql = `SELECT * FROM edges${where.length ? ' WHERE ' + where.join(' AND ') : ''}
      ORDER BY status = 'proposed' DESC, score DESC NULLS LAST, id${limit ? ` LIMIT ${Number(limit)}` : ''}`;
    return (await db.all(sql, params)).map(rowToEdge);
  } finally { db.close(); }
}

export async function getEdge(root, id) {
  const db = await openLineage(root, { readOnly: true });
  try { const r = await db.all('SELECT * FROM edges WHERE id = ?', [Number(id)]); return r.length ? rowToEdge(r[0]) : null; }
  finally { db.close(); }
}

// Confirm/reject curates the edge; confirming also re-reads both spans so the stored hashes
// reflect the text the curator actually approved.
export async function curateEdges(root, ids, { status, rel = null, note = null, by = null } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
  const db = await openLineage(root);
  try {
    let updated = 0;
    for (const id of ids) {
      const rows = await db.all('SELECT * FROM edges WHERE id = ?', [Number(id)]);
      if (!rows.length) continue;
      const e = rowToEdge(rows[0]);
      const sets = ['status = ?', 'updated_at = now()'], params = [status];
      if (rel) { sets.push('rel = ?'); params.push(rel); }
      if (note) { sets.push('note = ?'); params.push(note); }
      if (by) { sets.push('curated_by = ?'); params.push(by); }
      if (status === 'confirmed') {
        const srcText = readSpan(root, e.src.file, e.src.start, e.src.end);
        const dstText = readSpan(root, e.dst.file, e.dst.start, e.dst.end);
        if (srcText != null) { sets.push('src_hash = ?', 'src_text = ?'); params.push(spanHash(srcText), srcText.slice(0, 1200)); }
        if (dstText != null) { sets.push('dst_hash = ?', 'dst_text = ?'); params.push(spanHash(dstText), dstText.slice(0, 1200)); }
      }
      params.push(Number(id));
      await db.run(`UPDATE edges SET ${sets.join(', ')} WHERE id = ?`, params);
      updated++;
    }
    return updated;
  } finally { db.close(); }
}

// Manual edge — curator asserts a link directly; lands confirmed.
export async function addEdge(root, { src, dst, rel = 'related', note = null, by = null }) {
  const srcText = readSpan(root, src.file, src.start, src.end);
  const dstText = readSpan(root, dst.file, dst.start, dst.end);
  if (srcText == null || dstText == null) throw new Error('span out of range — check file:start-end');
  const db = await openLineage(root);
  try {
    await db.run(
      `INSERT INTO edges (src_file, src_start, src_end, dst_file, dst_start, dst_end, rel, via,
         status, note, curated_by, src_hash, dst_hash, src_text, dst_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', 'confirmed', ?, ?, ?, ?, ?, ?)`,
      [toPosix(src.file), src.start, src.end, toPosix(dst.file), dst.start, dst.end, rel, note, by,
        spanHash(srcText), spanHash(dstText), srcText.slice(0, 1200), dstText.slice(0, 1200)]);
    const r = await db.all('SELECT max(id) AS id FROM edges');
    return Number(r[0].id);
  } finally { db.close(); }
}

// ── impact ──────────────────────────────────────────────────────────────────────────────────────
// For the given changed files: every CONFIRMED edge with a span in one of them where the span's
// content hash no longer matches. A hash that matches at a relocated position means the span
// merely moved — reported separately (and fixable with `stamp`), not an impact. The counterpart
// side of a drifted edge is what the curator promised stays in sync — that's the impact.
export async function impactFor(root, files, { readOnly = true } = {}) {
  if (!lineageExists(root)) return { impacts: [], moved: [], missing: [] };
  const set = new Set(files.map(toPosix));
  const db = await openLineage(root, { readOnly });
  let rows;
  try {
    const marks = [...set].map(() => '?').join(',');
    rows = await db.all(
      `SELECT * FROM edges WHERE status = 'confirmed' AND (src_file IN (${marks}) OR dst_file IN (${marks}))`,
      [...set, ...set]);
  } finally { db.close(); }

  const impacts = [], moved = [], missing = [];
  for (const row of rows) {
    const e = rowToEdge(row);
    for (const side of ['src', 'dst']) {
      const span = e[side];
      if (!set.has(span.file)) continue;
      const other = side === 'src' ? e.dst : e.src;
      const text = readSpan(root, span.file, span.start, span.end);
      const stored = side === 'src' ? e.srcHash : e.dstHash;
      if (text != null && spanHash(text) === stored) continue; // untouched — no impact
      const reloc = relocateSpan(root, span.file, span.start, span.end, stored);
      if (reloc) { moved.push({ edge: e, side, at: reloc }); continue; }
      if (text == null && !existsSync(join(root, span.file))) { missing.push({ edge: e, side }); continue; }
      impacts.push({ edge: e, side, changed: span, counterpart: other });
    }
  }
  return { impacts, moved, missing };
}

// Reconcile: after the counterpart has been reviewed/updated, re-read both spans (relocating
// moved ones) and stamp the current content as the new curated baseline.
export async function stampEdges(root, { files = null, ids = null } = {}) {
  const db = await openLineage(root);
  try {
    let rows;
    if (ids?.length) rows = await db.all(`SELECT * FROM edges WHERE status = 'confirmed' AND id IN (${ids.map(() => '?').join(',')})`, ids.map(Number));
    else if (files?.length) {
      const set = files.map(toPosix), marks = set.map(() => '?').join(',');
      rows = await db.all(`SELECT * FROM edges WHERE status = 'confirmed' AND (src_file IN (${marks}) OR dst_file IN (${marks}))`, [...set, ...set]);
    } else rows = await db.all(`SELECT * FROM edges WHERE status = 'confirmed'`);

    let stamped = 0;
    for (const row of rows) {
      const e = rowToEdge(row);
      const next = {};
      for (const side of ['src', 'dst']) {
        const span = { ...e[side] };
        const stored = side === 'src' ? e.srcHash : e.dstHash;
        let text = readSpan(root, span.file, span.start, span.end);
        if (text == null || spanHash(text) !== stored) {
          const reloc = relocateSpan(root, span.file, span.start, span.end, stored);
          if (reloc) { span.start = reloc.start; span.end = reloc.end; text = readSpan(root, span.file, span.start, span.end); }
        }
        if (text == null) { next.skip = true; break; } // span gone — leave for the curator
        next[side] = { span, hash: spanHash(text), text: text.slice(0, 1200) };
      }
      if (next.skip) continue;
      await db.run(
        `UPDATE edges SET src_start = ?, src_end = ?, dst_start = ?, dst_end = ?,
           src_hash = ?, dst_hash = ?, src_text = ?, dst_text = ?, updated_at = now() WHERE id = ?`,
        [next.src.span.start, next.src.span.end, next.dst.span.start, next.dst.span.end,
          next.src.hash, next.dst.hash, next.src.text, next.dst.text, e.id]);
      stamped++;
    }
    return stamped;
  } finally { db.close(); }
}

// Replace an edge's spans (attention refinement narrowing a coarse chunk to the engaging
// lines). Re-reads text and hashes at the new extents so curation/impact see the tight span.
export async function setEdgeSpans(root, id, { src = null, dst = null } = {}) {
  const db = await openLineage(root);
  try {
    const rows = await db.all('SELECT * FROM edges WHERE id = ?', [Number(id)]);
    if (!rows.length) return false;
    const e = rowToEdge(rows[0]);
    const sets = ['updated_at = now()'], params = [];
    for (const [side, span] of [['src', src], ['dst', dst]]) {
      if (!span) continue;
      const text = readSpan(root, e[side].file, span.start, span.end);
      if (text == null) continue;
      sets.push(`${side}_start = ?`, `${side}_end = ?`, `${side}_hash = ?`, `${side}_text = ?`);
      params.push(span.start, span.end, spanHash(text), text.slice(0, 1200));
    }
    if (params.length === 0) return false;
    await db.run(`UPDATE edges SET ${sets.join(', ')} WHERE id = ?`, [...params, Number(id)]);
    return true;
  } finally { db.close(); }
}

export async function lineageStats(root) {
  if (!lineageExists(root)) return null;
  const db = await openLineage(root, { readOnly: true });
  try {
    const rows = await db.all(`SELECT status, via, count(*) AS n FROM edges GROUP BY status, via ORDER BY status, via`);
    const total = await db.all(`SELECT count(*) AS n, count(DISTINCT src_file) + count(DISTINCT dst_file) AS files FROM edges`);
    return { rows: rows.map((r) => ({ status: r.status, via: r.via, n: Number(r.n) })), total: Number(total[0].n) };
  } finally { db.close(); }
}

function rowToEdge(r) {
  return {
    id: Number(r.id),
    src: { file: r.src_file, start: Number(r.src_start), end: Number(r.src_end), symbol: r.src_symbol ?? null },
    dst: { file: r.dst_file, start: Number(r.dst_start), end: Number(r.dst_end), symbol: r.dst_symbol ?? null },
    rel: r.rel, score: r.score == null ? null : Number(r.score), via: r.via, status: r.status,
    note: r.note ?? null, curatedBy: r.curated_by ?? null,
    srcHash: r.src_hash, dstHash: r.dst_hash, srcText: r.src_text ?? '', dstText: r.dst_text ?? '',
  };
}
