# Mari — Skills design

The `Mari` skill mirrors impeccable: **one user-invocable skill** with sub-commands,
loaded references per command, and a setup phase that reads project context. Below is the
skill spec, the routing logic, and every command's flow. Commands marked **[core]** ship in
M1; the rest are M3.

---

## Skill frontmatter (`SKILL.src.md`)

```yaml
name: Mari
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
  - Bash(npx Mari *)
license: Apache 2.0
```

---

## Setup (runs before any command, mirrors impeccable)

1. Run `node {{scripts_path}}/context.mjs` once per session (or `--target <path>` for a
   specific file). It prints **PRODUCT.md** + **STYLE.md** as markdown, or reports
   `NO_PRODUCT_MD`. If missing → stop and run `init` first. Honor an `UPDATE_AVAILABLE`
   directive non-blockingly.
2. If a sub-command was invoked, read `reference/<command>.md` next (non-optional).
3. Familiarize with existing writing: read at least one representative file (a README, a
   docs page, existing copy) to learn the project's real voice before changing it. Don't
   impose a generic voice when the project already has one.
4. Read the matching **register reference** (non-optional — skipping it produces generic
   edits). Pick by first match: task cue → surface in focus → `register` in PRODUCT.md.
   - `reference/register-docs.md` — technical docs, API docs, READMEs, guides.
   - `reference/register-marketing.md` — landing copy, announcements, campaigns.
   - `reference/register-editorial.md` — blog posts, essays, long-form.
   - `reference/register-microcopy.md` — UI strings, errors, empty states, buttons.
5. Load the project's **base style guide** from STYLE.md (`microsoft` default). The register
   reference + style guide together define the bar; the detector enforces the mechanical
   subset.

### Context files written by `init`

- **PRODUCT.md** — `register`, audience, voice (3-word personality), anti-references
  (what NOT to sound like), banned words, reading-grade target.
- **STYLE.md** — base style guide; terminology glossary (preferred term + forbidden
  variants, feeds `terminology-consistency`); formatting rules (headings case, lists,
  emphasis, oxford comma, numbers); approved/forbidden phrasings; voice do/don't examples.

---

## Routing rules (mirror impeccable)

1. **No argument** → context-aware menu. Run `context-signals.mjs`; if `scan.targets`
   non-empty, run `detect.mjs --json <targets>` once and fold hits into 2–3 pointed picks
   (many buzzword/cliché hits → `deslop`; long-sentence/reading-grade hits → `tighten`;
   passive/jargon → `clarify`; inclusive/link/heading hits → `audit`). Then the full menu.
   Never auto-run a command.
2. **First word matches a command** (or `pin`/`unpin`/`hooks`) → load its reference, run it;
   the rest of the line is the target.
3. **First word doesn't match but intent maps** ("make this punchier" → `sharpen`, "cut this
   down" → `tighten`, "fix the error messages" → `clarify`) → load that reference.
4. **No clear match** → general editing pass using setup + register + the full line as
   context.

---

## Commands

Categories mirror impeccable: Build · Evaluate · Refine · Enhance · Fix · Iterate.
Each command's reference file defines its flow. "Leans on" = detector rules the command
should run first (via `detect.mjs`) to ground its edits in concrete findings.

### Build

#### `init` **[core]**
One-time setup. Detect register (ask: docs / marketing / editorial / microcopy) and base
style guide (Microsoft / Google / AP / Chicago / plain). Sample existing files to infer
current voice. Write PRODUCT.md; offer STYLE.md. Offer to install the hook. Recommend next
commands. This is the blocker `context.mjs` routes to on `NO_PRODUCT_MD`.

#### `document` **[core]**
Reverse of init: read a corpus of the project's *good* existing writing and generate
STYLE.md (voice, terminology glossary, formatting conventions) from observed patterns. Use
when a project has strong writing but no documented style.

#### `draft [topic]`
Outline → write end-to-end in the project voice. Runs `outline` internally if no structure
exists, drafts, then self-runs `deslop` + `tighten` before presenting. Leans on: full registry.

#### `outline [topic]`
Plan structure, argument, and section cadence before writing. Output an annotated outline,
not prose. Guards against the uniform "intro / 3 sections / conclusion" template (see
`section-parallelism`, `conclusion-restate`).

#### `glossary [target]`
Extract recurring terms and approved phrasings from a target into STYLE.md's glossary,
resolving inconsistent variants to one canonical term. Feeds `terminology-consistency`.

### Evaluate

