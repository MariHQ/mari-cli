// Public API surface extraction: the deterministic half of `mari check --deep` and
// `mari surface`. Pull every exported/public symbol out of the source tree — signature, file,
// line — and render it as a compact text the attention model can hold as CONTEXT (~4k tokens
// of budget; raw source never fits, a signature list does).
//
// Two consumers:
//   mari surface       — print the inventory (the docsite flow's Phase-1 "public surface").
//   mari check --deep  — attention coverage over the rendered surface: which of these symbols
//                        do the docs never attend to (undocumented), and which doc sentences
//                        attend to none of them (stale)?
//
// Pure (no fs), in the style of platforms.mjs/site.mjs: callers pass path + text. Extraction
// is regex-per-language and deliberately shallow — it reads the PUBLIC surface (exports,
// pub/def/func at the margin), not the AST. A missed private helper costs nothing; the point
// is the surface a reader of the docs could care about.

export const SOURCE_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|py|go|rs)$/i;

// Paths that are code but not *surface*: tests, fixtures, generated bundles, examples.
export const NOT_SURFACE = /(^|\/)(tests?|__tests__|fixtures?|examples?|benchmarks?|scripts?|dist|build|vendor|vendored|3rdparty|third[-_]?party|node_modules|\.[^/]+)(\/|$)|(\.|_)(test|spec)\.[a-z]+$|\.d\.ts$|\.min\.js$/i;

const LANGS = [
  {
    // JS/TS: ESM exports, CommonJS module.exports, and re-export lists.
    ext: /\.(mjs|cjs|js|jsx|ts|tsx)$/i,
    patterns: [
      { re: /^export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)[^\n]*/gm, kind: 'function' },
      { re: /^export\s+(?:default\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)[^\n]*/gm, kind: 'const' },
      { re: /^export\s*\{([^}]+)\}/gm, kind: 'reexport', list: true },
      { re: /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)\s*=[^\n]*/gm, kind: 'function' },
      { re: /^export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)[^\n]*/gm, kind: 'type' },
    ],
  },
  {
    // Python: top-level def/class; underscore-prefixed names are private by convention.
    ext: /\.py$/i,
    patterns: [
      { re: /^(?:async\s+)?def\s+([A-Za-z]\w*)\s*\([^\n]*/gm, kind: 'function' },
      { re: /^class\s+([A-Za-z]\w*)[^\n]*/gm, kind: 'class' },
    ],
  },
  {
    // Go: exported = capitalized, at file scope.
    ext: /\.go$/i,
    patterns: [
      { re: /^func\s+(?:\([^)]*\)\s+)?([A-Z]\w*)\s*\([^\n]*/gm, kind: 'function' },
      { re: /^type\s+([A-Z]\w*)\s+[^\n]*/gm, kind: 'type' },
    ],
  },
  {
    // Rust: anything pub at line start (fn/struct/enum/trait/const/mod).
    ext: /\.rs$/i,
    patterns: [
      { re: /^\s*pub\s+(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|trait|type|const|static|mod)\s+([A-Za-z_]\w*)[^\n]*/gm, kind: 'item' },
    ],
  },
];

function lineAt(text, offset) { return text.slice(0, offset).split('\n').length; }
const clean = (s) => s.replace(/\s*\{\s*$/, '').replace(/\s*=>?\s*$/, '').replace(/\s+/g, ' ').trim();

// Extract the public symbols of one source file → [{ name, kind, signature, line }].
export function extractSurface(path, text) {
  const lang = LANGS.find((l) => l.ext.test(path));
  if (!lang) return [];
  const items = [];
  const seen = new Set();
  for (const { re, kind, list } of lang.patterns) {
    re.lastIndex = 0;
    for (const m of String(text).matchAll(re)) {
      if (list) {
        // export { a, b as c } — each name is its own surface item
        for (const raw of m[1].split(',')) {
          const name = (raw.split(/\s+as\s+/)[1] || raw).trim();
          if (name && !name.startsWith('_') && !seen.has(name)) { seen.add(name); items.push({ name, kind: 'export', signature: `export ${name}`, line: lineAt(text, m.index) }); }
        }
        continue;
      }
      const name = m[1];
      if (!name || name.startsWith('_') || seen.has(name)) continue;
      seen.add(name);
      items.push({ name, kind, signature: clean(m[0]), line: lineAt(text, m.index) });
    }
  }
  items.sort((a, b) => a.line - b.line);
  return items;
}

// Render per-file surface items as the attention CONTEXT text. Each symbol gets ONE rendered
// line, and the returned `map` has one entry per rendered line ({ file, line, name } for
// symbol lines, null for headers/blanks) so a flagged span maps straight back to source.
// Headers use the `// === path ===` convention lineOfSpan() already strips.
export function renderSurface(fileSurfaces) {
  const lines = [];
  const map = [];
  for (const { path, items } of fileSurfaces) {
    if (!items.length) continue;
    if (lines.length) { lines.push(''); map.push(null); }
    lines.push(`// === ${path} ===`); map.push(null);
    for (const it of items) {
      lines.push(it.signature.slice(0, 160));
      map.push({ file: path, line: it.line, name: it.name });
    }
  }
  return { text: lines.join('\n') + '\n', map };
}

// Split a rendered surface into chunks under `maxChars`, never splitting a file's block, so
// each chunk fits the attention context window. Returns [{ text, map }] with per-chunk maps.
export function chunkSurface(fileSurfaces, maxChars = 8000) {
  const chunks = [];
  let batch = [];
  let size = 0;
  const flush = () => { if (batch.length) { chunks.push(renderSurface(batch)); batch = []; size = 0; } };
  for (const fs of fileSurfaces) {
    if (!fs.items.length) continue;
    const cost = fs.path.length + 12 + fs.items.reduce((n, it) => n + Math.min(it.signature.length, 160) + 1, 0);
    if (size && size + cost > maxChars) flush();
    batch.push(fs); size += cost;
  }
  flush();
  return chunks;
}

// Map a flagged attention span back to the surface item(s) it covers: locate the span's words
// in the rendered text (whitespace-tolerant, same spirit as cli.js lineOfSpan), then return
// the map entries for every rendered line the span touches.
export function itemsOfSpan(rendered, spanText) {
  const probe = String(spanText).replace(/^[/].*?===\s*/s, '').replace(/\s+/g, ' ').trim();
  if (!probe) return [];
  const esc = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const words = probe.split(' ').slice(0, 16);
  // Words joined with a small any-character gap, not rigid \s+ — attention spans come back
  // whitespace-mangled and may skip rendered decoration ("{}", newlines) between symbols.
  const m = rendered.text.match(new RegExp(words.map(esc).join('[\\s\\S]{0,16}?')));
  if (!m) return [];
  const startLine = rendered.text.slice(0, m.index).split('\n').length - 1;      // 0-based
  const endLine = rendered.text.slice(0, m.index + m[0].length).split('\n').length - 1;
  const out = [];
  for (let i = startLine; i <= endLine && i < rendered.map.length; i++) {
    const e = rendered.map[i];
    if (e && !out.some((o) => o.file === e.file && o.name === e.name)) out.push(e);
  }
  return out;
}
