// Docs-as-code platform scaffolding: detect whether a repo already runs a documentation-site
// generator, and — when it doesn't — stand up a minimal, valid one for the platform the user picks.
//
// Two halves, both pure (no fs): `detectPlatforms(paths)` matches a list of repo-relative file
// paths against each platform's signature files, so the CLI can tell whether docs-as-code is
// already wired up; `scaffoldPlatform(id, opts)` returns the exact files to write for a fresh
// setup. The CLI (`mari platform …`) does the repo walk and the file writes; keeping this module
// I/O-free mirrors assets.mjs and makes both halves unit-testable with synthetic inputs.
//
// Detection is intentionally BROADER than scaffolding: we recognize platforms we don't scaffold
// (vitepress, starlight, gitbook, readthedocs, …) so we never propose standing up a second site
// next to one that already exists.

// A platform: `id` (stable key + scaffold verb), `label` (human name), `lang` (runtime the user
// will need), `site` (home page). `detect` is a list of RegExps matched against each repo-relative
// path — any match means "already set up". `scaffoldable` platforms also carry a `build` hint and
// a `files(opts)` factory returning [{ path, content }] for a minimal working site.
export const PLATFORMS = [
  {
    id: 'mkdocs',
    label: 'MkDocs (Material)',
    lang: 'Python',
    site: 'https://www.mkdocs.org',
    build: 'pip install mkdocs-material && mkdocs serve',
    detect: [/^mkdocs\.ya?ml$/i],
    files: mkdocsFiles,
  },
  {
    id: 'docusaurus',
    label: 'Docusaurus',
    lang: 'Node.js',
    site: 'https://docusaurus.io',
    build: 'npm install && npm run start',
    // Config can sit at the repo root or under website/ or docs/ (Marquez-style).
    detect: [/^((website|docs)\/)?docusaurus\.config\.(js|ts|mjs|cjs)$/i],
    files: docusaurusFiles,
  },
  {
    id: 'sphinx',
    label: 'Sphinx (MyST Markdown)',
    lang: 'Python',
    site: 'https://www.sphinx-doc.org',
    build: 'pip install sphinx myst-parser furo && sphinx-build -b html docs docs/_build',
    // conf.py is Sphinx's signature; keep it scoped to doc dirs so a random conf.py elsewhere
    // in a repo doesn't read as "Sphinx is set up".
    detect: [/^(docs?|source)\/conf\.py$/i],
    files: sphinxFiles,
  },
  {
    id: 'hugo',
    label: 'Hugo',
    lang: 'Go (single binary)',
    site: 'https://gohugo.io',
    build: 'hugo server',
    detect: [/^hugo\.(toml|ya?ml|json)$/i, /^config\/_default\/hugo\.(toml|ya?ml|json)$/i],
    files: hugoFiles,
  },
  {
    id: 'jekyll',
    label: 'Jekyll (GitHub Pages)',
    lang: 'Ruby',
    site: 'https://jekyllrb.com',
    build: 'bundle install && bundle exec jekyll serve',
    detect: [/^_config\.ya?ml$/i],
    files: jekyllFiles,
  },
  {
    id: 'mdbook',
    label: 'mdBook',
    lang: 'Rust (single binary)',
    site: 'https://rust-lang.github.io/mdBook',
    build: 'mdbook serve',
    detect: [/^book\.toml$/i],
    files: mdbookFiles,
  },
  {
    id: 'antora',
    label: 'Antora (AsciiDoc)',
    lang: 'Node.js',
    site: 'https://antora.org',
    build: 'npx antora antora-playbook.yml',
    detect: [/^antora-playbook\.ya?ml$/i, /^antora\.ya?ml$/i],
    files: antoraFiles,
  },
  {
    id: 'docsify',
    label: 'Docsify (zero-build)',
    lang: 'None — static, served as-is',
    site: 'https://docsify.js.org',
    build: 'npx docsify-cli serve docs',
    // Docsify has no config file; its tell is the docs/_sidebar.md nav. A bare docs/.nojekyll is
    // NOT a signal — that's a generic GitHub Pages marker any static setup may carry.
    detect: [/^docs\/_sidebar\.md$/i],
    files: docsifyFiles,
  },
  // Detected-but-not-scaffolded: recognized so we don't double-provision, but we don't generate
  // configs for them (their setup is idiomatic to bespoke toolchains we'd rather not guess at).
  {
    id: 'vitepress',
    label: 'VitePress',
    lang: 'Node.js',
    site: 'https://vitepress.dev',
    detect: [/(^|\/)\.vitepress\/config\.(js|ts|mjs|mts)$/i],
  },
  {
    id: 'starlight',
    label: 'Astro Starlight',
    lang: 'Node.js',
    site: 'https://starlight.astro.build',
    // An astro.config alone is just an Astro site; Starlight additionally keeps its docs under
    // src/content/docs/. Both signals must be present (see `requiresAll`).
    detect: [/^astro\.config\.(mjs|js|ts)$/i],
    requiresAll: [/^src\/content\/docs\//i],
  },
  {
    id: 'gitbook',
    label: 'GitBook',
    lang: 'Hosted / Node.js',
    site: 'https://gitbook.com',
    detect: [/^\.gitbook\.ya?ml$/i, /^book\.json$/i],
  },
  {
    id: 'readthedocs',
    label: 'Read the Docs (hosting)',
    lang: 'Hosting config',
    site: 'https://readthedocs.org',
    detect: [/^\.readthedocs\.ya?ml$/i, /^readthedocs\.ya?ml$/i],
  },
];

const byId = Object.fromEntries(PLATFORMS.map((p) => [p.id, p]));
export function platformSpec(id) { return byId[id] || null; }

// Every platform we can scaffold, for `mari platform list` and usage strings.
export function scaffoldablePlatforms() { return PLATFORMS.filter((p) => typeof p.files === 'function'); }

// Given repo-relative file paths, return the platforms already present — one entry per matched
// platform with the concrete paths that triggered it. Paths are normalized to forward slashes so
// callers can pass native paths on any OS.
export function detectPlatforms(paths) {
  const norm = (Array.isArray(paths) ? paths : []).map((p) => String(p).replace(/\\/g, '/').replace(/^\.\//, ''));
  const out = [];
  for (const p of PLATFORMS) {
    const matched = norm.filter((path) => p.detect.some((re) => re.test(path)));
    if (!matched.length) continue;
    // `requiresAll`: every listed pattern must also match SOME path (conjunctive corroboration
    // for weak signature files, e.g. Starlight = astro.config + src/content/docs/).
    if (p.requiresAll && !p.requiresAll.every((re) => norm.some((path) => re.test(path)))) continue;
    out.push({ id: p.id, label: p.label, matched });
  }
  return out;
}

// Build the file set for a fresh platform. `opts.name` names the site/project (default "Docs").
// Returns { id, label, build, files: [{ path, content }] } or null for an unknown /
// non-scaffoldable id.
export function scaffoldPlatform(id, opts = {}) {
  const p = byId[id];
  if (!p || typeof p.files !== 'function') return null;
  const name = (opts.name && String(opts.name).trim()) || 'Docs';
  const files = p.files({ name });
  return { id: p.id, label: p.label, build: p.build, files };
}

// ─── Scaffold templates ─────────────────────────────────────────────────────────────────────
// Each returns a minimal-but-valid site: the generator's config plus a landing page (and any
// nav/index file the tool requires to build). Content is starter prose the user replaces, not a
// full docs set — the point is a working `serve` on first run.

function mkdocsFiles({ name }) {
  return [
    { path: 'mkdocs.yml', content: `site_name: ${name}\ntheme:\n  name: material\nnav:\n  - Home: index.md\n` },
    { path: 'docs/index.md', content: `# ${name}\n\nWelcome. This site is built with [MkDocs](https://www.mkdocs.org) and the Material theme.\n\nEdit \`docs/index.md\` and add pages under \`docs/\`, then list them in \`mkdocs.yml\` under \`nav\`.\n` },
  ];
}

function docusaurusFiles({ name }) {
  const config = `// @ts-check
/** @type {import('@docusaurus/types').Config} */
const config = {
  title: ${JSON.stringify(name)},
  favicon: 'img/favicon.ico',
  url: 'https://example.com',
  baseUrl: '/',
  onBrokenLinks: 'warn',
  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({ docs: { routeBasePath: '/', sidebarPath: './sidebars.js' }, blog: false }),
    ],
  ],
};

module.exports = config;
`;
  return [
    { path: 'docusaurus.config.js', content: config },
    { path: 'sidebars.js', content: `// @ts-check\n/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */\nmodule.exports = { docs: [{ type: 'autogenerated', dirName: '.' }] };\n` },
    { path: 'docs/intro.md', content: `---\nslug: /\ntitle: Introduction\n---\n\n# ${name}\n\nWelcome. This site is built with [Docusaurus](https://docusaurus.io).\n\nRun \`npm install\` then \`npm run start\`. Add Markdown files under \`docs/\`.\n` },
  ];
}

function sphinxFiles({ name }) {
  const conf = `# Sphinx configuration. See https://www.sphinx-doc.org/en/master/usage/configuration.html
project = ${JSON.stringify(name)}
extensions = ["myst_parser"]
source_suffix = {".rst": "restructuredtext", ".md": "markdown"}
html_theme = "furo"
exclude_patterns = ["_build"]
`;
  const index = `# ${name}

Welcome. This site is built with [Sphinx](https://www.sphinx-doc.org) and MyST Markdown.

\`\`\`{toctree}
:maxdepth: 2
:caption: Contents
\`\`\`

Install and build:

\`\`\`
pip install sphinx myst-parser furo
sphinx-build -b html docs docs/_build
\`\`\`
`;
  return [
    { path: 'docs/conf.py', content: conf },
    { path: 'docs/index.md', content: index },
  ];
}

function hugoFiles({ name }) {
  return [
    { path: 'hugo.toml', content: `baseURL = "https://example.com/"\nlanguageCode = "en-us"\ntitle = ${JSON.stringify(name)}\n` },
    { path: 'content/_index.md', content: `---\ntitle: "${name}"\n---\n\nWelcome. This site is built with [Hugo](https://gohugo.io).\n\nRun \`hugo server\`. Add pages under \`content/\`. You will also want a theme — see https://themes.gohugo.io.\n` },
    { path: 'archetypes/default.md', content: `---\ntitle: "{{ replace .Name \"-\" \" \" | title }}"\ndate: {{ .Date }}\ndraft: true\n---\n` },
  ];
}

function jekyllFiles({ name }) {
  return [
    { path: '_config.yml', content: `title: ${name}\ndescription: >-\n  Documentation for ${name}.\ntheme: minima\n` },
    { path: 'index.md', content: `---\nlayout: home\ntitle: ${name}\n---\n\nWelcome. This site is built with [Jekyll](https://jekyllrb.com) and publishes on GitHub Pages.\n\nRun \`bundle exec jekyll serve\`. Add Markdown pages with front matter.\n` },
    { path: 'Gemfile', content: `source "https://rubygems.org"\ngem "jekyll"\ngem "minima"\n` },
  ];
}

function mdbookFiles({ name }) {
  return [
    { path: 'book.toml', content: `[book]\ntitle = ${JSON.stringify(name)}\nsrc = "src"\nlanguage = "en"\n` },
    { path: 'src/SUMMARY.md', content: `# Summary\n\n- [Introduction](./introduction.md)\n` },
    { path: 'src/introduction.md', content: `# ${name}\n\nWelcome. This site is built with [mdBook](https://rust-lang.github.io/mdBook).\n\nRun \`mdbook serve\`. Add chapters in \`src/\` and list them in \`src/SUMMARY.md\`.\n` },
  ];
}

function antoraFiles({ name }) {
  const playbook = `site:
  title: ${name}
  start_page: docs::index.adoc
content:
  sources:
    - url: .
      branches: HEAD
      start_path: docs
ui:
  bundle:
    url: https://gitlab.com/antora/antora-ui-default/-/jobs/artifacts/HEAD/raw/build/ui-bundle.zip?job=bundle-stable
    snapshot: true
`;
  return [
    { path: 'antora-playbook.yml', content: playbook },
    { path: 'docs/antora.yml', content: `name: docs\ntitle: ${name}\nversion: ~\nnav:\n  - modules/ROOT/nav.adoc\n` },
    { path: 'docs/modules/ROOT/nav.adoc', content: `* xref:index.adoc[Introduction]\n` },
    { path: 'docs/modules/ROOT/pages/index.adoc', content: `= ${name}\n\nWelcome. This site is built with https://antora.org[Antora] from AsciiDoc.\n\nRun \`npx antora antora-playbook.yml\`. Add pages under \`docs/modules/ROOT/pages/\`.\n` },
  ];
}

function docsifyFiles({ name }) {
  const index = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${name}</title>
  <link rel="stylesheet" href="//cdn.jsdelivr.net/npm/docsify@4/lib/themes/vue.css" />
</head>
<body>
  <div id="app"></div>
  <script>
    window.$docsify = { name: ${JSON.stringify(name)}, loadSidebar: true };
  </script>
  <script src="//cdn.jsdelivr.net/npm/docsify@4"></script>
</body>
</html>
`;
  return [
    { path: 'docs/index.html', content: index },
    { path: 'docs/README.md', content: `# ${name}\n\nWelcome. This site is built with [Docsify](https://docsify.js.org) — no build step.\n\nServe it with \`npx docsify-cli serve docs\`. Add Markdown files under \`docs/\` and link them in \`_sidebar.md\`.\n` },
    { path: 'docs/_sidebar.md', content: `- [Home](/)\n` },
    { path: 'docs/.nojekyll', content: `` },
  ];
}
