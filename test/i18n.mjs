#!/usr/bin/env node
// i18n association across layouts: suffix, hugo (content.zh), docusaurus, locale-dir, and a
// custom config mirror. Verifies a source maps to its translations, a translation maps back,
// and ordinary files map to nothing.

import { i18nAssociations, i18nConform } from '../cli/engine/i18n.mjs';
import { i18nNote } from '../skill/scripts/hook-lib.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'i18n-fixtures');
let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); } };
const assoc = (rel, cfg) => i18nAssociations(join(ROOT, rel), ROOT, cfg);
const locs = (a) => (a ? a.siblings.map((s) => s.locale).sort() : []);

// suffix: README.md ↔ README.es.md
const sfx = assoc('suffix/README.md');
check('suffix: source detected', sfx && sfx.layout === 'suffix' && sfx.isSource, `(${sfx && sfx.layout})`);
check('suffix: finds es sibling', locs(sfx).includes('es'));
const sfxT = assoc('suffix/README.es.md');
check('suffix: translation maps back to source', sfxT && !sfxT.isSource && sfxT.siblings.some((s) => /README\.md$/.test(s.rel)));

// hugo: content/docs/guide.md ↔ content.zh/docs/guide.md
const hg = assoc('hugo/content/docs/guide.md');
check('hugo: source detected', hg && hg.layout === 'hugo' && hg.isSource);
check('hugo: finds zh sibling at content.zh/...', hg && hg.siblings.some((s) => /content\.zh\/docs\/guide\.md$/.test(s.rel)), `(${hg && hg.siblings.map((s) => s.rel)})`);

// docusaurus: docs/intro.md ↔ i18n/de/docusaurus-plugin-content-docs/current/intro.md
const dc = assoc('docu/docs/intro.md');
check('docusaurus: source detected', dc && dc.layout === 'docusaurus' && dc.isSource, `(${dc && dc.layout})`);
check('docusaurus: finds de sibling in i18n tree', dc && dc.siblings.some((s) => /i18n\/de\/.*current\/intro\.md$/.test(s.rel)));

// locale dir: docs/en/z.md ↔ docs/fr/z.md
const dr = assoc('dir/docs/en/z.md');
check('dir: source detected', dr && dr.layout === 'dir', `(${dr && dr.layout})`);
check('dir: finds fr sibling', locs(dr).includes('fr'));

// ordinary file → nothing
check('plain file with no siblings → null', assoc('suffix/README.es.md') !== null && i18nAssociations(join(ROOT, 'docu/docs/intro.md'), ROOT, { i18n: { enabled: false } }) === null);

// custom mirror via config: source "hugo/content" ↔ "hugo/content.{locale}"
const mir = assoc('hugo/content/docs/guide.md', { i18n: { layouts: [], mirrors: [{ source: 'hugo/content', translation: 'hugo/content.{locale}' }] } });
check('custom mirror finds the zh sibling', mir && mir.layout === 'mirror' && mir.siblings.some((s) => /content\.zh/.test(s.rel)), `(${mir && mir.layout})`);

// disabling a layout suppresses it
check('disabling layouts → no suffix match', assoc('suffix/README.md', { i18n: { layouts: ['hugo'] } }) === null);

// the hook note (what the agent sees): source-only by default
const noteSrc = await i18nNote(join(ROOT, 'suffix/README.md'), ROOT, {});
check('i18nNote fires for a source edit', !!noteSrc && /may be stale/.test(noteSrc) && /README\.es\.md/.test(noteSrc));
check('i18nNote is silent on a translation by default', (await i18nNote(join(ROOT, 'suffix/README.es.md'), ROOT, {})) === null);
check('i18nNote fires on a translation when notifyOn=any', /source and other locales/.test(await i18nNote(join(ROOT, 'suffix/README.es.md'), ROOT, { i18n: { notifyOn: 'any' } }) || ''));
check('i18nNote silent when i18n disabled', (await i18nNote(join(ROOT, 'suffix/README.md'), ROOT, { i18n: { enabled: false } })) === null);

// conform: language-invariant structure must match (headings, code blocks, links)
const src = '# Title\n## Setup\n```js\nx = 1\n```\n## Usage\nSee [the docs](https://example.com/docs).';
const transOK = '# Título\n## Configuración\n```js\nx = 1\n```\n## Uso\nVer [los docs](https://example.com/docs).';
check('conform: matching structure → no drift', i18nConform(src, transOK).length === 0, `(${JSON.stringify(i18nConform(src, transOK))})`);
const transMissingSection = '# Título\n## Configuración\n```js\nx = 1\n```';
const d1 = i18nConform(src, transMissingSection);
check('conform: missing section flagged (warn)', d1.some((x) => x.severity === 'warn' && /headings:/.test(x.message)));
check('conform: missing code block flagged when counts differ', i18nConform(src, '# T\n## A\n## B').some((x) => /code blocks:/.test(x.message)));
const transCodeChanged = '# Título\n## Configuración\n```js\nx = 2\n```\n## Uso\nVer https://example.com/docs';
check('conform: changed code content is advisory', i18nConform(src, transCodeChanged).some((x) => x.severity === 'advisory' && /code block/.test(x.message)));
const transLinkGone = '# Título\n## Configuración\n```js\nx = 1\n```\n## Uso\nsin enlace';
check('conform: missing external link is advisory', i18nConform(src, transLinkGone).some((x) => /external link/.test(x.message)));

console.log(`\ni18n: ${pass + fail} checks · ${pass} passed · ${fail} failed`);
console.log(fail === 0 ? '✓ i18n green\n' : '');
process.exit(fail === 0 ? 0 : 1);
