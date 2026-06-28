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

1. **Load context.** Run `node skill/scripts/context.mjs`. It prints `PRODUCT.md` (+ `STYLE.md`,
   `FACTS.md`) or `NO_PRODUCT_MD`. If `NO_PRODUCT_MD` and the user asked for anything other than
   `init`, run **`init`** first, then resume.
2. **Load the command reference.** If a sub-command was named, read `skill/reference/<command>.md`
   — that's the authoritative flow.
3. **Read the existing writing.** Sample at least one representative file so edits match the
   project's real voice — never impose a generic voice on a project that already has one.
4. **Load the register reference** (non-optional). Pick by first match: task cue → surface in
   focus → `register` in `PRODUCT.md`: `skill/reference/register-{docs,marketing,editorial,microcopy}.md`.
5. **Run the detector** on the target (`node skill/scripts/detect.mjs <target>`, or
   `node cli/bin/cli.js detect <target>`) and let its findings drive the edit.

## Routing

- **No argument** → run the detector over the changed/target files, then surface the 2–3
  highest-value commands (many buzzword/cliché hits → `deslop`; long-sentence hits → `tighten`;
  passive/jargon → `clarify`; inclusive/heading/link hits → `audit`). Never auto-edit.
- **First word is a command** (`init`, `document`, `draft`, `outline`, `glossary`, `audit`,
  `critique`, `deslop`, `tighten`, `clarify`, `polish`, `sharpen`, `soften`, `harden`, `voice`,
  `cadence`, `format`, `delight`, `adapt`, `localize`, `live`) → load `skill/reference/<command>.md`
  and run it; the rest of the line is the target.
- **Intent maps to a command** ("make this punchier" → `sharpen`, "cut this down" → `tighten`,
  "fix the error copy" → `clarify`, "tone down the hype" → `soften`) → run that command.
- **No clear match** → a general editing pass using setup context + the detector findings.

## Commands

The eight below are the most-used; each has a `skill/reference/<command>.md` with its full flow.

### `init`
One-time setup. Ask the user their **register** (docs / marketing / editorial / microcopy) and
**base style guide** (default Microsoft). Sample existing files to infer current voice. Write
`PRODUCT.md` (audience, register, voice in 3 words, anti-references, banned words). Offer to
create `STYLE.md` and to install the editor hook (`node cli/bin/cli.js install`). Then recommend
next commands.

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

- **Build** — `draft` (outline then write a piece end-to-end), `outline` (plan structure before
  prose), `glossary` (harvest approved terms into `STYLE.md`).
- **Refine** — `sharpen` (make hedged prose direct), `soften` (tone down hype), `harden`
  (edge-case copy: errors, empty states, microcopy, i18n).
- **Enhance** — `voice` (inject brand voice into flat copy), `cadence` (fix sentence rhythm),
  `format` (headings, lists, emphasis, links), `delight` (add restrained human touches).
- **Fix / channel** — `adapt` (rework for a different channel), `localize` (prepare for
  translation and global English).
- **Iterate** — `live` (generate alternatives for a selected span at different intensities;
  also `node cli/bin/cli.js live` over stdin).

## Management

- `node cli/bin/cli.js install` — wire the Claude Code post-edit hook for this project.
- `node cli/bin/cli.js hooks status` — show hook + ignore state.
- `node cli/bin/cli.js ignores add-rule|add-file|add-value …` — manage detector ignores.
- Inline waiver in any file: `<!-- mari-disable <rule-id>: reason -->`
  (`-line` / `-next-line` variants scope to one line).

## Always

- The detector is deterministic and never claims a document "is AI-written." It points at spans
  worth rewriting. Treat findings as leads, not verdicts — `advisory` especially.
- Preserve the author's meaning and voice. De-slopping is rewriting, not deletion.
