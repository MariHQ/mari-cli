#!/usr/bin/env node
// mari — deterministic AI-slop + house-style detector (MVP).
//   mari detect <path|.> [--json] [--strict] [--quiet] [--stdin] [--no-config] [--style=<g>]
//   mari ignores list | add-rule <id> | add-file <glob> | add-value <rule> <value> [--reason "…"]
//   mari install   [--scope=project]   (wire the Claude Code hook)
//   mari hooks status

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../engine/config.mjs';
import { addIgnore, setIgnoreReason, setHookEnabled, resetConfig, addRule, removeRule } from '../engine/config-write.mjs';
import { detectText, detectTarget, PROSE_EXT } from '../engine/index.mjs';
import { extname } from 'node:path';
import { renderHuman, renderJSON, renderSummary, summarize } from '../engine/findings.mjs';
import { parseFacts, factcheck, factcheckNLI, factcheckDecomposed, factcheckLookback, claimTargets, sortFindings } from '../engine/grounding.mjs';
import { scoreDocument, renderScore } from '../engine/score.mjs';
import { modelsEnabled, capabilities, machineScore, nliEntail, warmup, warmupGenerative, lookbackGrounding, mlSlopFindings, embed, shutdown } from '../engine/ml/index.mjs';
import { loadClaimsFile } from '../engine/decompose.mjs';
import { buildAssoc, updateAssoc, parseGitChanges, loadAssoc, saveAssoc, associationsForFile, assocDir, walkFiles as walkAssocFiles, chunkFile } from '../engine/assoc.mjs';
import { tmpdir } from 'node:os';
import { segment } from '../engine/segment.mjs';
import * as LEX from '../engine/lexicons.mjs';
import { detectAssetType, validateAsset, scaffold, ASSET_TYPES } from '../engine/assets.mjs';
import { detectPlatforms, scaffoldPlatform, scaffoldablePlatforms, platformSpec } from '../engine/platforms.mjs';
import { checkSite, communityAssets } from '../engine/site.mjs';
import { extractSurface, renderSurface, chunkSurface, itemsOfSpan, SOURCE_EXT, NOT_SURFACE } from '../engine/surface.mjs';
import { i18nAssociations, i18nConform } from '../engine/i18n.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, '..', '..'); // cli/bin → package root, wherever mari is installed
const HOOK_SCRIPT = join(PKG_ROOT, 'skill', 'scripts', 'hook.mjs'); // wired into host hook manifests
const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

// Value-taking options accept both `--opt=value` and `--opt value`. Listed so positionals()
// can skip a space-form value and not mistake it for a positional argument.
const VALUE_OPTS = new Set(['source', 'style', 'providers', 'ground', 'threshold', 'reason', 'n', 'model', 'limit', 'paths', 'notify', 'exclude', 'name', 'claims', 'k']);
function flag(name) { return rest.includes(`--${name}`); }
function opt(name, def = null) {
  const eq = rest.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  const i = rest.indexOf(`--${name}`);
  if (i >= 0 && rest[i + 1] && !rest[i + 1].startsWith('--')) return rest[i + 1];
  return def;
}
function positionals() {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].startsWith('--')) continue;
    const prev = rest[i - 1];
    if (prev && prev.startsWith('--') && VALUE_OPTS.has(prev.slice(2))) continue; // value of a space-form option
    out.push(rest[i]);
  }
  return out;
}

async function main() {
  switch (cmd) {
    case 'detect': return await detect();
    case 'ignores': return ignores();
    case 'install': return install();
    case 'update': return update();
    case 'hooks': return hooks();
    case 'rules': return await rulesCmd();
    case 'pin': return pin(true);
    case 'unpin': return pin(false);
    case 'factcheck': return await runFactcheck();
    case 'facts': return facts();
    case 'asset': return asset();
    case 'platform':
    case 'platforms': return platform();
    case 'check': return check();
    case 'surface': return surface();
    case 'i18n': return i18n();
    case 'assoc': return await assocCmd();
    case 'explore': return await explore();
    case 'live': return live();
    case undefined:
    case '--help':
    case 'help': return usage();
    default:
      console.error(`Unknown command: ${cmd}\n`); usage(); process.exit(2);
  }
}

async function safeMachine(text) { try { return await machineScore(text); } catch { return null; } }

async function detect() {
  const root = process.cwd();
  const useConfig = !flag('no-config');
  const config = useConfig ? loadConfig(root) : { ignoreRules: new Set(), ignoreValues: {}, ignoreFiles: [], styleGuide: 'microsoft' };
  if (opt('style')) config.styleGuide = opt('style');
  const asJson = flag('json');
  const quiet = flag('quiet');
  const strict = flag('strict');

  const wantScore = flag('score');
  const useModels = flag('models') || modelsEnabled();
  // Source-string linting (JS/TS/Python) is built (cli/engine/detect-strings.mjs) but off for
  // now — Mari reads markdown only. Flip this to `flag('source')` to re-enable it.
  const lintSource = false;
  let results;
  if (flag('stdin')) {
    const text = readFileSync(0, 'utf8');
    results = [{ file: '<stdin>', findings: detectText(text, { config }), text }];
  } else {
    const targets = positionals();
    if (!targets.length) targets.push('.');
    results = [];
    for (const t of targets) {
      if (!existsSync(t)) { console.error(`No such path: ${t}`); process.exit(2); }
      if (statSync(t).isFile() && !PROSE_EXT.has(extname(t).toLowerCase())) {
        console.error(`Note: Mari reads markdown only (.md, .markdown, .mdx, .mdc); skipping ${t}.`);
      }
      results.push(...detectTarget(t, { config, root, lintSource }));
    }
  }

  // GLiNER span extraction is opt-in on top of --models. Zero-shot slop labels can't reliably
  // separate domain noun-phrases ("failure recovery") from marketing slop ("our offering") —
  // they score in the same band — so it's noisy on technical docs and off by the default path.
  const wantSlopSpans = flag('slop-spans') || ['1', 'true', 'on'].includes(process.env.MARI_SLOP_SPANS || '');
  // What the model tier actually feeds: perplexity → the machine-likelihood score (only rendered
  // with --json/--score), GLiNER → slop spans (only with --slop-spans). Warm nothing else — each
  // model is ~0.5-2 GB to load, so touching an unused one is what made --models look hung.
  const needPpl = wantScore || asJson;
  if (useModels && !needPpl && !wantSlopSpans) {
    console.error('(--models adds a machine-likelihood score and needs --json or --score to show it; add --slop-spans for GLiNER spans. Nothing to compute here — skipping model load.)');
  } else if (useModels) {
    const parts = [needPpl && 'Qwen perplexity', wantSlopSpans && 'GLiNER spans'].filter(Boolean);
    console.error(`(loading models — ${parts.join(' + ')}…)`);
    await warmup({ ppl: needPpl, spans: wantSlopSpans });
    if (wantSlopSpans) {
      for (const r of results) {
        if (!r.text) continue;
        try {
          const extra = await mlSlopFindings(r.text, r.findings, segment(r.text).locate);
          if (extra.length) r.findings = r.findings.concat(extra);
        } catch { /* ml failures never break detection */ }
      }
    }
  }

  // Opt-in grammar + mechanics pass (Harper WASM). Off by default; the default detector stays
  // pure-deterministic. Enable per-run with --grammar or per-project with detector.grammar.
  const useGrammar = flag('grammar') || config?.detector?.grammar;
  if (useGrammar) {
    const { grammarAvailable, detectGrammar } = await import('../engine/grammar.mjs');
    if (!(await grammarAvailable())) {
      console.error('(--grammar needs the optional Harper engine — run: npm install harper.js)');
    } else {
      console.error('(grammar pass — Harper, ~0.4s to load then a few ms per doc…)');
      for (const r of results) {
        if (!r.text) continue;
        try {
          let g = await detectGrammar(r.text);
          if (config?.ignoreRules?.size) g = g.filter((f) => !config.ignoreRules.has(f.ruleId));
          if (g.length) r.findings = r.findings.concat(g);
        } catch { /* grammar failures never break detection */ }
      }
    }
  }
  if (wantScore || asJson) {
    for (const r of results) {
      const machine = useModels ? await safeMachine(r.text || '') : null;
      r.score = scoreDocument(r.text || '', r.findings, { machine });
    }
  }

  if (asJson) console.log(renderJSON(results));
  else if (flag('summary')) console.log(renderSummary(results));
  else if (wantScore) console.log(results.map((r) => renderScore(r.file, r.score)).join('\n\n'));
  else console.log(renderHuman(results, { quiet }));
  const s = summarize(results);
  const fail = s.error > 0 || (strict && s.warn > 0);
  process.exitCode = fail ? 1 : 0;
}

function ensureMariDir(root) {
  const dir = join(root, '.mari');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, 'config.json');
}
function readMari(path) { return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}; }

const IGNORE_KIND = { 'add-rule': 'rule', 'add-file': 'file', 'add-value': 'value',
  'ignore-rule': 'rule', 'ignore-file': 'file', 'ignore-value': 'value' };

function writeMari(path, cfg) { writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n'); }

function ignores() {
  const root = process.cwd();
  const sub = rest[0];
  const args = positionals().slice(1);
  // Validate before touching disk so a typo'd subcommand never leaves an empty .mari/ behind.
  const cfg = readMari(join(root, '.mari', 'config.json'));
  if (sub === 'list') {
    const d = cfg.detector || {};
    console.log('ignoreRules :', (d.ignoreRules || []).join(', ') || '(none)');
    console.log('ignoreFiles :', (d.ignoreFiles || []).join(', ') || '(none)');
    console.log('ignoreValues:', JSON.stringify(d.ignoreValues || {}));
    return;
  }
  if (!IGNORE_KIND[sub] || !addIgnore(cfg, IGNORE_KIND[sub], args)) {
    console.error('Usage: mari ignores list | add-rule <id> | add-file <glob> | add-value <rule> <value> [--reason "…"]'); process.exit(2);
  }
  setIgnoreReason(cfg, IGNORE_KIND[sub], args, opt('reason'));
  const path = ensureMariDir(root);
  writeMari(path, cfg);
  console.log(`Updated ${path}`);
}

// Each provider knows where its manifest lives and how to wire (preserving unrelated entries).
const PROVIDERS = {
  claude: { dir: '.claude', wire: wireClaude },
  cursor: { dir: '.cursor', wire: wireCursor },
  codex: { dir: '.codex', wire: wireCodex },
  copilot: { dir: '.github', wire: wireCopilot },
};

function install() {
  const root = process.cwd();
  const requested = opt('providers');
  let names;
  if (requested) names = requested.split(',').map((s) => s.trim()).filter((n) => PROVIDERS[n]);
  else {
    // default: Claude Code always, plus any other provider whose dir already exists
    names = ['claude', ...Object.keys(PROVIDERS).filter((n) => n !== 'claude' && existsSync(join(root, PROVIDERS[n].dir)))];
  }
  for (const p of writeSkill(root)) console.log(`  ✓ skill → ${p}`);
  for (const name of names) {
    try { PROVIDERS[name].wire(root); }
    catch (e) { console.error(`  ✗ ${name}: ${e.message}`); }
  }
  console.log('\nReload each harness (Claude Code: /hooks) for the hook to take effect.');
}

// Build the installed SKILL.md from skill/SKILL.src.md: the skill ships inside the mari
// package (PKG_ROOT — works from any cwd, including a global npm install), so rewrite its
// relative script/reference/CLI paths to absolute ones rooted there.
function buildSkill() {
  const src = readFileSync(join(PKG_ROOT, 'skill', 'SKILL.src.md'), 'utf8');
  return src
    .replace(/\bskill\/scripts\//g, `${PKG_ROOT}/skill/scripts/`)
    .replace(/\bskill\/reference\//g, `${PKG_ROOT}/skill/reference/`)
    .replace(/\bcli\/bin\/cli\.js\b/g, `${PKG_ROOT}/cli/bin/cli.js`);
}
// Where the skill lives: refresh every existing install (global ~/.claude and/or project
// .claude); if none exists yet, install globally.
function skillTargets(root) {
  const home = process.env.HOME || '';
  const cands = [join(home, '.claude', 'skills', 'mari'), join(root, '.claude', 'skills', 'mari')];
  const existing = cands.filter((d) => existsSync(join(d, 'SKILL.md')));
  return existing.length ? existing : [cands[0]];
}
function writeSkill(root) {
  const content = buildSkill();
  const written = [];
  for (const dir of skillTargets(root)) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), content); written.push(join(dir, 'SKILL.md')); }
  return written;
}

