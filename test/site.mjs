#!/usr/bin/env node
// Whole-project site validation (`mari check`): link extraction and resolution, anchor slugs,
// per-platform nav conformance, orphan detection, and community-health presence — all against
// synthetic in-memory projects (the engine is pure; no fs).

import { maskCode, extractLinks, slugify, anchorsOf, resolveLink, checkLinks, checkNav, checkCommunity, checkSite, communityAssets } from '../cli/engine/site.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); } };
const ids = (fs) => fs.map((f) => f.ruleId);

// --- maskCode ---
check('fenced code is masked', !maskCode('```\n[x](a.md)\n```\n').includes('a.md'));
check('inline code is masked', !maskCode('use `[x](a.md)` here').includes('a.md'));
check('indented code after blank line is masked', !maskCode('para\n\n    [x](a.md)\n').includes('a.md'));
check('list continuation is NOT masked', maskCode('- item\n    [x](a.md)\n').includes('a.md'));
check('masking preserves offsets', maskCode('ab\n```\ncode\n```\nz').length === 'ab\n```\ncode\n```\nz'.length);

// --- extractLinks ---
{
  const { links, unresolved } = extractLinks('See [a](x.md) and ![img](i.png) and [r][ref] and [u][nodef].\n\n[ref]: y.md\n');
  const hrefs = links.map((l) => l.href);
  check('inline link extracted', hrefs.includes('x.md'));
  check('image extracted', hrefs.includes('i.png'));
  check('reference use resolves through its definition', hrefs.filter((h) => h === 'y.md').length === 2); // def + use
  check('undefined reference reported', unresolved.length === 1 && unresolved[0].id === 'nodef');
  check('angle-bracket hrefs unwrapped', extractLinks('[a](<sp ace.md>)').links[0].href === 'sp ace.md');
}

// --- slugify / anchorsOf ---
check('slugify matches GitHub style', slugify('Hello, World! (v2)') === 'hello-world-v2');
{
  const a = anchorsOf('# Setup\n\n## Setup\n\n## With `code` + stuff {#custom-id}\n\n<a name="html-anchor"></a>\n');
  check('heading slug present', a.has('setup'));
  check('duplicate heading gets -1 suffix', a.has('setup-1'));
  check('custom {#id} attribute registered', a.has('custom-id'));
  check('html anchor registered', a.has('html-anchor'));
}

// --- resolveLink ---
check('sibling resolution', resolveLink('docs/a/b.md', 'c.md') === 'docs/a/c.md');
check('parent resolution', resolveLink('docs/a/b.md', '../x.md') === 'docs/x.md');
check('escaping the repo root → null', resolveLink('a.md', '../../x.md') === null);

// --- checkLinks against a synthetic project ---
{
  const pages = [
    { path: 'docs/index.md', text: '# Home\n[ok](guide.md) [bad](gone.md) [anch](guide.md#setup) [bad-anch](guide.md#none)\n[self](#home) [bad-self](#nope)\n[ext](https://x.com) [mail](mailto:a@b.c)\n[extless](guide) [dir](sub)\n' },
    { path: 'docs/guide.md', text: '# Guide\n## Setup\n' },
    { path: 'docs/sub/index.md', text: '# Sub\n' },
  ];
  const paths = pages.map((p) => p.path);
  const fs = checkLinks(pages, paths);
  check('broken file link → warn', fs.some((f) => f.ruleId === 'link-broken' && f.span.includes('gone.md') && f.severity === 'warn'));
  check('valid link not flagged', !fs.some((f) => f.span.includes('(guide.md)')));
  check('cross-file anchor checked', fs.some((f) => f.ruleId === 'link-broken-anchor' && f.span.includes('#none')));
  check('valid cross-file anchor ok', !fs.some((f) => f.span.includes('#setup')));
  check('same-page anchor checked', fs.some((f) => f.ruleId === 'link-broken-anchor' && f.span.includes('#nope')));
  check('external + mailto skipped', !fs.some((f) => f.span.includes('x.com') || f.span.includes('mailto')));
  check('extensionless link resolves to .md', !fs.some((f) => f.span.includes('(guide)')));
  check('directory link resolves to index.md', !fs.some((f) => f.span.includes('(sub)')));
  check('anchors are advisory, files are warn', fs.filter((f) => f.ruleId === 'link-broken-anchor').every((f) => f.severity === 'advisory'));
  check('findings carry file + line', fs.every((f) => f.file && f.line >= 1));
}
{
  // root-relative links: resolvable via an ancestor → ok; unresolvable → advisory, not warn
  const pages = [{ path: 'docs/a.md', text: '[abs-ok](/docs/b.md) [abs-bad](/nowhere.md)\n' }, { path: 'docs/b.md', text: '# B\n' }];
  const fs = checkLinks(pages, pages.map((p) => p.path));
  check('root-relative resolvable link ok', !fs.some((f) => f.span.includes('/docs/b.md')));
  check('root-relative unresolvable → advisory', fs.some((f) => f.ruleId === 'link-unresolved-absolute' && f.severity === 'advisory'));
}

