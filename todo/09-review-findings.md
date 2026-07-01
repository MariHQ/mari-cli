# Full-repo review findings (2026-07-01)

Four-area review (core CLI, rules engine, features/hooks, packaging/ML/native).
Checkboxes track fix status. File:line refs are as of commit b3f3cc9.

## A. Rules engine

- [x] A1 **bug** `rule-helpers.mjs:18-21` — `phraseList()` has no `\b` boundaries; ~25 rules match substrings: "fetch"→word-swap(etc), "information"→ms-wordiness(inform), "obviously"/"trivial"→latinism(via), "blamed"→ableist(lame), "adjust"→minimizing(just), "attends to"→hedge, "weekend results"→redundant-pair. Fix: boundary-wrap alternation; handle keys ending in punctuation (`e.g.`, `i.e.`) where trailing `\b` never matches — use `(?![A-Za-z0-9_])`-style guards.
- [x] A2 **bug** `rules.mjs:220-227` — passive-voice flags any "-en" word ("are even", "was seven", "is open"); `isPP` check is a tautology. Needs a non-participle stoplist (even, often, seven, open, ...).
- [x] A3 **bug** `rules.mjs:214,223` — `IRREGULAR_PP` is dead: regex only matches ed/en endings, so "was sent/made/put/run/found/held/kept/lost/met/read/told/thought" never flag. Add irregular alternation to the regex.
- [x] A4 **bug** `rules-vale.mjs:30,667` — ms/google-ampm lack trailing `(?![a-zA-Z])` guard (AP variant at :1059 has it): "5 amps", "2 amendments" flag.
- [x] A5 **bug** `rules-vale.mjs:224,786` — `door(?:m[ae]|wom[ae]n)` missing `n`: "doorman/doormen" never match. Also add "draftsman".
- [x] A6 **likely-bug** `rules-vale.mjs:196` — ms-foreign-abbrev matches bare `eg`/`ie` case-insensitively; "IE" (browser) flags. Require dotted forms or drop bare tokens.
- [x] A7 **likely-bug** `rules.mjs:20-27,205-206,266-267` — density rules fire on a single hit in short docs (contradicts header contract "none fire on a single match"). Require ≥2 hits.
- [x] A8 **likely-bug** `rules-extra.mjs:613-620` — indefinite-article never flags "an user"/"a hour" (the exception-list cases). Add the two missing branches.
- [x] A9 **bug** `rules-vale.mjs:1014,1036` — google-word-list `ajax→AJAX` case-insensitive: correct "AJAX" flags itself. Skip matches already equal to the replacement (any case-only map entries).
- [x] A10 **likely-bug** `rules-discover.mjs:30 vs :114` — scan() skips dotfiles except `.env.example`, but rule also looks for `.env.sample` (unreachable). Allow `.env.sample` in scan.
- [x] A11 **likely-bug** `grammar.mjs:86-94` — Harper spans are Unicode-scalar indices, consumed as UTF-16 offsets; astral chars (emoji) shift all subsequent positions. Convert scalar→UTF-16 offsets.
- [x] A12 **likely-bug** `rules-vale.mjs:338` — ms-adverb-hyphen has no exception list (google twin at :833 does): "family-owned", "early-stage", "supply-chain" flag. Share the exception list.
- [x] A13 **likely-bug** `rules-extra.mjs:199-201` — serial-comma flags "Yesterday, John and Mary arrived" (introductory clause, not a list). Tighten (require a second comma-separated item or exclude sentence-initial adverbials).
- [x] A14 **bug** `rules-extra.mjs:74-76` — superficial-ing-participle offset assumes `,\s+` is exactly 2 chars; wrong span on ",  x" or comma+newline. Use `h.m[0].indexOf(h.m[1])`.
- [x] A15 **likely-bug** `rules-extra.mjs:425-441` — acronym-case: `ACRO_CASE_STOP` omits us/jar/war/zip/tar/bin/pr/ram; "US ... us" flags the pronoun. Extend stoplist.
- [x] A16 **bug** `rules-vale.mjs:291-321` — heading-acronyms/heading-colons use `h.raw.indexOf(m[0])` per match → repeated hits all report the first occurrence's offset. Track via `m.index` + prefix delta.
- [x] A17 **likely-bug** `rules-extra.mjs:243-248` — terminology-consistency locates with plain `indexOf`, can land inside a longer word ("screenlogin"). Locate with the same `\b` regex used for verification.
- [x] A18 **improvement** duplicate/conflicting rules: GENDERED (lexicons:101) vs ms/google-gender-bias; "in order to" ×3; "e.g." ×2 per pack; "abort" ×2; tricolon vs serial-comma makes 3-item lists unwinnable. Dedup: suppress always-on twin when a pack rule covers the same token, or dedup at findings level by overlapping span.
- [x] A19 **improvement** `rules.mjs:317` — no-op nonsensical condition; delete.
- [x] A20 **improvement** `rules-extra.mjs:542` — dead `if (m[0] === 'Guy')` guard (regex can't produce it); fix or remove.
- [x] A21 **improvement** `rules-extra.mjs:580` — `FAM.E` undefined (families are A–D); emitted family disagrees with declared. Fix to a real family.
- [x] A22 **improvement** `rules-vale.mjs:402,886` — quote-punctuation inner class crosses newlines; exclude `\n`.
- [x] A23 **improvement** `rules-extra.mjs:583-588` — thematic-break-before-heading splits text twice per break inside the loop; hoist the split.
- [x] A24 **improvement** `rules-vale.mjs:958-964` — google-units-nbsp flags "the 60s", "3d rendering", "747s"; exempt decades/ordinal-ish and drop ambiguous single-letter units d/s/h/B.

## B. CLI core

- [x] B1 **bug** `readability.mjs:13` — `SYLL_EXCEPTIONS[w] != null` hits prototype props; "constructor"/"toString" → NaN grade. Use `Object.hasOwn`.
- [x] B2 **bug** `config.mjs:28-35` — `deepMerge` treats `null` as mergeable → `Object.keys(null)` throws when local config sets a key to null. Guard `b !== null`.
- [x] B3 **bug** `config.mjs:77-81` — `<!-- mari-disable -->` (waive all) unreachable: regex captures `--` as rule id. Fix regex so bare form yields `['*']`.
- [x] B4 **likely-bug** `index.mjs:135-142` — `walk()` statSync without try/catch, follows symlinks: broken symlink crashes, cycles recurse forever. Use lstat/withFileTypes + try/catch.
- [x] B5 **likely-bug** `index.mjs:103-104` — locale-dir regex misclassifies `no-op/`, `de-dup/`, `ml-api/`, `ar-core/` as translations (silently skipped). Require known locale codes (or at least a known-locale allowlist).
- [x] B6 **likely-bug** `config.mjs:37-49` — `globToRe`: `**/` can't match zero dirs (root README.md unmatched by `**/*.md`); space placeholder corrupts globs containing real spaces. Fix `**/` → `(?:[^/]+/)*` and use a non-space placeholder.
- [x] B7 **likely-bug** `cli.js:749-754` — `lineOfSpan` locates by first occurrence of the span's first word anywhere in file → wrong `≈L` for spans starting with common words. Locate the full normalized probe, not the first word.
- [x] B8 **likely-bug** `segment.mjs:23` — front-matter regex requires bare `\n`; CRLF files lint front matter as prose. Allow `\r?\n`.
- [x] B9 **likely-bug** `cli.js:519-527` — tightenSentence `\b`-wraps keys ending in punctuation (`e.g.`) which never match. Same guard fix as A1.
- [x] B10 **likely-bug** `score.mjs:29` — first-person regex misses sentence-initial `We/My/Our/Us` (case-sensitive). Match capitalized forms except bare `I`-ambiguity case it was avoiding (`i` lowercase only).
- [x] B11 **bug (packaging)** `cli.js:202,221` — `mari install` reads `skill/SKILL.src.md` from `process.cwd()`, not package root; crashes for npm-installed users. Resolve from package root (`HERE/../..`).
- [x] B12 **improvement** `cli.js:343-345` — `--reason` parsed/echoed but never persisted. Persist (ignoreReasons map) or remove from usage.
- [x] B13 **improvement** `cli.js:325,174` — `ensureMariDir()` runs before subcommand validation; typos leave empty `.mari/`. Validate first.
- [x] B14 **improvement (win32)** `config.mjs:48`, `index.mjs:66`, `cli.js:610` — `relative()` backslashes vs `/`-assuming globs/splits. Normalize to `/`.
- [x] B15 **improvement** dead code: `cli.js:27` `HERE` unused (use it for B11), duplicate `fileURLToPath` import, unused `uniq()` at :191, `segment.mjs:126` `imgStarts`, `cli.js:507` unreachable fallback, `cli.js:301` unused `cmd` param.
- [x] B16 **improvement** `cli.js:684` — `shortenPath` replaces HOME anywhere in string; anchor to prefix.
- [x] B17 **improvement** `findings.mjs:9-10` — unknown severity → NaN sort; default rank with `?? 3`.

## C. Feature modules & hooks

- [x] C1 **bug** `grounding.mjs:53,57` — typed-span dedup by substring `includes` drops standalone numbers ("5" vanishes near "50%") → missed contradictions. Dedup by offset ranges.
- [x] C2 **bug** `grounding.mjs:104-113` — ISO vs prose dates normalize differently → same date reported as error mismatch. Canonicalize dates to one form.
- [x] C3 **likely-bug** `assets.mjs:141` — broken regex-escape in `hasField` (never escapes); latent RegExp injection/throw. Use standard escape `[.*+?^${}()|[\]\\]`.
- [x] C4 **likely-bug** `hook-lib.mjs:56` — `editedFile` accepts only Claude tool names; Codex/Copilot hook paths silently no-op. Make provider-tolerant like `proposedEdit`.
- [x] C5 **likely-bug** `.cursor/hooks.json` — missing `"version": 1`; event `beforeEdit` doesn't exist in Cursor (use `afterFileEdit` or correct blocking event); response mixes Claude `continue:false` with Cursor `permission:'deny'`. Fix config + host-appropriate output.
- [x] C6 **likely-bug** `.github/hooks/Mari.json` — case mismatch with documented `mari.json` (breaks on Linux); all three hook configs use cwd-relative script paths (break when host cwd ≠ repo root). Rename lowercase; make paths robust.
- [x] C7 **likely-bug** `hook.mjs:52-55` — `emit` always writes Claude `PostToolUse` contract regardless of host. Select output shape per host.
- [x] C8 **likely-bug** `hook-lib.mjs:105-110` — `proposedEdit` lints fragments: line numbers index the fragment not the file; MultiEdit fragments joined with `\n` fabricate adjacency. Label line numbers as fragment-relative (or map via old file content) and lint fragments separately.
- [x] C9 **likely-bug** `detect-strings.mjs:84-93` — no regex-literal awareness; a quote inside `/["']/` opens a phantom string, code linted as prose. Track regex-literal contexts or bail conservatively.
- [x] C10 **likely-bug** `i18n.mjs:173` — `startsWith(root)` without separator; sibling dirs mismatch, files outside root get bogus joins. Use `path.relative` + `..` check.
- [x] C11 **improvement** `grounding.mjs:24-27` — entities() doesn't skip sentence-initial capitals ("The"→entity); implement the documented skip.
- [x] C12 **improvement** `hook-lib.mjs:86-88,116` — grammar findings appended unsorted then truncated from top; sort merged findings by severity/line before slicing.
- [x] C13 **improvement** `hook-before-edit.mjs:22` — `fp.replace(cwd + '/')` not anchored, `/`-only; use `path.relative`.
- [x] C14 **improvement** `assets.mjs:21` — bare `startsWith(a)` subsumes the guarded form; "Why not X?" matches alias `why`. Tighten to word-boundary starts.
- [x] C15 **improvement** `assets.mjs:82`, `i18n.mjs:191` — front-matter regexes require bare `\n`; allow `\r?\n` (same as B8).
- [x] C16 **improvement** `detect.mjs:18-28` — engine faults exit 1 like "findings present"; catch and exit 2 on faults.
- [x] C17 **improvement** `platforms.mjs:92,109` — `docs/.nojekyll` alone ⇒ Docsify, any `astro.config.*` ⇒ Starlight; require stronger signals.
- [x] C18 **improvement** `hook-lib.mjs:33,93`, `grounding.mjs:127` — duplicated PROSE set shadowing module-level; in-place sort of caller's array.

## D. Packaging, ML, native, hygiene

- [x] D1 **bug** `package.json` files array omits `native/` → `mari i18n coverage` broken in published package. Add `native/attn/dist` (bundle only, not sources) or document/gate the feature.
- [x] D2 **bug** `ml/requirements.txt` pins `transformers>=5.6` vs v4-era `torch_dtype=` in mari_ml.py and gliner 0.2.x (built on transformers 4.x). Align pins and use `dtype=`.
- [x] D3 **likely-bug** default perplexity model `Qwen/Qwen3.5-0.8B` (ml/mari_ml.py:23, cli/engine/ml/index.mjs:39) doesn't exist on HF. Pick a real default (e.g. Qwen/Qwen3-0.6B).
- [x] D4 **likely-bug** `package.json` — harper.js in both dependencies and optionalDependencies (optional wins; failures silently swallowed; ~18MB always downloaded contradicts "opt-in"). Decision: remove from dependencies; lazy dynamic import with clear install hint. **User requirement: no model/heavy downloads until first use.**
- [x] D5 **likely-bug** `package.json:17` — selftest references `fixtures/sloppy.md` not in files list. Ship fixtures or drop from published manifest.
- [x] D6 **likely-bug** `native/attn/mari_attn.cpp` — comment/README claim wrapper "forces --mari-coverage" but it forwards argv verbatim; `#define main` renames every `main` token. Fix docs or behavior.
- [x] D7 **likely-bug** `ml/mari_ml.py:121` — `math.exp(loss)` overflows to error on gibberish; clamp / return inf sentinel.
- [x] D8 **improvement** `.idea/` committed (leaks old name mari_impec); add to .gitignore, `git rm -r --cached`.
- [x] D9 **improvement** `native/attn/CMakeLists.txt` — hardcoded personal/macOS paths, `.dylib`-only, CACHE FORCE build type. Parameterize via env/options.
- [x] D10 **improvement** `cli/engine/ml/index.mjs:24-27` — python discovery only checks package-root `.venv/bin/python`; also check cwd `.venv` and Windows `Scripts/python.exe`.
- [x] D11 **improvement** `test/grammar.mjs:10-13` — exits 0 when harper.js missing (silent pass); print SKIP loudly.
- [x] D12 **improvement** `test/cases.mjs:168,258` — `second-person` defined twice, violating one-per-rule contract.
- [x] D13 **improvement** `package.json` test script chains with `&&`; first failure hides the rest. Run all, OR the exit codes.
- [x] D14 **improvement** `package-lock.json` has no resolved entries (deps never installed/locked); regenerate with `npm install` once dep set is final.

## Release checklist (after fixes)

- [x] `npm ci && npm test` green (all 8 suites, 2026-07-01)
- [x] `npm pack` (74 files, ~4 MB), tarball installed into a temp project: `mari install` wires claude/cursor/codex/copilot with package-rooted absolute script paths, `mari detect` correct, selftest works from installed package, zero deps downloaded at install
- [x] harper.js removed from deps (grammar prints `npm install harper.js` hint on first use); ML sidecar imports torch/transformers/gliner lazily inside task handlers; default model fixed to Qwen/Qwen3-0.6B
