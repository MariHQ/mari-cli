#!/usr/bin/env node
// Claude Code PostToolUse hook (Edit|Write|MultiEdit). Lints the edited prose file with the
// deterministic detector and feeds findings back into the turn as additionalContext.
//
// CONTRACT: never break the turn. Every path exits 0; on any failure we emit nothing.

import { readStdin, targetFile, lint, renderForAgent, safe } from './hook-lib.mjs';

const QUIET_DEFAULT = true;

(async () => {
  try {
    const payload = await readStdin();
    const cwd = payload?.cwd || process.cwd();
    const fp = targetFile(payload);
    if (!fp) return done();

    const res = await safeAsync(() => lint(fp, cwd));
    if (!res || res.disabled) return done();
    const { rel, findings, config } = res;
    const quiet = config?.hook?.quiet ?? QUIET_DEFAULT;

    if (!findings.length) {
      if (!quiet) emit(`Mari: ${rel} clean ✓`);
      return done();
    }
    const max = config?.hook?.maxFindings ?? 10;
    emit(renderForAgent(rel, findings, max));
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
