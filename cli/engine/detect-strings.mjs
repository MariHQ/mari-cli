// Source-file string linting: extract the human-facing text from source (string/template
// literals, comments, Python docstrings) and run the prose rules over it. Everything that
// isn't user-facing text is replaced by spaces of EQUAL LENGTH — newlines preserved — so the
// findings reported by `detectText` still point at the right line/col in the original file.
//
// Deliberately dependency-free: a tiny per-language scanner, not a full parser. It targets the
// common case (UI microcopy and comments), and it errs toward masking — code it can't classify
// is dropped, never linted as prose. Bare JSX text and `${…}` template expressions are left in
// the string body; they're rarely slop and the cost of a real parser isn't worth it here.

const LANGS = {
  // open/close are single chars; `triples` are matched before single quotes (Python docstrings).
  js: { line: '//', block: ['/*', '*/'], quotes: ['"', "'", '`'], triples: [] },
  py: { line: '#', block: null, quotes: ['"', "'"], triples: ['"""', "'''"] },
};

const EXT_LANG = {
  '.js': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.py': 'py',
};

export function sourceLangFor(ext) { return EXT_LANG[ext] || null; }
export function isSourceFile(ext) { return ext in EXT_LANG; }

// Code in languages we DON'T extract from (Java, Scala, Go, Rust, …). We recognize these only
// so we never lint them as if they were prose — string extraction for them isn't supported yet.
const CODE_EXT = new Set([
  '.java', '.scala', '.kt', '.kts', '.go', '.rs', '.rb', '.php', '.c', '.h', '.cc', '.cpp',
  '.hpp', '.cs', '.swift', '.m', '.mm', '.dart', '.lua', '.pl', '.r', '.sh', '.bash', '.zsh',
  '.sql', '.groovy', '.clj', '.ex', '.exs', '.erl', '.hs', '.ml', '.fs', '.vb',
]);
// A code file in ANY language (supported for extraction or not).
export function isCodeFile(ext) { return ext in EXT_LANG || CODE_EXT.has(ext); }

// License / copyright boilerplate lives in comments at the top of nearly every source file
// (the Apache header alone is in tens of thousands of Flink files). It isn't authored prose, so
// comments matching these markers are dropped, not linted. Applied to COMMENTS only — a
// docstring that happens to mention "license" is real text and stays.
const LICENSE_RE = /\blicen[sc]ed?\b|\bcopyright\b|\ball rights reserved\b|warranties or conditions|as is\b|spdx-license|apache\.org\/licenses|governing permissions/i;

export function maskSource(text, lang) {
  const cfg = LANGS[lang];
  const n = text.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = text[i] === '\n' ? '\n' : ' ';
  if (!cfg) return out.join('');
  const keep = (s, e) => { for (let k = s; k < Math.min(e, n); k++) if (text[k] !== '\n') out[k] = text[k]; };
  // keep a comment span unless it's license/copyright boilerplate
  const keepComment = (s, e) => { if (!LICENSE_RE.test(text.slice(s, e))) keep(s, e); };
  // A blanked delimiter position becomes a sentence boundary so that two kept spans on adjacent
  // lines (e.g. 'FLINK_HOME' then 'FLINK_HOME') don't read as one run and trip cross-span rules
  // like repeated-word. Offsets are preserved — we only rewrite a char we'd otherwise blank.
  const boundary = (p) => { if (p >= 0 && p < n && text[p] !== '\n') out[p] = '.'; };

  let i = 0;
  while (i < n) {
    const ch = text[i];

    // line comment → keep the text after the marker
    if (cfg.line && text.startsWith(cfg.line, i)) {
      let j = i + cfg.line.length; const s = j;
      while (j < n && text[j] !== '\n') j++;
      boundary(i); keepComment(s, j); i = j; continue;
    }
    // block comment → keep the body
    if (cfg.block && text.startsWith(cfg.block[0], i)) {
      const s = i + cfg.block[0].length;
      const end = text.indexOf(cfg.block[1], s);
      const stop = end === -1 ? n : end;
      boundary(i); keepComment(s, stop); i = end === -1 ? n : stop + cfg.block[1].length; continue;
    }
    // triple-quoted string / docstring (Python) — match before single quotes
    let tri = false;
    for (const t of cfg.triples) {
      if (text.startsWith(t, i)) {
        const s = i + t.length;
        const end = text.indexOf(t, s);
        const stop = end === -1 ? n : end;
        boundary(i); keep(s, stop); i = end === -1 ? n : stop + t.length; tri = true; break;
      }
    }
    if (tri) continue;
    // single/double/backtick string with escape handling
    if (cfg.quotes.includes(ch)) {
      let j = i + 1; const s = j;
      while (j < n) {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === ch) break;
        if (text[j] === '\n' && ch !== '`') break; // unterminated single-line string
        j++;
      }
      boundary(i); keep(s, j); i = j + 1; continue;
    }
    i++;
  }
  return out.join('');
}
