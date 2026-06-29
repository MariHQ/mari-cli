#!/usr/bin/env node
// Hook library tests — payload extraction and the pre-write lint/block decision.

import { proposedEdit, lintContent, targetFile, editedFile, renderForAgent } from '../skill/scripts/hook-lib.mjs';
import { addIgnore, setHookEnabled, resetConfig, addWatch, removeWatch } from '../cli/engine/config-write.mjs';
import { matchWatch } from '../cli/engine/config.mjs';
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

// watch rules — config writers + the path matcher behind `mari watch`
{
  const cfg = {};
  check('addWatch rejects missing notify', addWatch(cfg, { name: 'x', paths: ['src/**'] }) === false);
  check('addWatch rejects missing paths', addWatch(cfg, { name: 'x', notify: 'do it' }) === false);
  // addWatch takes arrays; the CLI splits the comma-separated --paths string before calling it.
  const cfg2 = {};
  addWatch(cfg2, { name: 'api-docs', paths: ['src/api/**', 'openapi.yaml'], notify: 'Update docs/api/** if the API changed.', exclude: ['**/*.test.*'] });
  check('addWatch stores a rule', cfg2.watch.length === 1 && cfg2.watch[0].name === 'api-docs');
  addWatch(cfg2, { name: 'api-docs', paths: ['src/api/v2/**'], notify: 'updated' });
  check('addWatch upserts by name (no dupes)', cfg2.watch.length === 1 && cfg2.watch[0].notify === 'updated');
  check('removeWatch removes by name', removeWatch(cfg2, 'api-docs') && cfg2.watch.length === 0);
  check('removeWatch returns false when absent', removeWatch(cfg2, 'nope') === false);

  const rules = [{ name: 'api-docs', paths: ['src/api/**', 'openapi.yaml', '**/*Controller.java'], notify: 'go', exclude: ['**/*.test.*'] }];
  check('watch matches a folder glob', matchWatch('src/api/users.ts', rules).length === 1);
  check('watch matches a deep pattern', matchWatch('app/web/UserController.java', rules).length === 1);
  check('watch matches a bare filename anywhere', matchWatch('config/openapi.yaml', rules).length === 1);
  check('watch ignores a non-matching path', matchWatch('src/web/page.tsx', rules).length === 0);
  check('watch exclude wins over a match', matchWatch('src/api/users.test.ts', rules).length === 0);
  check('watch rule without notify never matches', matchWatch('src/api/x.ts', [{ name: 'bad', paths: ['src/**'] }]).length === 0);
}

// editedFile accepts any extension (watch fires on source, not just markdown)
check('editedFile accepts a non-markdown edit', editedFile({ tool_name: 'Edit', tool_input: { file_path: import.meta.url.replace('file://', '') } }) !== null);
check('editedFile rejects non-edit tools', editedFile({ tool_name: 'Bash', tool_input: { file_path: '/x.ts' } }) === null);

// proposedEdit tolerates several payload shapes
check('proposedEdit reads content', proposedEdit({ tool_input: { file_path: 'a.md', content: 'hi' } }).text === 'hi');
check('proposedEdit reads new_string', proposedEdit({ tool_input: { file_path: 'a.md', new_string: 'yo' } }).text === 'yo');
check('proposedEdit reads edits[]', proposedEdit({ tool_input: { file_path: 'a.md', edits: [{ new_string: 'x' }, { new_string: 'y' }] } }).text === 'x\ny');

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
