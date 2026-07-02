// Code-symbol ↔ doc-mention candidates for semantic lineage. Embeddings find topical overlap;
// this finds the precise thing: a doc that NAMES a function/class/command defined in code. Pure
// lexical (regex per language family), no models — high precision, cheap enough to run on every
// propose. Complements assoc.mjs candidates; both feed proposeEdges().

import { readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { walkFiles } from './assoc.mjs';

export const DOC_EXT = new Set(['.md', '.mdx', '.mdc', '.markdown', '.txt', '.rst', '.adoc']);

// Top-level definitions worth documenting. Deliberately shallow: exported/def-site names only,
// no locals, no methods — doc mentions of those are almost always incidental.
const DEF_PATTERNS = {
  js: [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|class)\s+([A-Za-z_$][\w$]*)/,
    /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
    /^(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)/,
    /^class\s+([A-Za-z_$][\w$]*)/,
  ],
  py: [/^(?:async\s+)?def\s+([A-Za-z_]\w*)/, /^class\s+([A-Za-z_]\w*)/],
  go: [/^func\s+(?:\([^)]*\)\s+)?([A-Za-z_]\w*)/, /^type\s+([A-Za-z_]\w*)/],
  rs: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z_]\w*)/],
  jvm: [/^\s*(?:public|internal)?\s*(?:abstract\s+|final\s+|data\s+|sealed\s+)*(?:class|interface|enum|object)\s+([A-Za-z_]\w*)/],
};
const EXT_FAMILY = {
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js', '.ts': 'js', '.tsx': 'js',
  '.py': 'py', '.go': 'go', '.rs': 'rs',
  '.java': 'jvm', '.kt': 'jvm', '.kts': 'jvm', '.scala': 'jvm', '.cs': 'jvm',
};

// Names that appear in prose for reasons other than the symbol. Short or dictionary-common
// names drown the graph in false positives; require length ≥ 4 and skip the obvious ones.
const STOP = new Set([
  'main', 'test', 'tests', 'init', 'setup', 'index', 'error', 'errors', 'data', 'config',
  'value', 'values', 'result', 'results', 'name', 'type', 'types', 'file', 'files', 'list',
  'item', 'items', 'node', 'text', 'line', 'lines', 'read', 'write', 'load', 'save', 'run',
  'build', 'update', 'check', 'parse', 'render', 'start', 'stop', 'close', 'open', 'state',
]);

// Where a definition starting at line index `i` actually ends — brace depth for brace
// languages, indentation for Python. A span should cover the symbol's body, not a fixed
// window: "def line + 24" swallows the next function and makes every edge coarser than the
// promise it encodes. Heuristic (braces in strings fool it), capped, fallback +12.
function defExtent(lines, i, family) {
  const cap = Math.min(lines.length - 1, i + 200);
  if (family === 'py') {
    const base = (lines[i].match(/^\s*/) || [''])[0].length;
    let end = i;
    for (let j = i + 1; j <= cap; j++) {
      if (!lines[j].trim()) continue; // blank lines inside the body don't end it
      if ((lines[j].match(/^\s*/) || [''])[0].length <= base) break;
      end = j;
    }
    return end;
  }
  let depth = 0, opened = false;
  for (let j = i; j <= cap; j++) {
    for (const ch of lines[j]) { if (ch === '{') { depth++; opened = true; } else if (ch === '}') depth--; }
    if (opened && depth <= 0) return j;
    if (!opened && j >= i + 2) break; // no body (export const X = …) — the def line(s) suffice
  }
  return opened ? cap : Math.min(i + (lines[i].trimEnd().endsWith(';') ? 0 : 12), lines.length - 1);
}

