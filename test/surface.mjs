#!/usr/bin/env node
// Public API surface extraction (`mari surface`, `mari check --deep`): per-language symbol
// extraction, the rendered attention-context text with its line map, chunking, and mapping
// flagged attention spans back to source symbols. All pure — synthetic sources, no fs.

import { extractSurface, renderSurface, chunkSurface, itemsOfSpan, SOURCE_EXT, NOT_SURFACE } from '../cli/engine/surface.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); } };
const names = (items) => items.map((i) => i.name);

// --- JS/TS ---
{
  const src = `import x from 'y';
export function alpha(a, b) {
  return a + b;
}
export const beta = 42;
export default class Gamma {}
export async function delta() {}
function privateHelper() {}
export { one, two as three };
export interface Opts { a: string }
exports.legacy = () => {};
export function _internal() {}
`;
  const items = extractSurface('src/x.ts', src);
  const n = names(items);
  check('js: exported function', n.includes('alpha'));
  check('js: exported const', n.includes('beta'));
  check('js: default class', n.includes('Gamma'));
  check('js: async function', n.includes('delta'));
  check('js: re-export list with `as`', n.includes('one') && n.includes('three') && !n.includes('two'));
  check('js: interface/type', n.includes('Opts'));
  check('js: CommonJS exports.x', n.includes('legacy'));
  check('js: non-exported function skipped', !n.includes('privateHelper'));
  check('js: underscore-prefixed skipped', !n.includes('_internal'));
  check('js: lines are 1-based and ordered', items[0].name === 'alpha' && items[0].line === 2);
  check('js: signature is the cleaned first line', items.find((i) => i.name === 'alpha').signature === 'export function alpha(a, b)');
}

// --- Python / Go / Rust ---
{
  const py = extractSurface('m.py', 'def visible(a):\n    pass\n\ndef _hidden():\n    pass\n\nclass Thing:\n    def method(self): pass\n');
  check('py: top-level def', names(py).includes('visible'));
  check('py: underscore def skipped', !names(py).includes('_hidden'));
  check('py: class extracted, indented method not', names(py).includes('Thing') && !names(py).includes('method'));

  const go = extractSurface('m.go', 'func Exported(a int) {}\nfunc unexported() {}\nfunc (s *S) Method(x int) {}\ntype Config struct {}\n');
  check('go: capitalized func', names(go).includes('Exported'));
  check('go: lowercase func skipped', !names(go).includes('unexported'));
  check('go: method with receiver', names(go).includes('Method'));
  check('go: exported type', names(go).includes('Config'));

  const rs = extractSurface('m.rs', 'pub fn run() {}\nfn private() {}\n  pub struct Conf {}\npub async fn go() {}\n');
  check('rs: pub fn', names(rs).includes('run'));
  check('rs: private fn skipped', !names(rs).includes('private'));
  check('rs: pub struct (indented)', names(rs).includes('Conf'));
  check('rs: pub async fn', names(rs).includes('go'));
}

check('unknown extension → empty', extractSurface('style.css', 'a{}').length === 0);

// --- SOURCE_EXT / NOT_SURFACE filters ---
check('SOURCE_EXT matches source, not markdown', SOURCE_EXT.test('a/b.mjs') && SOURCE_EXT.test('a.py') && !SOURCE_EXT.test('a.md'));
check('NOT_SURFACE skips tests', NOT_SURFACE.test('test/foo.mjs') && NOT_SURFACE.test('src/a.test.ts') && NOT_SURFACE.test('src/a_test.py') && NOT_SURFACE.test('src/x.spec.js'));
check('NOT_SURFACE skips dist/vendor/dotdirs', NOT_SURFACE.test('dist/x.js') && NOT_SURFACE.test('vendor/y.go') && NOT_SURFACE.test('.venv/z.py'));
check('NOT_SURFACE keeps real source', !NOT_SURFACE.test('cli/engine/site.mjs') && !NOT_SURFACE.test('src/lib.rs'));

// --- renderSurface: text + line map agree ---
{
  const fsurf = [
    { path: 'src/a.mjs', items: extractSurface('src/a.mjs', 'export function first() {}\nexport function second() {}\n') },
    { path: 'src/b.mjs', items: extractSurface('src/b.mjs', 'export const K = 1;\n') },
    { path: 'src/empty.mjs', items: [] },
  ];
  const { text, map } = renderSurface(fsurf);
  const lines = text.split('\n');
  check('render: header uses the === convention', lines[0] === '// === src/a.mjs ===');
  check('render: one map entry per rendered line', map.length === lines.length - 1); // trailing \n
  check('render: headers/blanks map to null', map[0] === null);
  check('render: symbol lines map to file+line+name', map[1] && map[1].name === 'first' && map[1].file === 'src/a.mjs' && map[1].line === 1);
  check('render: empty files omitted', !text.includes('empty.mjs'));
  const bIdx = lines.indexOf('// === src/b.mjs ===');
  check('render: second file follows a blank separator', bIdx > 0 && lines[bIdx - 1] === '' && map[bIdx + 1].name === 'K');
}

// --- chunkSurface: file blocks never split; everything lands somewhere ---
{
  const mk = (path, count) => ({ path, items: Array.from({ length: count }, (_, i) => ({ name: `f${i}`, kind: 'function', signature: `export function f${i}(${'x'.repeat(60)})`, line: i + 1 })) });
  const fsurf = [mk('a.mjs', 30), mk('b.mjs', 30), mk('c.mjs', 30)];
  const chunks = chunkSurface(fsurf, 3000);
  check('chunk: splits into multiple chunks', chunks.length > 1);
  check('chunk: a file block is never split across chunks', chunks.every((c) => {
    const files = new Set(c.map.filter(Boolean).map((e) => e.file));
    return [...files].every((f) => c.map.filter((e) => e && e.file === f).length === 30);
  }));
  const total = chunks.reduce((n, c) => n + c.map.filter(Boolean).length, 0);
  check('chunk: no symbol dropped', total === 90);
  check('chunk: single small file → one chunk', chunkSurface([mk('a.mjs', 2)], 3000).length === 1);
}

// --- itemsOfSpan: flagged attention spans map back to symbols ---
{
  const fsurf = [{ path: 'src/a.mjs', items: extractSurface('src/a.mjs', 'export function checkLinks(pages, paths) {}\nexport function checkNav(pages, paths) {}\n') }];
  const rendered = renderSurface(fsurf);
  const one = itemsOfSpan(rendered, 'export function checkNav(pages, paths)');
  check('span → single symbol', one.length === 1 && one[0].name === 'checkNav' && one[0].line === 2);
  const multi = itemsOfSpan(rendered, 'checkLinks(pages, paths)\nexport function checkNav');
  check('multi-line span → both symbols', names(multi).includes('checkLinks') && names(multi).includes('checkNav'));
  check('span with header prefix is stripped', itemsOfSpan(rendered, '// === src/a.mjs ===\nexport function checkLinks(pages, paths)')[0].name === 'checkLinks');
  check('unmatchable span → empty', itemsOfSpan(rendered, 'totally unrelated words').length === 0);
}

console.log(`\nSurface checks: ${pass + fail} · ${pass} passed · ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
