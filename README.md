# Mari

Editorial guidance for AI writing agents. 1 skill, 22 commands, live in-editor iteration, and 171 deterministic detector rules for AI-generated prose.

> **Quick start:** From your project root, run `npx mari install`, then run `/mari init` inside your AI coding or writing tool. Full docs: [mari.style](https://mari.style).

## Why mari?

Microsoft's [Writing Style Guide](https://learn.microsoft.com/style-guide/welcome/) and the [Google developer documentation style guide](https://developers.google.com/style) set the bar for clear, human prose. Mari starts from there.

Every model trained on the same internet, then got RLHF'd toward the same register. Skip the guidance and you get the same handful of tells on every draft: *delve*, *tapestry*, *testament*, *underscore*; "In today's fast-paced world…"; "It's not just X — it's Y"; em-dashes everywhere; a tidy "In conclusion" that restates the intro; a bulleted list where a sentence would do. The vocabulary spike is measured, not vibes — *delve* and its cohort show large excess-frequency jumps in post-ChatGPT academic text ([Kobak et al., 2024](https://arxiv.org/abs/2406.07016); [Liang et al., 2024](https://arxiv.org/abs/2403.07183)).

mari is a **design system for text**. It adds:

- **One setup flow.** `/mari init` writes `PRODUCT.md` and offers `STYLE.md` and `FACTS.md`, so every later command knows the audience, register (docs / marketing / editorial / UX microcopy), voice, banned words, terminology, the base style guide you write to (Microsoft, Google, AP, Chicago, plain language), and your ground-truth facts.
- **22 commands.** A shared editorial vocabulary with your AI: `deslop`, `tighten`, `sharpen`, `clarify`, `critique`, `audit`, `polish`, `factcheck`, `docsite`, and more.
- **A detector that runs on any machine.** Deterministic rules (regex/wordlist/density/structural) plus small local encoder models (GLiNER slop-span extraction, a BERT/DeBERTa NLI checker). Both run on CPU: no GPU, no API key, weights cached once. A heavier **generative model is opt-in** for attention-based fact-grounding, and `--no-models` runs pure-deterministic for offline use.

## What's Included

### The Skill: mari

The skill installs as one command:

```bash
/mari <command> <target>
```

Start every new project with:

```bash
/mari init
```

`init` asks what register you're writing in (technical docs, product UI copy, marketing, or long-form editorial) and which base style guide governs the project, then writes editorial context that every later command reads.

### 22 Commands

All commands are accessed through `/mari`:

| Command | What it does |
|---------|--------------|
| `/mari docsite` | Document an entire codebase: choose a platform, derive the architecture, write every page, add community files, validate |
| `/mari draft` | Outline, then write a piece end-to-end in your voice |
| `/mari init` | One-time setup: gather voice context, write PRODUCT.md and STYLE.md, configure the hook, recommend next steps |
| `/mari document` | Generate a house STYLE.md from your existing writing |
| `/mari outline` | Plan structure and argument before writing a word |
| `/mari glossary` | Pull approved terms and phrasings into the style system |
| `/mari critique` | Editorial review: argument, structure, clarity, voice |
| `/mari audit` | Run mechanical checks (readability, grammar, inclusivity, link text) |
| `/mari polish` | Final copyedit and style-system alignment before publishing |
| `/mari deslop` | Strip the AI tells: buzzwords, clichés, cadence, em-dash overuse |
| `/mari sharpen` | Make timid, hedged prose direct and confident |
| `/mari soften` | Tone down hype and overclaiming |
| `/mari tighten` | Cut wordiness, redundancy, and filler |
| `/mari harden` | Edge-case copy: errors, empty states, microcopy, i18n |
| `/mari voice` | Inject brand voice and personality into flat copy |
| `/mari cadence` | Fix sentence rhythm, flow, and length variation |
| `/mari format` | Fix headings, lists, emphasis, and markdown structure |
| `/mari delight` | Add memorable, human touches |
| `/mari clarify` | Rewrite unclear or confusing copy |
| `/mari factcheck` | Check claims against your `FACTS.md` (or a `--source` doc); flag contradictions and unsupported claims |
| `/mari adapt` | Adapt a piece for a different channel (email, docs, social, UI) |
| `/mari localize` | Prepare copy for translation and global English |
| `/mari live` | In-place iteration: pick sentences in the editor, generate alternatives |

Use `/mari pin <command>` to create standalone shortcuts (e.g., `pin deslop` creates `/deslop`).

#### Usage Examples

```
/mari deslop README.md          # Strip AI tells from the readme
/mari critique docs/intro.md    # Editorial review of the intro
/mari tighten the changelog     # Cut the changelog down to essentials
/mari clarify the error copy    # Rewrite confusing error messages
```

Or use `/mari` directly with a description:
```
/mari rewrite this paragraph so it sounds like a person
```

### Anti-Patterns

The skill includes explicit guidance on the recognizable tells of machine prose to avoid:

- Don't reach for the AI vocabulary spike (*delve, tapestry, testament, underscore, leverage, seamless, robust, realm, multifaceted*)
- Don't open with "In today's fast-paced world…" or "In the ever-evolving landscape of…"
- Don't manufacture contrast ("It's not just X — it's Y", "not only… but…")
- Don't close with an "In conclusion" that restates the intro
- Don't attribute vaguely ("studies show", "experts say", "many believe") without a citation
- Don't carpet the page with em-dashes, bold lead-ins on every bullet, or a list where a sentence works
- Don't hedge by reflex ("it's important to note that", "it could be argued that")

## See It In Action

Visit [mari.style](https://mari.style#casestudies) to see before/after rewrites of real AI-generated drafts: documentation, release notes, marketing copy, and UI microcopy.

## Installation

Installing mari downloads **no models and no heavy artifacts** — the package has zero runtime dependencies. Optional layers (Harper grammar, the Python ML sidecar, GGUF attention models) are opt-in and fetch their weights only on first use.

### Option 1: CLI installer (Recommended)

From the root of your project, run:

```bash
npx mari install
```

This shows the harness folders it detected (for example `~/.claude`, `~/.codex`, or project-local `.cursor`), lets you keep the detected set or customize providers, then asks whether to install into the current project or globally. Use `--providers=claude,codex,cursor` and `--scope=project|global` to skip those choices in scripts. On Claude Code, Cursor, and Codex, it also installs the provider-native hook manifest for the current project. Works with Cursor, Claude Code, Gemini CLI, Codex CLI, and every other supported tool. Reload your harness afterward.

To refresh an existing install, run:

```bash
npx mari update
```

Codex users should open `/hooks` after install or update and approve the project hook when prompted. Codex tracks trust by hook definition, so updates that change `.codex/hooks.json` can require approval again.

## Usage

Once installed, every command runs through the single `/mari` skill:

```
/mari audit        # Find issues
/mari deslop       # Strip AI tells
/mari tighten      # Cut wordiness
/mari critique     # Full editorial review
```

Type `/mari` alone to see the full command list.

Most commands accept an optional argument to focus on a specific file or passage:

```
/mari deslop the introduction
/mari clarify the onboarding emails
```

If you reach for one command often, pin it with `/mari pin deslop` to get `/deslop` as a standalone shortcut.

**Note:** Codex uses skills here, not `/prompts:` commands. Open `/skills` or type `$mari`. Repo-local installs live in `.agents/skills/`; user-wide installs live in `~/.agents/skills/`. GitHub Copilot uses `.github/skills/`. Restart the tool if a newly installed skill does not appear.

## Editorial hook

On Claude Code, GitHub Copilot, Codex, and Cursor, `npx mari install` and `npx mari update` install a provider-native hook manifest along with the skill payload. The hook runs the Mari detector on direct edits to markdown files (`.md`, `.markdown`, `.mdx`, `.mdc`) and surfaces findings back into the agent flow. All four hosts surface findings after the edit (Cursor has no blocking pre-edit hook event, so it uses `afterFileEdit` like the others). Each manifest passes `--provider=claude|cursor|codex|copilot` to the hook script so the output matches the host's contract.

To keep the signal high, the hook surfaces only **error and warn** findings by default — advisories are the bulk of any file and would bury the actionable ones after a small edit. They stay available on demand via `mari audit`. Set `hook.minSeverity` in `.mari/config.json` (`error` | `warn` | `advisory`) to change the floor.

Installed hook surfaces:

- Claude Code: `.claude/settings.local.json` (gitignored, machine-local). A hook moved into the shared `settings.json` is honored in place.
- GitHub Copilot: `.github/hooks/mari.json` (committed, shared by the Copilot CLI and the cloud agent). The Copilot CLI activates it once the file is on the repository's default branch and the folder is trusted.
- Cursor: `.cursor/hooks.json` (`"version": 1`, `afterFileEdit`).
- Codex: `.codex/hooks.json` (`afterEdit`).

The installer writes each manifest command as `node "<mari package>/skill/scripts/hook.mjs" --provider=<host>` — an absolute path into the installed mari package, so the hook works regardless of the directory the host launches it from. (This repo's own committed manifests use repo-relative paths instead, since here the repo *is* the package.) Re-running `mari install` or `mari update` migrates entries written by older versions. Caveat: if you installed via `npx` rather than a project or global `npm install`, the absolute path points into the npx cache, which can be evicted — prefer `npm install -D mari` for durable hooks.

The installer preserves unrelated hook entries and settings. If a hook manifest is malformed, install/update aborts by default; rerun with `--force` to back up the malformed file as `.bak` and replace it.

On an interactive `install`/`update`, Mari explains the hook and offers to install it (default yes). Your choice is remembered per-developer in the gitignored `.mari/config.local.json`, so you are not asked again; `--no-hooks` skips it for that run without recording anything. Hook lifecycle settings live under the `hook` key of `.mari/config.json`; detector ignores live under `detector`, shared by `/mari hooks` and `npx mari detect`.

Manage the hook without editing config by hand: `mari hooks status | on | off | reset | ignore-rule <id> | ignore-file <glob> | ignore-value <rule> <value>`. `off` pauses linting while leaving the manifest wired; `reset` clears the ignores and the enabled flag.

### Rules — notify the agent on relevant edits

Beyond prose, the hook fires **your own rules on any edited file** — source, config, schemas — so a code change can remind the agent to do the follow-up work. The classic case: when the API surface changes, update the API docs. `mari init` proposes rules automatically (`mari rules discover` scans the repo for code↔docs couplings), or add them by hand:

```bash
mari rules add api-docs \
  --paths "src/api/**,openapi.yaml,**/*Controller.java" \
  --notify "This edit touches the API surface. If it changed endpoints, request/response shapes, status codes, or auth, update the API docs in docs/api/**." \
  --exclude "**/*.test.*"

mari rules discover          # propose rules from the repo's code↔docs layout
mari rules list
mari rules remove api-docs
```

When an edited file matches a rule's `paths` (and none of its `exclude`), the post-edit hook injects the rule's `notify` text into the turn, so the agent — which already has the diff in context — decides whether the change actually warrants the follow-up and does it. `paths` are globs over the repo-relative path: a folder (`src/api/**`), a pattern (`**/*Controller.java`), or a bare file name matched anywhere (`openapi.yaml`). Rules live under the `rules` key of `.mari/config.json` (edit by hand or use the command); the hook applies them to every edit regardless of file type, and a disabled hook (`mari hooks off`) suppresses them too.

Codex requires one platform step that mari cannot safely skip: open `/hooks` after install or update and approve the project hook.

Full hook docs: [mari.style/docs/hooks](https://mari.style/docs/hooks).

## CLI

Mari includes a standalone CLI for detecting AI slop and style issues without an AI harness:

```bash
npx mari detect docs/                   # scan a directory of prose
npx mari detect README.md               # scan a single file
npx mari detect --json .                # CI-friendly JSON output
npx mari detect --style=microsoft .     # pick the base style guide (microsoft|google|ap|chicago|plain)
npx mari detect --stdin < draft.txt     # scan piped text
npx mari detect --no-config docs/       # raw scan, ignoring project config/context
npx mari ignores list                   # show detector ignores
npx mari ignores add-file "vendor/**"
npx mari ignores add-value overused-word delve --reason "Quoting a source"
npx mari hooks off                      # pause the editor hook (config only; manifest stays wired)
npx mari hooks ignore-rule em-dash-overuse   # mute a rule for the hook; `mari hooks reset` clears it
npx mari live draft.md --n=3            # iterate one sentence: a tighter variant + its flags
```

`detect` reads **markdown** (`.md`, `.markdown`, `.mdx`, `.mdc`); directory scans skip everything else.

The detector catches **171 deterministic issues** across four families:

| Family | Rules | Examples |
|--------|------:|----------|
| **AI-slop tells** | 31 | overused vocabulary (*delve / meticulous / underscore*, weighted by measured over-use), hype intensifiers ("greatly", "crucial", "one of the most"), cliché openers, manufactured contrast ("not just X — it's Y"), the "despite challenges… continues to" closer, significance/legacy boilerplate, conclusion-that-restates, vague attribution, em-dash overuse, smart quotes in plaintext, emoji bullets, assistant meta-phrases ("I hope this helps"), bold-lead-in lists, a bold line used as a heading, tricolon density, transition/conversational scaffolding |
| **Clarity & concision** | 13 | passive voice, long sentences, wordy phrases ("in order to" → "to"), zombie nouns, adverb overuse, reading-grade ceiling, weasel words, undefined jargon |
| **Style, formatting & citations** | 110 | sentence-case headings, contractions, second person ("Users can" → "you"), "please"/latinism bans (Google), terminology consistency, inconsistent capitalization of a term ("Catalog Store" vs "catalog store"), acronym casing (ddl vs DDL) and plural (UDF's → UDFs), exclamation overuse, number/date/time/unit formatting, em-dash spacing, redundant acronyms, duplicate headings, code fences missing a language hint, placeholder/tracking-param citations — plus the full per-pack conformance sets (Microsoft / Google / AP / Chicago / plain) |
| **Inclusive & accessible language** | 17 | gendered defaults, ableist terms, person-first language, inclusive tech terms (allowlist/blocklist), non-inclusive idioms, vague link text ("click here"), bare URLs, skipped heading levels, missing alt text |

The base style guide selects which conformance rules fire. Mari ships full rule packs for the **Microsoft Writing Style Guide**, the **Google developer documentation style guide**, **AP**, **Chicago**, and **plainlanguage.gov**. The Microsoft and Google packs are a direct port of [Vale](https://vale.sh)'s official style packages — **96% of their deterministically-checkable rules** (the rest need a part-of-speech tagger or proper-noun detection, which a deterministic linter can't do reliably) — tuned for AI-generated drafts.

**Optional grammar + mechanics pass.** The conformance rules above are pure-deterministic. For real grammar — broken English, wrong articles, agreement, confusables — Mari can run an opt-in pass through [Harper](https://github.com/Automattic/harper), Automattic's Rust→WASM offline grammar checker. It runs entirely on-device (no API key, no network) and is markdown-aware (it skips code). It's **off by default** and high-precision: Mari keeps only Harper's "broken English" lint kinds (agreement, grammar, articles, confusables, redundancy) and drops its noisy ones (spelling, title-case headings, compound-splitting) that false-positive on technical docs. Enable per run with `mari detect --grammar`, or in the edit hook with `"hook": { "grammar": true }` so the agent can correct grammar in the same turn it edits. Harper is **not installed with mari** (its ~18&nbsp;MB WASM engine would otherwise download for everyone at install time); opt in with `npm install harper.js` in your project, and Mari picks it up automatically.

By default, `detect` respects the same `.mari/config.json` and `.mari/config.local.json` detector config as the hook: `detector.ignoreRules`, `detector.ignoreFiles`, `detector.ignoreValues`, and `detector.styleGuide`.

All waivers live in that JSON config — there are no inline in-file comments. Silence a rule with `mari ignores add-rule <id>`, skip whole files with `mari ignores add-file <glob>`, or allow a specific term with `mari ignores add-value <rule> <value>` (each writes `.mari/config.json`; `--no-config` bypasses them for a run).

Full detector docs: [mari.style/docs/detector](https://mari.style/docs/detector).

## Fact-checking & grounding

Style is only half the problem. The other half is confident, wrong claims. Add a `FACTS.md`
(by hand or with `npx mari facts add "…"`) and mari checks your prose against it:

```bash
npx mari facts add "mari's CLI is 'npx mari detect', not 'mari scan'."
npx mari factcheck README.md                  # check claims against FACTS.md
npx mari factcheck draft.md --source notes.md # check a summary against its source
npx mari factcheck draft.md --decompose       # split each sentence into atomic claims, check each
npx mari factcheck draft.md --source notes.md --ground=attention  # flag ungrounded spans (Lookback-Lens)
```

It runs cheapest-first: a deterministic pass aligns numbers, dates, and named entities between
your text and your facts (the wrong-number tell), then a small local NLI model (CPU, runs by
default) labels each claim **Supported / Contradicted / Unsupported** with the evidence line
attached. A contradiction is an error; an unsupported claim is advisory (absence isn't disproof).
Two **opt-in** generative tiers go deeper. `--decompose` breaks each sentence into atomic claims
so one bad clause in a true sentence is caught; the splitting is done by Claude in-session via the
`/mari` skill (the CLI never bundles a model or calls `claude` for it), and each atomic claim is
then checked by the local NLI model. `--ground=attention` runs an on-device Lookback-Lens pass
(Qwen3-0.6B, downloads once and caches) that flags spans the model never attended to your facts
for.

mari never claims a document "is AI-written." Detectors are biased, and that's not the goal.
It points at spans worth rewriting and claims worth verifying.

## Developer assets

Some documents have a job to do and an established shape to do it in. Mari recognizes four
developer-asset archetypes and applies the right handling automatically — so the agent editing
a runbook is held to runbook standards, not generic prose ones.

```bash
npx mari asset detect docs/adr/0007-use-postgres.md   # ADR (Architecture Decision Record) — score 10 [...]
npx mari asset check  runbooks/restart-api.md          # flag missing canonical sections (Rollback, Escalation…)
npx mari asset scaffold postmortem "Checkout outage"   # print a best-practice template
```

| Asset | Canonical sections checked | Convention |
|-------|----------------------------|------------|
| **ADR** | Status · Context · Decision · Consequences | Michael Nygard · [MADR](https://adr.github.io/madr/) |
| **Postmortem** | Summary · Impact · Timeline · Root cause · Action items · Lessons learned (+ **blameless** tone check) | [Google SRE](https://sre.google/sre-book/example-postmortem/) · PagerDuty · Atlassian |
| **Runbook** | Overview · Prerequisites · Steps · Rollback · Escalation | incident.io · AWS IDR |
| **RFC / design doc** | Summary · Motivation · Alternatives · Drawbacks (+ Non-goals) | [Rust RFC](https://github.com/rust-lang/rfcs/blob/master/0000-template.md) · Oxide RFD |

Detection is deterministic and tolerant — it combines directory (`docs/adr/`, `runbooks/`),
filename (`adr-`, `*-runbook.md`), front-matter `status:`, and a quorum of distinctive headings,
so an ordinary README or skill doc is never misclassified. Structure checks **warn** (a draft
legitimately lacks sections); they're surfaced by `mari asset check` and the skill, not the edit
hook. When you work on a detected asset, the `/mari` skill loads the matching review reference
(`skill/reference/asset-<type>.md`) and applies its structure, tone, and rubric on top of the
register.

## Docs-as-code platforms

Good writing needs somewhere to live. When a repo has no documentation-site generator yet, the
`/mari platform` command sets one up — it detects whether docs-as-code is already wired up, and if
not, asks which platform you want and scaffolds a minimal, working site.

```bash
npx mari platform detect                          # is a docs-site generator already wired up?
npx mari platform list                            # compare the platforms Mari can scaffold
npx mari platform scaffold mkdocs --name "Acme"   # write a minimal, valid MkDocs site
```

| Platform | Runtime | Config written |
|----------|---------|----------------|
| **MkDocs** (Material) | Python | `mkdocs.yml` + `docs/index.md` |
| **Docusaurus** | Node.js | `docusaurus.config.js` + `sidebars.js` + `docs/intro.md` |
| **Sphinx** (MyST) | Python | `docs/conf.py` + `docs/index.md` |
| **Hugo** | Go | `hugo.toml` + `content/_index.md` + archetype |
| **Jekyll** | Ruby | `_config.yml` + `index.md` + `Gemfile` |
| **mdBook** | Rust | `book.toml` + `src/SUMMARY.md` + intro |
| **Antora** | Node.js | `antora-playbook.yml` + AsciiDoc module |
| **Docsify** | none (static) | `docs/index.html` + `docs/README.md` + sidebar |

Detection recognizes more platforms than it scaffolds (VitePress, Astro Starlight, GitBook, Read
the Docs), so it won't propose standing up a second site next to one that already exists. The CLI
is deterministic and never prompts — it refuses to overwrite existing files and re-checks detection
before scaffolding (override with `--force`). The **choice** of platform happens in the `/mari`
skill flow (`skill/reference/platform.md`), which recommends a fit for the repo's stack but lets
you decide.

## Document a whole codebase (`/mari docsite`)

`platform` gives docs somewhere to live; `docsite` fills the house. One command takes a repo from
"no docs" to a complete documentation website: survey the code, choose and scaffold a platform,
derive the information architecture from the actual CLI/API/config surface ([Diátaxis](https://diataxis.fr):
tutorial, how-to, reference, explanation), write every page grounded in the source, generate the
community-health files (CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, license and changelog prompts),
and validate the result until it's clean. The flow lives in `skill/reference/docsite.md`; you
approve the platform and the page tree before anything gets filled.

The validation gate is deterministic and yours to keep:

```bash
npx mari check             # validate the whole project in one pass
npx mari check --strict    # nonzero exit on warns — the CI / pre-commit docs gate
```

`mari check` verifies, with no network and no model: every internal link and anchor resolves; the
platform nav agrees with the files on disk (entries that point nowhere, pages orphaned outside the
nav); the community-health files exist; and each one's structure passes its `asset check`. Pair it
with the platform's own `build --strict` in CI and docs rot gets caught at commit time.

### Is the whole API documented? Is anything stale?

Structure checks can't tell you whether the docs *cover the code*. The attention layer can — the
same native primitive that powers i18n coverage and factcheck grounding, pointed at the API:

```bash
npx mari surface                 # the extracted public surface: every export/pub/def/func, file:line
npx mari check --deep            # + attention: undocumented symbols, stale doc passages
```

`mari surface` deterministically extracts the public symbols (JS/TS, Python, Go, Rust) with their
signatures. `check --deep` then runs two attention passes over that rendered surface: **coverage**
(surface as context, docs as query) flags the symbols no doc prose ever engages — the undocumented
API; **grounding** (docs as query) flags doc sentences that engage none of the surface — prose
that's stale after a rename or was never anchored to the code. Both are leads for review, not
verdicts, and both run fully locally (~3s per doc; needs the shipped attention binary + a small
GGUF model, and skips gracefully without them).

## Explore a repo (RAG + attention)

The same index that powers `mari assoc` answers questions. `explore` embeds your query, searches
the on-disk Lance vector store, and prints the top chunks with `file:line` and a snippet — the
index builds itself on first use:

```bash
npx mari explore "how does the post-edit hook decide what to show the agent"
npx mari explore docs/quickstart.md        # what in the repo relates to this file?
npx mari explore docs/quickstart.md --deep # …and how strongly, by attention (RAG pre-filters)
npx mari explore "…" --k 20 --json         # more hits, machine-readable
```

A file query is represented by the mean of its chunk embeddings — the whole document, not just
its head — and with `--deep` the full document becomes the attention context for each candidate
chunk. The attention window sizes itself to the inputs (override the cap with `MARI_ATTN_CTX`;
default 32768 tokens), so long docs are no longer truncated at a fixed 4k.

`--focus` goes one step further: for each top-matched *file*, it widens from the matched chunk to
the whole file as attention context and reports where the query's attention mass concentrates —
the top regions with `≈L` line anchors, scored as a fraction of that file's peak. RAG chooses the
documents cheaply; attention localizes within them. Slow by design (`--limit N` files,
`--threshold t` for the bar), and worth it when you want *the exact passage*, not just the file.

Embeddings retrieve (purpose-built `Qwen3-Embedding-0.6B`, local, CPU-friendly); `--deep` then
scores each hit with the native attention model — how much of the chunk *genuinely engages* the
question — which separates true matches from vocabulary coincidence. Everything runs locally.

The index maintains itself from git history: it stamps the commit it was built at, and every
query diffs that against the current tree (`git diff` for committed drift, `git status` for the
working tree, an existence check for untracked deletions). Deleted files have their vectors and
associations revoked; changed files are re-embedded — and only if their content hash actually
moved, so a dirty-but-identical file costs nothing. Non-git repos fall back to a full hash scan.
`mari assoc update` runs the same sync explicitly; `mari explore --build` forces a full rebuild,
and a changed embedding model triggers one automatically (mixed vector spaces are never reused).

## Localized docs (i18n)

When a doc has translations, editing the source should remind you the translations are now
stale. Mari maps a markdown file to its localized siblings across the common layouts, and the
editor hook surfaces them after a source edit:

```text
🌐 1 localized version(s) may be stale after this edit — update to match:
  zh      docs/content.zh/docs/deployment/elastic_scaling.md
```

```bash
npx mari i18n README.md          # list a doc's translations (or, from a translation, its source)
npx mari i18n conform README.md  # check every translation shares the source's structure
```

### Conform — keep translations structurally in sync

Mari can't translate, but it can hold every translation to the source's **language-invariant
structure** — the way translations actually drift is a section gets added to the source and
never to the translations. `mari i18n conform <file>` compares the source against each
translation and reports:

```text
Conforming source docs/content/docs/deployment/elastic_scaling.md against 1 translation(s):

  zh      docs/content.zh/docs/deployment/elastic_scaling.md
    ⚠ headings: 12 in source, 10 here — a section is missing or extra.
    · 3 code block(s) differ from the source (code shouldn't be translated).
```

- **Heading count / nesting** mismatch → `warn` (a missing or extra section — the main drift).
- **Code-block count** mismatch → `warn`; differing code content → advisory (code isn't translated).
- **External links / images** present in the source but not the translation → advisory.

It checks structure, not prose, so different languages don't trip it. Use `--strict` to exit
non-zero on structural drift (a CI gate that keeps localized docs from silently falling behind).

### Coverage — find passages the translation skipped (attention, opt-in)

`conform` catches structural drift; it can't tell whether a *paragraph* was actually translated
or quietly dropped. For that, Mari ships a native attention extractor (`native/attn`, a vendored
copy of the [attention](https://github.com/henneberger/attention) tool with a Mari entry point).
It runs a multilingual model with the **source as context and the translation as query**, then
measures how much attention each source span receives. A span the translation barely attends to
is content it likely avoided:

```bash
export MARI_ATTN_MODEL=~/models/qwen3.5-0.8b.gguf   # any multilingual GGUF
mari i18n coverage docs/setup.md docs/setup.zh.md
#   ⚠ 13% coverage  (≈L5)  All network traffic is encrypted with TLS. Store your API keys…
```

Unlike sentence-embedding alignment (which assumes 1:1 passages and breaks when a translation
merges/splits/reorders), attention **coverage** asks the robust question "did the translation
engage this source content at all?" — so reordering doesn't trip it. It's opt-in: build the
binary once (needs a local llama.cpp), then point `MARI_ATTN_MODEL` at a GGUF.

The bundle ships prebuilt — users never compile; only the GGUF model is supplied at runtime.

**It's opt-in, woven into existing commands** (it costs ~3s/doc, so it never runs unless asked):

```bash
mari i18n conform docs                       # fast structural sweep (0.5s) — the default
mari i18n conform docs --deep --limit 5 # + attention on the 5 worst-drifted docs
mari i18n conform setup.md --deep       # localize skipped prose in one doc
mari factcheck draft.md --source facts.md --deep   # flag sentences disconnected from the facts
```

- `i18n conform --deep` adds prose-coverage to its structural check — so a doc with matching
  headings but an *untranslated paragraph* (which structure can't catch) is still flagged. In the
  sweep it runs only on the drifted docs, **worst-drift first**, capped by `--limit N` (default 10).
- `factcheck --deep` adds **grounding** — doc as query, facts/`--source` as context — flagging
  sentences **disconnected** from the facts (fabricated/off-topic; an Eiffel-Tower sentence against
  software facts drops to ~20%). It complements NLI factchecking, which catches *on-topic
  contradictions* attention can't. `factcheck doc.md --source impl.cpp` is the doc↔code check.

The model auto-resolves from `MARI_ATTN_MODEL`, `.mari/config.json` (`"attn":{"model":…}`), or a
GGUF discovered in `~/.mari/models` / `~/attn/cpp/models` (preferring Qwen3.5-0.8B). `--deep`
**errors** (exit 2) if no binary/model is available, so it never silently falls back.

Built-in layouts (any subset via `i18n.layouts`):

| Layout | Source ↔ translation | Seen in |
|--------|----------------------|---------|
| `suffix` | `README.md` ↔ `README.es.md` / `README.zh-CN.md` | most repos |
| `hugo` | `content/…` ↔ `content.zh/…` | Flink |
| `docusaurus` | `docs/x.md` ↔ `i18n/<locale>/docusaurus-plugin-content-docs/current/x.md` | Docusaurus sites |
| `dir` | `docs/en/x.md` ↔ `docs/fr/x.md` | locale-dir repos |

It's **expandable** — add org-specific layouts in `.mari/config.json` without code:

```json
{ "i18n": {
    "defaultLocale": "en",
    "notifyOn": "source",
    "mirrors": [{ "source": "src/locales/en", "translation": "src/locales/{locale}" }]
} }
```

Only translations that actually exist on disk are reported (it never invents files), and the
note fires on **source** edits by default (`notifyOn: "any"` also nudges on translation edits).

## Supported Tools

- [Cursor](https://cursor.com)
- [Claude Code](https://claude.ai/code)
- [GitHub Copilot](https://github.com/features/copilot)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [Codex CLI](https://github.com/openai/codex)
- [OpenCode](https://opencode.ai)
- [Pi](https://pi.dev)
- [Kiro](https://kiro.dev)
- [Trae](https://trae.ai)
- [Rovo Dev](https://www.atlassian.com/software/rovo)
- [Qoder](https://qoder.com)

## Community & Ecosystem

Join the community and ecosystem conversations:

- GitHub Discussions: file bugs, request rules, and help newcomers.
- mari on npm: grab the CLI, follow releases, and star the package.
- Follow along for release notes, sample lint reports, and new-rule highlights.

## Contributing

See [DEVELOP.md](docs/DEVELOP.md) for contributor guidelines and build instructions. New detector rules should ship with fixture pairs (a sloppy input and its clean rewrite) and cite the empirical source or style-guide section they enforce.

## License

Apache 2.0. See [LICENSE](LICENSE).
