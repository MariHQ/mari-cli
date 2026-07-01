#!/usr/bin/env node
// Hook library tests — payload extraction and the pre-write lint/block decision.

import { proposedEdit, lintContent, lintFragments, targetFile, editedFile, renderForAgent } from '../skill/scripts/hook-lib.mjs';
import { addIgnore, setHookEnabled, resetConfig, addRule, removeRule } from '../cli/engine/config-write.mjs';
import { matchRules } from '../cli/engine/config.mjs';
import { detectText } from '../cli/engine/index.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name); } };

// hooks lifecycle — the pure config mutations behind `mari hooks on|off|ignore-*|reset`
{
  const cfg = {};
  setHookEnabled(cfg, false);
  check('hooks off sets hook.enabled false', cfg.hook.enabled === false);
  setHookEnabled(cfg, true);
  check('hooks on sets hook.enabled true', cfg.hook.enabled === true);

  check('ignore-rule appends', addIgnore(cfg, 'rule', ['em-dash-overuse']) && cfg.detector.ignoreRules.includes('em-dash-overuse'));
  addIgnore(cfg, 'rule', ['em-dash-overuse']);
  check('ignore-rule dedupes', cfg.detector.ignoreRules.filter((r) => r === 'em-dash-overuse').length === 1);
  check('ignore-file appends', addIgnore(cfg, 'file', ['vendor/**']) && cfg.detector.ignoreFiles.includes('vendor/**'));
  check('ignore-value appends under its rule', addIgnore(cfg, 'value', ['overused-word', 'delve']) && cfg.detector.ignoreValues['overused-word'].includes('delve'));
  check('addIgnore rejects a bad kind', addIgnore(cfg, 'bogus', ['x']) === false);
  check('addIgnore rejects missing args', addIgnore(cfg, 'rule', []) === false);

  resetConfig(cfg);
  check('reset clears ignoreRules', cfg.detector.ignoreRules.length === 0);
  check('reset clears ignoreValues', Object.keys(cfg.detector.ignoreValues).length === 0);
  check('reset drops the enabled flag', cfg.hook.enabled === undefined);
}

// edit rules — config writers + the path matcher behind `mari rules`
{
  const cfg = {};
  check('addRule rejects missing notify', addRule(cfg, { name: 'x', paths: ['src/**'] }) === false);
  check('addRule rejects missing paths', addRule(cfg, { name: 'x', notify: 'do it' }) === false);
  // addRule takes arrays; the CLI splits the comma-separated --paths string before calling it.
  const cfg2 = {};
  addRule(cfg2, { name: 'api-docs', paths: ['src/api/**', 'openapi.yaml'], notify: 'Update docs/api/** if the API changed.', exclude: ['**/*.test.*'] });
  check('addRule stores a rule', cfg2.rules.length === 1 && cfg2.rules[0].name === 'api-docs');
  addRule(cfg2, { name: 'api-docs', paths: ['src/api/v2/**'], notify: 'updated' });
  check('addRule upserts by name (no dupes)', cfg2.rules.length === 1 && cfg2.rules[0].notify === 'updated');
  check('removeRule removes by name', removeRule(cfg2, 'api-docs') && cfg2.rules.length === 0);
  check('removeRule returns false when absent', removeRule(cfg2, 'nope') === false);

  const rules = [{ name: 'api-docs', paths: ['src/api/**', 'openapi.yaml', '**/*Controller.java'], notify: 'go', exclude: ['**/*.test.*'] }];
  check('rule matches a folder glob', matchRules('src/api/users.ts', rules).length === 1);
  check('rule matches a deep pattern', matchRules('app/web/UserController.java', rules).length === 1);
  check('rule matches a bare filename anywhere', matchRules('config/openapi.yaml', rules).length === 1);
  check('rule ignores a non-matching path', matchRules('src/web/page.tsx', rules).length === 0);
  check('rule exclude wins over a match', matchRules('src/api/users.test.ts', rules).length === 0);
  check('rule without notify never matches', matchRules('src/api/x.ts', [{ name: 'bad', paths: ['src/**'] }]).length === 0);
}

