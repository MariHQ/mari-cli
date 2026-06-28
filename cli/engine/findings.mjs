// Finding shape, dedupe, severity sort, and rendering (human + JSON).

import { FAMILY_LABELS } from './rules.mjs';

const SEV_RANK = { error: 0, warn: 1, advisory: 2 };
const SEV_PAD = { error: 'error   ', warn: 'warn    ', advisory: 'advisory' };

export function sortFindings(findings) {
  return findings.slice().sort((a, b) =>
    (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || (a.line - b.line) || (a.col - b.col) || a.ruleId.localeCompare(b.ruleId));
}

// merge identical (rule, offset) duplicates
export function dedupe(findings) {
  const seen = new Set();
  const out = [];
  for (const f of findings) {
    const key = `${f.ruleId}@${f.offset}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

const C = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const SEV_COLOR = { error: 31, warn: 33, advisory: 36 };

export function renderHuman(fileResults, { quiet = false } = {}) {
  const out = [];
  let totalErr = 0, totalWarn = 0, totalAdv = 0;
  for (const { file, findings } of fileResults) {
    if (!findings.length) {
      if (!quiet) out.push(`${C(32, '✓')} ${file} — clean`);
      continue;
    }
    const counts = { error: 0, warn: 0, advisory: 0 };
    findings.forEach((f) => counts[f.severity]++);
    totalErr += counts.error; totalWarn += counts.warn; totalAdv += counts.advisory;
    out.push('');
    out.push(`${C(1, file)} — ${findings.length} findings ` +
      `(${counts.error} error, ${counts.warn} warn, ${counts.advisory} advisory)`);
    const byFamily = new Map();
    for (const f of findings) { if (!byFamily.has(f.family)) byFamily.set(f.family, []); byFamily.get(f.family).push(f); }
    for (const [fam, fs] of byFamily) {
      out.push(`  ${C(2, FAMILY_LABELS[fam] || fam)}`);
      for (const f of fs) {
        const loc = `L${f.line}`.padEnd(6);
        const sev = C(SEV_COLOR[f.severity], SEV_PAD[f.severity]);
        out.push(`    ${loc}${sev}  ${C(2, f.ruleId.padEnd(24))} ${f.message}`);
      }
    }
  }
  out.push('');
  out.push(`${totalErr} error · ${totalWarn} warn · ${totalAdv} advisory across ${fileResults.length} file(s)`);
  out.push(`Waive inline: <!-- mari-disable <rule-id>: reason -->`);
  return out.join('\n');
}

export function renderJSON(fileResults) {
  return JSON.stringify({
    files: fileResults.map(({ file, findings, score }) => ({
      file,
      ...(score ? { score: score.score, band: score.band, scoreBreakdown: score.breakdown } : {}),
      findings: findings.map((f) => ({
        rule: f.ruleId, family: f.family, severity: f.severity,
        line: f.line, col: f.col, span: f.span, message: f.message, ref: f.ref || null,
      })),
    })),
    summary: summarize(fileResults),
  }, null, 2);
}

// Compact roll-up for large trees: worst files + the rule histogram, not every finding.
export function renderSummary(fileResults) {
  const out = [];
  const ruleCounts = {};
  const sev = { error: 0, warn: 0, advisory: 0 };
  const withCounts = [];
  for (const { file, findings } of fileResults) {
    if (!findings.length) continue;
    for (const f of findings) { ruleCounts[f.ruleId] = (ruleCounts[f.ruleId] || 0) + 1; sev[f.severity]++; }
    const e = findings.filter((f) => f.severity === 'error').length;
    withCounts.push({ file, n: findings.length, e });
  }
  withCounts.sort((a, b) => (b.e - a.e) || (b.n - a.n));
  out.push(`Scanned ${fileResults.length} file(s); ${withCounts.length} with findings.`);
  out.push(`${sev.error} error · ${sev.warn} warn · ${sev.advisory} advisory`);
  out.push('\nTop files:');
  for (const w of withCounts.slice(0, 12)) out.push(`  ${String(w.n).padStart(5)}  ${w.e ? C(31, `(${w.e} err) `) : ''}${w.file}`);
  out.push('\nTop rules:');
  for (const [r, n] of Object.entries(ruleCounts).sort((a, b) => b[1] - a[1]).slice(0, 15)) out.push(`  ${String(n).padStart(5)}  ${r}`);
  return out.join('\n');
}

export function summarize(fileResults) {
  let error = 0, warn = 0, advisory = 0;
  for (const { findings } of fileResults) for (const f of findings) {
    if (f.severity === 'error') error++; else if (f.severity === 'warn') warn++; else advisory++;
  }
  return { files: fileResults.length, error, warn, advisory };
}
