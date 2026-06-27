# Limpid — Build TODO

Design-first plan for Limpid: a design system for text that strips AI slop and enforces
house style, delivered as one skill + provider hooks + a standalone deterministic CLI.
Direct counterpart to [Impeccable](https://impeccable.style) (frontend design → prose).

**Scope (updated):** detection is **layered, not deterministic-only**.
1. A fast **deterministic core** (regex / wordlist / density / structural) — default, no model,
   no key, instant, explainable. Most rules live here.
2. An **ML layer** (BERT/RoBERTa/DeBERTa classifiers, GLiNER span extraction, perplexity/
   burstiness) for the fuzzy patterns regex can't reach — see [`04-ml-layer.md`](04-ml-layer.md).
3. A **grounding / factuality layer** — checks claims against a user-supplied fact base and uses
   a small local model (Qwen) for attention-based grounding — see [`05-grounding.md`](05-grounding.md).
ML is local-first (ONNX / transformers.js, no API key); the deterministic core always runs
without it. We use whatever gets the job done.

## Design docs

1. [`01-skills.md`](01-skills.md) — the `limpid` skill: setup, context files, registers,
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
      inline-ignores.mjs          # <!-- limpid-disable rule: reason -->
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
  (05-grounding.md). Editable by hand or via `npx limpid facts add "…"`.

## Milestones

- [ ] **M0 — Detector core.** Tokenizer + readability + density helpers + lexicons +
      registry + the deterministic core rules (02 + 06) + `npx limpid detect` (text/markdown) +
      JSON output + inline ignores. Fixtures for every rule.
- [ ] **M1 — Skill core.** `SKILL.src.md` + setup/context + routing + core commands
      (`init`, `document`, `deslop`, `tighten`, `clarify`, `critique`, `audit`, `polish`).
- [ ] **M2 — Hooks + install.** `hook.mjs` + provider manifests + `npx limpid install/update`
      across claude/cursor/codex/copilot, hook ignore management, `pin`/`unpin`.
- [ ] **M3 — Full command set + rule packs.** Remaining commands + register references +
      `live` mode + Families C–F (style-guide / inclusive / formatting / citation packs).
- [ ] **M4 — ML layer.** Lazy-loaded ONNX classifier + GLiNER span extraction + perplexity/
      burstiness (`--ml`), wired into `deslop`/`audit` scoring (04-ml-layer.md).
- [ ] **M5 — Grounding & facts.** `FACTS.md` + `facts` command + claim extraction + NLI
      entailment + Qwen attention grounding; `factcheck` command + grounding family (05-grounding.md).

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
