// Shared hook logic. Never throws to the caller; the entry points wrap everything so the
// agent turn is never broken. Deterministic detector only — no models, no network.

import { readFileSync, existsSync } from 'node:fs';
import { extname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const ENGINE = new URL('../../cli/engine/index.mjs', import.meta.url);
const CONFIG = new URL('../../cli/engine/config.mjs', import.meta.url);

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

// Decide the target file from a Claude Code PostToolUse payload. Returns null if nothing to lint.
export function targetFile(payload) {
  const name = payload?.tool_name;
  if (!['Edit', 'Write', 'MultiEdit'].includes(name)) return null;
  const fp = payload?.tool_input?.file_path;
  if (!fp || !existsSync(fp)) return null;
  if (!PROSE.has(extname(fp).toLowerCase())) return null;
  return fp;
}

export async function lint(fp, cwd) {
  const { detectText } = await import(ENGINE);
  const { loadConfig, fileIgnored } = await import(CONFIG);
  const config = safe(() => loadConfig(cwd), null);
  if (config?.hook?.enabled === false) return { disabled: true, findings: [] };
  const rel = relative(cwd, fp) || fp;
  if (config && fileIgnored(rel, config.ignoreFiles)) return { findings: [] };
  const text = readFileSync(fp, 'utf8');
  const findings = severityFloor(detectText(text, { config }), config);
  return { rel, findings, config };
}

// Pre-write path (Cursor): lint a proposed content string that isn't on disk yet.
export async function lintContent(text, cwd, ext = '.md') {
  const PROSE = new Set(['.md', '.mdx', '.mdc', '.markdown']);
  if (!PROSE.has(ext.toLowerCase())) return { findings: [] };
  const { detectText } = await import(ENGINE);
  const { loadConfig } = await import(CONFIG);
  const config = safe(() => loadConfig(cwd), null);
  if (config?.hook?.enabled === false) return { disabled: true, findings: [] };
  return { findings: severityFloor(detectText(text, { config }), config), config };
}

// Extract the proposed file path + content from a pre-write payload (provider-tolerant).
export function proposedEdit(payload) {
  const ti = payload?.tool_input || payload || {};
  const fp = ti.file_path || ti.path || payload?.file_path || '';
  const text = ti.content ?? ti.new_string ?? ti.new_text ??
    (Array.isArray(ti.edits) ? ti.edits.map((e) => e.new_string || e.new_text || '').join('\n') : '') ?? '';
  return { fp, text };
}

export async function renderForAgent(rel, findings, max = 10) {
  const sev = (s) => (s === 'error' ? 'error   ' : s === 'warn' ? 'warn    ' : 'advisory');
  const shown = findings.slice(0, max);
  const lines = shown.map((f) => `  L${String(f.line).padEnd(4)} ${sev(f.severity)} ${f.ruleId.padEnd(22)} ${f.message}`);
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
    `\n\nWaive a rule inline: <!-- mari-disable <rule-id>: reason -->`;
}

export function safe(fn, fallback) { try { return fn(); } catch { return fallback; } }