// rules discover — propose code↔docs couplings from a temp repo layout
{
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { discoverRules } = await import('../cli/engine/rules-discover.mjs');
  const root = mkdtempSync(join(tmpdir(), 'mari-discover-'));
  for (const d of ['src/api', 'docs/api', 'migrations', 'src/commands']) mkdirSync(join(root, d), { recursive: true });
  for (const f of ['src/api/users.ts', 'docs/api/index.md', 'openapi.yaml', 'migrations/001.sql', 'src/commands/run.ts', '.env.example']) writeFileSync(join(root, f), 'x');
  const found = discoverRules(root);
  const byName = Object.fromEntries(found.map((r) => [r.name, r]));
  check('discover finds the api-docs coupling', !!byName['api-docs']);
  check('discover api rule includes the api code dir', byName['api-docs']?.paths.includes('src/api/**'));
  check('discover finds schema + cli + config couplings', byName['schema-docs'] && byName['cli-docs'] && byName['config-docs']);
  check('discover rules carry a notify message', found.every((r) => typeof r.notify === 'string' && r.notify.length > 0));
  check('discover notify has no trailing slash-dot', found.every((r) => !/\/\.$/.test(r.notify)));
}

// editedFile accepts any extension (rules fire on source, not just markdown)
const selfPath = import.meta.url.replace('file://', '');
check('editedFile accepts a non-markdown edit', editedFile({ tool_name: 'Edit', tool_input: { file_path: selfPath } }) !== null);
check('editedFile rejects non-edit tools', editedFile({ tool_name: 'Bash', tool_input: { file_path: '/x.ts' } }) === null);

// editedFile is provider-tolerant (C4): Cursor afterFileEdit and bare-path payload shapes
check('editedFile accepts a Cursor afterFileEdit shape', editedFile({ file_path: selfPath, edits: [{ old_string: 'a', new_string: 'b' }] }) === selfPath);
check('editedFile accepts a bare path field (codex-style)', editedFile({ path: selfPath }) === selfPath);
check('editedFile still rejects a Bash payload with a path', editedFile({ tool_name: 'Bash', path: selfPath }) === null);
check('editedFile rejects a missing file', editedFile({ file_path: '/no/such/file.md' }) === null);

// proposedEdit tolerates several payload shapes
check('proposedEdit reads content', proposedEdit({ tool_input: { file_path: 'a.md', content: 'hi' } }).text === 'hi');
check('proposedEdit reads new_string', proposedEdit({ tool_input: { file_path: 'a.md', new_string: 'yo' } }).text === 'yo');
check('proposedEdit reads edits[]', proposedEdit({ tool_input: { file_path: 'a.md', edits: [{ new_string: 'x' }, { new_string: 'y' }] } }).text === 'x\ny');

// proposedEdit exposes fragments so MultiEdit snippets are linted separately (C8)
const pe = proposedEdit({ tool_input: { file_path: 'a.md', edits: [{ new_string: 'x' }, { new_string: 'y' }] } });
check('proposedEdit exposes fragments', Array.isArray(pe.fragments) && pe.fragments.length === 2 && pe.fragments[1] === 'y');
check('proposedEdit marks whole-file content', proposedEdit({ tool_input: { file_path: 'a.md', content: 'z' } }).isFullContent === true && pe.isFullContent === false);

// targetFile only accepts prose edit tools
check('targetFile rejects non-edit tools', targetFile({ tool_name: 'Bash', tool_input: { file_path: '/x.md' } }) === null);

const cwd = process.cwd();
const sloppy = '# T\n\nAs an AI language model, I hope this helps!';
const clean = '# Title\n\nThe cat sat on the mat.';

const r1 = await lintContent(sloppy, cwd, '.md');
check('pre-write: sloppy content yields error findings', r1.findings.some((f) => f.severity === 'error'));

const r2 = await lintContent(clean, cwd, '.md');
check('pre-write: clean content yields no findings', r2.findings.length === 0);