// `mari update` — refresh an existing install: rebuild the skill payload from this repo and
// re-wire the project hooks (idempotent). What `install` does, minus the first-time prompts.
function update() {
  const root = process.cwd();
  if (!existsSync(join(PKG_ROOT, 'skill', 'SKILL.src.md'))) { console.error(`Mari install is incomplete: missing ${join(PKG_ROOT, 'skill', 'SKILL.src.md')}.`); process.exit(2); }
  console.log('Refreshing Mari…');
  for (const p of writeSkill(root)) console.log(`  ✓ skill → ${p}`);
  const names = ['claude', ...Object.keys(PROVIDERS).filter((n) => n !== 'claude' && existsSync(join(root, PROVIDERS[n].dir)))];
  for (const name of names) { try { PROVIDERS[name].wire(root); } catch (e) { console.error(`  ✗ ${name}: ${e.message}`); } }
  console.log('\nReload the harness to pick up the refreshed skill + commands.');
}

function readJsonOrAbort(path) {
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`malformed ${path}; fix or remove it (or re-run with --force).`); }
}
function writeJson(path, obj) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(obj, null, 2) + '\n'); }

// A mari hook entry from a previous version: references one of our scripts but predates
// the --provider flag (and used cwd-relative or ${CLAUDE_PROJECT_DIR} paths). Replace on wire.
function isMariEntry(e) { const s = JSON.stringify(e); return s.includes('hook.mjs') || s.includes('hook-before-edit.mjs'); }
function isCurrentMariEntry(e) { return isMariEntry(e) && JSON.stringify(e).includes('--provider='); }
function pruneStale(arr) { return arr.filter((e) => !(isMariEntry(e) && !isCurrentMariEntry(e))); }

function wireClaude(root) {
  const settingsPath = join(root, '.claude', 'settings.local.json');
  const sharedPath = join(root, '.claude', 'settings.json');
  const cmd = `node "${HOOK_SCRIPT}" --provider=claude`;
  if (hasMariHook(sharedPath)) { console.log('  • claude: already wired in shared settings.json'); return; }
  const settings = flag('force') && existsSync(settingsPath) ? safeRead(settingsPath) : readJsonOrAbort(settingsPath);
  settings.hooks = settings.hooks || {};
  const arr = settings.hooks.PostToolUse = pruneStale(settings.hooks.PostToolUse || []);
  if (arr.some(isCurrentMariEntry)) { console.log('  • claude: already installed'); return; }
  arr.push({ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: cmd, timeout: 10 }] });
  writeJson(settingsPath, settings);
  console.log(`  ✓ claude → ${settingsPath} (post-edit)`);
}
function wireCursor(root) {
  const path = join(root, '.cursor', 'hooks.json');
  const manifest = readJsonOrAbort(path);
  manifest.version = manifest.version || 1;
  manifest.hooks = manifest.hooks || {};
  if (Array.isArray(manifest.hooks.beforeEdit)) delete manifest.hooks.beforeEdit; // stale pre-1.7 wiring
  const arr = manifest.hooks.afterFileEdit = pruneStale(manifest.hooks.afterFileEdit || []);
  if (arr.some(isCurrentMariEntry)) { console.log('  • cursor: already installed'); return; }
  arr.push({ command: `node "${HOOK_SCRIPT}" --provider=cursor` });
  writeJson(path, manifest);
  console.log(`  ✓ cursor → ${path} (post-edit)`);
}
function wireCodex(root) {
  const path = join(root, '.codex', 'hooks.json');
  const manifest = readJsonOrAbort(path);
  const arr = manifest.hooks = pruneStale(manifest.hooks || []);
  if (arr.some(isCurrentMariEntry)) { console.log('  • codex: already installed'); return; }
  arr.push({ event: 'afterEdit', command: `node "${HOOK_SCRIPT}" --provider=codex` });
  writeJson(path, manifest);
  console.log(`  ✓ codex → ${path} (post-edit) — run /hooks in Codex to approve`);
}
function wireCopilot(root) {
  const dir = join(root, '.github', 'hooks');
  const path = join(dir, 'mari.json');
  // Migrate the pre-rename manifest: on case-sensitive filesystems it would otherwise
  // linger next to mari.json and fire the hook twice.
  if (existsSync(dir) && readdirSync(dir).includes('Mari.json')) rmSync(join(dir, 'Mari.json'));
  const existing = existsSync(path) ? readJsonOrAbort(path) : null;
  const manifest = existing && isCurrentMariEntry(existing)
    ? existing
    : { event: 'postEdit', command: `node "${HOOK_SCRIPT}" --provider=copilot` };
  writeJson(path, manifest);
  console.log(`  ✓ copilot → ${path} (post-edit)`);
}
function safeRead(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } }

function hasMariHook(path) {
  if (!existsSync(path)) return false;
  try { return JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))).includes('hook.mjs'); } catch { return false; }
}

const HOOKS_USAGE = 'Usage: mari hooks status | on | off | reset | ignore-rule <id> | ignore-file <glob> | ignore-value <rule> <value> [--reason "…"]';

function hooks() {
  const sub = rest[0];
  const root = process.cwd();

  if (sub === 'status' || sub === undefined) {
    const local = join(root, '.claude', 'settings.local.json');
    const shared = join(root, '.claude', 'settings.json');
    const installed = hasMariHook(local) || hasMariHook(shared);
    const cfg = loadConfig(root);
    console.log('hook installed :', installed ? 'yes' : 'no');
    console.log('hook enabled   :', cfg.hook.enabled === false ? 'no' : (cfg.hook.enabled === true ? 'yes' : 'yes (default)'));
    console.log('ignoreRules    :', [...cfg.ignoreRules].join(', ') || '(none)');
    console.log('ignoreFiles    :', (cfg.ignoreFiles || []).join(', ') || '(none)');
    console.log('ignoreValues   :', JSON.stringify(cfg.ignoreValues || {}));
    const reasons = Object.entries(cfg.ignoreReasons || {});
    if (reasons.length) {
      console.log('reasons        :');
      for (const [k, v] of reasons) console.log(`  ${k} — ${v}`);
    }
    return;
  }

  // Validate the subcommand before touching disk so a typo never leaves an empty .mari/ behind.
  if (sub !== 'on' && sub !== 'off' && sub !== 'reset' && !IGNORE_KIND[sub]) {
    console.error(HOOKS_USAGE); process.exit(2);
  }
  const cfg = readMari(join(root, '.mari', 'config.json'));

  if (sub === 'on' || sub === 'off') {
    setHookEnabled(cfg, sub === 'on');
    const path = ensureMariDir(root);
    writeMari(path, cfg);
    console.log(`Hook ${sub === 'on' ? 'enabled' : 'disabled'} (${path}).`);
    return;
  }
  if (sub === 'reset') {
    resetConfig(cfg);
    const path = ensureMariDir(root);
    writeMari(path, cfg);
    console.log(`Reset hook ignores and enabled flag (${path}).`);
    return;
  }
  const args = positionals().slice(1);
  if (!addIgnore(cfg, IGNORE_KIND[sub], args)) { console.error(HOOKS_USAGE); process.exit(2); }
  const reason = opt('reason');
  setIgnoreReason(cfg, IGNORE_KIND[sub], args, reason);
  const path = ensureMariDir(root);
  writeMari(path, cfg);
  console.log(`Updated ${path}${reason ? ` (reason: ${reason})` : ''}.`);
}

const RULES_USAGE = `Usage:
  mari rules list
  mari rules discover [--json] [--write]
  mari rules add <name> --paths "<glob[,glob…]>" --notify "<message>" [--exclude "<glob[,glob…]>"]
  mari rules remove <name>

When an edited file matches a rule's paths, the post-edit hook reminds the agent to do <message>
— e.g. update API docs when the API surface changes. Paths are globs over the repo-relative path
(folders: "src/api/**", patterns: "**/*Controller.java", or a bare file name: "openapi.yaml").
discover scans the repo for code↔docs couplings and proposes rules (--write adds them all).`;

function splitList(s) { return (s || '').split(',').map((x) => x.trim()).filter(Boolean); }

async function rulesCmd() {
  const root = process.cwd();
  const sub = rest[0];

  if (sub === 'list' || sub === undefined) {
    const defined = loadConfig(root).rules || [];
    if (!defined.length) { console.log('No rules. Add one:\n  ' + RULES_USAGE.split('\n')[3].trim()); return; }
    for (const r of defined) {
      console.log(`• ${r.name}`);
      console.log(`    paths  : ${(r.paths || []).join(', ')}`);
      if (r.exclude?.length) console.log(`    exclude: ${r.exclude.join(', ')}`);
      console.log(`    notify : ${r.notify}`);
    }
    return;
  }

  if (sub === 'discover') {
    const { discoverRules } = await import('../engine/rules-discover.mjs');
    const found = discoverRules(root);
    if (flag('json')) { console.log(JSON.stringify(found, null, 2)); return; }
    if (!found.length) { console.log('No code↔docs couplings discovered. Add a rule by hand:\n  ' + RULES_USAGE.split('\n')[3].trim()); return; }
    if (flag('write')) {
      const p = ensureMariDir(root);
      const cfg = readMari(p);
      let n = 0;
      for (const r of found) if (addRule(cfg, r)) n++;
      writeMari(p, cfg);
      console.log(`Added ${n} discovered rule(s) to ${p}.`);
      return;
    }
    console.log(`Discovered ${found.length} candidate rule(s) — review, then add with \`mari rules add …\` (or rerun with --write):\n`);
    for (const r of found) {
      console.log(`• ${r.name}  (${r.rationale})`);
      console.log(`    paths  : ${r.paths.join(', ')}`);
      if (r.exclude?.length) console.log(`    exclude: ${r.exclude.join(', ')}`);
      console.log(`    notify : ${r.notify}`);
    }
    return;
  }

  // Validate (subcommand AND its args) before touching disk so a typo'd invocation never
  // leaves an empty .mari/ behind.
  const cfg = readMari(join(root, '.mari', 'config.json'));

  if (sub === 'add') {
    const name = positionals()[1];
    const ok = addRule(cfg, { name, paths: splitList(opt('paths')), notify: opt('notify'), exclude: splitList(opt('exclude')) });
    if (!ok) { console.error(RULES_USAGE); process.exit(2); }
    const path = ensureMariDir(root);
    writeMari(path, cfg);
    console.log(`Added rule "${name}" (${path}).`);
    return;
  }
  if (sub === 'remove' || sub === 'rm') {
    const name = positionals()[1];
    if (!name || !removeRule(cfg, name)) { console.error(`No rule named "${name}".`); process.exit(2); }
    const path = ensureMariDir(root);
    writeMari(path, cfg);
    console.log(`Removed rule "${name}" (${path}).`);
    return;
  }
  console.error(RULES_USAGE); process.exit(2);
}

