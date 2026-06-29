// i18n association: given a markdown file, find its sibling translations across the common
// localization layouts, so editing the source can flag the translations that may now be stale.
//
// Built-in layouts (any subset enabled via config.i18n.layouts):
//   suffix      — name.<locale>.md siblings        (README.es.md ↔ README.md)        [hermes]
//   hugo        — content[.|-]<locale>/ parallel tree (docs/content ↔ docs/content.zh) [Flink]
//   docusaurus  — i18n/<locale>/docusaurus-plugin-content-docs/current/…              [hermes website]
//   dir         — a locale directory segment with sibling locale dirs (docs/en ↔ docs/zh)
// Plus custom `config.i18n.mirrors`: [{ source, translation }] where `translation` contains
// `{locale}` — for org-specific layouts. Expandable without code changes.
//
// Detection only reports translations that ACTUALLY EXIST on disk, so it never invents files.

import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// ISO-639 base codes Mari recognizes as locales (mirrors index.mjs, plus the default `en`).
const LOCALE_BASE = new Set(('en es fr de pt it ja ko zh ru ar ur hi bn pa te ta mr gu kn ml ' +
  'nl pl tr vi th id sv da no fi cs el he ro hu uk fa sw af sr hr sk bg lt lv et sl ms tl ne si km my ka az kk uz').split(' '));

