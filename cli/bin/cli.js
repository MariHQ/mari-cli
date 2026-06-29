#!/usr/bin/env node
// mari — deterministic AI-slop + house-style detector (MVP).
//   mari detect <path|.> [--json] [--strict] [--quiet] [--stdin] [--no-config] [--style=<g>]
//   mari ignores list | add-rule <id> | add-file <glob> | add-value <rule> <value> [--reason "…"]
//   mari install   [--scope=project]   (wire the Claude Code hook)
//   mari hooks status

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath as _f2u } from 'node:url';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../engine/config.mjs';
import { addIgnore, setHookEnabled, resetConfig } from '../engine/config-write.mjs';
import { detectText, detectTarget, PROSE_EXT } from '../engine/index.mjs';
import { extname } from 'node:path';
import { renderHuman, renderJSON, renderSummary, summarize } from '../engine/findings.mjs';
import { parseFacts, factcheck, factcheckNLI, factcheckDecomposed, factcheckLookback, sortFindings } from '../engine/grounding.mjs';
import { scoreDocument, renderScore } from '../engine/score.mjs';
import { modelsEnabled, capabilities, machineScore, nliEntail, warmup, warmupGenerative, decomposeClaims, lookbackGrounding, mlSlopFindings } from '../engine/ml/index.mjs';
import { segment } from '../engine/segment.mjs';
import * as LEX from '../engine/lexicons.mjs';
import { detectAssetType, validateAsset, scaffold, ASSET_TYPES } from '../engine/assets.mjs';
import { i18nAssociations, i18nConform } from '../engine/i18n.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

// Value-taking options accept both `--opt=value` and `--opt value`. Listed so positionals()
// can skip a space-form value and not mistake it for a positional argument.
const VALUE_OPTS = new Set(['source', 'style', 'providers', 'ground', 'threshold', 'reason', 'n', 'model']);
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
    case 'pin': return pin(true);
    case 'unpin': return pin(false);
    case 'factcheck': return await runFactcheck();
    case 'facts': return facts();
    case 'asset': return asset();
    case 'i18n': return i18n();
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
  const useInline = !flag('no-inline-ignores') && useConfig;

  const wantScore = flag('score');
  const useModels = flag('models') || modelsEnabled();
  // Source-string linting (JS/TS/Python) is built (cli/engine/detect-strings.mjs) but off for
  // now — Mari reads markdown only. Flip this to `flag('source')` to re-enable it.
  const lintSource = false;
  let results;
  if (flag('stdin')) {
    const text = readFileSync(0, 'utf8');
    results = [{ file: '<stdin>', findings: detectText(text, { config, useInlineIgnores: useInline }), text }];
  } else {
    const targets = positionals();
    if (!targets.length) targets.push('.');
    results = [];
    for (const t of targets) {
      if (!existsSync(t)) { console.error(`No such path: ${t}`); process.exit(2); }
      if (statSync(t).isFile() && !PROSE_EXT.has(extname(t).toLowerCase())) {
        console.error(`Note: Mari reads markdown only (.md, .markdown, .mdx, .mdc); skipping ${t}.`);
      }
      results.push(...detectTarget(t, { config, root, useInlineIgnores: useInline, lintSource }));
    }
  }

  if (useModels) {
    console.error('(loading models — Qwen perplexity + GLiNER spans…)');
    await warmup();
    for (const r of results) {
      if (!r.text) continue;
      try {
        const extra = await mlSlopFindings(r.text, r.findings, segment(r.text).locate);
        if (extra.length) r.findings = r.findings.concat(extra);
      } catch { /* ml failures never break detection */ }
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
  process.exit(fail ? 1 : 0);
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
  const path = ensureMariDir(root);
  const cfg = readMari(path);
  const sub = rest[0];
  const args = positionals().slice(1);
  if (sub === 'list') {
    const d = cfg.detector || {};
    console.log('ignoreRules :', (d.ignoreRules || []).join(', ') || '(none)');
    console.log('ignoreFiles :', (d.ignoreFiles || []).join(', ') || '(none)');
    console.log('ignoreValues:', JSON.stringify(d.ignoreValues || {}));
    return;
  }
  if (!IGNORE_KIND[sub] || !addIgnore(cfg, IGNORE_KIND[sub], args)) {
    console.error('Usage: mari ignores list | add-rule <id> | add-file <glob> | add-value <rule> <value>'); process.exit(2);
  }
  writeMari(path, cfg);
  console.log(`Updated ${path}`);
}
function uniq(a) { return [...new Set(a.filter(Boolean))]; }

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

// Build the installed SKILL.md from skill/SKILL.src.md: the skill is read in place from this
// repo, so rewrite its relative script/reference/CLI paths to absolute ones rooted here.
function buildSkill(root) {
  const src = readFileSync(join(root, 'skill', 'SKILL.src.md'), 'utf8');
  return src
    .replace(/\bskill\/scripts\//g, `${root}/skill/scripts/`)
    .replace(/\bskill\/reference\//g, `${root}/skill/reference/`)
    .replace(/\bcli\/bin\/cli\.js\b/g, `${root}/cli/bin/cli.js`);
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
  const content = buildSkill(root);
  const written = [];
  for (const dir of skillTargets(root)) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'SKILL.md'), content); written.push(join(dir, 'SKILL.md')); }
  return written;
}

// `mari update` — refresh an existing install: rebuild the skill payload from this repo and
// re-wire the project hooks (idempotent). What `install` does, minus the first-time prompts.
function update() {
  const root = process.cwd();
  if (!existsSync(join(root, 'skill', 'SKILL.src.md'))) { console.error('Run `mari update` from the Mari repo root.'); process.exit(2); }
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

function wireClaude(root) {
  const settingsPath = join(root, '.claude', 'settings.local.json');
  const sharedPath = join(root, '.claude', 'settings.json');
  const cmd = 'node "${CLAUDE_PROJECT_DIR}/skill/scripts/hook.mjs"';
  if (hasMariHook(sharedPath)) { console.log('  • claude: already wired in shared settings.json'); return; }
  const settings = flag('force') && existsSync(settingsPath) ? safeRead(settingsPath) : readJsonOrAbort(settingsPath);
  settings.hooks = settings.hooks || {};
  const arr = settings.hooks.PostToolUse = settings.hooks.PostToolUse || [];
  if (arr.some((e) => JSON.stringify(e).includes('hook.mjs'))) { console.log('  • claude: already installed'); return; }
  arr.push({ matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: cmd, timeout: 10 }] });
  writeJson(settingsPath, settings);
  console.log(`  ✓ claude → ${settingsPath} (post-edit)`);
}
function wireCursor(root) {
  const path = join(root, '.cursor', 'hooks.json');
  const manifest = readJsonOrAbort(path);
  manifest.hooks = manifest.hooks || {};
  const arr = manifest.hooks.beforeEdit = manifest.hooks.beforeEdit || [];
  if (arr.some((e) => JSON.stringify(e).includes('hook-before-edit.mjs'))) { console.log('  • cursor: already installed'); return; }
  arr.push({ command: 'node skill/scripts/hook-before-edit.mjs' });
  writeJson(path, manifest);
  console.log(`  ✓ cursor → ${path} (pre-write, blocking)`);
}
function wireCodex(root) {
  const path = join(root, '.codex', 'hooks.json');
  const manifest = readJsonOrAbort(path);
  const arr = manifest.hooks = manifest.hooks || [];
  if (arr.some((e) => JSON.stringify(e).includes('hook.mjs'))) { console.log('  • codex: already installed'); return; }
  arr.push({ event: 'afterEdit', command: 'node skill/scripts/hook.mjs' });
  writeJson(path, manifest);
  console.log(`  ✓ codex → ${path} (post-edit) — run /hooks in Codex to approve`);
}
function wireCopilot(root) {
  const path = join(root, '.github', 'hooks', 'Mari.json');
  const manifest = existsSync(path) ? readJsonOrAbort(path) : { event: 'postEdit', command: 'node skill/scripts/hook.mjs' };
  writeJson(path, manifest);
  console.log(`  ✓ copilot → ${path} (post-edit)`);
}
function safeRead(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } }

function hasMariHook(path, cmd) {
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
    return;
  }

  const path = ensureMariDir(root);
  const cfg = readMari(path);

  if (sub === 'on' || sub === 'off') {
    setHookEnabled(cfg, sub === 'on');
    writeMari(path, cfg);
    console.log(`Hook ${sub === 'on' ? 'enabled' : 'disabled'} (${path}).`);
    return;
  }
  if (sub === 'reset') {
    resetConfig(cfg);
    writeMari(path, cfg);
    console.log(`Reset hook ignores and enabled flag (${path}).`);
    return;
  }
  if (IGNORE_KIND[sub]) {
    const args = positionals().slice(1);
    if (!addIgnore(cfg, IGNORE_KIND[sub], args)) { console.error(HOOKS_USAGE); process.exit(2); }
    const reason = opt('reason');
    writeMari(path, cfg);
    console.log(`Updated ${path}${reason ? ` (reason: ${reason})` : ''}.`);
    return;
  }
  console.error(HOOKS_USAGE); process.exit(2);
}

async function runFactcheck() {
  const root = process.cwd();
  const target = positionals()[0];
  if (!target || !existsSync(target)) { console.error('Usage: mari factcheck <file> [--source <file>] [--json] [--strict] [--models] [--decompose] [--no-attention]'); process.exit(2); }
  const sourcePath = opt('source');
  const factsFilePath = sourcePath || join(root, 'FACTS.md'); // for default-on attention grounding

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
  const wantDecompose = flag('decompose');
  const wantLookback = flag('lookback') || opt('ground') === 'attention';
  const useModels = flag('models') || modelsEnabled() || wantDecompose || wantLookback;
  let findings;
  if (wantLookback && !sourceMode) {
    // attention grounding is only meaningful against the source the prose was written from
    console.error('--lookback / --ground=attention needs the source: pass --source <file>.'); process.exit(2);
  }
  if (wantDecompose || wantLookback) {
    if (!capabilities().available) { console.error('Mari ML sidecar unavailable: no Python venv (.venv) or ml/mari_ml.py. Run: python3.12 -m venv .venv && .venv/bin/pip install -r ml/requirements.txt'); process.exit(2); }
    console.error('(loading generative grounding models — first run downloads ~1–2 GB)…');
    try {
      await warmupGenerative({ decompose: wantDecompose, lookback: wantLookback });
      findings = wantDecompose
        ? await factcheckDecomposed(docText, facts, { sourceMode, nli: nliEntail, decompose: decomposeClaims })
        : await factcheckNLI(docText, facts, { sourceMode, nli: nliEntail });
      if (wantLookback) findings = sortFindings([...findings, ...await factcheckLookback(docText, facts, { lookback: lookbackGrounding })]);
    } catch (e) {
      console.error(`(generative grounding failed: ${e.message} — falling back to NLI)`);
      findings = await factcheckNLI(docText, facts, { sourceMode, nli: nliEntail });
    }
  } else if (useModels) {
    console.error('(loading NLI model for entailment checking…)');
    await warmup();
    findings = await factcheckNLI(docText, facts, { sourceMode, nli: nliEntail });
  } else {
    findings = factcheck(docText, facts, { sourceMode });
  }
  const rel = positionals()[0];
  const results = [{ file: rel, findings }];
  console.log(flag('json') ? renderJSON(results) : renderHuman(results, { quiet: flag('quiet') }));

  // Attention grounding runs by default when available (binary + MARI_ATTN_MODEL): it flags
  // sentences disconnected from the facts (fabricated/off-topic), complementing the deterministic
  // and NLI checks above. --no-attention opts out.
  if (!flag('json') && !flag('no-attention') && attnReady() && existsSync(factsFilePath)) {
    const res = runMariAttn(factsFilePath, target, { grounding: true, threshold: parseFloat(opt('threshold') || '0.3'), querySegment: 'sentence' });
    if (!res.error) {
      console.log(`\nGrounding (attention) vs ${shortenPath(factsFilePath)}:`);
      printAttnFindings(res.out.flagged || [], docText, 'every sentence attends to the facts');
    }
  }
  const s = summarize(results);
  process.exit(s.error > 0 || (flag('strict') && s.warn > 0) ? 1 : 0);
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
    const fact = positionals().slice(1).join(' ') || rest.slice(1).filter((a) => !a.startsWith('--')).join(' ');
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
      out = out.replace(new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), v);
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
    const flags = [...new Set(detectText(orig, { config, useInlineIgnores: false }).map((f) => f.ruleId))];
    console.log(`\n[${idx}] ${orig}`);
    console.log(`  tighter: ${tighter === orig ? '(already tight)' : tighter}`);
    if (flags.length) console.log(`  flags:   ${flags.join(', ')}`);
  }
  console.log('\nPick one with --n=<k>. For bolder/quieter rewrites, run /mari live (agent-driven).');
}

// Developer-asset awareness: detect a doc's archetype (runbook/ADR/postmortem/RFC), validate
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
    process.exit(flag('strict') && miss > 0 ? 1 : 0);
  }
  console.error(`Usage: mari asset detect <file> | check <file> | scaffold <${types}> [title]`); process.exit(2);
}

// i18n association: list the translations of a doc (or the source, if a translation is given)
// across the common localization layouts. Powers the hook's "translations may be stale" note.
const shortenPath = (p) => String(p).replace(process.env.HOME || '~~', '~');

// ─── Native attention primitive ─────────────────────────────────────────────────────────────
// One mechanism — "how much does query text engage context text?" — drives every attention
// feature. `coverage` flags CONTEXT spans the query ignored (i18n: dropped translation content;
// docs↔code: stale docs). `grounding` flags QUERY rows that ignore the context (factcheck:
// ungrounded sentences). Runs the shipped, relocatable native binary; opt-in via MARI_ATTN_MODEL.
function mariAttnBin() {
  const attn = join(dirname(_f2u(import.meta.url)), '..', '..', 'native', 'attn');
  const shipped = join(attn, 'dist', `${process.platform}-${process.arch}`, 'mari_attn'); // prebuilt, shipped
  const built = join(attn, 'build', 'mari_attn');
  return process.env.MARI_ATTN_BIN || (existsSync(shipped) ? shipped : built);
}
// The model can be set via MARI_ATTN_MODEL or `.mari/config.json` ("attn": { "model": "…gguf" }),
// so it's configured once per project rather than passed every time.
function attnModel() {
  if (process.env.MARI_ATTN_MODEL) return process.env.MARI_ATTN_MODEL;
  try { const c = loadConfig(process.cwd()); return c.raw?.attn?.model || c.raw?.i18n?.attn?.model || null; } catch { return null; }
}
function runMariAttn(ctxFile, qryFile, { grounding = false, threshold = 0.3, querySegment = 'paragraph' } = {}) {
  const bin = mariAttnBin();
  const model = attnModel();
  if (!existsSync(bin)) return { error: `attention binary not shipped for ${process.platform}-${process.arch}; set MARI_ATTN_BIN or build native/attn (see native/attn/README.md).` };
  if (!model || !existsSync(model)) return { error: 'set MARI_ATTN_MODEL (or attn.model in .mari/config.json) to a multilingual GGUF model.' };
  const r = spawnSync(bin, ['--model', model, '--context', ctxFile, '--query', qryFile,
    '--query-glob', extname(qryFile).slice(1) || 'md', grounding ? '--mari-grounding' : '--mari-coverage',
    '--context-segment', 'phrase', '--phrase-tokens', '10', '--query-segment', querySegment,
    '--ctx-size', '4096', '--mari-threshold', String(threshold)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return { error: `extractor failed: ${(r.stderr || '').trim().split('\n').pop()}` };
  try { return { out: JSON.parse((r.stdout || '').trim().split('\n').filter(Boolean).pop()) }; }
  catch { return { error: 'could not parse extractor output' }; }
}
// Map a flagged span (which carries a synthetic `// === path ===` header) back to a line in the
// file the span came from (context for coverage, query for grounding).
function lineOfSpan(fileText, spanText) {
  const probe = spanText.replace(/^[/].*?===\s*/s, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  const word = (probe.split(' ')[0] || '');
  if (!word || fileText.replace(/\s+/g, ' ').indexOf(probe) < 0) return null;
  const idx = fileText.indexOf(word);
  return idx >= 0 ? fileText.slice(0, idx).split('\n').length : null;
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
// Run coverage for one source→translation pair and print the dropped passages, indented under
// the current doc (used by `i18n conform --attention` to localize the prose behind a drift).
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
  if (!target || !existsSync(target)) { console.error('Usage: mari i18n conform <file|dir>'); process.exit(2); }
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
  // Attention coverage runs by default when available (binary + MARI_ATTN_MODEL); --no-attention opts out.
  const withAttn = !flag('no-attention') && attnReady();
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
  if (!attnReady()) console.log(`Tip: set MARI_ATTN_MODEL to also localize which prose the translation skipped (attention).`);
  process.exit(flag('strict') && warns > 0 ? 1 : 0);
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
  const withAttn = !flag('no-attention') && attnReady(); // default-on when available
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
  for (const r of reports) {
    console.log(`\n${shortenPath(r.f)}`);
    for (const fd of r.fileDrift) {
      console.log(`  ${String(fd.t.locale).padEnd(7)} ${shortenPath(fd.t.rel)}`);
      for (const w of fd.warns) console.log(`    ⚠ ${w.message}`);
      if (withAttn) printCoverageUnder(r.f, fd.t.rel, r.srcText, thr); // localize the skipped prose
    }
  }
  console.log(`\n${sources} localized source doc(s) · ${clean} in sync · ${drifted} with structural drift.`);
  if (withAttn) console.log(`(attention localized prose drops on the ${drifted} drifted docs; pass a single file to check a structurally-clean one)`);
  else if (!attnReady()) console.log(`Tip: set MARI_ATTN_MODEL to also localize skipped prose (attention).`);
  process.exit(flag('strict') && drifted > 0 ? 1 : 0);
}

const PINNABLE = new Set(['audit', 'deslop', 'tighten', 'clarify', 'critique', 'polish', 'document', 'draft', 'outline', 'glossary', 'sharpen', 'soften', 'harden', 'voice', 'cadence', 'format', 'delight', 'adapt', 'localize', 'live', 'factcheck']);

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
  mari detect <path|.> [--json] [--summary] [--score] [--strict] [--quiet] [--stdin] [--style=microsoft|google|ap|chicago|plain] [--models] [--no-config]
  mari ignores list | add-rule <id> | add-file <glob> | add-value <rule> <value>
  mari factcheck <file> [--source <file>] [--json] [--strict] [--models] [--decompose] [--ground=attention]   Check claims vs FACTS.md
  mari facts list | add "<fact>"                                Manage the fact base
  mari install [--providers=claude,cursor,codex,copilot] [--force]   Wire editor hooks + install the skill
  mari update             Refresh the installed skill + hooks from this repo
  mari hooks status | on | off | reset | ignore-rule <id> | ignore-file <glob> | ignore-value <rule> <value>
  mari asset detect <file> | check <file> | scaffold <type> [title]   Developer-asset (runbook/ADR/postmortem/RFC) detection, structure check, scaffold
  mari i18n <file> | conform <file|dir>   List a doc's translations, or check they share the source's structure (dir = one-pass sweep)
  mari i18n coverage <source> [translation]   Flag source passages the translation barely covers (needs native/attn + a GGUF model)
  mari live [<file>] [--n=<k>] [--stdin]   Iterate a sentence: show a tighter variant + its flags
  mari pin <command>      Create a /<command> shortcut (.claude/commands/<command>.md)
  mari unpin <command>    Remove a pinned shortcut

Exit code: non-zero when any 'error' finding is present (--strict also fails on 'warn').`);
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(2); });