async function runFactcheck() {
  const root = process.cwd();
  const target = positionals()[0];
  if (!target || !existsSync(target)) { console.error('Usage: mari factcheck <file> [--source <file>] [--json] [--strict] [--models] [--decompose] [--claims <file>] [--deep]'); process.exit(2); }

  // --emit-claim-targets: print the candidate sentences the skill should decompose, then exit.
  // The mari skill runs this, splits each into atomic claims in-session, writes them to a file,
  // and re-runs factcheck with --claims — so decomposition happens in Claude, with no spawn.
  if (flag('emit-claim-targets')) {
    const doc = readFileSync(target, 'utf8');
    console.log(JSON.stringify({ targets: claimTargets(doc) }, null, flag('json') ? 0 : 2));
    return;
  }

  const sourcePath = opt('source');
  const factsFilePath = sourcePath || join(root, 'FACTS.md'); // facts file for --deep grounding
  const withAttn = attnDecision(); // --deep (opt-in): run the attention grounding pass

  let facts, sourceMode = false;
  if (sourcePath) {
    if (!existsSync(sourcePath)) { console.error(`No such source: ${sourcePath}`); process.exit(2); }
    facts = parseFacts(readFileSync(sourcePath, 'utf8'), { asDocument: true });
    sourceMode = true;
  } else {
    const factsPath = join(root, 'FACTS.md');
    if (!existsSync(factsPath)) { console.error('No FACTS.md found. Add facts with `mari facts add "…"`, or pass --source <file>.'); process.exit(2); }
    facts = parseFacts(readFileSync(factsPath, 'utf8'));
  }
  if (!facts.length) { console.error('No facts to check against.'); process.exit(2); }

  const docText = readFileSync(target, 'utf8');
  const claimsFile = opt('claims');
  const wantDecompose = flag('decompose') || !!claimsFile;
  const wantLookback = flag('lookback') || opt('ground') === 'attention';
  const useModels = flag('models') || modelsEnabled() || wantDecompose || wantLookback;
  let findings;
  if (wantLookback && !sourceMode) {
    // attention grounding is only meaningful against the source the prose was written from
    console.error('--lookback / --ground=attention needs the source: pass --source <file>.'); process.exit(2);
  }
  if (wantDecompose || wantLookback) {
    // Both paths need the sidecar: decompose grounds each claim with NLI, lookback needs the
    // attention model. Decomposition itself is done by Claude, never a sidecar model.
    if (!capabilities().available) { console.error('Mari ML sidecar unavailable: no Python venv (.venv) or ml/mari_ml.py. Run: python3.12 -m venv .venv && .venv/bin/pip install -r ml/requirements.txt'); process.exit(2); }

    // Atomic claims come only from a --claims file: the mari skill decomposes each sentence in
    // Claude's own session (see `--emit-claim-targets`) and writes them here. The CLI never calls
    // Claude itself. With no --claims, there is no decomposition — fall back to whole-sentence NLI.
    let decompose = null;
    if (wantDecompose) {
      if (claimsFile) {
        if (!existsSync(claimsFile)) { console.error(`No such --claims file: ${claimsFile}`); process.exit(2); }
        const claims = loadClaimsFile(claimsFile, claimTargets(docText).length);
        decompose = async () => claims;
      } else {
        console.error('(--decompose needs atomic claims from Claude: run the `/mari factcheck` skill, or pass --claims <file> (get the sentence list with `--emit-claim-targets`). Falling back to whole-sentence NLI.)');
      }
    }

    console.error(wantLookback ? '(loading attention grounding model — first run downloads ~1 GB)…'
      : decompose ? '(loading NLI model; decomposing claims via Claude)…' : '(loading NLI model for entailment checking…)');
    try {
      await warmupGenerative({ nli: wantDecompose, lookback: wantLookback });
      findings = decompose
        ? await factcheckDecomposed(docText, facts, { sourceMode, nli: nliEntail, decompose })
        : await factcheckNLI(docText, facts, { sourceMode, nli: nliEntail });
      if (wantLookback) findings = sortFindings([...findings, ...await factcheckLookback(docText, facts, { lookback: lookbackGrounding })]);
    } catch (e) {
      console.error(`(generative grounding failed: ${e.message} — falling back to NLI)`);
      findings = await factcheckNLI(docText, facts, { sourceMode, nli: nliEntail });
    }
  } else if (useModels) {
    console.error('(loading NLI model for entailment checking…)');
    await warmup({ nli: true });
    findings = await factcheckNLI(docText, facts, { sourceMode, nli: nliEntail });
  } else {
    findings = factcheck(docText, facts, { sourceMode });
  }
  const rel = positionals()[0];
  const results = [{ file: rel, findings }];
  console.log(flag('json') ? renderJSON(results) : renderHuman(results, { quiet: flag('quiet') }));

  // Attention grounding runs by default when available (binary + MARI_ATTN_MODEL): it flags
  // sentences disconnected from the facts (fabricated/off-topic), complementing the deterministic
  // and NLI checks above.
  if (!flag('json') && withAttn && existsSync(factsFilePath)) {
    const res = runMariAttn(factsFilePath, target, { grounding: true, threshold: parseFloat(opt('threshold') || '0.3'), querySegment: 'sentence' });
    if (res.error) { if (flag('deep')) { console.error(res.error); process.exit(2); } }
    else {
      console.log(`\nGrounding (attention) vs ${shortenPath(factsFilePath)}:`);
      printAttnFindings(res.out.flagged || [], docText, 'every sentence attends to the facts');
    }
  } else if (flag('deep') && !existsSync(factsFilePath)) {
    console.error('--deep grounding needs facts: add FACTS.md or pass --source <file>.'); process.exit(2);
  }
  const s = summarize(results);
  process.exitCode = s.error > 0 || (flag("strict") && s.warn > 0) ? 1 : 0;
}

function facts() {
  const root = process.cwd();
  const path = join(root, 'FACTS.md');
  const sub = rest[0];
  if (sub === 'list') {
    if (!existsSync(path)) { console.log('(no FACTS.md)'); return; }
    const parsed = parseFacts(readFileSync(path, 'utf8'));
    parsed.forEach((f, i) => console.log(`${String(i + 1).padStart(3)}. ${f.text}${f.source ? `  (${f.source})` : ''}`));
    if (!parsed.length) console.log('(no facts yet)');
    return;
  }
  if (sub === 'add') {
    const fact = positionals().slice(1).join(' ');
    if (!fact) { console.error('Usage: mari facts add "<fact>"'); process.exit(2); }
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : '# FACTS\n\nGround-truth claims Mari checks prose against. One fact per line.\n\n';
    writeFileSync(path, existing.replace(/\s*$/, '') + `\n- ${fact}\n`);
    console.log(`Added to ${path}.`);
    return;
  }
  console.error('Usage: mari facts list | add "<fact>"'); process.exit(2);
}

// Deterministic concision pass for `live` — apply the swap lexicons; richer/creative variants
// (bolder/quieter) are the agent's job via the `/mari live` skill (skill/reference/live.md).
function tightenSentence(s) {
  let out = s;
  const apply = (map) => {
    for (const [k, v] of Object.entries(map)) {
      // \b only works against word-char edges; keys ending in punctuation ("e.g.") need an
      // explicit not-a-word-char guard or they never match.
      const lead = /^[A-Za-z0-9_]/.test(k) ? '\\b' : '(?<![A-Za-z0-9_])';
      const trail = /[A-Za-z0-9_]$/.test(k) ? '\\b' : '(?![A-Za-z0-9_])';
      out = out.replace(new RegExp(`${lead}${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${trail}`, 'gi'), v);
    }
  };
  apply(LEX.WORDY_PHRASES); apply(LEX.NOMINALIZATIONS); apply(LEX.COMPLEX_WORDS); apply(LEX.WORD_SWAP);
  return out.replace(/\s{2,}/g, ' ').trim();
}

function live() {
  const target = positionals()[0];
  let text;
  if (flag('stdin') || !target) text = readFileSync(0, 'utf8');
  else { if (!existsSync(target)) { console.error(`No such path: ${target}`); process.exit(2); } text = readFileSync(target, 'utf8'); }
  const ctx = segment(text);
  const sents = ctx.sentences.filter((s) => s.text.trim().length);
  if (!sents.length) { console.error('No sentences to iterate.'); process.exit(2); }

  const pick = opt('n');
  const focus = pick ? sents.filter((_, i) => i === parseInt(pick, 10) - 1) : sents;
  if (pick && !focus.length) { console.error(`No sentence #${pick} (the text has ${sents.length}).`); process.exit(2); }

  const config = { ignoreRules: new Set(), ignoreValues: {}, ignoreFiles: [], styleGuide: opt('style') || 'microsoft' };
  for (const s of focus) {
    const idx = sents.indexOf(s) + 1;
    const orig = s.text.trim();
    const tighter = tightenSentence(orig);
    const flags = [...new Set(detectText(orig, { config }).map((f) => f.ruleId))];
    console.log(`\n[${idx}] ${orig}`);
    console.log(`  tighter: ${tighter === orig ? '(already tight)' : tighter}`);
    if (flags.length) console.log(`  flags:   ${flags.join(', ')}`);
  }
  console.log('\nPick one with --n=<k>. For bolder/quieter rewrites, run /mari live (agent-driven).');
}

