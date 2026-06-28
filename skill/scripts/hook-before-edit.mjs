#!/usr/bin/env node
// Cursor pre-write hook. Unlike the post-edit hook, this can BLOCK: a proposed edit that would
// introduce `error`-severity slop (assistant boilerplate, dense overused vocabulary, …) is
// denied before it lands; warn/advisory are surfaced but allowed.
//
// CONTRACT: fail open. Any error in the hook → allow the edit (never wedge the editor).

import { extname } from 'node:path';
import { readStdin, lintContent, proposedEdit, renderForAgent, safe } from './hook-lib.mjs';

(async () => {
  try {
    const payload = await readStdin();
    const cwd = payload?.cwd || process.cwd();
    const { fp, text } = proposedEdit(payload);
    if (!fp || !text) return allow();

    const res = await safe(async () => await lintContent(text, cwd, extname(fp)), null);
    if (!res || res.disabled || !res.findings.length) return allow();

    const errors = res.findings.filter((f) => f.severity === 'error');
    const rel = fp.replace(cwd + '/', '');
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
