#!/usr/bin/env node
// Post-edit hook (Claude Code PostToolUse Edit|Write|MultiEdit; also wired for Cursor's
// afterFileEdit, Codex, and Copilot via `--provider=`). Two jobs, both fed back into the turn:
// (1) lint edited *markdown* with the deterministic detector (+ optional grammar + i18n
// staleness), and (2) fire user-defined *edit rules* on *any* edited file so the agent gets
// reminded to do follow-up work (e.g. "the API changed — update docs/api/**").
//
// The host is declared explicitly by each hooks manifest passing `--provider=claude|cursor|
// codex|copilot` (or MARI_HOOK_PROVIDER); the default remains the Claude Code contract.
//
// CONTRACT: never break the turn. Every path exits 0; on any failure we emit nothing.

import { readStdin, editedFile, targetFile, lint, renderForAgent, i18nNote, rulesNotice, assocNotice, lineageNotice, safe } from './hook-lib.mjs';

const QUIET_DEFAULT = true;
const PROVIDER = (process.argv.find((a) => a.startsWith('--provider='))?.split('=')[1]
  || process.env.MARI_HOOK_PROVIDER || 'claude').toLowerCase();

(async () => {
  try {
    const payload = await readStdin();
    const cwd = payload?.cwd || payload?.workspace_roots?.[0] || process.cwd();
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

    // (3) Curated semantic lineage — a confirmed edge's span changed; the agent must address
    // the counterpart in this session. Takes precedence over raw assoc candidates: when a
    // curated edge fires, the uncurated reminders for the same file are noise.
    const lineage = await safeAsync(() => lineageNotice(fp, cwd));
    if (lineage) parts.push(lineage);

    // (4) Derived code<->doc associations — remind the agent to check the linked counterpart.
    if (!lineage) {
      const assoc = await safeAsync(() => assocNotice(fp, cwd));
      if (assoc) parts.push(assoc);
    }

    if (parts.length) emit(parts.join('\n\n'));
    done();
  } catch {
    done(); // never break the turn
  }
})();

// Output shape per host. Claude Code (default): PostToolUse additionalContext JSON. Cursor:
// `agentMessage` (Cursor's hook-response field for feeding text to the agent; afterFileEdit is
// observational, so this is best-effort). Codex/Copilot: plain text on stdout — neither
// publishes a structured post-edit response contract, and both surface hook stdout.
function emit(text) {
  try {
    if (PROVIDER === 'cursor') process.stdout.write(JSON.stringify({ agentMessage: text }));
    else if (PROVIDER === 'codex' || PROVIDER === 'copilot') process.stdout.write(text);
    else process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } }));
  } catch { /* ignore */ }
}

function done() { process.exit(0); }

async function safeAsync(fn) { try { return await fn(); } catch { return null; } }
