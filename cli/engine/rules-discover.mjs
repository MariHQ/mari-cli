// Discover candidate edit rules from a repo's existing code + docs, so `mari init` can propose
// them instead of asking the user to write globs from scratch. Deterministic and
// filesystem-based: it detects well-known code↔docs couplings (API surface ↔ API docs, schema
// ↔ data-model docs, CLI ↔ usage docs, config ↔ config reference) and only proposes a rule when
// the code signal actually exists in the tree. The agent running `init` confirms/edits the
// suggestions with the user before writing them — these are leads, not auto-applied config.

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SKIP_DIR = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.mari', 'target', 'out',
  'testdata', 'test-data', 'fixtures', '__fixtures__', 'golden', 'snapshots', '__snapshots__',
  'vendor', 'vendored', '3rdparty', 'thirdparty', 'third_party', 'third-party',
]);
const CODE_EXCLUDE = ['**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/*.snap'];

// Walk the tree (bounded) collecting relative dir paths and notable file paths (posix-style).
function scan(root, { maxDepth = 5, maxEntries = 20000 } = {}) {
  const dirs = new Set();
  const files = new Set();
  let count = 0;
  const toPosix = (p) => p.split(sep).join('/');
  (function walk(dir, depth) {
    if (depth > maxDepth || count > maxEntries) return;
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (count++ > maxEntries) return;
      if (name.startsWith('.') && name !== '.env.example' && name !== '.env.sample') continue;
      if (SKIP_DIR.has(name)) continue;
      const p = join(dir, name);
      let st; try { st = statSync(p); } catch { continue; }
      const rel = toPosix(relative(root, p));
      if (st.isDirectory()) { dirs.add(rel); walk(p, depth + 1); }
      else files.add(rel);
    }
  })(root, 0);
  return { dirs, files };
}

const lastSeg = (d) => d.split('/').pop();

// Find the first doc location matching any of the given path tails (e.g. "docs/api").
function findDocTarget(dirs, tails) {
  for (const d of dirs) {
    const low = d.toLowerCase();
    for (const t of tails) if (low === t || low.endsWith('/' + t)) return d;
  }
  return null;
}
// A generic docs root, for phrasing when no specific sub-target exists.
function findDocsRoot(dirs) {
  return findDocTarget(dirs, ['docs', 'doc', 'documentation', 'website/docs', 'site/content', 'content']);
}

