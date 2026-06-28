# Mari — Build TODO

Design-first plan for Mari: a design system for text that strips AI slop and enforces
house style, delivered as one skill + provider hooks + a standalone deterministic CLI.
Direct counterpart to [Impeccable](https://impeccable.style) (frontend design → prose).

**Scope (updated):** detection is **layered by model size, not "rules vs. AI."**
1. **Deterministic** (regex / wordlist / density / structural) — instant, no download. Most rules.
2. **Default local models** — small encoders that run on any CPU (no GPU/API): GLiNER slop-span
   extraction, a BERT/DeBERTa NLI/fact-checker, an AI-likelihood gauge, perplexity. These are
   NOT opt-in — they're part of the default detector ([`04-ml-layer.md`](04-ml-layer.md)).
3. **Generative (opt-in)** — a small Qwen for attention-based grounding (Lookback Lens) and LLM
   claim decomposition ([`05-grounding.md`](05-grounding.md)). The only heavy tier.
All local-first, no API key. `--no-models` runs pure-deterministic for offline/locked-down use.
Readability scores (Flesch-Kincaid) are deliberately **not** core — opt-in, plain-pack only.

## Design docs

1. [`01-skills.md`](01-skills.md) — the `Mari` skill: setup, context files, registers,
   routing, and all commands + management commands. Marks the **core (MVP)** subset.
2. [`02-detector-rules.md`](02-detector-rules.md) — the AI-slop + clarity detector rules
   (Families A & B): id, category, detection method, severity, bad→good fixture, source.
3. [`03-research.md`](03-research.md) — the verified, cited research dossier: empirical
   AI-vocabulary numbers, the AI-writing taxonomy, Microsoft/Google rule packs + master
   word-swap map, prior-art license matrix, and readability / passive-voice / plain-language /
   inclusive-language specs. (ML-detection and grounding research live in 04 and 05.)
4. [`04-ml-layer.md`](04-ml-layer.md) — the model layer: classifiers, GLiNER span
   extraction, perplexity/burstiness; what runs where; local-first stack; honesty caveats.
5. [`05-grounding.md`](05-grounding.md) — the facts/grounding feature: user-supplied
   `FACTS.md`, claim extraction, NLI entailment, and Qwen attention-based grounding
   (Lookback-Lens style) for hallucination & contradiction detection.
6. [`06-rule-packs.md`](06-rule-packs.md) — the full data-driven rule packs mined from the
   research (Families C–F): Microsoft & Google mechanical rules, the master word-swap map,
   inclusive-language categories, punctuation/formatting tells, and citation/reference tells.
7. [`07-hooks-claude.md`](07-hooks-claude.md) — hook orchestration for **Claude Code**: the
   `PostToolUse` binding, the `settings.local.json` manifest, the stdin/stdout (never-break-
   the-turn) contract, file filtering, the deterministic-only latency budget, and the
   on/off/ignore lifecycle.
8. [`08-mvp.md`](08-mvp.md) — the **MVP definition**: the narrowest shippable slice
   (deterministic detector + 8 core skill commands + Claude Code hook, single Microsoft pack,
   offline, no models), the build order, success criteria, and what's explicitly cut and why.

## Architecture (mirror impeccable)

```
cli/
  bin/cli.js                      # install | update | link | detect | ignores | pin
  engine/
    registry/rules.mjs            # the rule registry (Families A–F; see 02 + 06)
    rules/checks.mjs              # deterministic detection implementations
    engines/
      text/detect-text.mjs        # plaintext / piped input
      markdown/detect-md.mjs      # markdown-aware (headings, lists, links, code fences)
      source/detect-strings.mjs   # string literals + comments in code
    ml/                           # optional model layer (04-ml-layer.md) — lazy-loaded
      classifier.mjs              # ONNX AI-likelihood + GLiNER span extraction
      perplexity.mjs              # local GPT-2 perplexity + burstiness
      grounding.mjs               # Qwen attention grounding + NLI (05-grounding.md)
    shared/
      tokenize.mjs                # sentence/word/heading segmentation
      readability.mjs             # Flesch-Kincaid, syllables, sentence stats
      density.mjs                 # per-1k-word / per-N-sentence scorers
      lexicons.mjs                # wordlists (slop tiers, buzzwords, weasel, inclusive)
      style-guides.mjs            # microsoft | google | ap | chicago | plain rule packs
      inline-ignores.mjs          # <!-- Mari-disable rule: reason -->
    findings.mjs                  # finding shape, JSON output, severity sort
skill/
  SKILL.src.md                    # the skill (setup + routing + guidance)
  reference/<command>.md          # one per command
  reference/register-*.md         # docs | marketing | editorial | microcopy
  scripts/
    context.mjs                   # prints PRODUCT.md + STYLE.md or NO_PRODUCT_MD
    context-signals.mjs           # menu signals (git changes, last critique, etc.)
    detect.mjs                    # bundled detector wrapper (no npx, no network)
    hook.mjs / hook-before-edit.mjs / hook-lib.mjs
    pin.mjs
plugin/ , .claude/ , .cursor/ ... # built provider payloads (per-harness)
```

Context files (parallel to impeccable's PRODUCT.md + DESIGN.md):
- **PRODUCT.md** — audience, register, voice, anti-references, banned words.
- **STYLE.md** — house style: base style guide, terminology glossary, formatting rules,
  approved/forbidden phrasings, reading-grade ceiling. Read by every command + the detector
  (`detector.styleGuide`, terminology consistency, banned-word lists).
- **FACTS.md** — user-supplied ground-truth facts/claims the grounding layer checks against
  (05-grounding.md). Editable by hand or via `npx Mari facts add "…"`.

## Milestones

- [x] **M0 — Detector core.** Tokenizer + density helpers + lexicons + registry + the
      deterministic rules (02 + 06) + `mari detect` (text/markdown) + JSON + inline ignores +
      a fixture pair per rule. Pure deterministic; no models yet. **Done — 90 rules across
      Families A–F (incl. Microsoft + Google packs), 180 fixture assertions + integration tests.**
- [x] **M1 — Skill core.** `SKILL.src.md` + setup/context + routing + core commands
      (`init`, `document`, `deslop`, `tighten`, `clarify`, `critique`, `audit`, `polish`).
      **Done — skill + 8 command references + 4 register references + `context.mjs`/`detect.mjs`.**
- [x] **M2 — Hooks + install.** hook + provider manifests + `mari install/update`
      across claude/cursor/codex/copilot, hook ignore management, `pin`/`unpin`.
      **Done** — Claude post-edit (live), Cursor pre-write (blocking) hook, Codex + Copilot
      manifests, `--providers`/`--force`, `pin`/`unpin`. (Cursor/Codex/Copilot manifest schemas
      are best-effort and may need per-provider tweaks once tested in those harnesses.)
- [x] **M3 — Default local models + full rule packs.** Real local inference via a **Python ML
      sidecar** (`ml/mari_ml.py`, torch + transformers + gliner; spoken to over JSON lines so models
      load once). All three models run for real: **NLI** (`cross-encoder/nli-deberta-v3-xsmall`)
      for grounding, **Qwen3.5-0.8B** perplexity → machine-likelihood (`--models` blends it into the
      §18 slop score), and **GLiNER** (`gliner_small-v2.1`) zero-shot slop spans deduped against the
      rules (`ml-slop-span`; zero-shot recall on abstract labels is low by design, needs fine-tuning).
      Plus the model-free `uniform-cadence` burstiness signal (§9.4) and Families C–F (91 rules).
      Opt-in via `--models`/`MARI_MODELS=1`; the default detector + editor hook stay instant and
      Python-free. `npm run test:models` runs real inference (no stubs anywhere).
- [x] **M4 — Grounding & facts.** `FACTS.md` + `facts`/`factcheck` + Tier 0–3 grounding.
      **Tier 0** (deterministic): typed-span extraction (number/money/percent/year/date/entity) +
      overlap retrieval → `number-date-mismatch`/`contradicts-fact`/`unsupported-claim`.
      **Tier 3** (`--models`): real NLI entailment (`factcheckNLI`) catches *semantic*
      contradictions with no number mismatch (verified: "requires API key" vs "no API key" → 99%
      contradiction). `mari factcheck [--source] [--models]`, `mari facts add/list`.
      Tier 4 (Lookback-Lens attention grounding, Qwen) remains the one advanced opt-in (M5).
- [ ] **M5 — Generative tier (opt-in).** Qwen attention grounding (Lookback Lens, Tier 4) +
      optional LLM atomic-claim decomposition. The only heavy, opt-in part.
- [ ] **Optional readability.** Flesch-Kincaid only in the `plain` pack for regulated registers.
- [x] **Large-repo hardening** (stress-tested on Apache Flink 844 docs, hermes-agent 1.4k docs,
      gbrain 350 docs; ~2–3s each). Mask HTML comments / Hugo+Liquid shortcodes / YAML+TOML front
      matter / inline HTML; skip predominantly non-Latin docs (CJK) **and localized translations by
      filename + directory locale** (`README.es.md`, `i18n/zh-Hans/`, `content.zh`, `pt-BR/`); skip
      non-prose data files (fixtures, dumps), **generated/boilerplate files** (CHANGELOG, HISTORY,
      LICENSE, NOTICE, `llms.txt` — walk only, explicit lint still works), and **vendored
      third-party trees** (`3rdparty/`, `vendor/`, `third_party/`); table-aware number/spacing
      rules; big tech-acronym + callout allowlist; spaced em-dash flagged once per doc; `overused-word`
      capped at warn; dropped "hit" from violent-tech-metaphor (cache hit is standard); `--summary`
      mode. Flink FPs −51%, hermes errors 131→14, gbrain advisory −33% — all remaining errors are
      legit meta-doc examples. All regression-tested (35 integration checks).

## Resolved by round-2 research (see [03-research.md](03-research.md))

- **Oxford comma + contractions:** Microsoft and Google *agree* (both require the serial comma,
  both encourage common contractions). Encode as shared rules, default on — not per-pack.
- **Sentence case headings, second person, active voice, present tense, no "please", singular
  they:** both guides agree → shared rules.
- **Genuine MS↔Google divergences** (per-pack rules): `terminate`, `via`, `easy/simple/just`,
  heading gerunds, exclamation points, number spell-out, "you can". Default base guide `microsoft`.
- **ML is allowed and welcome** (scope updated). The deterministic core still runs standalone;
  ML adds a fuzzy layer (04) and a grounding layer (05). The "Hard cases" in 02 now have *two*
  paths: the deterministic approximation (always on) and an ML upgrade (opt-in, better recall).

## Open questions

- `live` mode for prose: editor-selection iteration vs browser. Defer to M3; likely
  CLI/stdin + editor selection rather than a browser session.
- Candidate extra rules from the prior-art gap analysis (03-research.md §4): dead-link checking,
  `a/an` indefinite-article, redundant-acronym ("ATM machine"). Decide in M4.
