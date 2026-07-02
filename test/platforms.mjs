#!/usr/bin/env node
// Docs-as-code platform setup: detection by signature files, scaffold file lists, and the
// round-trip guarantee — every scaffoldable platform's own output must be re-detected as that
// platform (so `platform scaffold` followed by `platform detect` agrees).

import { detectPlatforms, scaffoldPlatform, scaffoldablePlatforms, platformSpec, PLATFORMS } from '../cli/engine/platforms.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); } };
const idsOf = (paths) => detectPlatforms(paths).map((f) => f.id);

// --- detection by signature file ---
check('mkdocs.yml → mkdocs', idsOf(['README.md', 'mkdocs.yml']).includes('mkdocs'));
check('mkdocs.yaml also matches', idsOf(['mkdocs.yaml']).includes('mkdocs'));
check('docusaurus at root', idsOf(['docusaurus.config.js']).includes('docusaurus'));
check('docusaurus under website/', idsOf(['website/docusaurus.config.ts']).includes('docusaurus'));
check('docusaurus under docs/', idsOf(['docs/docusaurus.config.js']).includes('docusaurus'));
check('sphinx conf.py under docs/', idsOf(['docs/conf.py']).includes('sphinx'));
check('hugo.toml → hugo', idsOf(['hugo.toml']).includes('hugo'));
check('_config.yml → jekyll', idsOf(['_config.yml']).includes('jekyll'));
check('book.toml → mdbook', idsOf(['book.toml']).includes('mdbook'));
check('antora-playbook.yml → antora', idsOf(['antora-playbook.yml']).includes('antora'));
check('.vitepress/config.ts → vitepress (detected, not scaffolded)', idsOf(['docs/.vitepress/config.ts']).includes('vitepress'));
check('.readthedocs.yaml → readthedocs', idsOf(['.readthedocs.yaml']).includes('readthedocs'));
check('backslash paths are normalized', idsOf(['docs\\conf.py']).includes('sphinx'));

// --- non-signals do not false-positive ---
check('a plain repo detects nothing', detectPlatforms(['README.md', 'src/index.js', 'package.json']).length === 0);
check('a stray conf.py outside docs is not sphinx', !idsOf(['src/conf.py']).includes('sphinx'));
check('a random book.json at root is gitbook, not mdbook', idsOf(['book.json']).includes('gitbook') && !idsOf(['book.json']).includes('mdbook'));
// C17: weak signature files need corroboration
check('docs/.nojekyll alone is not docsify', !idsOf(['docs/.nojekyll']).includes('docsify'));
check('docs/_sidebar.md is docsify', idsOf(['docs/_sidebar.md']).includes('docsify'));
check('astro.config alone is not starlight', !idsOf(['astro.config.mjs']).includes('starlight'));
check('astro.config + src/content/docs/ is starlight', idsOf(['astro.config.mjs', 'src/content/docs/index.md']).includes('starlight'));

// --- scaffold shape ---
check('scaffoldablePlatforms all have a files() factory', scaffoldablePlatforms().every((p) => typeof p.files === 'function'));
check('unknown id → null', scaffoldPlatform('nope') === null);
check('detected-only platform (vitepress) is not scaffoldable', scaffoldPlatform('vitepress') === null);

const out = scaffoldPlatform('mkdocs', { name: 'Acme' });
check('mkdocs scaffold returns files', out && out.files.length >= 2);
check('mkdocs scaffold injects the name', out.files.some((f) => f.content.includes('Acme')));
check('mkdocs scaffold reports a build command', typeof out.build === 'string' && out.build.length > 0);
check('name defaults to Docs when omitted', scaffoldPlatform('mkdocs').files.some((f) => f.content.includes('Docs')));

// --- round-trip: each scaffold is re-detected as its own platform ---
for (const p of scaffoldablePlatforms()) {
  const files = scaffoldPlatform(p.id, { name: 'Roundtrip' }).files.map((f) => f.path);
  const detected = idsOf(files);
  check(`round-trip: scaffold ${p.id} is detected as ${p.id}`, detected.includes(p.id), `(got ${detected.join(',') || 'none'})`);
}

// --- every platform has a spec with the required fields ---
for (const p of PLATFORMS) {
  const spec = platformSpec(p.id);
  check(`spec(${p.id}) has label + detect`, spec && spec.label && Array.isArray(spec.detect) && spec.detect.length > 0);
}

console.log(`\nPlatform checks: ${pass + fail} · ${pass} passed · ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
