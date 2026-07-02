// Whole-project docs validation: the deterministic half of `mari check` / the docsite flow.
// Everything here is pure (no fs) in the style of platforms.mjs/assets.mjs — callers pass
// repo-relative paths and page texts, we return detector-shaped findings:
//   { ruleId, family, source: 'site', severity, file, line, col, span, message }
//
// Three checks compose into checkSite():
//   links     — every relative markdown link resolves to a real file; anchors resolve to a
//               real heading (same-file `#x` and cross-file `page.md#x`).
//   nav       — the platform's explicit nav (mkdocs.yml nav, mdBook SUMMARY.md, Docsify
//               _sidebar.md, Sphinx toctree, Antora nav.adoc) points at files that exist,
//               and no docs page is orphaned outside the nav.
//   community — the community-health files a project should carry (README, LICENSE,
//               CONTRIBUTING required; CODE_OF_CONDUCT, SECURITY, CHANGELOG recommended).
//
// Severity philosophy mirrors assets.mjs: a broken relative link or missing nav target is a
// `warn` (objectively wrong today); anchors and orphans are `advisory` (generators differ on
// slug schemes, and a page outside the nav can be deliberate).

// ─── location helpers ───────────────────────────────────────────────────────────────────────

function locator(text) {
  const lines = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lines.push(i + 1);
  return (offset) => {
    let lo = 0, hi = lines.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lines[mid] <= offset) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: offset - lines[lo] + 1 };
  };
}

// Blank out fenced code blocks and inline code, preserving offsets/newlines, so link and
// heading regexes never fire inside code samples.
export function maskCode(text) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return String(text)
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, blank)
    // indented code blocks: runs of 4-space/tab-indented lines preceded by a blank line
    // (list continuations are also indented, but follow a non-blank line)
    .replace(/(^|\n[ \t]*\n)((?:(?: {4}|\t)[^\n]*\n?)+)/g, (m, lead, block) => lead + blank(block))
    .replace(/`[^`\n]*`/g, blank);
}

// ─── links ──────────────────────────────────────────────────────────────────────────────────

// Extract every markdown link from a page: inline [t](href), images, reference definitions
// [id]: href, and reference uses [t][id] (flagging uses whose definition is missing).
export function extractLinks(text) {
  const masked = maskCode(text);
  const out = [];
  const defs = new Map();
  // reference definitions: [id]: href
  for (const m of masked.matchAll(/^[ \t]*\[([^\]^][^\]]*)\]:\s*(<[^>\n]*>|\S+)/gm)) {
    const href = m[2].replace(/^<|>$/g, '');
    defs.set(m[1].toLowerCase(), href);
    out.push({ href, offset: m.index, span: m[0].trim() });
  }
  // inline links + images: [text](href "title")
  for (const m of masked.matchAll(/!?\[([^\]]*)\]\(\s*(<[^>\n]*>|[^)\s]+)(?:\s+["'][^)\n]*["'])?\s*\)/g)) {
    out.push({ href: m[2].replace(/^<|>$/g, ''), offset: m.index, span: m[0] });
  }
  // reference uses: [text][id] or shortcut [id][]
  const unresolved = [];
  for (const m of masked.matchAll(/\[([^\]]+)\]\[([^\]]*)\]/g)) {
    const id = (m[2] || m[1]).toLowerCase();
    if (defs.has(id)) out.push({ href: defs.get(id), offset: m.index, span: m[0] });
    else unresolved.push({ id: m[2] || m[1], offset: m.index, span: m[0] });
  }
  return { links: out, unresolved };
}

// GitHub-style heading slugs (the scheme mkdocs/docusaurus/mdbook all approximate): lowercase,
// drop punctuation, spaces → hyphens; duplicates get -1, -2, … suffixes.
export function slugify(heading) {
  return String(heading).toLowerCase().trim()
    .replace(/<[^>]*>/g, '')            // inline HTML
    .replace(/[!(),.:;'"`’“”?[\]{}\\/|@#$%^&*+=~<>]+/g, '')
    // GitHub maps EACH space to a hyphen without collapsing runs — "`A` / `B`" (punctuation
    // stripped, two spaces left) becomes a--b, not a-b.
    .replace(/\s/g, '-');
}