// --- nav: mkdocs ---
{
  const pages = [
    { path: 'mkdocs.yml', text: 'site_name: X\nnav:\n  - Home: index.md\n  - Guide:\n    - guide/a.md\n    - Missing: guide/gone.md\ntheme:\n  name: material\n' },
    { path: 'docs/index.md', text: '# H\n' },
    { path: 'docs/guide/a.md', text: '# A\n' },
    { path: 'docs/orphan.md', text: '# O\n' },
  ];
  const paths = [...pages.map((p) => p.path)];
  const fs = checkNav(pages, paths);
  check('mkdocs missing nav target → warn', fs.some((f) => f.ruleId === 'nav-missing-target' && f.span === 'docs/guide/gone.md'));
  check('mkdocs nav entries that exist are quiet', !fs.some((f) => f.span === 'docs/index.md' || f.span === 'docs/guide/a.md'));
  check('mkdocs orphan page → advisory', fs.some((f) => f.ruleId === 'nav-orphan-page' && f.file === 'docs/orphan.md' && f.severity === 'advisory'));
  check('mkdocs without a nav block conforms nothing', checkNav([{ path: 'mkdocs.yml', text: 'site_name: X\n' }], ['mkdocs.yml', 'docs/a.md']).length === 0);
}

// --- nav: mdBook SUMMARY.md ---
{
  const pages = [
    { path: 'src/SUMMARY.md', text: '# Summary\n\n- [Intro](./intro.md)\n- [Gone](./gone.md)\n' },
    { path: 'src/intro.md', text: '# I\n' },
    { path: 'src/extra.md', text: '# E\n' },
  ];
  const fs = checkNav(pages, pages.map((p) => p.path));
  check('mdbook missing chapter → warn', fs.some((f) => f.ruleId === 'nav-missing-target' && f.span.includes('gone.md')));
  check('mdbook orphan chapter → advisory', fs.some((f) => f.ruleId === 'nav-orphan-page' && f.file === 'src/extra.md'));
}

// --- nav: docsify _sidebar.md ---
{
  const pages = [
    { path: 'docs/_sidebar.md', text: '- [Home](/)\n- [Guide](/guide)\n- [Gone](/gone)\n' },
    { path: 'docs/README.md', text: '# H\n' },
    { path: 'docs/guide.md', text: '# G\n' },
  ];
  const fs = checkNav(pages, pages.map((p) => p.path));
  check('docsify "/" routes to README.md', !fs.some((f) => f.span.includes('README')));
  check('docsify extensionless route resolves', !fs.some((f) => f.span.includes('guide')));
  check('docsify missing route → warn', fs.some((f) => f.ruleId === 'nav-missing-target' && f.span.includes('gone')));
}

// --- nav: sphinx toctree (MyST) ---
{
  const pages = [
    { path: 'docs/index.md', text: '# X\n\n```{toctree}\n:maxdepth: 2\nusage\ngone\n```\n' },
    { path: 'docs/usage.md', text: '# U\n' },
  ];
  const fs = checkNav(pages, pages.map((p) => p.path));
  check('toctree entry resolves extensionless', !fs.some((f) => f.span.includes('usage')));
  check('toctree missing entry → warn', fs.some((f) => f.ruleId === 'nav-missing-target' && f.span.includes('gone')));
  const glob = checkNav([{ path: 'docs/index.md', text: '```{toctree}\n:glob:\nguide/*\n```\n' }, { path: 'docs/other.md', text: '# O\n' }], ['docs/index.md', 'docs/other.md']);
  check('globbed toctree skips orphan detection', !glob.some((f) => f.ruleId === 'nav-orphan-page'));
}

// --- nav: antora ---
{
  const pages = [
    { path: 'docs/modules/ROOT/nav.adoc', text: '* xref:index.adoc[Introduction]\n* xref:gone.adoc[Missing]\n' },
    { path: 'docs/modules/ROOT/pages/index.adoc', text: '= I\n' },
  ];
  const fs = checkNav(pages, pages.map((p) => p.path));
  check('antora xref resolves', !fs.some((f) => f.span.includes('pages/index.adoc')));
  check('antora missing xref → warn', fs.some((f) => f.ruleId === 'nav-missing-target' && f.span.includes('gone.adoc')));
}

// --- community-health files ---
{
  const { findings, found } = checkCommunity(['README.md', 'LICENSE', '.github/SECURITY.md', 'src/x.js']);
  check('present files recorded', found['README.md'] === 'README.md' && found['SECURITY.md'] === '.github/SECURITY.md');
  check('missing required file → warn', findings.some((f) => f.span === 'CONTRIBUTING.md' && f.severity === 'warn'));
  check('missing recommended file → advisory', findings.some((f) => f.span === 'CODE_OF_CONDUCT.md' && f.severity === 'advisory'));
  check('LICENSE without extension counts', !findings.some((f) => f.span === 'LICENSE'));
  check('nested files do not count', checkCommunity(['src/README.md']).findings.some((f) => f.span === 'README.md'));
  check('docs/ + .github/ locations count', Object.keys(checkCommunity(['docs/CONTRIBUTING.md']).found).includes('CONTRIBUTING.md'));
}
check('communityAssets exposes archetyped docs', communityAssets().map((c) => c.asset).sort().join(',') === 'code-of-conduct,contributing,security');

// --- checkSite composition ---
{
  const pages = [{ path: 'README.md', text: '# X\n[gone](nope.md)\n' }];
  const { findings, community } = checkSite(pages, ['README.md', 'LICENSE', 'CONTRIBUTING.md']);
  check('checkSite composes links + community', ids(findings).includes('link-broken') && ids(findings).includes('community-missing-file'));
  check('checkSite reports found community files', community['LICENSE'] === 'LICENSE');
  check('checkSite output is sorted by file/line', findings.every((f, i) => i === 0 || findings[i - 1].file < f.file || (findings[i - 1].file === f.file && findings[i - 1].line <= f.line)));
}

console.log(`\nSite checks: ${pass + fail} · ${pass} passed · ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