// Return the normalized locale (e.g. "zh-cn") if the token is a locale, else null.
function isLocale(tok) {
  const t = String(tok).toLowerCase();
  const m = t.match(/^([a-z]{2,3})(?:[-_][a-z0-9]{2,4})?$/);
  return m && LOCALE_BASE.has(m[1]) ? t : null;
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const toPosix = (p) => String(p).split(/[\\/]/).join('/');
const joinRel = (...parts) => parts.filter((p) => p !== '' && p != null).join('/');
function listDirs(abs) { try { return readdirSync(abs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } }
function listFiles(abs) { try { return readdirSync(abs, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name); } catch { return []; } }
const exists = (root, rel) => existsSync(join(root, rel));

// --- layout resolvers: (rel, def, root) → { layout, locale, sourceRel, siblings:[{locale,rel}] } | null
// Each resolver does its own filesystem discovery and only returns EXISTING sibling files.

function suffix(rel, def, root) {
  const i = rel.lastIndexOf('/');
  const dir = i === -1 ? '' : rel.slice(0, i);
  const b = i === -1 ? rel : rel.slice(i + 1);
  const dot = b.lastIndexOf('.');
  if (dot <= 0) return null;
  const ext = b.slice(dot);
  const stem = b.slice(0, dot);
  const m = stem.match(/^(.+)\.([A-Za-z0-9-]{2,7})$/);
  let baseStem = stem, locale = def;
  if (m && isLocale(m[2])) { baseStem = m[1]; locale = isLocale(m[2]); }
  const files = listFiles(join(root, dir));
  const re = new RegExp(`^${esc(baseStem)}\\.([A-Za-z0-9-]{2,7})${esc(ext)}$`);
  const siblings = [];
  if (locale !== def && files.includes(baseStem + ext)) siblings.push({ locale: def, rel: joinRel(dir, baseStem + ext) });
  for (const f of files) {
    const mm = f.match(re); if (!mm) continue;
    const l = isLocale(mm[1]); if (!l || l === locale) continue;
    siblings.push({ locale: l, rel: joinRel(dir, f) });
  }
  if (!siblings.length) return null;
  return { layout: 'suffix', locale, sourceRel: joinRel(dir, baseStem + ext), siblings };
}

const CONTENT_SEG = /^content(?:[.\-]([a-z]{2,3}(?:[-_][a-z0-9]{2,4})?))?$/i;
function hugo(rel, def, root) {
  const segs = rel.split('/');
  let idx = -1, locale = def;
  for (let k = 0; k < segs.length; k++) { const m = segs[k].match(CONTENT_SEG); if (m) { idx = k; if (m[1] && isLocale(m[1])) locale = isLocale(m[1]); break; } }
  if (idx === -1) return null;
  const parentRel = segs.slice(0, idx).join('/');
  const tail = segs.slice(idx + 1);
  const siblings = [];
  for (const d of listDirs(join(root, parentRel))) {
    const m = d.match(CONTENT_SEG); if (!m) continue;
    const loc = m[1] ? isLocale(m[1]) : def; if (!loc || loc === locale) continue;
    const sibRel = joinRel(parentRel, d, ...tail);
    if (exists(root, sibRel)) siblings.push({ locale: loc, rel: sibRel });
  }
  if (!siblings.length) return null;
  return { layout: 'hugo', locale, sourceRel: joinRel(parentRel, 'content', ...tail), siblings };
}

function docusaurus(rel, def, root) {
  let web, folder, tail, locale;
  let m = rel.match(/^(.*?)i18n\/([A-Za-z0-9-]+)\/docusaurus-plugin-content-(docs|blog|pages)\/(?:current\/)?(.+)$/);
  if (m && isLocale(m[2])) { web = m[1].replace(/\/$/, ''); folder = m[3]; tail = m[4]; locale = isLocale(m[2]); }
  else {
    m = rel.match(/^(.*?)(docs|blog)\/(.+)$/);
    if (!m) return null;
    web = m[1].replace(/\/$/, ''); folder = m[2]; tail = m[3]; locale = def;
    if (!existsSync(join(root, web, 'i18n'))) return null; // only docusaurus if an i18n tree exists
  }
  const plugin = `docusaurus-plugin-content-${folder}`;
  const sourceRel = joinRel(web, folder, tail);
  const siblings = [];
  if (locale !== def && exists(root, sourceRel)) siblings.push({ locale: def, rel: sourceRel });
  for (const d of listDirs(join(root, web, 'i18n'))) {
    const loc = isLocale(d); if (!loc || loc === locale) continue;
    const sibRel = joinRel(web, 'i18n', d, plugin, 'current', tail);
    if (exists(root, sibRel)) siblings.push({ locale: loc, rel: sibRel });
  }
  if (!siblings.length) return null;
  return { layout: 'docusaurus', locale, sourceRel, siblings };
}

function localeDir(rel, def, root) {
  const segs = rel.split('/');
  for (let k = 0; k < segs.length - 1; k++) {
    const loc = isLocale(segs[k]); if (!loc) continue;
    const parentRel = segs.slice(0, k).join('/');
    const locDirs = listDirs(join(root, parentRel)).filter((d) => isLocale(d));
    // require evidence this really is a locale-mirror dir, not a coincidental short name
    if (locDirs.length < 2 && !locDirs.includes(def)) continue;
    const tail = segs.slice(k + 1);
    const siblings = [];
    for (const d of locDirs) { const l = isLocale(d); if (l === loc) continue; const sibRel = joinRel(parentRel, d, ...tail); if (exists(root, sibRel)) siblings.push({ locale: l, rel: sibRel }); }
    if (!siblings.length) continue;
    return { layout: 'dir', locale: loc, sourceRel: joinRel(parentRel, def, ...tail), siblings };
  }
  return null;
}

// Custom mirror: { source: "<prefix>", translation: "<prefix with {locale}>" }. `{locale}` may
// sit inside a path segment (content.{locale}) or be a whole segment (i18n/{locale}/current).
function mirror(rel, def, root, m) {
  const src = String(m.source || '').replace(/\/$/, '');
  const tpl = String(m.translation || '').replace(/\/$/, '');
  if (!tpl.includes('{locale}') || !src) return null;

  let tail = null, locale = def;
  if (rel.startsWith(src + '/')) tail = rel.slice(src.length + 1);
  else {
    const re = new RegExp('^' + esc(tpl).replace(esc('{locale}'), '([A-Za-z0-9-]+)') + '/(.+)$');
    const mm = rel.match(re);
    if (!mm) return null;
    locale = mm[1].toLowerCase(); tail = mm[2];
  }

  // Locate the segment that carries {locale}; its parent dir is what we scan for real locales.
  const tplSegs = tpl.split('/');
  const li = tplSegs.findIndex((s) => s.includes('{locale}'));
  const parentSegs = tplSegs.slice(0, li);
  const afterSegs = tplSegs.slice(li + 1);
  const segRe = new RegExp('^' + esc(tplSegs[li]).replace(esc('{locale}'), '([A-Za-z0-9-]+)') + '$');

  const sourceRel = joinRel(src, tail);
  const siblings = [];
  if (locale !== def && exists(root, sourceRel)) siblings.push({ locale: def, rel: sourceRel });
  for (const d of listDirs(join(root, ...parentSegs))) {
    const mm = d.match(segRe); if (!mm) continue;
    const loc = mm[1].toLowerCase(); if (loc === locale) continue;
    const sibRel = joinRel(...parentSegs, d, ...afterSegs, tail);
    if (exists(root, sibRel)) siblings.push({ locale: loc, rel: sibRel });
  }
  if (!siblings.length) return null;
  return { layout: 'mirror', locale, sourceRel, siblings };
}

const BUILTINS = { suffix, hugo, docusaurus, dir: localeDir };
export const DEFAULT_LAYOUTS = ['hugo', 'docusaurus', 'dir', 'suffix'];

// Read i18n config from either a loadConfig() result (`.raw.i18n`) or a plain `{ i18n }`.
function i18nConfig(config) { return (config && (config.raw?.i18n || config.i18n)) || {}; }

// Find the i18n set this file belongs to. Returns the matched layout, this file's locale, the
// canonical source path, and the EXISTING sibling translations — or null if the file isn't part
// of a localized set. `mirrors` (custom) are tried first, then the enabled built-ins in order.
export function i18nAssociations(absPath, root, config) {
  const cfg = i18nConfig(config);
  if (cfg.enabled === false) return null;
  const def = String(cfg.defaultLocale || 'en').toLowerCase();
  const layouts = cfg.layouts || DEFAULT_LAYOUTS;
  // When root is set and contains the file, use a clean relative path; otherwise resolve against
  // the file's own absolute location (root stays "").
  const rel = root && absPath.startsWith(root) ? toPosix(absPath.slice(root.length).replace(/^[/\\]/, '')) : toPosix(absPath);

  for (const m of (cfg.mirrors || [])) { const r = mirror(rel, def, root, m); if (r) return finalize(r, rel); }
  for (const name of layouts) {
    const fn = BUILTINS[name]; if (!fn) continue;
    const r = fn(rel, def, root); if (r) return finalize(r, rel);
  }
  return null;
}

function finalize(r, rel) {
  // dedupe siblings, drop self, sort source-first then by locale
  const seen = new Set([rel]);
  const siblings = r.siblings.filter((s) => !seen.has(s.rel) && seen.add(s.rel));
  siblings.sort((a, b) => (a.rel === r.sourceRel ? -1 : b.rel === r.sourceRel ? 1 : a.locale.localeCompare(b.locale)));
  return { layout: r.layout, locale: r.locale, isSource: r.sourceRel === rel, sourceRel: r.sourceRel, siblings };
}
