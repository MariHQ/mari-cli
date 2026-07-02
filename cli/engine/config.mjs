// Config loading (.mari/config.json + .local). All waivers live in the JSON config
// (ignoreRules / ignoreFiles / ignoreValues) — there are no inline in-file waivers.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function loadConfig(root) {
  const base = read(join(root, '.mari', 'config.json'));
  const local = read(join(root, '.mari', 'config.local.json'));
  const merged = deepMerge(base, local);
  const d = merged.detector || {};
  return {
    styleGuide: d.styleGuide || 'microsoft',
    ignoreRules: new Set(d.ignoreRules || []),
    ignoreFiles: d.ignoreFiles || [],
    ignoreValues: d.ignoreValues || {},
    ignoreReasons: d.ignoreReasons || {},
    hook: merged.hook || {},
    rules: Array.isArray(merged.rules) ? merged.rules : [],
    raw: merged,
  };
}

function read(path) {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

export function deepMerge(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b)) {
    // note: typeof null === 'object' — a local config setting a key to null must override, not merge
    out[k] = a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])
      && b[k] !== null && typeof b[k] === 'object' && !Array.isArray(b[k])
      ? deepMerge(a[k], b[k]) : b[k];
  }
  return out;
}

export function globToRe(glob) {
  // Placeholders are control chars that cannot appear in a glob (a visible placeholder would
  // corrupt globs containing that character). \u{2a}\u{2a}/ matches zero or more directories,
  // so **/*.md also matches a root-level README.md.
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*\//g, "\u0001")
    .replace(/\*\*/g, "\u0002")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replace(/\u0001/g, "(?:[^/]+/)*")
    .replace(/\u0002/g, ".*");
  return new RegExp(`^${re}$`);
}

// Windows paths arrive with backslashes; globs are written with /.
const toPosix = (p) => String(p).replace(/\\/g, "/");

export function fileIgnored(relPath, patterns) {
  const rel = toPosix(relPath);
  return patterns.some((p) => globToRe(p).test(rel) || globToRe(p).test(rel.split("/").pop()));
}

// A glob matches a path if it matches the full repo-relative path OR its basename, so a rule
// can target a folder ("src/api/**"), a deep pattern ("**/*Controller.java"), or a bare file
// name ("openapi.yaml") anywhere in the tree.
function pathMatches(relPath, glob) {
  const rel = toPosix(relPath);
  return globToRe(glob).test(rel) || globToRe(glob).test(rel.split('/').pop());
}
const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);

// User-defined edit rules: when an edited file matches a rule's `paths` (and none of its
// `exclude`), the hook surfaces the rule's `notify` text so the agent can do the follow-up
// (e.g. "the API changed — update docs/api/**"). Returns the matched rules in order.
export function matchRules(relPath, rules) {
  return (rules || []).filter((r) => {
    const paths = asList(r && r.paths);
    if (!paths.length || !r.notify) return false;
    if (!paths.some((p) => pathMatches(relPath, p))) return false;
    if (asList(r.exclude).some((p) => pathMatches(relPath, p))) return false;
    return true;
  });
}

