# Mari — MVP definition

The smallest thing that is a **complete, useful product on its own** — shippable, not a demo.
Pulled from the milestones (`README.md` M0–M2), the `[core]` commands (`01-skills.md`), and
the deterministic rule families (`02`, `06`). Everything here is **deterministic — no models,
no grounding, no network.** Those are real, deliberate cuts (see §6), not omissions.

> **The MVP in one line:** a deterministic AI-slop + house-style detector you can run as a CLI
> (`npx mari detect`), drive through one skill (`/mari` with the core editing commands), and
> wire into Claude Code as a post-edit hook — all on any CPU, offline, no API key.

This maps to the pitch's own claim: *"The core alone is a complete, useful product. The other
layers are sharpening."* (PITCH §3).

---

## 1. What's in

Three surfaces over one deterministic engine.

### 1.1 The detector (M0) — the foundation
- **Engine:** tokenizer (words/sentences/headings/lists/links/code-fences), density +
  burstiness helpers, lexicons, the rule registry, and the deterministic check implementations.
- **Inputs:** file, directory tree, and `--stdin`. **Markdown-aware** (`detect-md.mjs`) and
  **plaintext** (`detect-text.mjs`). Source-file string-literal linting is **out** of MVP.
- **Rules — the high-signal deterministic subset** (full set is M3):
  - **Family A (AI-slop tells)** — the signature value: `overused-word`, `marketing-buzzword`,
    `cliche-opener`, `filler-phrase`, `manufactured-contrast`, `conclusion-restate`,
    `vague-attribution`, `despite-challenges-closer`, `significance-boilerplate`,
    `em-dash-overuse`, `emoji-decoration`, `bold-lead-in-list`, `assistant-meta`, `sycophancy`,
    `smart-quotes`, `unicode-artifact`, `hedge-overuse`.
  - **Family B (clarity & concision)** — `passive-voice`, `long-sentence`, `wordy-phrase`,
    `complex-word`, `nominalization`, `weasel-word`, `redundant-pair`, `repeated-word`,
    `there-is-expletive`.
  - **Family C (style) — Microsoft pack only**, shared rules: `sentence-case-heading`,
    `heading-end-punctuation`, `serial-comma`, `use-contractions`, `second-person`,
    `word-swap` (the avoid→use map).
  - **Family D (inclusive) — the near-zero-FP core:** `gendered-language`, `ableist-language`,
    `vague-link-text`, `skipped-heading`.
- **Output:** human-readable (grouped by family, bad→good fix) **and** `--json` for CI.
- **Suppression:** `.mari/config.json` (`ignoreRules`/`ignoreFiles`/`ignoreValues`) + inline
  `<!-- mari-disable <id>: reason -->` (whole-file / `-line` / `-next-line`).
- **CI gate:** exit non-zero on any `error`; `--strict` promotes `warn`.
- **Every MVP rule ships with a fixture pair** (sloppy input + clean rewrite) and cites its
  source. No rule lands without one.

### 1.2 The skill (M1) — `/mari`
- `SKILL.src.md` with the setup phase (load `PRODUCT.md`/`STYLE.md` → route to `init` if
  missing → read a representative file → load the register reference → load the base style guide).
- **Routing:** no-arg context menu (runs the detector, leads with 2–3 pointed picks) · first-word
  command match · intent map · general pass.
- **The 8 `[core]` commands only:**
  `init`, `document`, `audit`, `deslop`, `tighten`, `clarify`, `critique`, `polish`.
- **Context files:** `init` writes `PRODUCT.md`, offers `STYLE.md`. `FACTS.md` is **out** (no
  grounding in MVP).

### 1.3 The Claude Code hook (M2) — see `07-hooks-claude.md`
- `PostToolUse` on `Edit|Write|MultiEdit`, deterministic-core-only, post-edit findings injected
  as turn context. **Claude Code is the only hook provider in MVP** — Cursor/Codex/Copilot are
  M2-plus.
- `npx mari install` / `update` wires the `.claude/settings.local.json` manifest (preserving
  unrelated entries) and the skill payload.
- `/mari hooks <on|off|status|ignore-*|reset>` and `/mari pin <command>`.

