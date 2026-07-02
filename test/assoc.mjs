// Tests for the uniform semantic-association engine. Models are injected, so we use a
// deterministic bag-of-words fake embedder: chunks sharing vocabulary get high cosine. This
// exercises chunking, nearest-neighbor recall, association, persistence, and lookup — no models.
import { walkFiles, chunkFile, cosine, buildAssoc, updateAssoc, parseGitChanges, saveAssoc, loadAssoc, associationsForFile } from '../cli/engine/assoc.mjs';
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

// --- parseGitChanges: name-status + porcelain → candidate change set --------------------------
{
  const c = parseGitChanges(
    'M\tsrc/a.js\nA\tdocs/new.md\nD\tdocs/old.md\nR100\tsrc/before.js\tsrc/after.js\n',
    ' M dirty.md\n?? untracked.md\n D removed.md\nR  moved.md -> moved2.md\n');
  ok(c.modified.includes('src/a.js') && c.modified.includes('docs/new.md'), 'diff M/A are modified');
  ok(c.deleted.includes('docs/old.md'), 'diff D is deleted');
  ok(c.deleted.includes('src/before.js') && c.modified.includes('src/after.js'), 'rename = delete old + modify new');
  ok(c.modified.includes('dirty.md') && c.modified.includes('untracked.md'), 'porcelain dirty + untracked are modified');
  ok(c.deleted.includes('removed.md'), 'porcelain D is deleted');
  ok(c.deleted.includes('moved.md') && c.modified.includes('moved2.md'), 'porcelain rename splits old/new');
  const re = parseGitChanges('D\tx.md\n', '?? x.md\n');
  ok(re.modified.includes('x.md') && !re.deleted.includes('x.md'), 'deleted-then-recreated counts as modified');
  ok(parseGitChanges('', '').modified.length === 0, 'empty output → no candidates');
}

// --- incremental update: revoke deleted, re-embed changed, skip untouched ---------------------
{
  const udir = mkdtempSync(join(tmpdir(), 'mari-assoc-upd-'));
  const lanceDir = join(udir, '.mari', 'assoc', 'lance');
  mkdirSync(join(udir, 'src'), { recursive: true }); mkdirSync(join(udir, 'docs'), { recursive: true });
  writeFileSync(join(udir, 'docs/payments.md'), '# Payments\n\nThe payment processor charges the customer card and emits a receipt event for every transaction.\n');
  writeFileSync(join(udir, 'src/charge.js'), 'export function chargeCard(payment) {\n  // charges the customer card and emits a receipt event for the transaction\n  return payment;\n}\n');
  writeFileSync(join(udir, 'docs/weather.md'), '# Weather\n\nTomorrow brings scattered rain, sunshine, and mild wind across the northern valley region.\n');
  const { index: uidx } = await buildAssoc(udir, { embedFn, lanceDir, cosThreshold: 0.25, annK: 5 });

  // 1) hash-verify: a "candidate" whose content didn't change costs nothing
  const noop = await updateAssoc(udir, { index: uidx, embedFn, lanceDir,
    candidates: { modified: ['docs/payments.md'], deleted: [] } });
  ok(noop.stats.modified === 0 && noop.stats.chunks === 0, 'unchanged candidate re-embeds nothing');

  // 2) delete weather.md, change charge.js to be about weather, add a refunds doc
  rmSync(join(udir, 'docs/weather.md'));
  writeFileSync(join(udir, 'src/charge.js'), 'export function forecast() {\n  // scattered rain, sunshine, and mild wind across the northern valley region tomorrow\n  return "weather";\n}\n');
  writeFileSync(join(udir, 'docs/refunds.md'), '# Refunds\n\nThe refund processor reverses the customer card charge and emits a refund receipt event.\n');
  const upd = await updateAssoc(udir, { index: uidx, embedFn, lanceDir, cosThreshold: 0.25, annK: 5,
    candidates: { modified: ['src/charge.js', 'docs/refunds.md'], deleted: ['docs/weather.md'] } });
  ok(upd.stats.deleted === 1 && upd.stats.modified === 2, `revokes 1, re-embeds 2 (got d${upd.stats.deleted} m${upd.stats.modified})`);
  ok(!uidx.filesMeta['docs/weather.md'] && uidx.filesMeta['docs/refunds.md'], 'filesMeta follows the tree');
  ok(uidx.associations.every((a) => a.a.file !== 'docs/weather.md' && a.b.file !== 'docs/weather.md'), 'deleted file loses its associations');
  const refundHits = associationsForFile(uidx, 'docs/refunds.md');
  ok(refundHits.some((a) => a.b.file === 'docs/payments.md'), 'new file associates against the existing store');
  ok(associationsForFile(uidx, 'src/charge.js').every((a) => a.b.file !== 'docs/payments.md'),
    'changed file sheds its stale association (charge.js is about weather now)');

  // 3) the store itself reflects the update: search finds new content, not revoked content
  const lance = await import('../cli/engine/assoc-lance.mjs');
  const [wq] = fakeEmbed(['rain sunshine valley weather forecast']);
  const wHits = await lance.lanceSearch(lanceDir, wq, { k: 3 });
  ok(wHits[0]?.file === 'src/charge.js', 'search lands on the re-embedded content');
  ok(wHits.every((h) => h.file !== 'docs/weather.md'), 'revoked vectors are gone from the store');
  rmSync(udir, { recursive: true, force: true });
}

rmSync(dir, { recursive: true, force: true });

console.log(`\nAssoc: ${checks} checks · ${checks - failed} passed · ${failed} failed`);
if (failed) process.exit(1);
console.log('✓ assoc green');