#### `critique [target]` **[core]**
Editorial review — judgment, not mechanics. Assess argument/structure, clarity, voice
fidelity (vs PRODUCT.md), and reader experience. Produce a scored snapshot (stored like
impeccable's critique storage) that `polish` reads as its backlog. Leans on: runs the full
detector first so the prose-level critique sits on top of mechanical findings.

#### `audit [target]` **[core]**
Mechanical quality pass: runs the detector and reports every finding grouped by family
(slop / clarity / style-guide / inclusive-accessible), with bad→good fixes. This is the
human-facing front end of `npx Mari detect`. Leans on: **all rules**.

### Refine

#### `polish [target]` **[core]**
Final pre-publish pass: resolve the latest `critique` snapshot + all detector findings, align
to STYLE.md, verify nothing regressed. Leans on: all rules.

#### `deslop [target]` **[core]** — *signature command*
Strip AI tells and rewrite in human voice: overused vocabulary, marketing buzzwords, cliché
openers, manufactured contrast, conclusion-restate, vague attribution, em-dash overuse,
emoji decoration, bold-lead-in lists, assistant meta-phrases, sycophancy, transition
scaffolding, listicle reflex. Rewrite — don't just delete — preserving meaning and the
project's voice. Leans on: Family A (all 26) + `wordy-phrase`, `complex-word`.

#### `sharpen [target]`
Make timid, hedged, passive prose direct and confident. Cut hedges, convert passive→active,
replace nominalizations with verbs, commit to claims. Leans on: `hedge-overuse`,
`passive-voice`, `nominalization`, `weasel-word`, `there-is-expletive`.

#### `soften [target]`
Opposite failure: tone down hype, overclaiming, and exclamatory enthusiasm. Replace
superlatives and puffery with specific, verifiable statements. Leans on: `promotional-puffery`,
`marketing-buzzword`, `exclamation-overuse`, `manufactured-contrast`.

#### `tighten [target]` **[core]**
Cut wordiness, redundancy, and filler without losing meaning. Apply concision swaps, kill
expletive constructions, merge or split for rhythm, drop redundant pairs. Leans on:
`wordy-phrase`, `complex-word`, `redundant-pair`, `filler-phrase`, `long-sentence`,
`adverb-overuse`, `there-is-expletive`.

#### `harden [target]`
Edge-case copy: error messages, empty states, loading/confirmation microcopy, i18n length
budgets, truncation, plurals/zero states. Register-microcopy is mandatory. Leans on:
`vague-link-text`, `terminology-consistency`, microcopy register checks.

### Enhance

#### `voice [target]`
Inject the project's brand voice and personality into flat, generic copy (the "could be any
product" problem). Anchored to PRODUCT.md voice + anti-references. Leans on: slop family
(remove generic) then voice injection.

#### `cadence [target]`
Fix sentence rhythm: break up monotone sentence lengths, vary structure, fix choppy or
run-on passages. Leans on: `long-sentence`, sentence-length-variance signal, `tricolon-overuse`.

#### `format [target]`
Fix document structure: heading hierarchy and case, list vs prose decisions, emphasis
discipline, code formatting, link text. Leans on: `sentence-case-heading`, `skipped-heading`,
`excessive-bold`, `bold-lead-in-list`, `listicle-reflex`, `vague-link-text`.

#### `delight [target]`
Add memorable, human touches — a sharp opening line, a concrete example, a well-placed
specific detail — without tipping into cute or slop. Restraint-first.

### Fix

#### `clarify [target]` **[core]**
Rewrite unclear/confusing copy: define jargon, resolve ambiguity, convert passive→active,
add missing context, fix the error-message formula (what happened / why / how to fix).
Leans on: `passive-voice`, `undefined-acronym`, `complex-word`, `nominalization`,
`vague-link-text`.

#### `adapt [target]`
Adapt a piece for a different channel: docs → release note, long-form → social, prose → UI
microcopy, formal → email. Re-pick register; rewrite length/tone/structure to fit.

#### `localize [target]`
Prepare for translation and global English: simplify idioms, expand contractions where
needed, separate variables from sentences, flag length-budget risks (German +30%), avoid
culture-bound references. Leans on: `wordy-phrase`, idiom checks, `terminology-consistency`.

### Iterate

#### `live`
In-place iteration: select a sentence/paragraph in the editor (or pipe via stdin), generate
N alternatives at different intensities (tighter / bolder / quieter), apply the chosen one.
Prose analog of impeccable's live variant mode. M3.

---

## Management commands

- `pin <command>` / `unpin <command>` — create/remove `/<command>` shortcuts across all
  installed harness dirs. Script: `pin.mjs`. **[core]** (`pin` only for M2)
- `hooks <on|off|status|ignore-rule|ignore-file|ignore-value|reset>` — manage the editorial
  hook and detector ignores. Reference: `reference/hooks.md`. **[core]** (M2)

---

## Core (MVP) skill set — build order

1. `init` + `document` (context files exist before anything else is useful)
2. `audit` (thin wrapper over the detector — fastest to ship, immediate value)
3. `deslop` (the signature command, the reason the product exists)
4. `tighten`, `clarify` (highest-frequency editing verbs)
5. `critique` + `polish` (the evaluate→refine loop)
6. Management: `hooks`, `pin`

Everything else (`draft`, `outline`, `glossary`, `sharpen`, `soften`, `harden`, `voice`,
`cadence`, `format`, `delight`, `adapt`, `localize`, `live`) is M3, layered on the same
setup + detector foundation.