const r3 = await lintContent(sloppy, cwd, '.json');
check('pre-write: non-prose extension is skipped', r3.findings.length === 0);

// hook severity floor: advisories are dropped by default (error+warn only) so a small edit
// doesn't surface whole-file advisory backlog. Advisories remain available via `mari audit`.
const advisoryText = 'Run grep, sed, etc. to filter things.';
const rawAdv = detectText(advisoryText, { config: { ignoreRules: new Set(), ignoreValues: {}, ignoreFiles: [], styleGuide: 'microsoft' }, useInlineIgnores: true });
check('floor setup: raw detect surfaces an advisory', rawAdv.some((f) => f.severity === 'advisory'));
const floored = await lintContent(advisoryText, cwd, '.md');
check('hook floor: advisories suppressed by default', floored.findings.every((f) => f.severity !== 'advisory'));
check('hook floor: still keeps error/warn', r1.findings.some((f) => f.severity === 'error'));

// C8: fragments lint separately — no fabricated adjacency across MultiEdit snippets, and
// findings carry a fragment-relative label so line numbers aren't mistaken for file lines.
const frag = await lintFragments(['# T\n\nAs an AI language model, I can help!', 'The cat sat.'], cwd, '.md');
check('lintFragments finds slop in a fragment', frag.findings.some((f) => f.severity === 'error'));
check('lintFragments labels findings fragment-relative', frag.findings.every((f) => /^edit #\d+ L\d+$/.test(f.lineLabel || '')));
const fragRendered = await renderForAgent('x.md', frag.findings, 10);
check('rendered output shows the fragment-relative label', /edit #1 L\d+/.test(fragRendered));
// whole-file content keeps plain file-accurate line numbers
const whole = await lintFragments(['# T\n\nAs an AI language model, I can help!'], cwd, '.md', { isFullContent: true });
check('whole-file content has no fragment label', whole.findings.length > 0 && whole.findings.every((f) => !f.lineLabel));

// C4 end-to-end: a cursor-shaped payload run through the hook script produces lint output
{
  const { execFileSync } = await import('node:child_process');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'mari-hook-'));
  const mdPath = join(dir, 'doc.md');
  writeFileSync(mdPath, '# T\n\nAs an AI language model, I hope this helps!');
  const run = (payload, args = []) => execFileSync('node', ['skill/scripts/hook.mjs', ...args], { input: JSON.stringify(payload), cwd: process.cwd(), encoding: 'utf8' });
  const cursorOut = run({ file_path: mdPath, edits: [{ old_string: '', new_string: 'x' }], workspace_roots: [process.cwd()] }, ['--provider=cursor']);
  check('cursor payload → cursor-shaped lint output', cursorOut.includes('agentMessage') && cursorOut.includes('Mari'));
  const codexOut = run({ path: mdPath, cwd: process.cwd() }, ['--provider=codex']);
  check('codex payload → plain-text lint output', codexOut.includes('Mari') && !codexOut.includes('hookSpecificOutput'));
  const claudeOut = run({ tool_name: 'Write', tool_input: { file_path: mdPath }, cwd: process.cwd() });
  check('claude payload keeps the PostToolUse contract', claudeOut.includes('hookSpecificOutput') && claudeOut.includes('PostToolUse'));
}

// findings come with one-shot bad→good fix exemplars
const rendered = await renderForAgent('x.md', [
  { line: 3, severity: 'warn', ruleId: 'bold-lead-in-list', message: '…' },
  { line: 4, severity: 'warn', ruleId: 'marketing-buzzword', message: '…' },
], 10);
check('hook output includes a How-to-fix block', rendered.includes('How to fix (bad → good)'));
check('hook output shows the bold-lead-in fix exemplar', rendered.includes('Strip the bold lead-in'));

console.log(`\nHooks: ${pass + fail} checks · ${pass} passed · ${fail} failed`);
console.log(fail === 0 ? '✓ hooks green\n' : '');
process.exit(fail === 0 ? 0 : 1);
