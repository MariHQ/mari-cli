// Tests for the uniform semantic-association engine. Models are injected, so we use a
// deterministic bag-of-words fake embedder: chunks sharing vocabulary get high cosine. This
// exercises chunking, nearest-neighbor recall, association, persistence, and lookup — no models.
import { walkFiles, chunkFile, cosine, buildAssoc, saveAssoc, loadAssoc, associationsForFile } from '../cli/engine/assoc.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let checks = 0, failed = 0;
function ok(cond, msg) { checks++; if (!cond) { failed++; console.log(`  ✗ ${msg}`); } }

// deterministic fake embedding: hashed bag-of-words, L2-normalized → shared words ⇒ high cosine
function fakeEmbed(texts) {
  const D = 128;
  return texts.map((t) => {
    const v = new Array(D).fill(0);
    for (const w of (t.toLowerCase().match(/[a-z]{3,}/g) || [])) {
      let h = 0; for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
      v[h % D] += 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  });
}

// --- unit: chunking -----------------------------------------------------------------------------
const chunks = chunkFile('line1\nline2\nline3 with enough text to pass the length gate here\nline4', 'a.js');
ok(chunks.length >= 1, 'chunkFile yields chunks');
ok(chunks[0].startLine === 1 && chunks[0].lines === undefined, 'chunk carries startLine');

// --- unit: cosine -------------------------------------------------------------------------------
const [va, vb] = fakeEmbed(['charge the card and emit receipt', 'charge the card and emit receipt']);
ok(Math.abs(cosine(va, vb) - 1) < 1e-9, 'cosine of identical vectors ≈ 1');

// --- integration: build + symmetric lookup ------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'mari-assoc-'));
mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'docs'));
writeFileSync(join(dir, 'docs/payments.md'), '# Payments\n\nThe payment processor charges the customer card and emits a receipt event for every transaction.\n');
writeFileSync(join(dir, 'src/charge.js'), 'export function chargeCard(payment) {\n  // charges the customer card and emits a receipt event for the transaction\n  return payment;\n}\n');
writeFileSync(join(dir, 'docs/weather.md'), '# Weather\n\nTomorrow brings scattered rain, sunshine, and mild wind across the northern valley region.\n');

const embedFn = async (texts) => fakeEmbed(texts);
const { index, stats } = await buildAssoc(dir, { embedFn, cosThreshold: 0.25, annK: 5 });
ok(stats.chunks >= 3, `chunks every file (${stats.chunks})`);
ok(index.via === 'embedding', 'via=embedding without attnFn');
ok(index.associations.length >= 1, 'derives at least one association');

// payments doc ↔ charge code should associate (shared vocabulary); weather should not
const payHits = associationsForFile(index, 'docs/payments.md');
ok(payHits.some((a) => a.b.file === 'src/charge.js'), 'payments.md ↔ charge.js (shared vocab)');
ok(payHits.every((a) => a.a.file === 'docs/payments.md'), 'lookup normalizes edited file to `a`');
ok(associationsForFile(index, 'docs/weather.md').every((a) => a.b.file !== 'src/charge.js'), 'unrelated file not associated to charge.js');

// symmetric: the code file finds the doc back
const codeHits = associationsForFile(index, 'src/charge.js');
ok(codeHits.some((a) => a.b.file === 'docs/payments.md'), 'symmetric: charge.js ↔ payments.md');

// no self-association (a file with itself)
ok(index.associations.every((a) => a.a.file !== a.b.file), 'no file associates with itself');

// --- persistence round-trip ---------------------------------------------------------------------
saveAssoc(dir, index);
const reloaded = loadAssoc(dir);
ok(reloaded && reloaded.associations.length === index.associations.length, 'index persists + reloads');

// --- discovery: skips test files ----------------------------------------------------------------
writeFileSync(join(dir, 'src/charge.test.js'), 'test("x", () => {});\n');
ok(!walkFiles(dir).includes('src/charge.test.js'), 'walkFiles skips *.test.js');

// --- Lance vector store + ANN recall (real, package installed) -----------------------------------
{
  const lance = await import('../cli/engine/assoc-lance.mjs');
  const ldir = join(dir, '.mari', 'assoc', 'lance');
  const c = [
    { id: 'L1', file: 'a.md', startLine: 1, endLine: 3, _fhash: 'h1' },
    { id: 'L1', file: 'b.js', startLine: 1, endLine: 3, _fhash: 'h2' },
    { id: 'L1', file: 'c.md', startLine: 1, endLine: 3, _fhash: 'h3' },
  ];
  const v = fakeEmbed(['charge the customer card receipt event',
    'charge the customer card receipt event transaction', 'rain sunshine valley weather forecast']);
  const wrote = await lance.lanceWrite(ldir, c, v);
  ok(wrote === 3, 'lanceWrite persists all chunks');
  const cache = await lance.lanceLoadCache(ldir);
  ok(cache.get('a.md#L1')?.hash === 'h1' && cache.get('a.md#L1').v.length === v[0].length, 'lanceLoadCache round-trips vectors + hash');
  const pairs = await lance.lanceRecall(ldir, c, v, { annK: 5, cosThreshold: 0.3 });
  const files = pairs.map((p) => [c[p.i].file, c[p.j].file].sort().join('~'));
  ok(files.includes('a.md~b.js'), 'lanceRecall finds the a↔b neighbor');
  ok(!files.some((f) => f.includes('c.md')), 'lanceRecall excludes the unrelated chunk');
  ok(pairs.every((p) => c[p.i].file !== c[p.j].file), 'lanceRecall excludes same-file pairs');

  // free-vector search (mari explore): a query about payments lands on the payment chunks
  const [qv] = fakeEmbed(['customer card receipt']);
  const hits = await lance.lanceSearch(ldir, qv, { k: 2 });
  ok(hits.length === 2 && hits[0].sim >= hits[1].sim, 'lanceSearch returns k hits sorted by similarity');
  ok(hits.every((h) => h.file !== 'c.md'), 'lanceSearch ranks the related chunks above the unrelated one');
  ok(typeof hits[0].start === 'number' && hits[0].file, 'lanceSearch hits carry file + line span');
  const excl = await lance.lanceSearch(ldir, qv, { k: 3, excludeFile: 'a.md' });
  ok(excl.every((h) => h.file !== 'a.md'), 'lanceSearch excludeFile filters the source file');
  ok((await lance.lanceSearch(join(dir, 'nope'), qv, { k: 2 })).length === 0, 'lanceSearch on a missing store returns []');
}

rmSync(dir, { recursive: true, force: true });

console.log(`\nAssoc: ${checks} checks · ${checks - failed} passed · ${failed} failed`);
if (failed) process.exit(1);
console.log('✓ assoc green');
