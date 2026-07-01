#!/usr/bin/env node
// Pre-write hook (Claude Code PreToolUse-style hosts). Unlike the post-edit hook, this can
// BLOCK: a proposed edit that would introduce `error`-severity slop (assistant boilerplate,
// dense overused vocabulary, …) is denied before it lands; warn/advisory are surfaced but
// allowed. NOTE: Cursor has no blocking pre-edit hook event (afterFileEdit is post-hoc), so
// .cursor/hooks.json wires only the post-edit path; this script serves hosts that do offer a
// blocking pre-write event.
//
// MultiEdit fragments are linted SEPARATELY (no fabricated adjacency) and findings are labeled
// fragment-relative ("edit #2 L3") so the agent isn't misled about file line numbers.
//
// CONTRACT: fail open. Any error in the hook → allow the edit (never wedge the editor).

import { extname, relative } from 'node:path';
import { readStdin, lintFragments, proposedEdit, renderForAgent } from './hook-lib.mjs';

(async () => {
  try {
    const payload = await readStdin();
    const cwd = payload?.cwd || payload?.workspace_roots?.[0] || process.cwd();
    const { fp, fragments, isFullContent } = proposedEdit(payload);
    if (!fp || !fragments.length || !fragments.some((t) => t)) return allow();

    const res = await lintFragments(fragments, cwd, extname(fp), { isFullContent });
    if (!res || res.disabled || !res.findings.length) return allow();

    const errors = res.findings.filter((f) => f.severity === 'error');
    const rel = relative(cwd, fp) || fp;
    if (errors.length) {
      return block(`Mari blocked this edit — ${errors.length} error-level slop issue(s):\n` +
        await renderForAgent(rel, res.findings, res.config?.hook?.maxFindings ?? 10));
    }
    // warn/advisory: allow but surface
    return allow(await renderForAgent(rel, res.findings, res.config?.hook?.maxFindings ?? 10));
  } catch {
    allow();
  }
})();

function block(reason) {
  // Cursor-style deny payload; also set a non-zero-but-handled signal via the JSON contract.
  write({ continue: false, permission: 'deny', reason, userMessage: reason });
  process.exit(0);
}
function allow(message) {
  write(message ? { continue: true, permission: 'allow', userMessage: message } : { continue: true, permission: 'allow' });
  process.exit(0);
}
function write(obj) { try { process.stdout.write(JSON.stringify(obj)); } catch { /* ignore */ } }