// Developer-asset awareness: detect a doc's archetype (runbook/ADR/postmortem/RFC + community
// docs: contributing/code-of-conduct/governance/security), validate
// its canonical structure, or scaffold a best-practice template. Used by the skill to apply
// type-specific handling by default. Structure checks warn (drafts legitimately lack sections).
function asset() {
  const sub = rest[0];
  const args = positionals().slice(1);
  const types = ASSET_TYPES.map((a) => a.type).join('|');

  if (sub === 'scaffold') {
    const tpl = scaffold(args[0], args.slice(1).join(' '));
    if (!tpl) { console.error(`Usage: mari asset scaffold <${types}> [title]`); process.exit(2); }
    process.stdout.write(tpl);
    return;
  }
  const target = args[0];
  if ((sub === 'detect' || sub === 'check') && (!target || !existsSync(target))) {
    console.error('Usage: mari asset detect <file> | check <file> | scaffold <type> [title]'); process.exit(2);
  }
  if (sub === 'detect' || sub === 'check') {
    const text = readFileSync(target, 'utf8');
    const ctx = segment(text);
    const det = detectAssetType(target, text, ctx.headings);
    if (!det) { console.log(`No developer-asset type detected for ${target}.`); return; }
    console.log(`Detected: ${det.label} (${det.type}) — score ${det.score} [${det.signals.join(', ')}]`);
    if (sub === 'detect') return;

    const findings = validateAsset(ctx, det.type);
    if (!findings.length) { console.log('Structure looks complete — all canonical sections present.'); return; }
    const sev = (s) => (s === 'error' ? 'error   ' : s === 'warn' ? 'warn    ' : 'advisory');
    for (const f of findings) console.log(`  L${String(f.line).padEnd(4)} ${sev(f.severity)} ${f.ruleId.padEnd(22)} ${f.message}`);
    const miss = findings.filter((f) => f.severity === 'warn').length;
    console.log(`\n${miss} required section(s) missing · ${findings.length - miss} other note(s)`);
    process.exitCode = flag("strict") && miss > 0 ? 1 : 0;
    return;
  }
  console.error(`Usage: mari asset detect <file> | check <file> | scaffold <${types}> [title]`); process.exit(2);
}

// Docs-as-code platform setup: detect whether a docs-site generator is already wired up, list the
// ones we can scaffold, or stand up a fresh one. The interactive "which platform?" choice lives in
// the skill flow (skill/reference/platform.md); this command is deterministic — it scans, prints,
// and writes files without prompting. Detection auto-runs before a scaffold so we never provision a
// second site next to an existing one (override with --force).
function walkForPlatforms(root, { maxDepth = 4, maxEntries = 20000, keep = [] } = {}) {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.mari',
    'target', 'out', 'vendor', '.venv', '_build', 'public', '.cache']);
  for (const k of keep) SKIP.delete(k); // `mari check` needs public/ — sites serve it at "/"
  const files = [];
  let count = 0;
  (function walk(dir, depth) {
    if (depth > maxDepth || count > maxEntries) return;
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (count++ > maxEntries) return;
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      const rel = p.slice(root.length + 1).replace(/\\/g, '/'); // win32: detection globs assume '/'
      if (e.isDirectory()) walk(p, depth + 1);
      else files.push(rel);
    }
  })(root, 0);
  return files;
}

