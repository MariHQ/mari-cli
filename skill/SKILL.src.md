---
name: mari
description: >
  Use when the user wants to write, rewrite, edit, critique, audit, polish, tighten,
  clarify, or de-slop prose: documentation, README files, release notes, marketing copy,
  blog posts, UX microcopy, error messages, emails, or any text. Covers AI-slop removal
  (buzzwords, clichés, cadence tells, em-dash overuse), clarity and concision, voice and
  tone, structure and formatting, readability, inclusive language, and house-style
  conformance (Microsoft, Google, AP, Chicago, plain language). Not for code logic or
  non-text tasks.
argument-hint: "[command] [target]"
user-invocable: true
allowed-tools:
  - Bash(node cli/bin/cli.js *)
  - Bash(npx mari *)
  - Read
  - Edit
license: Apache-2.0
---

# Mari — a design system for text

Mari strips AI slop and enforces house style. It pairs a **deterministic detector** (run it
with `node cli/bin/cli.js detect <target>`) with editorial commands. The detector is the source
of ground truth — run it first so every edit is grounded in concrete findings, not vibes.

## Setup (run before any command)

> **Deterministic commands skip this setup.** `detect`, `audit`, `asset`, and `i18n` are
> mechanical CLI checks — they need no `PRODUCT.md`, register, or voice context. If the first
> word is one of these, run it directly (see Routing) and skip steps 1–6. Setup applies to the
> prose-*editing* commands (`deslop`, `tighten`, `clarify`, …).

1. **Load context.** Run `node skill/scripts/context.mjs`. It prints `PRODUCT.md` (+ `STYLE.md`,
   `FACTS.md`) or `NO_PRODUCT_MD`. If `NO_PRODUCT_MD` and the user asked for a prose-editing
   command, run **`init`** first, then resume.
2. **Load the command reference.** If a sub-command was named, read `skill/reference/<command>.md`
   — that's the authoritative flow.
3. **Read the existing writing.** Sample at least one representative file so edits match the
   project's real voice — never impose a generic voice on a project that already has one.
4. **Load the register reference** (non-optional). Pick by first match: task cue → surface in
   focus → `register` in `PRODUCT.md`: `skill/reference/register-{docs,marketing,editorial,microcopy}.md`.
5. **Run the detector** on the target (`node skill/scripts/detect.mjs <target>`, or
   `node cli/bin/cli.js detect <target>`) and let its findings drive the edit.
6. **Check for a developer asset.** Run `node cli/bin/cli.js asset detect <target>`. If it
   reports a type (runbook / ADR / postmortem / RFC, or a community doc: contributing /
   code-of-conduct / governance / security), load `skill/reference/asset-<type>.md`
   and run `node cli/bin/cli.js asset check <target>`. Apply that type's structure
   requirements, tone norms, and rubric on top of the register. This makes Mari handle these
   assets correctly by default. To create one, scaffold from best practice with
   `mari asset scaffold <type> "<title>"`.

## Routing

- **No argument** → run the detector over the changed/target files, then surface the 2–3
  highest-value commands (many buzzword/cliché hits → `deslop`; long-sentence hits → `tighten`;
  passive/jargon → `clarify`; inclusive/heading/link hits → `audit`). Never auto-edit.
