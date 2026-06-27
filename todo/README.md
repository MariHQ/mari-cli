# Limpid — Build TODO

Design-first plan for Limpid: a design system for text that strips AI slop and enforces
house style, delivered as one skill + provider hooks + a standalone deterministic CLI.
Direct counterpart to [Impeccable](https://impeccable.style) (frontend design → prose).

**Scope decision (locked):** detection is **100% deterministic**. No ML/BERT/GLiNER in the
core product. Patterns that "want" a classifier are approximated with regex + density +
structural heuristics (see [`02-detector-rules.md`](02-detector-rules.md) → *Hard cases*).
We get it done with rules, thresholds, and good fixtures.

## Design docs

1. [`01-skills.md`](01-skills.md) — the `limpid` skill: setup, context files, registers,
   routing, and all 21 commands + management commands. Marks the **core (MVP)** subset.
2. [`02-detector-rules.md`](02-detector-rules.md) — the 56 deterministic detector rules:
   id, category, detection method, severity, bad→good fixture, and source. Marks the
   **core (MVP)** subset.

## Architecture (mirror impeccable)

```
cli/
  bin/cli.js                      # install | update | link | detect | ignores | pin
  engine/
    registry/rules.mjs            # the 56-rule registry (see 02-detector-rules.md)
    rules/checks.mjs              # detection implementations
    engines/
      text/detect-text.mjs        # plaintext / piped input
      markdown/detect-md.mjs      # markdown-aware (headings, lists, links, code fences)
      source/detect-strings.mjs   # string literals + comments in code
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

## Milestones

- [ ] **M0 — Detector core.** Tokenizer + readability + density helpers + lexicons +
      registry + the **core rules** (see 02) + `npx limpid detect` (text/markdown) + JSON
      output + inline ignores. Fixtures for every rule.
- [ ] **M1 — Skill core.** `SKILL.src.md` + setup/context + routing + **core commands**
      (`init`, `document`, `deslop`, `tighten`, `clarify`, `critique`, `audit`, `polish`).
- [ ] **M2 — Hooks + install.** `hook.mjs` + provider manifests + `npx limpid install/update`
      across claude/cursor/codex/copilot, hook ignore management, `pin`/`unpin`.
- [ ] **M3 — Full command set.** Remaining commands + register references + `live` mode.
- [ ] **M4 — Style-guide packs + source-string scanning + `localize`.**

## Open questions

- Sentence-case vs Title-case default: tie to chosen base style guide (Microsoft/Google →
  sentence case). Default `microsoft` when unset.
- `live` mode for prose: editor-selection iteration vs browser. Defer to M3; likely
  CLI/stdin + editor selection rather than a browser session.