function platform() {
  const root = process.cwd();
  const sub = rest[0] || 'detect';
  const args = positionals().slice(1);
  const scaffoldable = scaffoldablePlatforms();
  const ids = scaffoldable.map((p) => p.id).join('|');

  if (sub === 'list') {
    if (flag('json')) { console.log(JSON.stringify(scaffoldable.map((p) => ({ id: p.id, label: p.label, lang: p.lang, site: p.site, build: p.build })), null, 2)); return; }
    console.log('Docs-as-code platforms Mari can scaffold:\n');
    for (const p of scaffoldable) console.log(`  ${p.id.padEnd(12)} ${p.label}  ·  ${p.lang}\n${''.padEnd(16)}${p.site}`);
    return;
  }

  if (sub === 'detect') {
    const found = detectPlatforms(walkForPlatforms(root));
    if (flag('json')) { console.log(JSON.stringify(found, null, 2)); return; }
    if (!found.length) {
      console.log('No docs-as-code platform detected in this repo.');
      console.log(`Run \`mari platform scaffold <${ids}>\` to set one up, or \`mari platform list\` to compare.`);
      return;
    }
    console.log('Docs-as-code platform(s) already set up:\n');
    for (const f of found) console.log(`  ${f.label} (${f.id}) — ${f.matched.join(', ')}`);
    return;
  }

  if (sub === 'scaffold') {
    const id = args[0];
    const spec = platformSpec(id);
    if (!spec || typeof spec.files !== 'function') {
      console.error(`Usage: mari platform scaffold <${ids}> [--name "<title>"] [--force]`);
      if (id) console.error(`Unknown or non-scaffoldable platform: ${id}`);
      process.exit(2);
    }
    const force = flag('force');
    if (!force) {
      const found = detectPlatforms(walkForPlatforms(root));
      if (found.length) {
        console.error(`A docs platform is already set up (${found.map((f) => f.id).join(', ')}). Re-run with --force to scaffold anyway.`);
        process.exit(1);
      }
    }
    const out = scaffoldPlatform(id, { name: opt('name') });
    // Never clobber existing files: if any target path exists, bail unless --force.
    const clashes = out.files.filter((f) => existsSync(join(root, f.path)));
    if (clashes.length && !force) {
      console.error(`These files already exist — refusing to overwrite (use --force):\n  ${clashes.map((f) => f.path).join('\n  ')}`);
      process.exit(1);
    }
    for (const f of out.files) {
      const abs = join(root, f.path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
      console.log(`  wrote ${f.path}`);
    }
    console.log(`\n✓ Scaffolded ${out.label}. Next: ${out.build}`);
    return;
  }

  console.error(`Usage: mari platform detect | list | scaffold <${ids}> [--name "<title>"] [--force]`);
  process.exit(2);
}

// `mari check` — the whole-project docs validation: every internal link and anchor resolves,
// the platform nav agrees with the files on disk (missing targets, orphan pages), the
// community-health files exist (README/LICENSE/CONTRIBUTING + CODE_OF_CONDUCT/SECURITY/
// CHANGELOG), and each community doc that has an asset archetype passes its structure check.
// One command a docsite build, a pre-commit hook, or CI can gate on: `mari check --strict`.
function check() {
  const root = process.cwd();
  const config = flag('no-config') ? null : loadConfig(root);
  const files = walkForPlatforms(root, { maxDepth: 8, maxEntries: 50000, keep: ['public'] });
  const READ = /\.(md|mdx|mdc|markdown|rst|adoc)$/i;
  const NAV_ONLY = /(^|\/)mkdocs\.ya?ml$/i; // non-markdown files the nav parsers need to read
  const pages = [];
  for (const p of files) {
    if (!READ.test(p) && !NAV_ONLY.test(p)) continue;
    try { pages.push({ path: p, text: readFileSync(join(root, p), 'utf8') }); } catch { /* unreadable — skip */ }
  }

  // pages include nav configs (mkdocs.yml) for checkNav; checkLinks skips non-markdown itself.
  let { findings, community } = checkSite(pages, files);

  // Structure-check every community doc that has an asset archetype (CONTRIBUTING, CoC, SECURITY).
  for (const { name, asset } of communityAssets()) {
    const path = community[name];
    if (!path) continue;
    const page = pages.find((pg) => pg.path === path);
    if (!page) continue;
    const ctx = segment(page.text);
    for (const f of validateAsset(ctx, asset)) findings.push({ ...f, file: path });
  }

  // Respect rule-level waivers (`ignores add-rule link-broken`), but NOT ignoreFiles — those
  // scope the PROSE detector ("don't slop-lint README.md"), and a slop waiver must never hide
  // a structural defect like a broken link in that same file.
  if (config) findings = findings.filter((f) => !config.ignoreRules.has(f.ruleId));
  findings.sort((a, b) => (a.file === b.file ? a.line - b.line || a.col - b.col : a.file < b.file ? -1 : 1));

  const platforms = detectPlatforms(files);
  if (flag('json')) {
    console.log(JSON.stringify({ platforms, community, findings }, null, 2));
  } else {
    console.log(platforms.length
      ? `Platform: ${platforms.map((p) => `${p.label} (${p.matched.join(', ')})`).join(' · ')}`
      : 'Platform: none detected — `mari platform list` to set one up.');
    const present = Object.keys(community).map((k) => `${k} ✓`).join('  ');
    if (present) console.log(`Community: ${present}`);
    if (!findings.length) {
      console.log('\n✓ Project checks clean — links, nav, and community files all in order.');
    } else {
      let file = null;
      const sev = (s) => (s === 'error' ? 'error   ' : s === 'warn' ? 'warn    ' : 'advisory');
      for (const f of findings) {
        if (f.file !== file) { file = f.file; console.log(`\n${file}`); }
        console.log(`  L${String(f.line).padEnd(4)} ${sev(f.severity)} ${f.ruleId.padEnd(24)} ${f.message}`);
      }
      const warns = findings.filter((f) => f.severity === 'warn').length;
      const errors = findings.filter((f) => f.severity === 'error').length;
      console.log(`\n${findings.length} finding(s) · ${errors} error · ${warns} warn · ${findings.length - errors - warns} advisory`);
      console.log('Tip: `mari detect .` for the prose-level pass; `mari check --strict` fails on warns (CI/pre-commit).');
    }
  }
  // --deep: attention passes over the public API surface (opt-in, ~3s/run; see attnDecision).
  // Coverage asks "which extracted symbols do the docs never engage?" (undocumented surface);
  // grounding asks "which doc sentences engage none of the surface?" (stale/unanchored prose).
  if (!flag('json') && attnDecision()) deepDocsPass(root, files, pages);

  const warns = findings.filter((f) => f.severity === 'warn').length;
  const errors = findings.filter((f) => f.severity === 'error').length;
  process.exitCode = errors > 0 || (flag('strict') && warns > 0) ? 1 : 0;
}

// Extract the public surface of every source file in the walk → [{ path, items }].
function surfaceFiles(root, files) {
  const out = [];
  for (const p of files) {
    if (!SOURCE_EXT.test(p) || NOT_SURFACE.test(p)) continue;
    try {
      const items = extractSurface(p, readFileSync(join(root, p), 'utf8'));
      if (items.length) out.push({ path: p, items });
    } catch { /* unreadable — skip */ }
  }
  return out;
}

// `mari surface [dir]` — print the extracted public API surface (exports / pub / def / func):
// the deterministic inventory the docsite flow documents against, and the CONTEXT text that
// `mari check --deep` feeds the attention model.
function surface() {
  const root = process.cwd();
  const dir = positionals()[0];
  const scope = dir ? dir.replace(/\/+$/, '') : null;
  const files = walkForPlatforms(root, { maxDepth: 8, maxEntries: 50000 })
    .filter((p) => !scope || p === scope || p.startsWith(scope + '/'));
  const fsurf = surfaceFiles(root, files);
  if (flag('json')) { console.log(JSON.stringify(fsurf, null, 2)); return; }
  if (!fsurf.length) { console.log(`No public surface found${scope ? ` under ${scope}` : ''} (looked for exports/pub/def/func in JS/TS, Python, Go, Rust).`); return; }
  process.stdout.write(renderSurface(fsurf).text);
  console.error(`\n${fsurf.reduce((n, f) => n + f.items.length, 0)} public symbol(s) across ${fsurf.length} file(s).`);
}

// The attention layer of `mari check --deep`. Context window is small (~4k tokens), so the
// code side is the rendered SURFACE (signature list), never raw source — chunked per file
// block for coverage, capped for grounding.
function deepDocsPass(root, files, pages) {
  const thr = parseFloat(opt('threshold') || '0.3');
  const limit = opt('limit') != null ? parseInt(opt('limit'), 10) : 10;
  const fsurf = surfaceFiles(root, files);
  if (!fsurf.length) { console.log('\n--deep: no public surface extracted (JS/TS, Python, Go, Rust) — skipping the attention pass.'); return; }
  // Nav/community/meta files aren't API prose; Mari's own convention files (PRODUCT/STYLE/FACTS)
  // describe voice and facts, not the surface. Blogs/changelogs are temporal — they describe a
  // past release and are EXPECTED to drift from today's surface. Generated OpenAPI pages
  // (*.api.mdx, docusaurus-plugin-openapi-docs) are JSX renderings of the spec, not prose.
  // Docs-root pages and the README go first so a --limit'ed grounding pass spends its budget
  // on the pages readers actually use.
  const NOT_API_DOC = /(^|\/)(_sidebar|_navbar|_coverpage|SUMMARY|CHANGELOG|CODE_OF_CONDUCT|LICENSE|GOVERNANCE|PRODUCT|STYLE|FACTS)\.(md|mdx|markdown)$|(^|\/)(blog|news|_posts|vendor|vendored|3rdparty|third[-_]?party)\/|\.api\.mdx$/i;
  const docRank = (p) => (/^docs?\//i.test(p) ? 0 : /^readme\./i.test(p) ? 1 : 2);
  const docs = pages
    .filter((pg) => /\.(md|mdx|markdown)$/i.test(pg.path) && !NOT_API_DOC.test(pg.path))
    .sort((a, b) => docRank(a.path) - docRank(b.path) || (a.path < b.path ? -1 : 1));
  if (!docs.length) { console.log('\n--deep: no docs pages to check the surface against.'); return; }

  const tmp = join(tmpdir(), 'mari-check'); mkdirSync(tmp, { recursive: true });
  const docsFile = join(tmp, 'docs.md');
  writeFileSync(docsFile, docs.map((d) => `\n// === ${d.path} ===\n\n${d.text}`).join('\n'));

  // 1) Coverage — surface as CONTEXT, all docs as QUERY: flag symbols no doc prose attends to.
  console.log('\nDocs coverage of the public surface (attention):');
  const chunks = chunkSurface(fsurf);
  const undocumented = new Map(); // file+name → { file, line, name, score }
  let covered = 0;
  for (const [i, chunk] of chunks.entries()) {
    const cf = join(tmp, `surface-${i}.txt`);
    writeFileSync(cf, chunk.text);
    const res = runMariAttn(cf, docsFile, { grounding: false, threshold: thr });
    if (res.error) { console.log(`  · surface chunk ${i + 1}/${chunks.length} skipped: ${res.error}`); continue; }
    covered++;
    for (const f of res.out.flagged || []) {
      for (const it of itemsOfSpan(chunk, f.text)) {
        const k = `${it.file}|${it.name}`;
        if (!undocumented.has(k) || undocumented.get(k).score > f.score) undocumented.set(k, { ...it, score: f.score });
      }
    }
  }
  if (!covered) console.log('  · coverage did not run (every chunk skipped) — nothing verified');
  else if (!undocumented.size) console.log('  ✓ every extracted symbol is engaged by the docs');
  else {
    const list = [...undocumented.values()].sort((a, b) => a.score - b.score);
    for (const u of list) console.log(`  ⚠ ${(u.score * 100).toFixed(0)}%  ${u.file} L${u.line}  ${u.name}`);
    console.log(`  ${list.length} symbol(s) the docs barely engage — document or deliberately omit them.`);
  }

  // 2) Grounding — surface as CONTEXT, each docs page as QUERY: flag sentences that attend to
  // none of the surface (stale after a rename/removal, or never anchored to the code at all).
  console.log('\nDoc passages unanchored to the current surface (attention):');
  const ctxFile = join(tmp, 'surface-all.txt');
  // Cap the grounding context to what the attention window can actually hold (≈3 chars/token
  // against MARI_ATTN_CTX) rather than an arbitrary constant.
  const maxChars = 3 * (+(process.env.MARI_ATTN_CTX || 32768));
  writeFileSync(ctxFile, renderSurface(fsurf).text.slice(0, maxChars));
  const ranked = limit > 0 ? docs.slice(0, limit) : docs;
  for (const d of ranked) {
    const res = runMariAttn(ctxFile, join(root, d.path), { grounding: true, threshold: thr, querySegment: 'sentence' });
    if (res.error) { console.log(`  · ${d.path} skipped: ${res.error}`); continue; }
    const flagged = res.out.flagged || [];
    if (!flagged.length) { console.log(`  ✓ ${d.path}`); continue; }
    console.log(`  ${d.path} — ${flagged.length} passage(s) to re-verify against the code:`);
    printAttnFindings(flagged, d.text, 'anchored');
  }
  if (docs.length > ranked.length) console.log(`  (checked ${ranked.length}/${docs.length} docs pages — raise with --limit N or 0 for all)`);
  console.log('  Treat these as leads, not verdicts: conceptual prose legitimately floats above the surface.');
}

// i18n association: list the translations of a doc (or the source, if a translation is given)
// across the common localization layouts. Powers the hook's "translations may be stale" note.
const shortenPath = (p) => {
  const s = String(p), home = process.env.HOME;
  return home && (s === home || s.startsWith(home + '/')) ? '~' + s.slice(home.length) : s;
};

// ─── Native attention primitive ─────────────────────────────────────────────────────────────
// One mechanism — "how much does query text engage context text?" — drives every attention
// feature. `coverage` flags CONTEXT spans the query ignored (i18n: dropped translation content;
// docs↔code: stale docs). `grounding` flags QUERY rows that ignore the context (factcheck:
// ungrounded sentences). Runs the shipped, relocatable native binary; opt-in via MARI_ATTN_MODEL.
function mariAttnBin() {
  const attn = join(PKG_ROOT, 'native', 'attn');
  const shipped = join(attn, 'dist', `${process.platform}-${process.arch}`, 'mari_attn'); // prebuilt, shipped
  const built = join(attn, 'build', 'mari_attn');
  return process.env.MARI_ATTN_BIN || (existsSync(shipped) ? shipped : built);
}
// Resolve the GGUF model: MARI_ATTN_MODEL, then `.mari/config.json` ("attn":{"model":…}), then
// auto-discovery of a small multilingual *.gguf in common locations — so attention runs out of
// the box without anyone configuring it. Cached (the sweep would otherwise rescan per doc).
let _attnModelCache;
function discoverGguf() {
  const home = process.env.HOME || '';
  const dirs = [
    join(home, '.mari', 'models'), join(home, '.cache', 'mari', 'models'),
    join(PKG_ROOT, 'native', 'attn', 'models'),
    join(home, 'attn', 'cpp', 'models'),
  ];
  const found = [];
  const scan = (d, depth) => {
    if (depth > 3) return;
    let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) scan(p, depth + 1);
      else if (/\.gguf$/i.test(e.name) && !/mmproj|projector/i.test(e.name)) { try { found.push([p, statSync(p).size]); } catch { /* skip */ } }
    }
  };
  for (const d of dirs) scan(d, 0);
  if (!found.length) return null;
  // Prefer the 0.8B Qwen we've standardized on; then any 0.8B, then a small non-VL Qwen.
  const pref = [/qwen3\.5-0\.8b/i, /0\.8b/i, /qwen3\.5/i];
  for (const re of pref) { const f = found.find(([p]) => re.test(p)); if (f) return f[0]; }
  found.sort((a, b) => a[1] - b[1]);
  return (found.find(([p]) => /qwen/i.test(p) && !/-vl-/i.test(p)) || found[0])[0];
}
function attnModel() {
  if (_attnModelCache !== undefined) return _attnModelCache;
  let m = process.env.MARI_ATTN_MODEL;
  if (!m) { try { const c = loadConfig(process.cwd()); m = c.raw?.attn?.model || c.raw?.i18n?.attn?.model; } catch { /* no config */ } }
  if (!m) m = discoverGguf();
  _attnModelCache = (m && existsSync(m)) ? m : null;
  return _attnModelCache;
}
function runMariAttn(ctxFile, qryFile, { grounding = false, mode = null, threshold = 0.3, querySegment = 'paragraph', ctxSize = 0 } = {}) {
  const bin = mariAttnBin();
  const model = attnModel();
  if (!existsSync(bin)) return { error: `attention binary not shipped for ${process.platform}-${process.arch}; set MARI_ATTN_BIN or build native/attn (see native/attn/README.md).` };
  if (!model || !existsSync(model)) return { error: 'set MARI_ATTN_MODEL (or attn.model in .mari/config.json) to a multilingual GGUF model.' };
  // Size the context window from the actual inputs (≈3 chars/token + headroom) instead of a
  // fixed floor — long docs are the POINT of attention grounding. MARI_ATTN_CTX caps it (memory
  // and prompt-processing time grow with the window); the extractor's own "use --ctx-size N"
  // suggestion remains as a retry backstop for anything the estimate misses.
  const MAX_CTX = +(process.env.MARI_ATTN_CTX || 32768);
  if (!ctxSize) {
    let bytes = 0;
    for (const f of [ctxFile, qryFile]) { try { bytes += statSync(f).size; } catch { /* estimate from the other */ } }
    ctxSize = Math.min(MAX_CTX, Math.max(4096, Math.ceil(bytes / 3) + 1024));
  }
  const modeFlag = `--mari-${mode || (grounding ? 'grounding' : 'coverage')}`;
  const run = (size) => spawnSync(bin, ['--model', model, '--context', ctxFile, '--query', qryFile,
    '--query-glob', extname(qryFile).slice(1) || 'md', modeFlag,
    '--context-segment', 'phrase', '--phrase-tokens', '10', '--query-segment', querySegment,
    '--ctx-size', String(size), '--mari-threshold', String(threshold)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  let r = run(ctxSize);
  if (r.status !== 0) {
    const want = (r.stderr || '').match(/use --ctx-size (\d+)/);
    const next = want ? Math.min(parseInt(want[1], 10), MAX_CTX) : 0;
    if (next > ctxSize) r = run(next);
  }
  if (r.status !== 0) return { error: `extractor failed: ${(r.stderr || '').trim().split('\n').pop()}` };
  try { return { out: JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop()) }; }
  catch { return { error: 'could not parse extractor output' }; }
}
// Map a flagged span (which carries a synthetic `// === path ===` header) back to a line in the
// file the span came from (context for coverage, query for grounding).
function lineOfSpan(fileText, spanText) {
  const probe = spanText.replace(/^[/].*?===\s*/s, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  if (!probe) return null;
  // Locate the FULL normalized probe (whitespace-tolerant), not just its first word — common
  // first words ("The", "It") would otherwise match anywhere earlier in the file.
  const re = new RegExp(probe.split(' ').map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+'));
  const m = fileText.match(re);
  return m ? fileText.slice(0, m.index).split('\n').length : null;
}
function printAttnFindings(flagged, fileText, label) {
  if (!flagged.length) { console.log(`    ✓ ${label}`); return; }
  for (const f of flagged) {
    const line = lineOfSpan(fileText, f.text);
    console.log(`    ⚠ ${(f.score * 100).toFixed(0)}%${line ? `  (≈L${line})` : ''}  ${f.text.replace(/\s+/g, ' ').trim().slice(0, 80)}`);
  }
}
// Is the attention layer usable (shipped/built binary + a model)? Checked once before a slow loop.
function attnReady() {
  const m = attnModel();
  return existsSync(mariAttnBin()) && !!m && existsSync(m);
}
// Attention is OPT-IN (it costs ~3s/doc). It runs only with `--deep`, which errors loudly
// if it can't — so the LLM/user controls exactly when to pay for it. Default is fast/structural.
function attnDecision() {
  if (!flag('deep')) return false;
  if (!attnReady()) {
    const why = !existsSync(mariAttnBin())
      ? `the native attention binary isn't shipped for ${process.platform}-${process.arch} (set MARI_ATTN_BIN or build native/attn)`
      : `no model found (set MARI_ATTN_MODEL, "attn":{"model":…} in .mari/config.json, or drop a GGUF in ~/.mari/models)`;
    console.error(`--deep: cannot run — ${why}.`);
    process.exit(2);
  }
  console.error(`(--deep: running the attention model ${attnModel().split('/').pop()} — ~3s per doc, this will take a while)`);
  return true;
}
// Run coverage for one source→translation pair and print the dropped passages, indented under
// the current doc (used by `i18n conform --deep` to localize the prose behind a drift).
function printCoverageUnder(srcAbs, transRel, srcText, thr) {
  const res = runMariAttn(srcAbs, transRel, { grounding: false, threshold: thr });
  if (res.error) { console.log(`    · attention skipped: ${res.error}`); return; }
  const flagged = res.out.flagged || [];
  if (!flagged.length) { console.log('    ✓ prose coverage complete (attention)'); return; }
  for (const f of flagged) {
    const line = lineOfSpan(srcText, f.text);
    console.log(`    ↘ ${(f.score * 100).toFixed(0)}% covered${line ? `  (≈L${line})` : ''}  ${f.text.replace(/\s+/g, ' ').trim().slice(0, 70)}`);
  }
}

// ─── mari assoc — generic semantic association across the repo ────────────────────────────────
// Everything is embeddings: chunk every file, embed uniformly, shortlist candidate chunk pairs by
// nearest-neighbor, then ATTENTION decides the semantic association. Any file ↔ any file.
// attnFn(a, b) → { associated, score }: does attention connect these two chunks, how strongly?
function attnAssociate(textA, textB, { threshold = 0.3 } = {}) {
  try {
    const dir = join(tmpdir(), 'mari-assoc'); mkdirSync(dir, { recursive: true });
    const cf = join(dir, 'a.txt'), qf = join(dir, 'b.txt');
    writeFileSync(cf, textA); writeFileSync(qf, textB);
    // Sentence-level query rows so the score is graded: the fraction of B's rows that actually
    // attend to A. (A single paragraph collapses to one row and can't discriminate.)
    const res = runMariAttn(cf, qf, { grounding: true, threshold, querySegment: 'sentence' });
    if (res.error) return { associated: false, score: 0 };
    const rows = res.out.query_rows || 1;
    const flagged = (res.out.flagged || []).length;
    const score = Math.max(0, 1 - flagged / Math.max(rows, 1)); // engaged fraction of B
    return { associated: score >= (+(process.env.MARI_ASSOC_ATTN || 0.5)), score: Math.round(score * 1000) / 1000 };
  } catch { return { associated: false, score: 0 }; }
}

// Build (or rebuild) the repo's semantic index: chunk + embed every textual file into the
// Lance vector store, derive cross-file associations. Shared by `assoc build` and `explore`'s
// first-use auto-build. Requires the ML sidecar (checked here so every caller errors the same).
async function runAssocBuild(root, { useAttn = false } = {}) {
  if (!capabilities().available) { console.error('This needs the ML sidecar for embeddings: python3.12 -m venv .venv && .venv/bin/pip install -r ml/requirements.txt (or set MARI_PYTHON).'); process.exit(2); }
  let attnFn = null;
  if (useAttn) {
    console.error(`(association via attention model ${attnModel().split('/').pop()} — slow)`);
    attnFn = attnAssociate;
  }
  console.error(`(embedding with ${capabilities().models.embed} — first run downloads the model…)`);
  const embedFn = (texts) => embed(texts);
  const lanceDir = join(assocDir(root), 'lance'); // vectors persist as a Lance table
  // The vector cache is keyed by file hash ONLY — vectors from a different embed model would be
  // silently reused into a mixed space (half old-model, half new). If the model changed (or the
  // index predates model stamping), wipe the store and re-embed everything.
  const prev = loadAssoc(root);
  if (prev?.embedModel !== capabilities().models.embed) rmSync(lanceDir, { recursive: true, force: true });
  const { index, stats } = await buildAssoc(root, { embedFn, attnFn, lanceDir, onProgress: (m) => console.error(`  · ${m}`) });
  index.builtAt = new Date().toISOString();
  index.vectorStore = 'lance';
  index.embedModel = capabilities().models.embed; // queries must embed with the same model
  index.gitHead = gitHeadOf(root); // the tree this index reflects — refresh diffs against it
  saveAssoc(root, index); // index.json only — vectors live in Lance
  return { ...stats, via: index.via };
}

// ── index freshness: revoke + re-embed what the git tree says changed ──────────────────────────
function gitHeadOf(root) {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Candidate changed/deleted files since the index was built. Git-tracked repos get the cheap
// path: committed drift via `diff --name-status <indexedHead>..HEAD`, working-tree drift via
// `status --porcelain`. Returns null when git can't answer (no repo, or the indexed head is
// gone) — the caller falls back to a full hash scan.
function gitCandidates(root, indexedHead) {
  const head = gitHeadOf(root);
  if (!head) return null;
  let nameStatus = '';
  if (indexedHead && indexedHead !== head) {
    const r = spawnSync('git', ['diff', '--name-status', indexedHead, head], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) return null; // indexed head unknown to this repo — full scan instead
    nameStatus = r.stdout;
  }
  const s = spawnSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return { head, ...parseGitChanges(nameStatus, s.status === 0 ? s.stdout : '') };
}

// Bring the index in line with the working tree: figure out the candidate change set (git when
// possible, full hash scan otherwise), revoke + re-embed through updateAssoc, and re-stamp the
// head. Cheap when nothing changed; never a full re-embed unless everything actually changed.
async function refreshAssocIndex(root, { quiet = false } = {}) {
  const idx = loadAssoc(root);
  if (!idx?.filesMeta) return null; // no index (or a pre-filesMeta one) — caller decides to build
  // Deleted-while-untracked files are invisible to git (no diff entry, no porcelain line) —
  // catch them by existence-checking every indexed file. Cheap: one stat per indexed file.
  const missing = Object.keys(idx.filesMeta).filter((f) => !existsSync(join(root, f)));
  const g = gitCandidates(root, idx.gitHead);
  let candidates;
  if (g && idx.gitHead) {
    if (g.head === idx.gitHead && !g.modified.length && !g.deleted.length && !missing.length) return { fresh: true };
    candidates = { modified: g.modified, deleted: [...new Set([...g.deleted, ...missing])] };
  } else {
    // No git answer: verify every indexable file by hash instead.
    candidates = { modified: walkAssocFiles(root), deleted: missing };
  }
  const { stats } = await updateAssoc(root, {
    index: idx, embedFn: (texts) => embed(texts), lanceDir: join(assocDir(root), 'lance'),
    candidates, onProgress: quiet ? () => {} : (m) => console.error(`  · ${m}`),
  });
  idx.gitHead = g?.head ?? gitHeadOf(root);
  idx.builtAt = new Date().toISOString();
  saveAssoc(root, idx);
  return { fresh: stats.modified === 0 && stats.deleted === 0, ...stats };
}

const ASSOC_USAGE = 'Usage: mari assoc build [--attn] | update | list [file] [--json] | check <file>';
async function assocCmd() {
  const p = positionals();
  const sub = p[0];
  const root = process.cwd();

  if (sub === 'build') {
    const useAttn = flag('attn');
    if (useAttn && !attnReady()) { console.error('--attn needs the native attention binary + a GGUF model (see native/attn/README.md, or set MARI_ATTN_MODEL).'); process.exit(2); }
    const stats = await runAssocBuild(root, { useAttn });
    console.log(`✓ .mari/assoc — ${stats.associations} associations (via ${stats.via}) from ${stats.chunks} chunks across ${stats.files} files; vectors in Lance.`);
    return;
  }

  if (sub === 'update') {
    if (!capabilities().available) { console.error('mari assoc needs the ML sidecar for embeddings (create .venv, install ml/requirements.txt, or set MARI_PYTHON).'); process.exit(2); }
    const r = await refreshAssocIndex(root);
    if (!r) { console.error('No index yet (or one too old to update) — run `mari assoc build` first.'); process.exit(2); }
    console.log(r.fresh ? '✓ index already reflects the current tree.'
      : `✓ refreshed — ${r.modified} file(s) re-embedded, ${r.deleted} revoked, ${r.associations} new association(s).`);
    return;
  }

  if (sub === 'list' || sub === 'check') {
    const index = loadAssoc(root);
    if (!index) { console.error('No association index yet. Run `mari assoc build` first.'); process.exit(2); }
    const target = p[1];
    if (sub === 'check' && !target) { console.error('Usage: mari assoc check <file>'); process.exit(2); }
    const assocs = target ? associationsForFile(index, relative(root, target) || target) : index.associations;
    if (flag('json')) { console.log(JSON.stringify(target ? assocs : index, null, 2)); return; }
    if (!assocs.length) { console.log(target ? `No associations touch ${target}.` : 'No associations. Run `mari assoc build`.'); return; }

    if (sub === 'check') {
      const rel = toPosix(relative(root, target) || target);
      console.log(`\`${rel}\` is semantically associated with:`);
      const seen = new Set();
      for (const a of assocs) {
        const k = a.b.file + '|' + a.b.span; if (seen.has(k)) continue; seen.add(k);
        console.log(`  → ${a.b.file} L${a.b.lines[0]}-${a.b.lines[1]}  (${a.via}, ${a.score})  [your L${a.a.lines[0]}-${a.a.lines[1]}]`);
        if (seen.size >= 15) break;
      }
      return;
    }
    console.log(`${assocs.length} association(s):`);
    for (const a of assocs.slice(0, 60)) console.log(`  ${a.a.file} L${a.a.lines[0]}-${a.a.lines[1]}  ↔  ${a.b.file} L${a.b.lines[0]}-${a.b.lines[1]}  (${a.via}, ${a.score})`);
    if (assocs.length > 60) console.log(`  … and ${assocs.length - 60} more (use --json).`);
    return;
  }

  console.error(ASSOC_USAGE); process.exit(2);
}
const toPosix = (p) => String(p).split(sep).join('/');

// ─── mari explore — RAG + attention over the repo ─────────────────────────────────────────────
// One command to ask a repo anything: embed the query, vector-search the Lance chunk store
// (built automatically on first use), print the top chunks with file:line + snippet. `--deep`
// reranks the top hits with attention — "how much of this chunk genuinely engages the query?" —
// which separates true matches from vocabulary coincidence. A FILE argument explores from that
// file's content instead (what in the repo relates to this file?).
const EXPLORE_USAGE = 'Usage: mari explore "<question>" | <file>  [--k N] [--deep] [--json] [--build]';

const snippetOf = (text, n = 3) => String(text).split('\n')
  .map((l) => l.trim()).filter(Boolean).slice(0, n).map((l) => l.slice(0, 110));

async function explore() {
  const root = process.cwd();
  const args = positionals();
  if (!args.length && !flag('build')) { console.error(EXPLORE_USAGE); process.exit(2); }
  const k = Math.max(1, parseInt(opt('k') || '20', 10) || 20);
  const lanceDir = join(assocDir(root), 'lance');
  const { lanceSearch } = await import('../engine/assoc-lance.mjs');

  // First use: build the vector index right here — explore should work from zero. A stored
  // index embedded with a DIFFERENT model is useless for this query (mixed spaces), so a model
  // change also triggers a rebuild.
  const idx = loadAssoc(root);
  const staleModel = idx?.embedModel && idx.embedModel !== capabilities().models.embed;
  if (flag('build') || staleModel || !existsSync(lanceDir)) {
    console.error(staleModel ? `(index was embedded with ${idx.embedModel}, now using ${capabilities().models.embed} — rebuilding…)`
      : existsSync(lanceDir) ? '(rebuilding the vector index…)'
        : '(no vector index yet — building one now; this embeds the whole repo once…)');
    await runAssocBuild(root, { useAttn: false });
    if (!args.length) return;
  } else {
    if (!capabilities().available) { console.error('mari explore needs the ML sidecar for embeddings: python3.12 -m venv .venv && .venv/bin/pip install -r ml/requirements.txt (or set MARI_PYTHON).'); process.exit(2); }
    // Keep the index honest with the working tree: diff against the git head it was built at,
    // revoke what's gone, re-embed only what actually changed. Free when nothing moved.
    const r = await refreshAssocIndex(root);
    if (!r) { console.error('(index predates incremental maintenance — rebuilding…)'); await runAssocBuild(root, { useAttn: false }); }
    else if (!r.fresh) console.error(`(index refreshed: ${r.modified} file(s) re-embedded, ${r.deleted} revoked)`);
  }

  // A file argument explores FROM that file (its content is the query); free text embeds as-is.
  const isFile = args.length === 1 && existsSync(args[0]) && statSync(args[0]).isFile();
  const queryText = isFile ? readFileSync(args[0], 'utf8') : args.join(' ');
  const excludeFile = isFile ? toPosix(relative(root, args[0]) || args[0]) : null;

  // Embed the query. A FILE is represented by the mean of its chunk embeddings — the whole doc,
  // not just its head (the embedder truncates a single long text at its token limit). Free text
  // gets the Qwen query-side instruction prefix (documents stay raw).
  let qv;
  if (isFile) {
    const cs = chunkFile(queryText, excludeFile);
    const vs = await embed(cs.length ? cs.map((c) => c.text) : [queryText]);
    const dim = vs[0]?.length || 0;
    const sum = new Array(dim).fill(0);
    let n = 0;
    for (const v of vs) { if (v?.length === dim) { for (let i = 0; i < dim; i++) sum[i] += v[i]; n++; } }
    const norm = Math.sqrt(sum.reduce((s, x) => s + x * x, 0)) || 1;
    qv = n ? sum.map((x) => x / norm) : null;
  } else {
    [qv] = await embed([queryText], { instruct: 'Given a question about this code repository, retrieve the file chunks that answer it' });
  }
  if (!qv?.length) { console.error('Embedding the query failed.'); process.exit(2); }
  // Over-fetch, then cap hits per file — exploration wants the top PLACES in the repo, and one
  // large file would otherwise monopolize the list with near-duplicate chunks.
  const PER_FILE = 3;
  const raw = await lanceSearch(lanceDir, qv, { k: Math.min(k * 8, 96), excludeFile });
  const perFile = new Map();
  const capped = [], overflow = [];
  for (const h of raw) {
    const n = perFile.get(h.file) || 0;
    (n < PER_FILE ? capped : overflow).push(h);
    perFile.set(h.file, n + 1);
  }
  // diversity first, but never return fewer than k when matches exist — backfill from overflow
  let hits = capped.slice(0, k);
  if (hits.length < k) hits.push(...overflow.slice(0, k - hits.length));
  hits.sort((a, b) => b.sim - a.sim);
  if (!hits.length) { console.log('No matches. `mari explore --build` refreshes the index after big changes.'); return; }

  // The store keeps vectors + spans only — pull each chunk's text live from disk (also means
  // snippets reflect the file as it is now, not as it was at index time).
  for (const h of hits) {
    try { h.text = readFileSync(join(root, h.file), 'utf8').split('\n').slice(h.start - 1, h.end).join('\n'); }
    catch { h.text = ''; }
  }

  // --deep: attention rerank — context is the QUESTION, query rows are the chunk, so the score
  // is the fraction of the chunk that genuinely engages the question (graded, not 0/1).
  const deep = flag('deep');
  if (deep) {
    if (!attnReady()) { console.error('--deep needs the native attention binary + a GGUF model (set MARI_ATTN_MODEL or drop one in ~/.mari/models).'); process.exit(2); }
    // Rerank EVERY retrieved hit — RAG is the pre-filter, attention is the ranking. --limit
    // caps it when you want the speed back.
    const top = opt('limit') != null ? Math.min(hits.length, Math.max(1, parseInt(opt('limit'), 10) || hits.length)) : hits.length;
    // Stricter engagement bar for reranking than for build-time association: RAG already
    // shortlisted topically-related chunks, so a loose threshold saturates every score at 1.
    // Tune per query with --threshold.
    const thr = parseFloat(opt('threshold') || '0.55');
    console.error(`(attention rerank of ${top === hits.length ? `all ${top}` : `the top ${top}`} hits — ~3s each)`);
    for (const h of hits.slice(0, top)) h.attn = attnAssociate(queryText, h.text, { threshold: thr }).score;
    hits.sort((a, b) => (b.attn ?? -1) - (a.attn ?? -1) || b.sim - a.sim);
  }

  if (flag('json')) {
    console.log(JSON.stringify(hits.map(({ text, ...h }) => ({ ...h, snippet: snippetOf(text) })), null, 2));
    return;
  }
  console.log(isFile ? `Related to ${excludeFile}:` : `Explore: "${queryText.slice(0, 100)}"`);
  for (const [i, h] of hits.entries()) {
    const score = h.attn != null ? `attn ${h.attn} · cos ${h.sim}` : `cos ${h.sim}`;
    console.log(`\n${String(i + 1).padStart(2)}. ${h.file} L${h.start}-${h.end}  (${score})`);
    for (const l of snippetOf(h.text)) console.log(`      ${l}`);
  }
  console.log(`\n(top ${hits.length} by ${deep ? 'attention' : 'embedding'} · --k N for more · ${deep ? '--limit N caps the rerank' : '--deep reranks with attention'} · --build refreshes the index)`);

  // --focus: for the top RAG-matched FILES, widen from the matched chunk to the WHOLE file as
  // attention context and report where the query's attention mass concentrates (the new
  // --mari-focus mode). RAG picks the documents cheaply; attention localizes within them.
  if (flag('focus')) {
    if (!attnReady()) { console.error('--focus needs the native attention binary + a GGUF model (set MARI_ATTN_MODEL or drop one in ~/.mari/models).'); process.exit(2); }
    const files = [...new Set(hits.map((h) => h.file))].slice(0, Math.max(1, parseInt(opt('limit') || '6', 10) || 6));
    const fthr = parseFloat(opt('threshold') || '0.6');
    console.error(`(focus: attention over ${files.length} whole file(s) — this takes a while)`);
    const tmp = join(tmpdir(), 'mari-explore'); mkdirSync(tmp, { recursive: true });
    const qf = join(tmp, isFile ? `query.${excludeFile.split('.').pop()}` : 'query.md');
    writeFileSync(qf, queryText);
    console.log(`\nFocus — where the ${isFile ? 'doc' : 'question'}'s attention mass lands (≥${Math.round(fthr * 100)}% of each file's peak):`);
    for (const file of files) {
      const abs = join(root, file);
      let fileText; try { fileText = readFileSync(abs, 'utf8'); } catch { continue; }
      const res = runMariAttn(abs, qf, { mode: 'focus', threshold: fthr, querySegment: 'sentence' });
      if (res.error) { console.log(`\n${file}\n  · skipped: ${res.error}`); continue; }
      const regions = (res.out.flagged || []).sort((a, b) => b.score - a.score).slice(0, 5);
      console.log(`\n${file}`);
      if (!regions.length) { console.log('  (no region clears the bar — attention is spread evenly)'); continue; }
      for (const r of regions) {
        const line = lineOfSpan(fileText, r.text);
        console.log(`  ▮ ${(r.score * 100).toFixed(0)}%${line ? `  ≈L${line}` : ''}  ${r.text.replace(/\s+/g, ' ').trim().slice(0, 110)}`);
      }
    }
    console.log(`\n(focus: --limit N files · --threshold t for a looser/stricter bar)`);
  }
}

// `mari i18n coverage` — coverage mode with the SOURCE as context and the TRANSLATION as query.
function i18nCoverageCmd() {
  const srcF = positionals()[1], transArg = positionals()[2];
  if (!srcF || !existsSync(srcF)) { console.error('Usage: mari i18n coverage <source> [translation]'); process.exit(2); }
  const root = process.cwd();
  const srcAbs = srcF.startsWith('/') ? srcF : join(root, srcF);
  let targets;
  if (transArg) targets = [{ rel: transArg.startsWith('/') ? transArg : join(root, transArg), locale: '' }];
  else {
    const a = i18nAssociations(srcAbs, '', flag('no-config') ? null : loadConfig(root));
    targets = a ? a.siblings : [];
    if (!targets.length) { console.error(`No translation given and none detected for ${srcF}.`); process.exit(2); }
  }
  const srcText = readFileSync(srcAbs, 'utf8');
  const thr = parseFloat(opt('threshold') || '0.3');
  for (const t of targets) {
    console.log(`\n${shortenPath(srcAbs)}  →  ${t.locale ? t.locale + '  ' : ''}${shortenPath(t.rel)}`);
    const res = runMariAttn(srcAbs, t.rel, { grounding: false, threshold: thr });
    if (res.error) { console.error(`  (${res.error})`); continue; }
    printAttnFindings(res.out.flagged || [], srcText, 'the translation covers the source');
  }
}

function i18n() {
  if (positionals()[0] === 'coverage') return i18nCoverageCmd();
  if (positionals()[0] === 'conform') return i18nConformCmd();
  const target = positionals()[0];
  if (!target || !existsSync(target)) { console.error('Usage: mari i18n <file> | mari i18n conform <file>'); process.exit(2); }
  const root = process.cwd();
  const abs = target.startsWith('/') ? target : join(root, target);
  const config = flag('no-config') ? null : loadConfig(root);
  // Resolve against the file's own absolute location (root="") so it works for any target,
  // inside cwd or not. The hook passes the project root for clean relative paths.
  const a = i18nAssociations(abs, '', config);
  if (!a) { console.log(`No localized siblings found for ${target}.`); return; }
  console.log(`${a.isSource ? 'Source' : `Translation (${a.locale})`} · layout: ${a.layout} · source: ${shortenPath(a.sourceRel)}`);
  console.log(`${a.siblings.length} localized sibling(s)${a.isSource ? ' that may need updating' : ''}:`);
  for (const s of a.siblings) console.log(`  ${String(s.locale).padEnd(7)} ${shortenPath(s.rel)}`);
}

// Check that every translation shares the source's language-invariant structure (headings,
// code blocks, links). Mari can't translate — this keeps the docs structurally in lockstep.
function i18nConformCmd() {
  const target = positionals()[1];
  if (!target || !existsSync(target)) { console.error('Usage: mari i18n conform <file|dir> [--deep [--limit N]]'); process.exit(2); }
  const root = process.cwd();
  const abs = target.startsWith('/') ? target : join(root, target);
  const config = flag('no-config') ? null : loadConfig(root);
  // Directory → one-process sweep (don't pay Node startup per file).
  if (statSync(abs).isDirectory()) return i18nConformSweep(abs, config);
  const a = i18nAssociations(abs, '', config);
  if (!a) { console.log(`No localized siblings found for ${target}.`); return; }
  // Always conform from the source: gather every translation in the set.
  const srcAbs = a.sourceRel;
  const fromSource = i18nAssociations(srcAbs, '', config);
  const translations = fromSource ? fromSource.siblings : [];
  if (!translations.length) { console.log('No translations to conform.'); return; }
  // Attention coverage (opt-in via --deep; errors if it can't run). See attnDecision.
  const withAttn = attnDecision();
  const thr = parseFloat(opt('threshold') || '0.3');
  const srcText = readFileSync(srcAbs, 'utf8');
  console.log(`Conforming source ${shortenPath(srcAbs)} against ${translations.length} translation(s)${withAttn ? ' (+ attention)' : ''}:`);
  let warns = 0, clean = 0;
  for (const t of translations) {
    const drift = i18nConform(srcText, readFileSync(t.rel, 'utf8'));
    console.log(`\n  ${String(t.locale).padEnd(7)} ${shortenPath(t.rel)}`);
    if (!drift.length) { console.log('    ✓ structure matches the source'); clean++; }
    else for (const d of drift) { if (d.severity === 'warn') warns++; console.log(`    ${d.severity === 'warn' ? '⚠' : '·'} ${d.message}`); }
    if (withAttn) printCoverageUnder(srcAbs, t.rel, srcText, thr); // localize the skipped prose
  }
  console.log(`\n${clean}/${translations.length} structurally in sync · ${warns} structural drift(s).`);
  if (!withAttn) console.log(`Tip: add --deep to localize which prose the translation skipped (~3s, opt-in).`);
  process.exitCode = flag("strict") && warns > 0 ? 1 : 0;
}

const MD_EXT = /\.(md|mdx|mdc|markdown)$/i;
function* walkMd(dir) {
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkMd(p);
    else if (MD_EXT.test(e.name)) yield p;
  }
}

// Repo-wide conform: walk a tree ONCE (one Node process), conform every localized SOURCE doc
// against its translations. Reports only structural (warn) drift to stay actionable at scale.
function i18nConformSweep(dir, config) {
  const withAttn = attnDecision(); // --deep (opt-in): run attention on the worst-drifted docs
  const thr = parseFloat(opt('threshold') || '0.3');
  let sources = 0, clean = 0, drifted = 0;
  const reports = [];
  for (const f of walkMd(dir)) {
    const a = i18nAssociations(f, '', config);
    if (!a || !a.isSource || !a.siblings.length) continue; // act once, from the source only
    sources++;
    const srcText = readFileSync(f, 'utf8');
    const fileDrift = [];
    for (const t of a.siblings) {
      const warns = i18nConform(srcText, readFileSync(t.rel, 'utf8')).filter((d) => d.severity === 'warn');
      if (warns.length) fileDrift.push({ t, warns });
    }
    if (fileDrift.length) { drifted++; reports.push({ f, srcText, fileDrift }); } else clean++;
  }
  if (!sources) { console.log(`No localized source docs found under ${shortenPath(dir)}.`); return; }
  // --deep runs on the drifted docs only, worst-drift first, capped by --limit (default 10
  // so a big tree doesn't grind for minutes). The structural report still covers every drift.
  let attnSet = null;
  if (withAttn) {
    const sev = (r) => r.fileDrift.reduce((s, fd) => s + fd.warns.reduce((a, w) => {
      const m = w.message.match(/(\d+)\D+?(\d+)/); return a + (m ? Math.abs(+m[1] - +m[2]) : 1);
    }, 0), 0);
    const limit = opt('limit') != null ? parseInt(opt('limit'), 10) : 10;
    const ranked = [...reports].sort((a, b) => sev(b) - sev(a));
    attnSet = new Set(limit > 0 ? ranked.slice(0, limit) : ranked);
  }
  for (const r of reports) {
    console.log(`\n${shortenPath(r.f)}`);
    const doAttn = withAttn && attnSet.has(r);
    for (const fd of r.fileDrift) {
      console.log(`  ${String(fd.t.locale).padEnd(7)} ${shortenPath(fd.t.rel)}`);
      for (const w of fd.warns) console.log(`    ⚠ ${w.message}`);
      if (doAttn) printCoverageUnder(r.f, fd.t.rel, r.srcText, thr); // localize the skipped prose
    }
  }
  console.log(`\n${sources} localized source doc(s) · ${clean} in sync · ${drifted} with structural drift.`);
  if (withAttn) console.log(`(attention localized prose on the ${attnSet.size} worst-drifted of ${drifted}; use --limit N or run a single file)`);
  else console.log(`Tip: add --deep to localize skipped prose (worst-drifted first; --limit N to cap; ~3s/doc).`);
  process.exitCode = flag("strict") && drifted > 0 ? 1 : 0;
}

const PINNABLE = new Set(['audit', 'deslop', 'tighten', 'clarify', 'critique', 'polish', 'document', 'draft', 'outline', 'glossary', 'sharpen', 'soften', 'harden', 'voice', 'cadence', 'format', 'delight', 'adapt', 'localize', 'live', 'factcheck', 'docsite']);

function pin(create) {
  const name = positionals()[0];
  if (!name) { console.error('Usage: mari pin <command> | mari unpin <command>'); process.exit(2); }
  if (create && !PINNABLE.has(name)) {
    console.error(`"${name}" is not a pinnable command. One of: ${[...PINNABLE].join(', ')}`);
    process.exit(2);
  }
  const dir = join(process.cwd(), '.claude', 'commands');
  const file = join(dir, `${name}.md`);
  if (!create) {
    if (existsSync(file)) { rmSync(file); console.log(`Unpinned /${name} (removed ${file}).`); }
    else console.log(`/${name} was not pinned.`);
    return;
  }
  mkdirSync(dir, { recursive: true });
  const body = `---\ndescription: Mari ${name} — shortcut for /mari ${name}\nargument-hint: "[target]"\n---\n\nRun the Mari skill's \`${name}\` command on $ARGUMENTS. Follow skill/reference/${name}.md.\n`;
  writeFileSync(file, body);
  console.log(`Pinned /${name} → ${file}`);
}

function usage() {
  console.log(`mari — deterministic AI-slop + house-style detector (MVP)

Usage:
  mari detect <path|.> [--json] [--summary] [--score] [--strict] [--quiet] [--stdin] [--style=microsoft|google|ap|chicago|plain] [--models] [--slop-spans] [--grammar] [--no-config]
  mari ignores list | add-rule <id> | add-file <glob> | add-value <rule> <value> [--reason "…"]
  mari factcheck <file> [--source <file>] [--json] [--strict] [--models] [--decompose] [--claims <file>] [--ground=attention]   Check claims vs FACTS.md
                        (--decompose splits sentences into atomic claims via the /mari skill; --emit-claim-targets prints the sentences to decompose, --claims <file> consumes them)
  mari facts list | add "<fact>"                                Manage the fact base
  mari install [--providers=claude,cursor,codex,copilot] [--force]   Wire editor hooks + install the skill
  mari update             Refresh the installed skill + hooks from this repo
  mari hooks status | on | off | reset | ignore-rule <id> | ignore-file <glob> | ignore-value <rule> <value> [--reason "…"]
  mari rules list | discover | add <name> --paths "<glob[,…]>" --notify "<message>" [--exclude "<glob>"] | remove <name>   Notify the agent on matching edits (e.g. update API docs)
  mari asset detect <file> | check <file> | scaffold <type> [title]   Developer-asset (runbook/ADR/postmortem/RFC, contributing/code-of-conduct/governance/security) detection, structure check, scaffold
  mari platform detect | list | scaffold <name> [--name "<title>"] [--force]   Set up a docs-as-code site generator (MkDocs, Docusaurus, Sphinx, …) if none exists
  mari check [--json] [--strict] [--deep [--limit N] [--threshold 0.3]]   Validate the whole project: internal links + anchors, nav ↔ files (missing targets, orphans), community-health files and their structure
                        (--deep adds the attention passes: public-surface symbols the docs never engage = undocumented; doc sentences that engage no surface = stale. ~3s/run, needs native/attn + a GGUF model)
  mari surface [dir] [--json]   Print the extracted public API surface (JS/TS, Python, Go, Rust) — the inventory docs are checked against
  mari i18n <file> | conform <file|dir>   List a doc's translations, or check they share the source's structure (dir = one-pass sweep)
  mari i18n coverage <source> [translation]   Flag source passages the translation barely covers (needs native/attn + a GGUF model)
  mari assoc build [--attn] | update | list [file] | check <file>   Generic semantic association across all files (embeddings + nearest-neighbor); --attn uses attention for the association step
                        (update syncs the index with the git tree: revokes deleted files, re-embeds changed ones — explore does this automatically on every query)
  mari explore "<question>" | <file> [--k N] [--deep] [--focus] [--limit N] [--threshold t] [--json] [--build]   RAG search over the repo: embed the query, return the top chunks (file:line + snippet).
                        --focus widens each top-matched FILE to full attention context and prints where the query's attention mass concentrates inside it (≈L, top regions; slow, worth it).
                        A file argument explores from that file's whole content (mean of its chunk embeddings). --deep reranks hits by attention — the fraction of each chunk that
                        engages the query (~3s each; stricter --threshold spreads the scores). The attention window sizes itself to the inputs (cap: MARI_ATTN_CTX, default 32768).
                        First run builds the vector index automatically; afterwards it self-maintains from git.
  mari live [<file>] [--n=<k>] [--stdin]   Iterate a sentence: show a tighter variant + its flags
  mari pin <command>      Create a /<command> shortcut (.claude/commands/<command>.md)
  mari unpin <command>    Remove a pinned shortcut

Exit code: non-zero when any 'error' finding is present (--strict also fails on 'warn').`);
}

// Always release the ML sidecar (no-op if it never started) — a lingering child process
// otherwise keeps the event loop alive and the CLI never exits after embed-backed commands.
main().then(() => shutdown()).catch((e) => { console.error(e?.stack || String(e)); process.exit(2); });