- **First word is a deterministic command** (`detect`, `audit`, `asset`, `i18n`, `platform`,
  `check`) → run the CLI directly, skipping the setup phase (no `PRODUCT.md` needed):
  - `check` → whole-project validation in one pass: internal links + anchors resolve, the
    platform nav agrees with the files on disk (missing targets, orphan pages), and the
    community-health files (README/LICENSE/CONTRIBUTING/CODE_OF_CONDUCT/SECURITY/CHANGELOG)
    exist and pass their structure checks. `node cli/bin/cli.js check` (`--strict` fails on
    warns — the CI/pre-commit gate). Add `--deep` for the opt-in attention passes over the
    public API surface: symbols the docs never engage (undocumented) and doc sentences that
    engage no symbol (stale/unanchored). ~3s per run — cap with `--limit N`; don't add
    `--deep` unprompted on big repos.
  - `surface [dir]` → print the extracted public API surface (JS/TS, Python, Go, Rust
    exports/pub/def/func with file:line). Deterministic and fast — this is the code
    inventory `docsite` documents against and `check --deep` validates against.
  - `explore "<question>" | <file>` → RAG search over the repo: top chunks (file:line +
    snippet) for a question, or what relates to a file. `node cli/bin/cli.js explore …`
    (`--k N` more hits, `--deep` attention rerank ~3s/hit, `--json`). First run embeds the
    whole repo into `.mari/assoc` (minutes on a big repo — warn the user); after that,
    queries are ~5s. Use it to locate the prose/code a task touches before editing.
  - `platform` → set up a docs-as-code site generator if the repo has none. Load
    `skill/reference/platform.md`. Run `node cli/bin/cli.js platform detect`. If nothing is set up,
    **ask the user which platform** (`platform list` shows the options). Then run
    `node cli/bin/cli.js platform scaffold <id> --name "<title>"`. The choice is a conversation; the
    CLI never prompts.
  - `asset detect|check|scaffold <file>` → `node cli/bin/cli.js asset <sub> <target>`
  - `i18n <file>` → list a doc's translations; `i18n conform <file|dir>` → check every translation
    shares the source's structure (`node cli/bin/cli.js i18n conform <target>`). "i8n" means i18n.
    This is deterministic and fast, so run it on a whole tree freely. The deeper **attention**
    pass (which prose a translation skipped) is opt-in and costs ~3s/doc. Add `--deep` only
    when asked. On a tree, cap it with `--limit N` (e.g. `i18n conform docs --deep --limit 5`)
    or target a single file. Don't run `--deep` across a large tree unprompted.
  - `detect`/`audit <file>` → run the detector and report.
  - `factcheck <file>` → check the doc's claims against `FACTS.md` (or `--source <file>`). Load
    `skill/reference/factcheck.md`. For the deep **atomic-claim** pass, YOU do the decomposition
    in-session (the CLI never calls a model or `claude` for it): emit the target sentences, split
    each into atomic claims, write them, and re-run with `--claims`. The reference has the flow.
- **First word is `docsite`** (or the user asks to "document the whole codebase" / "generate a
  docs site") → the end-to-end flow in `skill/reference/docsite.md`: survey the code, choose +
  scaffold a platform, design the information architecture (Diátaxis), fill every page from
  the code, add the community-health files, then validate with `check --strict`.
- **First word is an editing command** (`init`, `document`, `draft`, `outline`, `glossary`,
  `critique`, `deslop`, `tighten`, `clarify`, `polish`, `sharpen`, `soften`, `harden`, `voice`,
  `cadence`, `format`, `delight`, `adapt`, `localize`, `live`) → run the setup phase, load
  `skill/reference/<command>.md`, and run it; the rest of the line is the target.
- **Intent maps to a command** ("make this punchier" → `sharpen`, "cut this down" → `tighten`,
  "fix the error copy" → `clarify`, "tone down the hype" → `soften`, "are translations in sync?"
  → `i18n conform`) → run that command.
- **No clear match** → a general editing pass using setup context + the detector findings.

## Commands

The eight below are the most-used; each has a `skill/reference/<command>.md` with its full flow.

### `init`
One-time setup. Ask the user their **register** (docs / marketing / editorial / microcopy) and
**base style guide** (default Microsoft). Sample existing files to infer current voice. Write
`PRODUCT.md` (audience, register, voice in 3 words, anti-references, banned words). Offer to
create `STYLE.md` and to install the editor hook (`node cli/bin/cli.js install`). Run
`node cli/bin/cli.js rules discover` and propose any code↔docs rules it finds (plus ones you
infer) for the user to confirm. Then recommend next commands.

### `document`
Reverse of `init`: read the project's *good* existing writing and generate a `STYLE.md` (voice,
terminology glossary, formatting conventions) from the observed patterns.

