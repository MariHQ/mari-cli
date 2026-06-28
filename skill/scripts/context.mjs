#!/usr/bin/env node
// Prints the project's context files for the skill's setup phase. If PRODUCT.md is absent it
// prints NO_PRODUCT_MD so the skill knows to route to `init` first. Honors an optional
// `--target <path>` (informational only — the context files are always project-root).

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const show = (name) => {
  const p = join(root, name);
  if (!existsSync(p)) return false;
  console.log(`\n===== ${name} =====`);
  console.log(readFileSync(p, 'utf8').trimEnd());
  return true;
};

if (!existsSync(join(root, 'PRODUCT.md'))) {
  console.log('NO_PRODUCT_MD');
  console.log('No PRODUCT.md found — run `/mari init` first to write the project context.');
  process.exit(0);
}

show('PRODUCT.md');
const hasStyle = show('STYLE.md');
show('FACTS.md');
if (!hasStyle) console.log('\n(STYLE.md not present — style-guide defaults to microsoft; terminology checks off.)');
