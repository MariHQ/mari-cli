#!/usr/bin/env node
// Hook library tests — payload extraction and the pre-write lint/block decision.

import { proposedEdit, lintContent, targetFile } from '../skill/scripts/hook-lib.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name); } };

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

console.log(`\nHooks: ${pass + fail} checks · ${pass} passed · ${fail} failed`);
console.log(fail === 0 ? '✓ hooks green\n' : '');
process.exit(fail === 0 ? 0 : 1);