### 1.4 Config
- One base style guide: **`microsoft`** (the default). Other packs are M3.
- `.mari/config.json` + `.mari/config.local.json`: `detector.styleGuide`, ignores, `hook.*`.

---

## 2. The build order

1. **M0 — detector core.** Tokenizer → density/lexicons → registry → the §1.1 rules → `mari
   detect` (text + markdown) → JSON → inline ignores → a fixture per rule. *Ship this alone; it's
   already a useful CLI linter.*
2. **M1 — skill core.** `SKILL.src.md` + setup/context + routing → `init`/`document` (context
   files first) → `audit` (thin detector wrapper, fastest value) → `deslop` (signature) →
   `tighten`/`clarify` → `critique`/`polish`.
3. **M2 — Claude hook + install.** `hook.mjs` + `hook-lib.mjs` → `.claude` manifest in
   `install`/`update` → `hooks` management → `pin`.

Each step is independently useful: M0 is a standalone linter, M0+M1 is an agent editing toolkit,
M0+M1+M2 is the self-linting loop.

---

## 3. Success criteria (definition of done)

- `npx mari detect README.md` flags real AI-slop on a known-sloppy fixture and stays quiet on a
  clean human-written file (low false-positive rate on the inclusive/assistant-meta rules).
- `npx mari detect --json .` exits non-zero on `error` findings — usable as a CI gate today.
- `/mari init` writes a usable `PRODUCT.md`; `/mari deslop <file>` rewrites slop while preserving
  meaning and the project's voice; `/mari audit` groups every finding with a fix.
- After `npx mari install` on Claude Code, editing a `.md` file surfaces Mari findings in the
  same turn, and the hook **never breaks the turn** (clean/error/timeout all exit 0).
- Every shipped rule has a passing fixture pair.
- Runs with **no network and no API key** end to end.

---

## 4. Surfaces & non-goals at a glance

| Surface | MVP | Later |
|---------|-----|-------|
| CLI `detect` | ✅ text + markdown, JSON, ignores | source string literals (M3), `--check-links` (M4) |
| Skill commands | ✅ 8 core | 13 more (`draft`, `outline`, `sharpen`, `voice`, `live`, …) — M3 |
| Hook providers | ✅ Claude Code | Cursor (pre-write), Codex, Copilot — M2+ |
| Style packs | ✅ microsoft | google / ap / chicago / plain — M3 |
| Models | ❌ none | GLiNER spans, NLI, perplexity — M3 (default, CPU) |
| Grounding / `FACTS.md` | ❌ none | typed-span → NLI → Lookback Lens — M4/M5 |
| Readability score | ❌ none | opt-in `plain` pack only — M3 |

---

## 5. Explicitly OUT of MVP (and why)

- **All models** (GLiNER, NLI, perplexity, the AI-likelihood gauge). The deterministic core is
  self-sufficient and instant; models add a download + load cost and a fuzzier failure surface.
  Deferred to **M3** as the *default* (not opt-in) layer.
- **Grounding & `FACTS.md`** (the differentiator, but heavier). Needs claim extraction + NLI.
  Deferred to **M4–M5**.
- **Non-Microsoft style packs**, **registers beyond the default**, the **13 non-core commands**,
  **source-file string linting**, **`live` editor mode**, **other hook providers**, and
  **readability scoring**. All real, all sharpening — none required for the core loop.

The line is drawn at **deterministic, offline, single-pack, Claude-only** — the narrowest slice
that still strips slop, enforces a real style guide, and self-lints as the agent writes.

---

## 6. Risks for the MVP

- **False positives on human prose** — the inclusive and `assistant-meta` rules must be
  near-zero-FP, and density rules must never fire on a single hit. Mitigated by the
  negative-signal discount (contractions/slang/first-person) and per-document density gates.
- **Hook UX** — surfacing too many findings floods the turn. Cap at top-N and drop `advisory`
  in the hook path if needed (open question in `07-hooks-claude.md` §11).
- **Voice preservation in `deslop`** — rewriting must not flatten a project's real voice; the
  setup phase reading a representative file is the guard, and it must actually be enforced.