export function discoverRules(root) {
  const { dirs, files } = scan(root);
  const docsRoot = findDocsRoot(dirs);
  const rules = [];
  const seenPaths = new Set();

  const add = (name, paths, notify, rationale, exclude = CODE_EXCLUDE) => {
    const uniqPaths = [...new Set(paths)].filter(Boolean);
    if (!uniqPaths.length) return;
    const key = uniqPaths.sort().join('|');
    if (seenPaths.has(key)) return; // don't propose two rules over the same paths
    seenPaths.add(key);
    rules.push({ name, paths: uniqPaths, notify, rationale, ...(exclude.length ? { exclude } : {}) });
  };

  // ---- API surface ↔ API docs ----
  const apiDirs = [...dirs].filter((d) => {
    const l = lastSeg(d).toLowerCase();
    return /(^|\/)api$/i.test(d) || ['controllers', 'controller', 'routes', 'handlers', 'endpoints', 'resolvers'].includes(l);
  });
  const specFiles = [...files].filter((f) => /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i.test(f) || /\.proto$/.test(f));
  if (apiDirs.length || specFiles.length) {
    const docTarget = findDocTarget(dirs, ['docs/api', 'doc/api', 'docs/reference', 'docs/rest', 'docs/endpoints', 'api-docs', 'apidocs']);
    const where = docTarget ? `the API docs in ${docTarget}` : (docsRoot ? `the API docs under ${docsRoot}` : 'the API reference docs');
    add('api-docs',
      [...apiDirs.slice(0, 6).map((d) => `${d}/**`), ...specFiles.slice(0, 4)],
      `This edit touches the API surface. If it changed endpoints, request/response shapes, status codes, or auth, update ${where}.`,
      `found API code (${[...apiDirs.slice(0, 3), ...specFiles.slice(0, 2)].join(', ') || 'spec'})${docTarget ? ` and docs at ${docTarget}` : ''}`);
  }

  // ---- DB schema / migrations ↔ data-model docs ----
  const schemaFiles = [...files].filter((f) => /(^|\/)schema\.prisma$/i.test(f) || /(^|\/)schema\.sql$/i.test(f) || /\.(prisma)$/i.test(f));
  const migrationDirs = [...dirs].filter((d) => ['migrations', 'migration', 'migrate'].includes(lastSeg(d).toLowerCase()) || /(^|\/)db\/(migrate|migrations)$/i.test(d));
  if (schemaFiles.length || migrationDirs.length) {
    const docTarget = findDocTarget(dirs, ['docs/schema', 'docs/data-model', 'docs/database', 'docs/db']);
    const where = docTarget ? `the schema docs in ${docTarget}` : (docsRoot ? `the data-model docs under ${docsRoot}` : 'the data-model / schema docs');
    add('schema-docs',
      [...schemaFiles.slice(0, 4), ...migrationDirs.slice(0, 4).map((d) => `${d}/**`)],
      `The database schema or a migration changed. If it altered tables, columns, or constraints, update ${where} and any affected API/contract docs.`,
      `found schema/migrations (${[...schemaFiles.slice(0, 2), ...migrationDirs.slice(0, 2)].join(', ')})`);
  }

  // ---- CLI / commands ↔ usage docs ----
  const cliDirs = [...dirs].filter((d) => {
    const l = lastSeg(d).toLowerCase();
    return ['commands', 'command', 'cli'].includes(l) || /(^|\/)src\/cli$/i.test(d) || /(^|\/)bin$/i.test(d);
  });
  if (cliDirs.length) {
    const docTarget = findDocTarget(dirs, ['docs/cli', 'docs/commands', 'docs/usage']);
    const where = docTarget ? `the CLI docs in ${docTarget}` : 'the CLI usage docs (README / command reference)';
    add('cli-docs',
      cliDirs.slice(0, 6).map((d) => `${d}/**`),
      `A CLI command changed. If you added, removed, or changed a command, flag, or its help text, update ${where}.`,
      `found CLI code (${cliDirs.slice(0, 3).join(', ')})`);
  }

  // ---- Config / environment ↔ config reference ----
  const envExample = [...files].filter((f) => /(^|\/)\.env\.example$/i.test(f) || /(^|\/)\.env\.sample$/i.test(f));
  const configDirs = [...dirs].filter((d) => ['config', 'configs'].includes(lastSeg(d).toLowerCase()) || /(^|\/)src\/config$/i.test(d));
  if (envExample.length || configDirs.length) {
    const docTarget = findDocTarget(dirs, ['docs/config', 'docs/configuration', 'docs/settings']);
    const where = docTarget ? `the configuration docs in ${docTarget}` : (docsRoot ? `the configuration reference under ${docsRoot}` : 'the configuration reference');
    add('config-docs',
      [...envExample.slice(0, 2), ...configDirs.slice(0, 4).map((d) => `${d}/**`)],
      `A configuration option or environment variable changed. If you added, renamed, or removed one, update ${where}.`,
      `found config (${[...envExample.slice(0, 1), ...configDirs.slice(0, 2)].join(', ')})`);
  }

  // ---- Monorepo packages ↔ per-package README ----
  const pkgRoots = [...dirs].filter((d) => /^(packages|apps|libs)\/[^/]+$/.test(d));
  if (pkgRoots.length >= 2) {
    add('package-readme',
      [...new Set(pkgRoots.map((d) => d.split('/')[0]))].map((r) => `${r}/*/src/**`),
      `A package's source changed. If its public API or behavior changed, update that package's README and any shared docs.`,
      `found a monorepo layout (${pkgRoots.length} packages under ${[...new Set(pkgRoots.map((d) => d.split('/')[0]))].join(', ')})`);
  }

  return rules;
}
