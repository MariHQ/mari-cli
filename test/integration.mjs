#!/usr/bin/env node
// Whole-file + behavioral assertions that complement the per-rule fixture pairs.

import { readFileSync } from 'node:fs';
import { detectText, looksLikeData, isNonEnglishLocale, isGeneratedFile, isSkippedDir } from '../cli/engine/index.mjs';
import { scoreDocument } from '../cli/engine/score.mjs';

const cfg = (pack) => ({ config: { ignoreRules: new Set(), ignoreValues: {}, ignoreFiles: [], styleGuide: pack || 'microsoft' }, useInlineIgnores: true });
const rules = (text, pack) => detectText(text, cfg(pack)).map((f) => f.ruleId);

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name); } };

// 1. The sloppy fixture trips the signature families with real severities.
const sloppy = readFileSync(new URL('../fixtures/sloppy.md', import.meta.url), 'utf8');
const sFinds = detectText(sloppy, cfg());
const sRules = sFinds.map((f) => f.ruleId);
check('sloppy: assistant-meta (error) present', sFinds.some((f) => f.ruleId === 'assistant-meta' && f.severity === 'error'));
check('sloppy: overused-word present', sRules.includes('overused-word'));
check('sloppy: cliche-opener present', sRules.includes('cliche-opener'));
check('sloppy: manufactured-contrast present', sRules.includes('manufactured-contrast'));
check('sloppy: >= 30 findings total', sFinds.length >= 30);

// 2. Clean prose stays quiet.
check('clean prose: 0 findings', rules('The cat sat on the mat. The dog ran outside. We shipped the build today.').length === 0);

// 3. YAML frontmatter is not treated as a thematic break / prose.
check('frontmatter: no thematic-break FP',
  !rules('---\ndescription: a short note\n---\n\n# Title\n\nSome body text here.').includes('thematic-break-before-heading'));

// 4. Pack gating: british spelling fires only under google.
check('british spelling fires under google', rules('Pick a colour.', 'google').includes('american-spelling'));
check('british spelling silent under microsoft', !rules('Pick a colour.', 'microsoft').includes('american-spelling'));

// 5. Inline waiver suppresses on its line only.
const waived = detectText('We utilize it. <!-- mari-disable-line complex-word -->\nWe utilize it again.', cfg());
check('inline waiver: only the unwaived line flags complex-word',
  waived.filter((f) => f.ruleId === 'complex-word').length === 1);

// 6. Slop score: sloppy ranks well above clean, and clean lands in the 'clean' band.
const cleanText = 'The cat sat on the mat. The dog ran outside. We shipped the build today.';
const sloppyScore = scoreDocument(sloppy, detectText(sloppy, cfg()));
const cleanScore = scoreDocument(cleanText, detectText(cleanText, cfg()));
check('slop score: sloppy >> clean', sloppyScore.score > cleanScore.score + 20);
check('slop score: clean is low', cleanScore.score < 12);
check('slop score: breakdown is explainable', typeof sloppyScore.breakdown.weightedDensityPer1k === 'number');

// 8. Generalization fixes surfaced by the flink stress test.
const ruleset = (t) => detectText(t, cfg()).map((f) => f.ruleId);
check('HTML comments (license headers) are masked',
  !ruleset('<!--\nAS IS BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND\n-->\n\n# Title\n\nReal prose here.').includes('all-caps-shouting'));
check('Hugo/TOML front matter masked', !ruleset('+++\ntitle = "x"\n+++\n\n# Heading\n\nText.').includes('markup-leak'));
check('[INSERT Statement](link) is not assistant-meta',
  !ruleset('See the [INSERT Statement]({{< ref "insert" >}}) page.').includes('assistant-meta'));
check('[insert your name] IS still assistant-meta',
  ruleset('Sign here: [insert your name] please.').includes('assistant-meta'));
check('table rows skip double-space / number rules', (() => {
  const r = ruleset('| col a  | 100000 |\n|---|---|\n| x  | y |');
  return !r.includes('double-space') && !r.includes('large-number-grouping');
})());
check('predominantly non-Latin text is skipped',
  detectText('这是一个测试文档。 '.repeat(40) + 'utilize', cfg()).length === 0);
check('looksLikeData flags a data dump', looksLikeData('apple orange banana grape lemon melon cherry '.repeat(40)));
check('looksLikeData passes real prose', !looksLikeData('This is a normal paragraph. It has several sentences. They end properly. '.repeat(10)));

// 9. Generalization fixes surfaced by the hermes-agent stress test.
check('locale: README.es.md skipped', isNonEnglishLocale('docs/README.es.md'));
check('locale: i18n/zh-Hans dir skipped', isNonEnglishLocale('website/i18n/zh-Hans/current/guide.md'));
check('locale: content.zh (Hugo) skipped', isNonEnglishLocale('docs/content.zh/page.md'));
check('locale: pt-BR dir skipped', isNonEnglishLocale('docs/pt-BR/guide.md'));
check('locale: plain English NOT skipped', !isNonEnglishLocale('docs/user-guide/configuration.md'));
check('locale: README.md NOT skipped', !isNonEnglishLocale('README.md'));
check('no-space-em-dash fires once per doc, not per use', (() => {
  const ems = detectText('A — b. C — d. E — f. G — h.', cfg('microsoft')).filter((f) => f.ruleId === 'no-space-em-dash');
  return ems.length === 1;
})());
check('overused-word never escalates to error', (() => {
  const dense = 'We delve into the intricate tapestry. The meticulous, pivotal, seamless, robust showcase underscores a commendable testament.';
  return !detectText(dense, cfg()).some((f) => f.ruleId === 'overused-word' && f.severity === 'error');
})());

// 10. Generalization fixes surfaced by the gbrain stress test.
check('generated: CHANGELOG.md skipped in walk', isGeneratedFile('CHANGELOG.md'));
check('generated: llms-full.txt skipped', isGeneratedFile('llms-full.txt'));
check('generated: LICENSE/NOTICE skipped', isGeneratedFile('LICENSE') && isGeneratedFile('NOTICE.md'));
check('generated: normal docs NOT skipped', !isGeneratedFile('README.md') && !isGeneratedFile('changelog-design.md'));
check('violent-metaphor no longer flags "hit"', !ruleset('Check for a cache hit before the call.').includes('violent-tech-metaphor'));
check('violent-metaphor still flags "abort"', ruleset('Abort the running job immediately.').includes('violent-tech-metaphor'));

// 11. Vendored third-party trees skipped (oleander stress test).
check('vendored dirs skipped (3rdparty, vendor, third_party)',
  isSkippedDir('3rdparty') && isSkippedDir('vendor') && isSkippedDir('third_party') && isSkippedDir('thirdparty'));
check('normal source dirs NOT skipped', !isSkippedDir('docs') && !isSkippedDir('src') && !isSkippedDir('tutorials'));

console.log(`\nIntegration: ${pass + fail} checks · ${pass} passed · ${fail} failed`);
console.log(fail === 0 ? '✓ integration green\n' : '');
process.exit(fail === 0 ? 0 : 1);
