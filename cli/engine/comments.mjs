// Comment stripping for attention prep. Comments are prose; when a prose query attends over a
// code file, the comments soak up the attention mass and the code itself gets outshouted — so
// `mari explore` strips them by default before anything reaches the attention model
// (--keep-comments opts out). Retrieval/embedding always sees the full text; only attention prep
// strips.
//
// Comments are BLANKED (replaced with spaces), never removed: the output is the same length with
// the same newlines, so offsets and ≈L line anchors computed against the stripped text hold for
// the original. The scanner is string-aware per language family — `"https://x"` and `s = "# not
// a comment"` survive intact.

export const CODE_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|go|rs|java|kt|kts|scala|swift|c|h|cc|cpp|hpp|cs|php|py|rb|sh|bash|zsh|yaml|yml|toml|r|jl|lua|sql)$/i;

const FAMILY = [
  { re: /\.(mjs|cjs|js|jsx|ts|tsx|go|rs|java|kt|kts|scala|swift|c|h|cc|cpp|hpp|cs|php)$/i, kind: 'c' },
  { re: /\.(py|rb|sh|bash|zsh|yaml|yml|toml|r|jl)$/i, kind: 'hash' },
  { re: /\.(sql)$/i, kind: 'sql' },
  { re: /\.(lua)$/i, kind: 'lua' },
];

// Blank text[i..j) except newlines.
function blank(chars, i, j) { for (let k = i; k < j; k++) if (chars[k] !== '\n') chars[k] = ' '; }

export function stripComments(text, path) {
  const fam = FAMILY.find((f) => f.re.test(String(path)))?.kind;
  if (!fam) return String(text);
  const s = String(text);
  const chars = [...s];
  const n = s.length;
  let i = 0;
  const skipString = (quote, { multiline = false, escapes = true } = {}) => {
    i++; // opening quote
    while (i < n) {
      if (escapes && s[i] === '\\') { i += 2; continue; }
      if (s.startsWith(quote, i)) { i += quote.length; return; }
      if (!multiline && s[i] === '\n') return; // unterminated — bail at EOL
      i++;
    }
  };
  const lineComment = () => { const start = i; while (i < n && s[i] !== '\n') i++; blank(chars, start, i); };
  const blockComment = (open, close) => {
    const start = i; i += open.length;
    while (i < n && !s.startsWith(close, i)) i++;
    i = Math.min(n, i + close.length);
    blank(chars, start, i);
  };

  while (i < n) {
    const c = s[i];
    if (fam === 'c') {
      if (c === '/' && s[i + 1] === '/') { lineComment(); continue; }
      if (c === '/' && s[i + 1] === '*') { blockComment('/*', '*/'); continue; }
      if (c === '`') { skipString('`', { multiline: true }); continue; }
      if (c === '"' || c === "'") { skipString(c); continue; }
    } else if (fam === 'hash') {
      if (c === '#') { lineComment(); continue; }
      if (s.startsWith('"""', i) || s.startsWith("'''", i)) { skipString(s.slice(i, i + 3), { multiline: true }); continue; }
      if (c === '"' || c === "'") { skipString(c); continue; }
    } else if (fam === 'sql') {
      if (c === '-' && s[i + 1] === '-') { lineComment(); continue; }
      if (c === '/' && s[i + 1] === '*') { blockComment('/*', '*/'); continue; }
      if (c === '"' || c === "'") { skipString(c, { escapes: false }); continue; }
    } else if (fam === 'lua') {
      if (s.startsWith('--[[', i)) { blockComment('--[[', ']]'); continue; }
      if (c === '-' && s[i + 1] === '-') { lineComment(); continue; }
      if (c === '"' || c === "'") { skipString(c); continue; }
    }
    i++;
  }
  return chars.join('');
}