### `audit [target]`
The human-facing front end of the detector. Run `node cli/bin/cli.js detect <target>` and report
every finding grouped by family (AI-slop / clarity / style / inclusive) with a bad→good fix for
each. Don't edit — this is the report.

### `deslop [target]` — *signature*
Strip AI tells and rewrite in human voice. Run the detector first; then rewrite (don't just
delete) the overused vocabulary, marketing buzzwords, cliché openers, manufactured contrast,
conclusion-restate, vague attribution, em-dash overuse, emoji decoration, bold-lead-in lists,
assistant meta-phrases, and sycophancy — preserving meaning and the project's voice.

### `tighten [target]`
Cut wordiness, redundancy, and filler. Apply the concision swaps (`wordy-phrase`, `complex-word`,
`redundant-pair`, `filler-phrase`), kill expletive constructions, split over-long sentences.

### `clarify [target]`
Rewrite unclear copy: define jargon, resolve ambiguity, convert passive→active, fix the
error-message formula (what happened / why / how to fix). Leans on `passive-voice`,
`complex-word`, `nominalization`, `there-is-expletive`, `vague-link-text`.

### `critique [target]`
Editorial judgment, not mechanics: assess argument/structure, clarity, voice fidelity (vs
`PRODUCT.md`), and reader experience. Run the detector first so the prose critique sits on top of
the mechanical findings. Produce a scored snapshot that `polish` can later resolve.

### `polish [target]`
Final pre-publish pass: resolve the latest `critique` plus all detector findings, align to
`STYLE.md`, and verify nothing regressed.

## More commands

Each has its own `skill/reference/<command>.md`; load it before running. Grouped by intent:

- **Build** — `docsite` (document an entire codebase: platform + architecture + every page +
  community files + validation, end to end), `draft` (outline then write a piece end-to-end),
  `outline` (plan structure before prose), `glossary` (harvest approved terms into `STYLE.md`).
- **Refine** — `sharpen` (make hedged prose direct), `soften` (tone down hype), `harden`
  (edge-case copy: errors, empty states, microcopy, i18n).
- **Enhance** — `voice` (inject brand voice into flat copy), `cadence` (fix sentence rhythm),
  `format` (headings, lists, emphasis, links), `delight` (add restrained human touches).
- **Fix / channel** — `adapt` (rework for a different channel), `localize` (prepare for
  translation and global English).
- **Iterate** — `live` (generate alternatives for a selected span at different intensities;
  also `node cli/bin/cli.js live` over stdin).
- **Verify** — `factcheck` (check a doc's claims against `FACTS.md`/a source; the deep
  `--decompose` tier has *you* split sentences into atomic claims in-session — see
  `skill/reference/factcheck.md`).

## Management

- `node cli/bin/cli.js install` — wire the Claude Code post-edit hook for this project.
- `node cli/bin/cli.js hooks status` — show hook + ignore state.
- `node cli/bin/cli.js ignores add-rule|add-file|add-value …` — manage detector ignores.
- `node cli/bin/cli.js rules add <name> --paths "<glob[,…]>" --notify "<message>" [--exclude "<glob>"]` —
  notify the agent when matching files are edited (e.g. update API docs when `src/api/**` changes);
  `rules discover` proposes some from the repo, `rules list` / `rules remove <name>` manage them.
  Fires on any edited file, not just markdown.
- Waive findings via `.mari/config.json` only (no inline in-file comments): `ignores add-rule`
  silences a rule, `add-file <glob>` skips whole files, `add-value <rule> <value>` allows a term.

## Always

- The detector is deterministic and never claims a document "is AI-written." It points at spans
  worth rewriting. Treat findings as leads, not verdicts — `advisory` especially.
- Preserve the author's meaning and voice. De-slopping is rewriting, not deletion.
