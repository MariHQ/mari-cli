// Detection orchestration: run the rule registry over a string, a file, or a tree.

import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join, relative, extname, basename } from 'node:path';
import { segment, isNonLatinProse } from './segment.mjs';
import { RULES } from './rules.mjs';
import { parseInlineWaivers, waived, fileIgnored } from './config.mjs';
import { dedupe, sortFindings } from './findings.mjs';
import { sourceLangFor, isSourceFile, isCodeFile, maskSource } from './detect-strings.mjs';

// Markdown only, for now. (.txt and source-string linting are intentionally out of scope —
// the source extractor in detect-strings.mjs stays built but is unreachable unless lintSource
// is explicitly turned on.)
export const PROSE_EXT = new Set(['.md', '.mdx', '.mdc', '.markdown']);
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.mari',
  'testdata', 'test-data', 'fixtures', '__fixtures__', 'golden', 'snapshots', '__snapshots__', 'target', 'out',
  // vendored / third-party trees — not the project's own prose
  'vendor', 'vendored', '3rdparty', 'thirdparty', 'third_party', 'third-party']);

// Cheap guard: a prose file has sentence structure. Data dumps (test fixtures, CSV-ish text,
// generated tables) have many words but almost no terminal punctuation — skip them.
export function looksLikeData(text) {
  const words = (text.match(/[A-Za-z]{2,}/g) || []).length;
  if (words < 100) return false; // too small to judge; lint it
  const sentences = (text.match(/[.!?](\s|$)/g) || []).length;
  const longLines = text.split('\n').some((l) => l.length > 2000);
  return longLines || sentences < words / 200;
}

export function detectText(text, { config, useInlineIgnores = true } = {}) {
  const ctx = segment(text);
  // check the masked text so English license headers/code don't keep a non-English doc in scope
  if (isNonLatinProse(ctx.masked)) return [];
  const raw = [];
  const emit = (f) => {
    const { line, col } = ctx.locate(f.offset);
    raw.push({ ...f, line, col });
  };
  const pack = config?.styleGuide || 'microsoft';
  ctx.styleGuide = pack; // shared rules (e.g. serial-comma) can vary behavior by base pack
  for (const rule of RULES) {
    if (config?.ignoreRules?.has(rule.id)) continue;
    // pack-gated rules only run under their base style guide; 'plain' rules are opt-in
    if (rule.pack && rule.pack !== pack) continue;
    try { rule.run(ctx, emit); } catch { /* never break detection on one rule */ }
  }
  let findings = dedupe(raw);

  // value-level ignores
  if (config?.ignoreValues) {
    findings = findings.filter((f) => {
      const vals = config.ignoreValues[f.ruleId];
      if (!vals) return true;
      return !vals.some((v) => f.span.toLowerCase().includes(String(v).toLowerCase()));
    });
  }
  // inline waivers
  if (useInlineIgnores) {
    const waivers = parseInlineWaivers(text);
    findings = findings.filter((f) => !waived(waivers, f.ruleId, f.line));
  }
  return sortFindings(findings);
}

export function detectFile(path, { config, root = process.cwd(), useInlineIgnores = true, lintSource = false } = {}) {
  const rel = relative(root, path) || basename(path);
  if (config?.ignoreFiles && fileIgnored(rel, config.ignoreFiles)) return null;
  const ext = extname(path).toLowerCase();
  if (isSourceFile(ext)) {
    // Supported source language: lint the human-facing text only, but only when asked (--source).
    // Never prose-lint code — without the flag, skip it.
    if (!lintSource) return null;
    const masked = maskSource(readFileSync(path, 'utf8'), sourceLangFor(ext));
    return { file: rel, findings: detectText(masked, { config, useInlineIgnores }), text: masked };
  }
  // Code in an unsupported language (Java, Scala, Go, …): never lint it as prose.
  if (isCodeFile(ext)) return null;
  // Markdown-only scope: skip anything that isn't a markdown file, even as an explicit target.
  if (!PROSE_EXT.has(ext)) return null;
  if (isNonEnglishLocale(path)) return null; // localized translation (name.<locale>.md)
  const text = readFileSync(path, 'utf8');
  if (looksLikeData(text)) return null; // data dump / test fixture, not prose
  return { file: rel, findings: detectText(text, { config, useInlineIgnores }), text };
}

export function isProse(path) { return PROSE_EXT.has(extname(path).toLowerCase()); }
export function isSource(path) { return isSourceFile(extname(path).toLowerCase()); }

// Localized docs follow the `name.<locale>.md` convention (README.es.md, README.zh-CN.md,
// guide.ur-pk.md). English rules don't apply to other languages, so skip non-English locales.
const NON_EN_LOCALES = new Set(('es fr de pt it ja ko zh ru ar ur hi bn pa te ta mr gu kn ml ' +
  'nl pl tr vi th id sv da no fi cs el he ro hu uk fa sw af sr hr sk bg lt lv et sl ms tl ne si km my ka az kk uz').split(' '));
export function isNonEnglishLocale(path) {
  // filename suffix: README.es.md, guide.zh-CN.md
  const m = basename(path).match(/\.([a-z]{2,3})(?:-[a-zA-Z]{2,4})?\.(?:md|mdx|markdown|txt)$/i);
  if (m && NON_EN_LOCALES.has(m[1].toLowerCase())) return true;
  // directory conventions: content.zh (Hugo/Flink), zh-Hans/pt-BR dirs, i18n/<locale>/…
  const segs = path.split(/[\\/]/);
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k].toLowerCase();
    const cm = s.match(/^content[.\-]([a-z]{2,3})(?:-[a-z]{2,4})?$/); // content.zh
    if (cm && NON_EN_LOCALES.has(cm[1])) return true;
    const rm = s.match(/^([a-z]{2,3})-[a-z]{2,4}$/);                  // zh-hans, pt-br
    if (rm && NON_EN_LOCALES.has(rm[1])) return true;
    if (['i18n', 'locales', 'translations', 'lang', 'locale'].includes(s) && segs[k + 1]) {
      if (NON_EN_LOCALES.has(segs[k + 1].toLowerCase().split('-')[0])) return true;
    }
  }
  return false;
}

export function detectTarget(target, opts = {}) {
  const root = opts.root || process.cwd();
  const st = statSync(target);
  const results = [];
  if (st.isDirectory()) {
    for (const p of walk(target)) {
      if (!isProse(p) && !(opts.lintSource && isSource(p))) continue;
      const r = detectFile(p, { ...opts, root });
      if (r) results.push(r);
    }
  } else {
    const r = detectFile(target, { ...opts, root });
    if (r) results.push(r);
  }
  return results;
}

// Conventionally generated / boilerplate files: not prose to lint in a tree scan (an explicit
// `mari detect CHANGELOG.md` still works — this only filters the recursive walk).
const SKIP_FILE = /^(CHANGELOG|HISTORY|CHANGES|RELEASES?|NEWS|AUTHORS|CONTRIBUTORS|NOTICE|LICEN[CS]E|COPYING|THIRD[-_]?PARTY)(\.|$)|^llms(-full)?\.txt$/i;
export function isGeneratedFile(name) { return SKIP_FILE.test(name); }
export function isSkippedDir(name) { return SKIP_DIR.has(name); }

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIR.has(name) || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (!isGeneratedFile(name)) yield p;
  }
}
