// Shared hook logic. Never throws to the caller; the entry points wrap everything so the
// agent turn is never broken. Deterministic detector only — no models, no network.

import { readFileSync, existsSync } from 'node:fs';
import { extname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const ENGINE = new URL('../../cli/engine/index.mjs', import.meta.url);
const CONFIG = new URL('../../cli/engine/config.mjs', import.meta.url);
const I18N = new URL('../../cli/engine/i18n.mjs', import.meta.url);
const GRAMMAR = new URL('../../cli/engine/grammar.mjs', import.meta.url);
const ASSOC = new URL('../../cli/engine/assoc.mjs', import.meta.url);

// Optional grammar + mechanics pass (Harper WASM). Off unless hook.grammar / detector.grammar is
// set. Opt-in because it loads an ~18 MB WASM blob; the deterministic path never touches it.
// Findings merge in at warn severity so the agent — which already has the file in context after
// an edit — can correct broken English in the same turn. Never throws.
async function grammarFindings(text, config) {
  if (!(config?.hook?.grammar || config?.detector?.grammar)) return [];
  try {
    const { detectGrammar } = await import(GRAMMAR);
    const g = await detectGrammar(text);
    return config?.ignoreRules ? g.filter((f) => !config.ignoreRules.has(f.ruleId)) : g;
  } catch { return []; }
}

export async function readStdin() {
  try {
    const raw = readFileSync(0, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

const PROSE = new Set(['.md', '.mdx', '.mdc', '.markdown']);

// The hook surfaces only error + warn by default — on real repos advisories are 70–90% of
// findings, which buries the actionable ones and pressures whole-file cleanup after a small
// edit. Advisories stay available on demand via `mari audit`. Override per project with
// `hook.minSeverity` in .mari/config.json ("error" | "warn" | "advisory").
const SEV_RANK = { advisory: 0, warn: 1, error: 2 };
function severityFloor(findings, config) {
  const floor = SEV_RANK[config?.hook?.minSeverity] ?? SEV_RANK.warn;
  return findings.filter((f) => (SEV_RANK[f.severity] ?? 0) >= floor);
}

// Merged findings (detector + grammar) sorted most-important-first, so truncation in
// renderForAgent drops the least important, not whatever happened to be appended last.
// Copies — never mutates the caller's array.
function sortMerged(findings) {
  return [...findings].sort((a, b) =>
    ((SEV_RANK[b.severity] ?? -1) - (SEV_RANK[a.severity] ?? -1)) || ((a.line ?? 0) - (b.line ?? 0)));
}

// Decide the prose target file from a Claude Code PostToolUse payload. Markdown only — returns
// null if nothing to lint.
export function targetFile(payload) {
  const fp = editedFile(payload);
  if (!fp || !PROSE.has(extname(fp).toLowerCase())) return null;
  return fp;
}

// Any edited file from a post-edit payload (any extension), if it exists on disk. Edit rules
// fire on these — source, config, anything — not just markdown. Provider-tolerant like
// proposedEdit: Claude Code sends { tool_name, tool_input: { file_path } }; Cursor's
// afterFileEdit sends { file_path, edits }; other hosts send a bare path/file field. When a
// tool_name IS present it must be an edit tool (so Bash/Read payloads never match).
export function editedFile(payload) {
  if (payload?.tool_name && !['Edit', 'Write', 'MultiEdit'].includes(payload.tool_name)) return null;
  const ti = payload?.tool_input || {};
  const fp = ti.file_path || ti.path || payload?.file_path || payload?.path || payload?.file || null;
  if (!fp || typeof fp !== 'string' || !existsSync(fp)) return null;
  return fp;
}

// User-defined edit rules: if the edited file matches a rule's paths, surface its notify text so
// the agent does the follow-up (e.g. "the API changed — update docs/api/**"). Any file type.
// Returns a formatted notice string or null. Never throws.
export async function rulesNotice(fp, cwd) {
  try {
    const { loadConfig, matchRules } = await import(CONFIG);
    const config = safe(() => loadConfig(cwd), null);
    if (!config || config.hook?.enabled === false || !config.rules?.length) return null;
    const rel = relative(cwd, fp) || fp;
    const matched = matchRules(rel, config.rules);
    if (!matched.length) return null;
    const lines = matched.map((r) => `  • [${r.name || 'rule'}] ${r.notify}`).join('\n');
    return `🔔 Mari — \`${rel}\` was edited:\n${lines}`;
  } catch { return null; }
}

// Derived code<->doc associations (from `mari assoc build`, stored in .mari/assoc/). When an
// edited file is one side of an association, remind the agent to check the counterpart — and
// include a short snippet so it can decide without opening the file. Deterministic; no models.
function snippet(cwd, file, lines) {
  try {
    const body = readFileSync(new URL('file://' + (file.startsWith('/') ? file : `${cwd}/${file}`)), 'utf8');
    const all = body.split('\n');
    const from = Math.max(0, (lines?.[0] || 1) - 1);
    return all.slice(from, from + 5).join('\n').trim().slice(0, 400);
  } catch { return null; }
}
export async function assocNotice(fp, cwd) {
  try {
    const { loadAssoc, associationsForFile } = await import(ASSOC);
    const { loadConfig } = await import(CONFIG);
    const config = safe(() => loadConfig(cwd), null);
    if (config?.hook?.enabled === false || config?.hook?.assoc === false) return null;
    const index = safe(() => loadAssoc(cwd), null);
    if (!index?.associations?.length) return null;
    const rel = relative(cwd, fp) || fp;
    const hits = associationsForFile(index, rel); // normalized: edited file is `a`, counterpart is `b`
    if (!hits.length) return null;

    const seen = new Set(); const lines = [];
    for (const a of hits) {
      const key = a.b.file + '|' + a.b.span; if (seen.has(key)) continue; seen.add(key);
      const snip = snippet(cwd, a.b.file, a.b.lines);
      lines.push(`  • ${a.b.file} L${a.b.lines[0]}-${a.b.lines[1]} (${a.via}, ${a.score})${snip ? `\n      ${snip.split('\n').join('\n      ')}` : ''}`);
      if (lines.length >= 6) break;
    }
    return `🔗 Mari — \`${rel}\` was edited; semantically associated spans elsewhere — check if they need updating:\n${lines.join('\n')}`;
  } catch { return null; }
}

export async function lint(fp, cwd) {
  const { detectText } = await import(ENGINE);
  const { loadConfig, fileIgnored } = await import(CONFIG);
  const config = safe(() => loadConfig(cwd), null);
  if (config?.hook?.enabled === false) return { disabled: true, findings: [] };
  const rel = relative(cwd, fp) || fp;
  if (config && fileIgnored(rel, config.ignoreFiles)) return { findings: [] };
  const text = readFileSync(fp, 'utf8');
  const findings = sortMerged(severityFloor(detectText(text, { config }), config)
    .concat(severityFloor(await grammarFindings(text, config), config)));
  return { rel, findings, config };
}

// Pre-write path: lint a proposed content string that isn't on disk yet.
export async function lintContent(text, cwd, ext = '.md') {
  if (!PROSE.has(ext.toLowerCase())) return { findings: [] };
  const { detectText } = await import(ENGINE);
  const { loadConfig } = await import(CONFIG);
  const config = safe(() => loadConfig(cwd), null);
  if (config?.hook?.enabled === false) return { disabled: true, findings: [] };
  const findings = sortMerged(severityFloor(detectText(text, { config }), config)
    .concat(severityFloor(await grammarFindings(text, config), config)));
  return { findings, config };
}

// Lint each proposed fragment SEPARATELY — MultiEdit fragments are disjoint snippets, and
// joining them would fabricate adjacency (false repeated-word/cadence hits across edits) and
// misattribute line numbers. Every finding gets a fragment-relative `lineLabel` ("edit #2 L3")
// unless the payload carried the whole file (`isFullContent`), where lines are file-accurate.
export async function lintFragments(fragments, cwd, ext = '.md', { isFullContent = false } = {}) {
  const out = [];
  let config = null, disabled = false;
  for (let i = 0; i < fragments.length; i++) {
    const res = await lintContent(fragments[i], cwd, ext);
    if (res.disabled) { disabled = true; break; }
    config = config || res.config;
    for (const f of res.findings) {
      out.push(isFullContent ? f : { ...f, lineLabel: `edit #${i + 1} L${f.line}` });
    }
  }
  return { disabled, findings: sortMerged(out), config };
}

// Extract the proposed file path + content from a pre-write payload (provider-tolerant).
// `fragments` are the individual proposed snippets (one per MultiEdit edit); `text` is the
// legacy joined view; `isFullContent` marks a whole-file Write where lines are file-accurate.
export function proposedEdit(payload) {
  const ti = payload?.tool_input || payload || {};
  const fp = ti.file_path || ti.path || payload?.file_path || '';
  let fragments = [];
  if (ti.content != null) fragments = [String(ti.content)];
  else if (ti.new_string != null || ti.new_text != null) fragments = [String(ti.new_string ?? ti.new_text)];
  else if (Array.isArray(ti.edits)) fragments = ti.edits.map((e) => String(e.new_string ?? e.new_text ?? ''));
  return { fp, text: fragments.join('\n'), fragments, isFullContent: ti.content != null };
}

export async function renderForAgent(rel, findings, max = 10) {
  const sev = (s) => (s === 'error' ? 'error   ' : s === 'warn' ? 'warn    ' : 'advisory');
  const shown = findings.slice(0, max);
  const lines = shown.map((f) => `  ${String(f.lineLabel || 'L' + f.line).padEnd(5)} ${sev(f.severity)} ${f.ruleId.padEnd(22)} ${f.message}`);
  const more = findings.length > max ? `\n  (+${findings.length - max} more — run /mari audit ${rel})` : '';
  const counts = findings.reduce((a, f) => { a[f.severity]++; return a; }, { error: 0, warn: 0, advisory: 0 });

  // Attach a one-shot bad→good exemplar for each distinct rule present, so the rewrite has a
  // concrete pattern to follow instead of guessing from the terse message.
  const { fixExampleFor } = await import(new URL('../../cli/engine/examples.mjs', import.meta.url));
  const distinct = [...new Set(shown.map((f) => f.ruleId))];
  const examples = distinct.map((id) => [id, fixExampleFor(id)]).filter(([, e]) => e);
  const fixBlock = examples.length
    ? '\n\nHow to fix (bad → good):\n' + examples.map(([id, e]) =>
        `  ${id}\n    ✗ ${e.bad.replace(/\n/g, '\n      ')}\n    ✓ ${e.good.replace(/\n/g, '\n      ')}` +
        (e.note ? `\n    · ${e.note}` : '')).join('\n')
    : '';

  return `Mari — ${rel}: ${findings.length} findings ` +
    `(${counts.error} error, ${counts.warn} warn, ${counts.advisory} advisory). Consider fixing before continuing.\n` +
    lines.join('\n') + more + fixBlock +
    `\n\nWaive a rule: mari ignores add-rule <rule-id> (or add-file <glob> / add-value <rule> <value>) — writes .mari/config.json`;
}

// When the edited file belongs to a localized set, remind the agent which translations may now
// be stale. Source-only by default (translators don't need nagging); set i18n.notifyOn:"any" to
// also fire on translation edits. Returns null when there's nothing to say.
export async function i18nNote(fp, cwd, config) {
  try {
    const { i18nAssociations } = await import(I18N);
    const a = i18nAssociations(fp, cwd, config);
    if (!a || !a.siblings.length) return null;
    const notifyOn = (config?.raw?.i18n || config?.i18n || {}).notifyOn || 'source';
    if (!a.isSource && notifyOn !== 'any') return null;
    const list = a.siblings.map((s) => `  ${String(s.locale).padEnd(7)} ${s.rel}`).join('\n');
    const head = a.isSource
      ? `🌐 ${a.siblings.length} localized version(s) may be stale after this edit — update to match:`
      : `🌐 This is the ${a.locale} translation; the source and other locales may need the same change:`;
    return `${head}\n${list}`;
  } catch { return null; }
}

export function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }
