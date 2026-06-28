#!/usr/bin/env node
// mari — deterministic AI-slop + house-style detector (MVP).
//   mari detect <path|.> [--json] [--strict] [--quiet] [--stdin] [--no-config] [--style=<g>]
//   mari ignores list | add-rule <id> | add-file <glob> | add-value <rule> <value> [--reason "…"]
//   mari install   [--scope=project]   (wire the Claude Code hook)
//   mari hooks status

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../engine/config.mjs';
import { detectText, detectTarget } from '../engine/index.mjs';
import { renderHuman, renderJSON, renderSummary, summarize } from '../engine/findings.mjs';
import { parseFacts, factcheck, factcheckNLI } from '../engine/grounding.mjs';
import { scoreDocument, renderScore } from '../engine/score.mjs';
import { modelsEnabled, capabilities, machineScore, nliEntail, warmup, mlSlopFindings } from '../engine/ml/index.mjs';
import { segment } from '../engine/segment.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const cmd = argv[0];
const rest = argv.slice(1);

function flag(name) { return rest.includes(`--${name}`); }
function opt(name, def = null) {
  const hit = rest.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : def;
}
function positionals() { return rest.filter((a) => !a.startsWith('--')); }

async function main() {
  switch (cmd) {
    case 'detect': return await detect();
    case 'ignores': return ignores();
    case 'install': return install();
    case 'hooks': return hooks();
    case 'pin': return pin(true);
    case 'unpin': return pin(false);
    case 'factcheck': return await runFactcheck();
    case 'facts': return facts();
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
      results.push(...detectTarget(t, { config, root, useInlineIgnores: useInline }));
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

function ignores() {
  const root = process.cwd();
  const path = ensureMariDir(root);
  const cfg = readMari(path);
  cfg.detector = cfg.detector || {};
  const d = cfg.detector;
  const sub = rest[0];
  const args = positionals().slice(1);
  switch (sub) {
    case 'list': {
      console.log('ignoreRules :', (d.ignoreRules || []).join(', ') || '(none)');
      console.log('ignoreFiles :', (d.ignoreFiles || []).join(', ') || '(none)');
      console.log('ignoreValues:', JSON.stringify(d.ignoreValues || {}));
      return;
    }
    case 'add-rule': d.ignoreRules = uniq([...(d.ignoreRules || []), args[0]]); break;
    case 'add-file': d.ignoreFiles = uniq([...(d.ignoreFiles || []), args[0]]); break;
    case 'add-value': {
      const [rule, value] = args;
      d.ignoreValues = d.ignoreValues || {};
      d.ignoreValues[rule] = uniq([...(d.ignoreValues[rule] || []), value]);
      break;
    }
    default: console.error('Usage: mari ignores list | add-rule <id> | add-file <glob> | add-value <rule> <value>'); process.exit(2);
  }
  writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
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
  for (const name of names) {
    try { PROVIDERS[name].wire(root); }
    catch (e) { console.error(`  ✗ ${name}: ${e.message}`); }
  }
  console.log('\nReload each harness (Claude Code: /hooks) for the hook to take effect.');
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

function hooks() {
  const sub = rest[0];
  const root = process.cwd();
  if (sub === 'status') {
    const local = join(root, '.claude', 'settings.local.json');
    const shared = join(root, '.claude', 'settings.json');
    const installed = hasMariHook(local) || hasMariHook(shared);
    const cfg = loadConfig(root);
    console.log('hook installed :', installed ? 'yes' : 'no');
    console.log('hook enabled   :', cfg.hook.enabled === false ? 'no' : 'yes (default)');
    console.log('ignoreRules    :', [...cfg.ignoreRules].join(', ') || '(none)');
    return;
  }
  console.error('Usage: mari hooks status'); process.exit(2);
}

async function runFactcheck() {
  const root = process.cwd();
  const target = positionals()[0];
  if (!target || !existsSync(target)) { console.error('Usage: mari factcheck <file> [--source <file>] [--json] [--strict] [--models]'); process.exit(2); }
  const sourcePath = opt('source');
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
  const useModels = flag('models') || modelsEnabled();
  let findings;
  if (useModels) {
    console.error('(loading NLI model for entailment checking…)');
    await warmup();
    findings = await factcheckNLI(docText, facts, { sourceMode, nli: nliEntail });
  } else {
    findings = factcheck(docText, facts, { sourceMode });
  }
  const rel = positionals()[0];
  const results = [{ file: rel, findings }];
  console.log(flag('json') ? renderJSON(results) : renderHuman(results, { quiet: flag('quiet') }));
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

const PINNABLE = new Set(['audit', 'deslop', 'tighten', 'clarify', 'critique', 'polish', 'document', 'draft', 'sharpen', 'soften', 'harden', 'voice', 'cadence', 'format', 'delight', 'adapt', 'localize', 'factcheck']);

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
  mari detect <path|.> [--json] [--summary] [--score] [--strict] [--quiet] [--stdin] [--style=microsoft] [--models] [--no-config]
  mari ignores list | add-rule <id> | add-file <glob> | add-value <rule> <value>
  mari factcheck <file> [--source <file>] [--json] [--strict]   Check claims vs FACTS.md
  mari facts list | add "<fact>"                                Manage the fact base
  mari install [--providers=claude,cursor,codex,copilot] [--force]   Wire editor hooks
  mari hooks status
  mari pin <command>      Create a /<command> shortcut (.claude/commands/<command>.md)
  mari unpin <command>    Remove a pinned shortcut

Exit code: non-zero when any 'error' finding is present (--strict also fails on 'warn').`);
}

main().catch((e) => { console.error(e?.stack || String(e)); process.exit(2); });
