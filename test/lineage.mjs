// Tests for semantic lineage: symbol extraction/mentions, the DuckDB edge store (propose →
// curate → impact → stamp), assoc-index candidates, and drift semantics (content change vs
// whitespace churn vs line movement). Real embedded DuckDB, temp dirs — no models, no network.
import { extractSymbols, symbolMentions, symbolProposals } from '../cli/engine/symbols.mjs';
import { proposeEdges, assocProposals, listEdges, getEdge, curateEdges, addEdge, impactFor, stampEdges, lineageStats, lineageExists, spanHash, relocateSpan } from '../cli/engine/lineage.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let checks = 0, failed = 0;
function ok(cond, msg) { checks++; if (!cond) { failed++; console.log(`  ✗ ${msg}`); } }

// --- unit: symbol extraction ----------------------------------------------------------------
const jsSyms = extractSymbols('export function chargeCard(x) {}\nexport class ReceiptEmitter {}\nfunction go2() {}\nconst x = 1;\nexport const RETRY_LIMIT = 3;', 'a.mjs');
ok(jsSyms.some((s) => s.name === 'chargeCard' && s.line === 1), 'js export function extracted with line');
ok(jsSyms.some((s) => s.name === 'ReceiptEmitter'), 'js export class extracted');
ok(jsSyms.some((s) => s.name === 'RETRY_LIMIT'), 'js export const extracted');
ok(!jsSyms.some((s) => s.name === 'go2'), 'short names filtered');
const pySyms = extractSymbols('class PaymentGateway:\n    pass\n\ndef refund_charge(x):\n    pass\ndef main():\n    pass', 'a.py');
ok(pySyms.some((s) => s.name === 'PaymentGateway') && pySyms.some((s) => s.name === 'refund_charge'), 'python class + def extracted');
ok(!pySyms.some((s) => s.name === 'main'), 'stopword symbols filtered');
ok(extractSymbols('export function whatever() {}', 'a.css').length === 0, 'unknown extension yields nothing');

// --- unit: definition extents (spans end at the body, not a fixed window) ----------------------
const braceSyms = extractSymbols('export function chargeCard(x) {\n  if (x) {\n    return x;\n  }\n  return null;\n}\n\nexport function otherThing() {\n  return 1;\n}', 'a.mjs');
ok(braceSyms.find((s) => s.name === 'chargeCard')?.endLine === 6, 'brace extent stops at the closing brace');
ok(braceSyms.find((s) => s.name === 'otherThing')?.endLine === 10, 'second def gets its own extent');
const pyExtent = extractSymbols('def refund_charge(x):\n    if x:\n        return x\n    return None\n\ndef unrelated():\n    pass', 'a.py');
ok(pyExtent.find((s) => s.name === 'refund_charge')?.endLine === 4, 'python extent follows indentation');

// --- unit: doc mentions -----------------------------------------------------------------------
const doc = 'Call `chargeCard()` to bill.\n\nchargeCard retries twice.\n\nNothing here.';
const mentions = symbolMentions(doc, 'chargeCard');
ok(mentions.length === 2, 'both mentions found');
ok(mentions[0].score > mentions[1].score, 'code-marked mention outscores bare mention');
ok(symbolMentions('chargeCardX is different', 'chargeCard').length === 0, 'word boundary respected');

// --- unit: span hashing + relocation ----------------------------------------------------------
ok(spanHash('a  b\n  c') === spanHash('a b\nc'), 'hash ignores whitespace churn');
ok(spanHash('a b') !== spanHash('a c'), 'hash sees content change');

// --- integration: temp repo -------------------------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'mari-lineage-'));
mkdirSync(join(dir, 'src')); mkdirSync(join(dir, 'docs'));
const SRC = 'src/charge.mjs', DOC = 'docs/payments.md';
writeFileSync(join(dir, SRC), [
  '// payment entry point',
  'export function chargeCard(payment) {',
  '  return { ...payment, charged: true };',
  '}',
  '',
  'export class ReceiptEmitter {',
  '  emit(evt) { return evt; }',
  '}',
].join('\n'));
writeFileSync(join(dir, DOC), [
  '# Payments',
  '',
  'Billing goes through `chargeCard()`, which marks the payment charged.',
  '',
  'Receipts are emitted by `ReceiptEmitter` after every charge.',
].join('\n'));

ok(!lineageExists(dir), 'no db before first propose');

