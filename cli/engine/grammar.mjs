// Optional grammar + usage/mechanics pass via Harper (Automattic) — a Rust→WASM offline grammar
// checker. OPT-IN: the default detector stays pure-deterministic and synchronous; this loads an
// ~18 MB WASM blob and runs async, so it only fires behind `--grammar` (CLI) or `hook.grammar`
// (the edit hook). No network, no API key — it runs entirely on-device.
//
// LOW NOISE is the whole point. Harper, run with all rules on, false-positives heavily on
// technical markdown: it flags identifiers (`JUnit`, `non-empty`) as misspellings, splits
// technical compounds (`classpath` → "class path"), and wants Title Case headings (the opposite
// of Mari's sentence-case preference). We therefore keep only the high-precision "broken English"
// lint kinds and drop the rest. Harper's own markdown parser skips fenced/inline code, so offsets
// come back into the original source.

let _linterPromise = null;

// Specific Harper rules to turn off — calibrated on the Flink corpus as the main false-positive
// sources within otherwise-useful kinds. MassNouns mislabels ordinary count nouns ("a greeting is
// a mass noun"); MissingPreposition fires vaguely on bare nouns ("environment" → "missing a
// preposition"). Disabling by rule name keeps the good catches in those kinds (e.g. its/it's).
const DISABLE_RULES = ['MassNouns', 'MissingPreposition'];

let _missingWarned = false;

async function getLinter() {
  if (!_linterPromise) {
    _linterPromise = (async () => {
      let LocalLinter, binary;
      try {
        ({ LocalLinter } = await import('harper.js'));
        ({ binary } = await import('harper.js/binary'));
      } catch (e) {
        // harper.js is an optional install — degrade with one clear line, never a stack trace.
        if (!_missingWarned) {
          _missingWarned = true;
          console.error('mari: grammar pass skipped — harper.js is not installed. Run `npm i harper.js` to enable it.');
        }
        throw e;
      }
      const linter = new LocalLinter({ binary });
      await linter.setup();
      try {
        const cfg = await linter.getLintConfig();
        for (const name of DISABLE_RULES) if (name in cfg) cfg[name] = false;
        await linter.setLintConfig(cfg);
      } catch { /* config is best-effort; linting still works without it */ }
      return linter;
    })();
  }
  return _linterPromise;
}

// Is the optional Harper dependency installed?
export async function grammarAvailable() {
  try { await import('harper.js'); return true; } catch { return false; }
}

// The lint kinds we keep by default — the high-precision "broken English / mechanics" classes.
// Dropped (heavy false positives or overlap with Mari's own rules on technical docs):
//   Spelling, Typo, Capitalization, Formatting, Punctuation, WordChoice, Style, Regionalism,
//   Readability. See cli/engine/grammar.mjs header + the calibration on the Flink corpus.
export const DEFAULT_GRAMMAR_KINDS = new Set([
  'Agreement',     // subject-verb / article-noun agreement
  'Grammar',       // structural grammar errors ("allows to deliver")
  'Miscellaneous', // includes wrong indefinite article (a → an)
  'Eggcorn',       // real-word confusables ("for all intensive purposes")
  'Malapropism',   // wrong-but-similar word
  'Nonstandard',   // non-standard usage
  'BoundaryError', // sentence-boundary / run-on issues
  'Redundancy',    // "and also" → "and"
]);

// Harper reports spans as Unicode-scalar (code point) indices; JS strings are UTF-16, so any
// astral character (emoji, some CJK) before a span would shift every later offset. Returns a
// scalar→UTF-16 offset converter; identity when the text has no surrogate pairs.
function makeScalarToUtf16(text) {
  if (!/[\uD800-\uDBFF]/.test(text)) return (i) => i;
  const map = [];
  let u = 0;
  for (const ch of text) { map.push(u); u += ch.length; }
  map.push(u); // end-of-text sentinel so span.end converts too
  return (i) => map[Math.max(0, Math.min(i, map.length - 1))];
}

// 1-based (line, col) from a char offset.
function makeLocator(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (off) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: off - starts[lo] + 1 };
  };
}

// Lint `text` (markdown) and return Mari findings for the kept lint kinds. Each finding carries
// Harper's message plus its top suggestions, so the agent can apply the correction directly.
// Returns [] on any failure (missing dep, WASM error) — grammar must never break detection.
export async function detectGrammar(text, { kinds = DEFAULT_GRAMMAR_KINDS, max = 30, severity = 'warn' } = {}) {
  let lints;
  try {
    const linter = await getLinter();
    lints = await linter.lint(text, { language: 'markdown' });
  } catch { return []; }

  const locate = makeLocator(text);
  const toUtf16 = makeScalarToUtf16(text);
  const out = [];
  for (const l of lints) {
    let kind;
    try { kind = l.lint_kind(); } catch { continue; }
    if (kinds && !kinds.has(kind)) continue;
    const span = l.span();
    const offset = toUtf16(span.start);
    const length = Math.max(0, toUtf16(span.end) - offset);
    const problem = (l.get_problem_text() || '').replace(/\s+/g, ' ').trim();
    const suggestions = l.suggestions().map((s) => s.get_replacement_text()).filter((s) => s != null).slice(0, 3);
    const fix = suggestions.length
      ? ` Suggested: ${suggestions.map((s) => (s === '' ? '(remove)' : `"${s}"`)).join(' / ')}.`
      : '';
    const { line, col } = locate(offset);
    out.push({
      ruleId: 'grammar-' + kind.toLowerCase(),
      family: 'grammar',
      source: 'grammar',
      severity,
      offset, length, line, col,
      span: problem.slice(0, 80),
      message: l.message() + fix,
      suggestions,
    });
  }
  out.sort((a, b) => a.offset - b.offset);
  return out.slice(0, max);
}
