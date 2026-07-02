// LanceDB vector store for `mari assoc`. Chunk embeddings persist as an on-disk Lance table
// (columnar), and nearest-neighbor recall uses Lance's vector search instead of a brute-force
// cosine scan — so it scales past a few thousand chunks. Loaded lazily so the rest of mari never
// pulls in the native dependency.

process.env.RUST_LOG ||= 'error'; // quiet Lance's "no existing dataset" info logging
let _lance;
async function lib() { if (!_lance) _lance = await import('@lancedb/lancedb'); return _lance; }
const TABLE = 'chunks';

// Vectors already written to the store, keyed by chunk id → {hash, v}. Lets an incremental
// rebuild reuse embeddings for unchanged chunks (matched by the file's content hash).
export async function lanceLoadCache(dir) {
  const cache = new Map();
  try {
    const db = await (await lib()).connect(dir);
    if (!(await db.tableNames()).includes(TABLE)) return cache;
    const tbl = await db.openTable(TABLE);
    for (const r of await tbl.query().toArray()) cache.set(r.id, { hash: r.hash, v: Array.from(r.vector) });
  } catch { /* no store yet */ }
  return cache;
}

// Persist the current chunk set (overwrite — the index is rebuilt wholesale each run).
export async function lanceWrite(dir, chunks, vecs) {
  const rows = chunks.map((c, i) => ({
    id: c.file + '#' + c.id, file: c.file, start: c.startLine, end: c.endLine,
    hash: c._fhash, vector: vecs[i],
  })).filter((r) => Array.isArray(r.vector) && r.vector.length);
  if (!rows.length) return 0;
  const db = await (await lib()).connect(dir);
  await db.createTable(TABLE, rows, { mode: 'overwrite' });
  return rows.length;
}

// Free-vector search (`mari explore`): top-k chunks nearest to an arbitrary query vector.
// Returns [{ id, file, start, end, sim }] sorted by similarity.
export async function lanceSearch(dir, vector, { k = 12, excludeFile = null } = {}) {
  try {
    const db = await (await lib()).connect(dir);
    if (!(await db.tableNames()).includes(TABLE)) return [];
    const tbl = await db.openTable(TABLE);
    let q = tbl.search(vector).distanceType('cosine').limit(k);
    if (excludeFile) q = q.where(`file != '${String(excludeFile).replace(/'/g, "''")}'`);
    const rows = await q.toArray();
    return rows.map((r) => ({ id: r.id, file: r.file, start: r.start, end: r.end,
      sim: Math.round((1 - (r._distance ?? 1)) * 1000) / 1000 }));
  } catch { return []; } // no store yet / unreadable — caller treats as "no matches"
}

// Nearest-neighbor recall via Lance: for each chunk, its top-annK neighbors in OTHER files with
// cosine similarity ≥ cosThreshold. Returns unique cross-file pairs {i, j, cos}.
export async function lanceRecall(dir, chunks, vecs, { annK = 8, cosThreshold = 0.55 } = {}) {
  const db = await (await lib()).connect(dir);
  const tbl = await db.openTable(TABLE);
  const idToIdx = new Map(chunks.map((c, i) => [c.file + '#' + c.id, i]));
  const pairs = new Map();
  for (let i = 0; i < chunks.length; i++) {
    if (!vecs[i]?.length) continue;
    let res;
    try {
      res = await tbl.search(vecs[i]).distanceType('cosine')
        .where(`file != '${chunks[i].file.replace(/'/g, "''")}'`).limit(annK).toArray();
    } catch { continue; }
    for (const r of res) {
      const sim = 1 - (r._distance ?? 1); // cosine distance → similarity
      if (sim < cosThreshold) continue;
      const j = idToIdx.get(r.id); if (j === undefined || j === i) continue;
      const key = i < j ? `${i}:${j}` : `${j}:${i}`;
      if (!pairs.has(key) || pairs.get(key).cos < sim) pairs.set(key, { i: Math.min(i, j), j: Math.max(i, j), cos: Math.round(sim * 1000) / 1000 });
    }
  }
  return [...pairs.values()];
}