export function extractSymbols(text, file) {
  const family = EXT_FAMILY[extname(file).toLowerCase()];
  if (!family) return [];
  const out = [];
  const seen = new Set();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const re of DEF_PATTERNS[family]) {
      const m = lines[i].match(re);
      if (!m) continue;
      const name = m[1];
      if (name.length < 4 || STOP.has(name.toLowerCase()) || seen.has(name)) break;
      seen.add(name);
      out.push({ name, line: i + 1, endLine: defExtent(lines, i, family) + 1 });
      break;
    }
  }
  return out;
}

// Where a doc mentions `name`: code-marked mentions (`name`, name(), fenced blocks) score high;
// a bare word-boundary hit still counts but lower. A plain lowercase short name (`live`,
// `facts`) is indistinguishable from ordinary English when unmarked — "settings live under…"
// is a verb, not the command — so those only match code-marked. Returns [{ line, score }].
const plainWord = (name) => /^[a-z]+$/.test(name) && name.length < 8;
export function symbolMentions(docText, name) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const marked = new RegExp('`[^`]*\\b' + esc + '\\b[^`]*`|\\b' + esc + '\\s*\\(');
  const bare = plainWord(name) ? null : new RegExp('\\b' + esc + '\\b');
  const out = [];
  const lines = docText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (marked.test(lines[i])) out.push({ line: i + 1, score: 0.95 });
    else if (bare?.test(lines[i])) out.push({ line: i + 1, score: 0.75 });
  }
  return out;
}

// Scan the repo: extract symbols from every code file, grep every doc for them, emit proposals
// shaped for proposeEdges(). Symbols defined in several files are ambiguous — a doc mention
// can't be pinned to one definition — so they're dropped.
export function symbolProposals(root, { maxFileBytes = 512 * 1024 } = {}) {
  const rels = walkFiles(root);
  const docs = [], code = [];
  for (const rel of rels) (DOC_EXT.has(extname(rel).toLowerCase()) ? docs : code).push(rel);

  const defs = new Map(); // name → { file, line } | null (null = ambiguous)
  for (const rel of code) {
    let text; try { if (statSync(join(root, rel)).size > maxFileBytes) continue; text = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
    for (const s of extractSymbols(text, rel)) {
      defs.set(s.name, defs.has(s.name) ? null : { file: rel, line: s.line, endLine: s.endLine });
    }
  }

  const proposals = [];
  for (const rel of docs) {
    let text; try { text = readFileSync(join(root, rel), 'utf8'); } catch { continue; }
    const docLines = text.split('\n');
    for (const [name, def] of defs) {
      if (!def || def.file === rel) continue;
      const mentions = symbolMentions(text, name);
      if (!mentions.length) continue;
      // Cluster adjacent mentions into one span; a doc that names the symbol 40 times should
      // yield a handful of edges, not 40.
      let cluster = null;
      const flush = () => { if (cluster) proposals.push(mkProposal(def, rel, cluster, docLines, name)); cluster = null; };
      for (const m of mentions) {
        if (cluster && m.line - cluster.end <= 6) { cluster.end = m.line; cluster.score = Math.max(cluster.score, m.score); }
        else { flush(); cluster = { start: m.line, end: m.line, score: m.score }; }
      }
      flush();
    }
  }
  return proposals;
}

// A doc mention's natural unit is its PARAGRAPH (blank-line bounded), not a fixed ±3 window —
// prose promises live in paragraphs. Runaway expansion (tables, dense reference lists) is
// capped back to the cluster itself.
function paragraphBounds(lines, start, end) {
  let s = start, e = end;
  while (s > 1 && lines[s - 2].trim()) s--;
  while (e < lines.length && lines[e].trim()) e++;
  return e - s > 16 ? [start, Math.min(end + 1, lines.length)] : [s, e];
}

function mkProposal(def, docFile, cluster, docLines, name) {
  const [ds, de] = paragraphBounds(docLines, cluster.start, cluster.end);
  return {
    src: { file: def.file, start: def.line, end: def.endLine, symbol: name },
    dst: { file: docFile, start: ds, end: de, symbol: name },
    score: cluster.score, via: 'symbol', rel: 'documents',
  };
}
