// Pure mutations on a parsed `.mari/config.json` object, shared by `mari ignores`,
// `mari hooks`, and the tests. Each takes the config object and mutates it in place so the
// CLI has a single place that knows the config shape and the tests can exercise it directly.

function uniq(a) { return [...new Set(a.filter(Boolean))]; }

export function ensureDetector(cfg) { cfg.detector = cfg.detector || {}; return cfg.detector; }
export function ensureHook(cfg) { cfg.hook = cfg.hook || {}; return cfg.hook; }

// kind: 'rule' | 'file' | 'value'. args: [id] | [glob] | [rule, value]. Returns false on a
// bad kind so the caller can print usage.
export function addIgnore(cfg, kind, args) {
  const d = ensureDetector(cfg);
  if (kind === 'rule') { if (!args[0]) return false; d.ignoreRules = uniq([...(d.ignoreRules || []), args[0]]); }
  else if (kind === 'file') { if (!args[0]) return false; d.ignoreFiles = uniq([...(d.ignoreFiles || []), args[0]]); }
  else if (kind === 'value') {
    const [rule, value] = args;
    if (!rule || !value) return false;
    d.ignoreValues = d.ignoreValues || {};
    d.ignoreValues[rule] = uniq([...(d.ignoreValues[rule] || []), value]);
  } else return false;
  return true;
}

// Flip the post-edit hook on/off without touching the installed manifest — the detector
// honors `hook.enabled === false` (skill/scripts/hook-lib.mjs).
export function setHookEnabled(cfg, on) { ensureHook(cfg).enabled = !!on; return cfg; }

// Clear detector ignores back to defaults and drop the explicit enabled flag (so the hook
// returns to its default-on behavior).
export function resetConfig(cfg) {
  const d = ensureDetector(cfg);
  d.ignoreRules = []; d.ignoreFiles = []; d.ignoreValues = {};
  if (cfg.hook) delete cfg.hook.enabled;
  return cfg;
}
