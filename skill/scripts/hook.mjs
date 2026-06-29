#!/usr/bin/env node
// Claude Code PostToolUse hook (Edit|Write|MultiEdit). Two jobs, both fed back into the turn as
// additionalContext: (1) lint edited *markdown* with the deterministic detector (+ optional
// grammar + i18n staleness), and (2) fire user-defined *edit rules* on *any* edited file so the
// agent gets reminded to do follow-up work (e.g. "the API changed — update docs/api/**").
//
// CONTRACT: never break the turn. Every path exits 0; on any failure we emit nothing.

import { readStdin, editedFile, targetFile, lint, renderForAgent, i18nNote, rulesNotice, safe } from './hook-lib.mjs';

const QUIET_DEFAULT = true;

(async () => {
  try {
    const payload = await readStdin();
    const cwd = payload?.cwd || process.cwd();
    const fp = editedFile(payload);
    if (!fp) return done();

    const parts = [];

    // (1) Prose detector — markdown only.
    if (targetFile(payload)) {
      const res = await safeAsync(() => lint(fp, cwd));
      if (res && !res.disabled) {
        const { rel, findings, config } = res;
        const quiet = config?.hook?.quiet ?? QUIET_DEFAULT;
        const note = await safeAsync(() => i18nNote(fp, cwd, config));
        if (findings.length) {
          const max = config?.hook?.maxFindings ?? 10;
          parts.push(await renderForAgent(rel, findings, max));
        } else if (note) {
          parts.push(`Mari — ${rel}: no slop/style findings.`);
        } else if (!quiet) {
          parts.push(`Mari: ${rel} clean ✓`);
        }
        if (note) parts.push(note);
      }
    }

    // (2) Edit rules — any edited file (source, config, etc.).
    const notice = await safeAsync(() => rulesNotice(fp, cwd));
    if (notice) parts.push(notice);

    if (parts.length) emit(parts.join('\n\n'));
    done();
  } catch {
    done(); // never break the turn
  }
})();

function emit(additionalContext) {
  const out = { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } };
  try { process.stdout.write(JSON.stringify(out)); } catch { /* ignore */ }
}

function done() { process.exit(0); }

async function safeAsync(fn) { try { return await fn(); } catch { return null; } }
