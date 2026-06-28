#!/usr/bin/env node
// Source-file string linting: prose rules fire inside string literals / comments / docstrings,
// and never on identifiers or keywords. Offsets map back to the real source line.

import { maskSource, sourceLangFor, isSourceFile, isCodeFile } from '../cli/engine/detect-strings.mjs';
import { detectText } from '../cli/engine/index.mjs';

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name); } };

const cfg = { config: { ignoreRules: new Set(), ignoreValues: {}, ignoreFiles: [], styleGuide: 'microsoft' }, useInlineIgnores: true };
const lint = (src, lang) => detectText(maskSource(src, lang), cfg);
const rules = (src, lang) => lint(src, lang).map((f) => f.ruleId);

check('ext maps to language', sourceLangFor('.tsx') === 'js' && sourceLangFor('.py') === 'py' && sourceLangFor('.go') === null);
// language coverage: JS/TS/Python are extractable; other code langs are recognized but unsupported
check('JS/TS/Python are supported for extraction', isSourceFile('.ts') && isSourceFile('.py') && !isSourceFile('.java'));
check('unsupported code langs are recognized (so never prose-linted)', isCodeFile('.java') && isCodeFile('.scala') && isCodeFile('.go') && !isSourceFile('.java'));
check('prose extensions are not treated as code', !isCodeFile('.md') && !isCodeFile('.txt'));

// --- JS/TS ---
const js = [
  'import { useState } from "react";',
  '// Please utilize the toggle in order to enable it.',
  'const label = "Empower your seamless workflow today!";',
  'function leverage(seamless) { return seamless * 2; }',
].join('\n');
const jsRules = rules(js, 'js');
check('JS: buzzword inside a string literal is flagged', jsRules.includes('marketing-buzzword'));
check('JS: wordy phrase inside a comment is flagged', jsRules.includes('wordy-phrase'));
check('JS: the identifier `leverage` (code) is NOT flagged', !rules('function leverage(x) { return x; }', 'js').includes('word-swap'));
check('JS: import keywords are not linted as prose', !rules('import { useState } from "react";', 'js').includes('complex-word'));

// offset mapping: the buzzword sits on line 3 of the source
const labelFinding = lint(js, 'js').find((f) => f.ruleId === 'marketing-buzzword');
check('JS: finding maps to the real source line', labelFinding && labelFinding.line === 3);

// template literals
check('JS: template-literal text is linted', rules('const m = `Please run it in order to win`;', 'js').includes('wordy-phrase'));

// --- Python ---
const py = [
  'import os  # leverage the os module',
  'def handler():',
  '    """Utilize this handler in order to process events."""',
  "    msg = 'Click here to empower your seamless workflow!'",
  '    return msg',
].join('\n');
const pyRules = rules(py, 'py');
check('Python: docstring prose is flagged', pyRules.includes('wordy-phrase'));
check('Python: string-literal buzzword is flagged', pyRules.includes('marketing-buzzword'));
check('Python: `def`/`return` keywords are not linted', !rules('def handler():\n    return 1', 'py').includes('complex-word'));

// license-header comments are boilerplate, not authored prose → skipped
const licensed = [
  '# Licensed to the Apache Software Foundation (ASF) under one',
  '# distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.',
  'def go():',
  '    return "Empower your seamless workflow"',
].join('\n');
const licRules = rules(licensed, 'py');
check('license header is not linted (no all-caps / undefined-acronym)',
  !licRules.includes('all-caps-shouting') && !licRules.includes('undefined-acronym'));
check('real strings still linted alongside a license header', licRules.includes('marketing-buzzword'));

// adjacent string literals on consecutive lines must not collapse into a false repeated-word
const adjacent = [
  "if 'FLINK_HOME' in os.environ:",
  "    return os.environ['FLINK_HOME']",
].join('\n');
check('adjacent string literals do not trip repeated-word', !rules(adjacent, 'py').includes('repeated-word'));

// masking preserves length and newlines (offsets stay valid)
const masked = maskSource(py, 'py');
check('mask preserves length', masked.length === py.length);
check('mask preserves newline count', masked.split('\n').length === py.split('\n').length);

console.log(`\nStrings: ${pass + fail} checks · ${pass} passed · ${fail} failed`);
console.log(fail === 0 ? '✓ strings green\n' : '');
process.exit(fail === 0 ? 0 : 1);