// The set of anchors a page exposes: ATX heading slugs (with duplicate suffixes), explicit
// {#custom-id} attributes (mkdocs attr_list / MyST), and HTML <a name|id> anchors.
export function anchorsOf(text) {
  const masked = maskCode(text);
  const anchors = new Set();
  const counts = new Map();
  // Find heading POSITIONS in the masked text (so headings inside code fences don't count),
  // but slugify the ORIGINAL text — masking blanks inline code, and "# `LICENSE`" must slug
  // from its real characters.
  for (const m of masked.matchAll(/^#{1,6}[ \t]+(?:.+?)[ \t]*#*[ \t]*$/gm)) {
    const orig = String(text).slice(m.index, m.index + m[0].length);
    let title = (orig.match(/^#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/) || [null, ''])[1];
    if (!title) continue;
    const custom = title.match(/\{#([^}\s]+)\}\s*$/);
    if (custom) { anchors.add(custom[1]); title = title.slice(0, custom.index); }
    const base = slugify(title.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')); // slug of the link text, not the URL
    const n = counts.get(base) || 0;
    counts.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  for (const m of text.matchAll(/<(?:a|h[1-6]|div|span|section)\s[^>]*(?:name|id)=["']([^"']+)["']/gi)) anchors.add(m[1]);
  return anchors;
}

// Resolve `href` from `fromPath` (both repo-relative, posix) with ./.. normalization.
export function resolveLink(fromPath, href) {
  const base = fromPath.split('/').slice(0, -1);
  const segs = href.startsWith('/') ? href.slice(1).split('/') : [...base, ...href.split('/')];
  const out = [];
  for (const s of segs) {
    if (s === '' || s === '.') continue;
    if (s === '..') { if (!out.length) return null; out.pop(); }
    else out.push(s);
  }
  return out.join('/');
}

const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i; // scheme: or protocol-relative
const PAGE_EXT = /\.(md|mdx|mdc|markdown|rst|adoc)$/i;

// Every directory implied by the file list — GitHub renders a link to a bare directory, so a
// target that is a real directory counts as resolved.
function dirsOf(paths) {
  const dirs = new Set();
  for (const p of paths) {
    const segs = String(p).split('/');
    for (let i = 1; i < segs.length; i++) dirs.add(segs.slice(0, i).join('/'));
  }
  return dirs;
}

// A link target `t` (already resolved repo-relative) exists if any generator-style candidate
// does: exact, extensionless page (`t.md`), directory index, or a real directory. Returns the
// matched path.
function findTarget(t, pathSet, dirSet) {
  const clean = t.replace(/\/+$/, '');
  const cands = [t, clean,
    `${clean}.md`, `${clean}.mdx`, `${clean}.markdown`, `${clean}.rst`, `${clean}.adoc`,
    `${clean}/index.md`, `${clean}/index.mdx`, `${clean}/README.md`, `${clean}/_index.md`];
  // generators publish page.md as page/ or page.html — map .html back to a source page
  if (/\.html?$/i.test(clean)) cands.push(clean.replace(/\.html?$/i, '.md'), clean.replace(/\.html?$/i, '.mdx'));
  for (const c of cands) if (c && pathSet.has(c)) return c;
  if (dirSet && dirSet.has(clean)) return clean;
  return null;
}

const MARKDOWN = /\.(md|mdx|mdc|markdown)$/i;

// Check every internal link on every markdown page (non-markdown entries — nav configs like
// mkdocs.yml passed along for checkNav — are skipped). `paths` = every repo-relative file
// path (posix), so links to code/assets also resolve.
export function checkLinks(pages, paths) {
  const pathSet = new Set(paths);
  const dirSet = dirsOf(paths);
  const pageText = new Map(pages.map((p) => [p.path, p.text]));
  const anchorCache = new Map();
  const anchors = (p) => {
    if (!anchorCache.has(p)) anchorCache.set(p, anchorsOf(pageText.get(p) || ''));
    return anchorCache.get(p);
  };
  const out = [];
  for (const page of pages) {
    if (!MARKDOWN.test(page.path)) continue;
    const locate = locator(page.text);
    const emit = (severity, offset, span, ruleId, message) => {
      const at = locate(offset);
      out.push({ ruleId, family: 'structure', source: 'site', severity, file: page.path,
        line: at.line, col: at.col, span: String(span).slice(0, 120), message });
    };
    const { links, unresolved } = extractLinks(page.text);
    for (const u of unresolved) {
      emit('warn', u.offset, u.span, 'link-undefined-reference', `Link reference "[${u.id}]" has no definition on this page.`);
    }
    for (const l of links) {
      const href = l.href.trim();
      if (!href || EXTERNAL.test(href)) continue; // external / mailto — network checks aren't deterministic
      const [pathPart, frag] = href.split('#', 2);
      if (!pathPart) { // same-page anchor
        if (frag && !anchors(page.path).has(decodeURIComponent(frag)))
          emit('advisory', l.offset, l.span, 'link-broken-anchor', `Anchor "#${frag}" doesn't match any heading on this page.`);
        continue;
      }
      const abs = pathPart.startsWith('/');
      let target = null;
      let resolved = null;
      if (abs) {
        // Root-relative links resolve against the SITE's base URL, which we can't know
        // statically — try the repo root, every ancestor of the page (the docs root is one of
        // them), and the common static-serving roots (Next.js/Docusaurus publish public/ and
        // static/ at "/"); if none hits, flag it advisory rather than claiming it's broken.
        const rel = decodeURIComponent(pathPart).slice(1);
        const dirs = page.path.split('/').slice(0, -1);
        const bases = [...Array(dirs.length + 1).keys()].map((i) => dirs.slice(0, i)).concat([['public'], ['static']]);
        for (const base of bases) {
          resolved = [...base, rel].join('/');
          target = findTarget(resolved, pathSet, dirSet);
          if (target) break;
        }
        if (!target) {
          // A machine-absolute path (/Users/…, /home/…) is never a site URL — it worked on
          // exactly one person's laptop. (Windows C:\ paths parse as a scheme and are already
          // skipped as external.)
          if (/^\/(Users|home|tmp|var|opt|mnt)\//.test(pathPart)) {
            emit('warn', l.offset, l.span, 'link-machine-path',
              `Link "${href}" is a local filesystem path — it breaks for every other reader; use a repo-relative path.`);
          } else {
            emit('advisory', l.offset, l.span, 'link-unresolved-absolute',
              `Root-relative link "${href}" doesn't match any file — it resolves against the site's base URL, so verify it in the built site.`);
          }
          continue;
        }
      } else {
        resolved = resolveLink(page.path, decodeURIComponent(pathPart));
        target = resolved != null ? findTarget(resolved, pathSet, dirSet) : null;
        if (!target) {
          emit('warn', l.offset, l.span, 'link-broken', `Broken link "${href}" — no file at "${resolved ?? pathPart}".`);
          continue;
        }
      }
      if (frag && pageText.has(target) && !anchors(target).has(decodeURIComponent(frag)))
        emit('advisory', l.offset, l.span, 'link-broken-anchor', `Anchor "#${frag}" doesn't match any heading in ${target}.`);
    }
  }
  return out;
}

// ─── nav ↔ pages ────────────────────────────────────────────────────────────────────────────

// Per-platform explicit-nav parsers. Each returns { navPath, docsRoot, entries: [repo-relative
// page paths], globs } or null when the platform has no parseable nav (Docusaurus autogenerated,
// Hugo, Jekyll, …). `globs` true means the nav pulls pages by pattern → skip orphan detection.
const NAV_SPECS = [
  {
    id: 'mkdocs',
    find: (paths) => paths.find((p) => /^mkdocs\.ya?ml$/i.test(p)),
    parse(text, navPath) {
      // naive YAML walk: everything indented under the top-level `nav:` key
      const m = text.match(/^nav:[ \t]*\n((?:[ \t]+[^\n]*\n?|\n)*)/m);
      if (!m) return null; // no explicit nav → mkdocs builds from the tree; nothing to conform
      const entries = [];
      for (const line of m[1].split('\n')) {
        const v = line.match(/(?::|^\s*-)\s+['"]?([^\s'"#:]+\.(?:md|mdx))['"]?\s*$/i);
        if (v) entries.push('docs/' + v[1].trim().replace(/^\.\//, ''));
      }
      return { navPath, docsRoot: 'docs', entries, globs: false };
    },
  },
  {
    id: 'mdbook',
    find: (paths) => paths.find((p) => /(^|\/)src\/SUMMARY\.md$/i.test(p) || /^SUMMARY\.md$/i.test(p)),
    parse(text, navPath) {
      const root = navPath.split('/').slice(0, -1).join('/');
      const entries = extractLinks(text).links
        .map((l) => l.href.split('#')[0]).filter((h) => h && !EXTERNAL.test(h))
        .map((h) => resolveLink(navPath, h)).filter(Boolean);
      return { navPath, docsRoot: root, entries, globs: false };
    },
  },
  {
    id: 'docsify',
    find: (paths) => paths.find((p) => /(^|\/)_sidebar\.md$/i.test(p)),
    parse(text, navPath) {
      const root = navPath.split('/').slice(0, -1).join('/');
      const entries = extractLinks(text).links
        .map((l) => l.href.split('#')[0].split('?')[0]).filter((h) => h && !EXTERNAL.test(h))
        // docsify routes from the docs root: "/" → README.md, "/guide" → guide.md
        .map((h) => {
          const rel = h.replace(/^\//, '');
          const base = rel === '' ? 'README.md' : rel;
          return resolveLink(navPath, PAGE_EXT.test(base) ? base : `${base}.md`);
        }).filter(Boolean);
      return { navPath, docsRoot: root, entries, globs: false };
    },
  },
  {
    id: 'sphinx',
    find: (paths) => paths.find((p) => /^(docs?|source)\/index\.(md|rst)$/i.test(p)),
    parse(text, navPath) {
      // MyST fenced toctrees (```{toctree}) and RST `.. toctree::` directives
      const blocks = [
        ...[...text.matchAll(/^(```+|~~~+)\{toctree\}[^\n]*\n([\s\S]*?)^\1/gm)].map((m) => m[2]),
        ...[...text.matchAll(/^\.\.[ \t]+toctree::[^\n]*\n((?:[ \t]+[^\n]*\n|\n)*)/gm)].map((m) => m[1]),
      ];
      if (!blocks.length) return null;
      const entries = []; let globs = false;
      for (const b of blocks) {
        for (const raw of b.split('\n')) {
          const line = raw.trim();
          if (!line || line.startsWith(':')) { if (/^:glob:/.test(line)) globs = true; continue; }
          if (/[*?]/.test(line)) { globs = true; continue; }
          // entries may carry a title: "Title <target>"
          const t = (line.match(/<([^<>]+)>\s*$/) || [null, line])[1];
          const resolved = resolveLink(navPath, PAGE_EXT.test(t) ? t : `${t}.md`);
          if (resolved) entries.push(resolved);
        }
      }
      return { navPath, docsRoot: navPath.split('/').slice(0, -1).join('/'), entries, globs };
    },
  },
  {
    id: 'antora',
    find: (paths) => paths.find((p) => /(^|\/)modules\/[^/]+\/nav\.adoc$/i.test(p)),
    parse(text, navPath) {
      const moduleRoot = navPath.replace(/\/nav\.adoc$/i, '');
      const entries = [...text.matchAll(/xref:([^[\]\s]+?)(?:\.adoc)?\[/g)]
        .map((m) => `${moduleRoot}/pages/${m[1]}.adoc`);
      return { navPath, docsRoot: `${moduleRoot}/pages`, entries, globs: false };
    },
  },
];

// Validate the explicit nav: every entry must exist; docs pages outside the nav are advisory
// orphans. Platforms without a parseable nav return [] (nothing to conform).
export function checkNav(pages, paths) {
  const pathSet = new Set(paths);
  const pageText = new Map(pages.map((p) => [p.path, p.text]));
  const out = [];
  for (const spec of NAV_SPECS) {
    const navPath = spec.find(paths);
    if (!navPath) continue;
    const nav = spec.parse(pageText.get(navPath) ?? '', navPath);
    if (!nav) continue;
    const resolvedEntries = new Set();
    for (const e of nav.entries) {
      const hit = findTarget(e, pathSet);
      if (hit) resolvedEntries.add(hit);
      else out.push({ ruleId: 'nav-missing-target', family: 'structure', source: 'site', severity: 'warn',
        file: navPath, line: 1, col: 1, span: e,
        message: `Nav entry "${e}" points at a file that doesn't exist.` });
    }
    if (nav.globs) continue; // pattern-driven nav — orphan detection would be all noise
    const skip = new RegExp(`(^|/)(SUMMARY|_sidebar|_navbar|_coverpage|index|README)\\.md$`, 'i');
    for (const p of paths) {
      if (!p.startsWith(nav.docsRoot + '/') || !/\.(md|mdx)$/i.test(p)) continue;
      if (p === navPath || skip.test(p) || resolvedEntries.has(p)) continue;
      out.push({ ruleId: 'nav-orphan-page', family: 'structure', source: 'site', severity: 'advisory',
        file: p, line: 1, col: 1, span: p,
        message: `Page isn't reachable from ${navPath} — add it to the nav or remove it.` });
    }
  }
  return out;
}

// ─── community-health files ─────────────────────────────────────────────────────────────────

// GitHub's community-standards set. `required` missing → warn; `recommended` → advisory.
// Files count wherever GitHub looks for them: repo root, .github/, or docs/.
const COMMUNITY = [
  { name: 'README.md', re: /^readme(\.[a-z-]+)?\.(md|mdx|rst|txt)$/i, required: true },
  { name: 'LICENSE', re: /^(licen[sc]e|copying)(\.[a-z-]+)?(\.(md|txt|rst))?$/i, required: true },
  { name: 'CONTRIBUTING.md', re: /^contributing(\.[a-z-]+)?\.(md|mdx|rst|txt)$/i, required: true, asset: 'contributing' },
  { name: 'CODE_OF_CONDUCT.md', re: /^code[-_]?of[-_]?conduct(\.[a-z-]+)?\.(md|mdx|rst|txt)$/i, required: false, asset: 'code-of-conduct' },
  { name: 'SECURITY.md', re: /^security(\.[a-z-]+)?\.(md|mdx|rst|txt)$/i, required: false, asset: 'security' },
  { name: 'CHANGELOG.md', re: /^(changelog|changes|history|news)(\.[a-z-]+)?\.(md|mdx|rst|txt)$/i, required: false },
];

export function checkCommunity(paths) {
  const roots = /^(\.github\/|docs\/)?[^/]+$/i;
  const basenames = paths.filter((p) => roots.test(p)).map((p) => ({ p, base: p.split('/').pop() }));
  const out = [];
  const found = {};
  for (const c of COMMUNITY) {
    const hit = basenames.find((b) => c.re.test(b.base));
    if (hit) { found[c.name] = hit.p; continue; }
    out.push({ ruleId: 'community-missing-file', family: 'structure', source: 'site',
      severity: c.required ? 'warn' : 'advisory', file: '(project)', line: 1, col: 1, span: c.name,
      message: `Missing ${c.name}${c.asset ? ` — scaffold one with \`mari asset scaffold ${c.asset}\`` : ''}.` });
  }
  return { findings: out, found };
}

// Which community files carry an asset archetype Mari can structure-check (the CLI runs
// validateAsset over these when they exist).
export function communityAssets() {
  return COMMUNITY.filter((c) => c.asset).map((c) => ({ name: c.name, asset: c.asset, re: c.re }));
}

// ─── composition ────────────────────────────────────────────────────────────────────────────

// The whole-project pass: links + nav + community presence. Asset structure checks and the
// prose detector layer on top in the CLI (they need segment()/config). Findings come back
// sorted by file then line for stable output.
export function checkSite(pages, paths) {
  const community = checkCommunity(paths);
  const findings = [...checkLinks(pages, paths), ...checkNav(pages, paths), ...community.findings];
  findings.sort((a, b) => (a.file === b.file ? a.line - b.line || a.col - b.col : a.file < b.file ? -1 : 1));
  return { findings, community: community.found };
}