// symbol proposals → DB
const props = symbolProposals(dir);
ok(props.length === 2, `symbolProposals finds both symbols (got ${props.length})`);
ok(props.every((p) => p.via === 'symbol' && p.rel === 'documents'), 'symbol proposals carry via/rel');
const inserted = await proposeEdges(dir, props);
ok(inserted === 2 && lineageExists(dir), 'proposals inserted into DuckDB');
ok(await proposeEdges(dir, props) === 0, 're-propose inserts nothing (dedupe, all statuses)');

// assoc-index candidates feed the same store
const assocIdx = { associations: [{ a: { file: DOC, lines: [1, 3] }, b: { file: SRC, lines: [1, 4] }, score: 0.71, via: 'attention' },
  { a: { file: DOC, lines: [1, 3] }, b: { file: SRC, lines: [1, 4] }, score: 0.2, via: 'embedding' }] };
const ap = assocProposals(assocIdx, { minScore: 0.4 });
ok(ap.length === 1 && ap[0].via === 'attention', 'assocProposals maps + filters by score');
await proposeEdges(dir, ap);

// curation
let proposed = await listEdges(dir, { status: 'proposed' });
ok(proposed.length === 3, `three proposed edges (got ${proposed.length})`);
ok(proposed.every((e) => e.srcText && e.dstText), 'review payload carries both span texts');
const symEdges = proposed.filter((e) => e.via === 'symbol');
const attnEdge = proposed.find((e) => e.via === 'attention');
await curateEdges(dir, symEdges.map((e) => e.id), { status: 'confirmed', by: 'llm' });
await curateEdges(dir, [attnEdge.id], { status: 'rejected', by: 'llm', note: 'topical overlap only' });
const e0 = await getEdge(dir, symEdges[0].id);
ok(e0.status === 'confirmed' && e0.curatedBy === 'llm', 'confirm records status + curator');
ok((await getEdge(dir, attnEdge.id)).status === 'rejected', 'reject records status');
ok(await proposeEdges(dir, ap) === 0, 'rejected pair does not resurface on propose');

// manual edge
const manualId = await addEdge(dir, { src: { file: SRC, start: 1, end: 4 }, dst: { file: DOC, start: 1, end: 1 }, rel: 'describes', by: 'human' });
ok((await getEdge(dir, manualId)).status === 'confirmed', 'link lands confirmed');

// impact: untouched file → nothing
let r = await impactFor(dir, [SRC]);
ok(r.impacts.length === 0 && r.moved.length === 0, 'no impact when nothing changed');

// impact: whitespace churn → nothing (normalized hash)
writeFileSync(join(dir, SRC), readFileSync(join(dir, SRC), 'utf8').replace('return {', 'return   {'));
r = await impactFor(dir, [SRC]);
ok(r.impacts.length === 0, 'whitespace-only churn is not an impact');

// impact: line movement → moved, not impacted
writeFileSync(join(dir, DOC), '<!-- new intro -->\n\n' + readFileSync(join(dir, DOC), 'utf8'));
r = await impactFor(dir, [DOC]);
ok(r.impacts.length === 0 && r.moved.length >= 1, 'moved span is not an impact');
ok(await stampEdges(dir, { files: [DOC] }) >= 1, 'stamp re-anchors moved spans');
const reAnchored = await getEdge(dir, symEdges[0].id);
ok(reAnchored.dst.start === symEdges[0].dst.start + 2, 'stamp updated the moved span lines');

// impact: real content change → the counterpart is impacted
writeFileSync(join(dir, SRC), readFileSync(join(dir, SRC), 'utf8').replace('charged: true', "charged: true, currency: 'usd'"));
r = await impactFor(dir, [SRC]);
const hit = r.impacts.find((i) => i.edge.src.symbol === 'chargeCard');
ok(hit, 'content change to chargeCard span impacts its edge');
ok(hit && hit.counterpart.file === DOC, 'impact points at the doc counterpart');
ok(!r.impacts.some((i) => i.edge.src.symbol === 'ReceiptEmitter'), 'untouched symbol edge not impacted');

// stamp reconciles; impact clears
await stampEdges(dir, { files: [SRC] });
r = await impactFor(dir, [SRC]);
ok(r.impacts.length === 0, 'stamp clears the impact');

// deleted file → missing
rmSync(join(dir, DOC));
r = await impactFor(dir, [DOC]);
ok(r.missing.length >= 1 && r.impacts.length === 0, 'deleted file reported as missing, not impact');

// stats
const stats = await lineageStats(dir);
ok(stats.total === 4, `stats counts all edges (got ${stats.total})`);

rmSync(dir, { recursive: true, force: true });
console.log(failed ? `lineage: ${failed}/${checks} FAILED` : `lineage: all ${checks} checks passed`);
process.exit(failed ? 1 : 0);
