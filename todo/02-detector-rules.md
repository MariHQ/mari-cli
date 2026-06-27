# Limpid — Deterministic detector rules design

The full registry: **56 deterministic rules**, no ML. Each rule is regex, wordlist,
density threshold, or structural heuristic. Mirrors impeccable's `registry/antipatterns.mjs`
shape:

```js
{
  id: 'overused-word',
  category: 'slop',           // slop | clarity | style | inclusive
  name: 'Overused AI vocabulary',
  description: 'Author-facing explanation + the fix.',
  method: 'lexicon+density',  // regex | lexicon | density | structural | readability
  severity: 'warn',           // error | warn | advisory
  styleGated: null,           // null | 'microsoft' | 'google' | 'ap' | 'chicago' | 'plain'
  source: 'Kobak 2024 / Liang 2024',
}
```

**Scoring philosophy (carried from research):** never fire on a single match for
cadence/density rules — humans trigger every individual tell. Slop is a *density and
co-occurrence* signal. Lexicon rules emit per-hit findings but the file-level severity
escalates with weighted density. Every rule is overridable via `.limpid/config.json`
(`ignoreRules`/`ignoreValues`/`ignoreFiles`) and inline `<!-- limpid-disable id: reason -->`.

**Severity:** `error` = near-zero false positives, safe to fail CI · `warn` = strong tell,
review · `advisory` = context-dependent, off by default in `--strict=false` CI.

**Detection inputs available:** sentence/word/heading/list segmentation, per-1k-word and
per-N-sentence density, syllable counts (Flesch-Kincaid), markdown AST (headings, lists,
links, emphasis, code fences — code/quoted spans are excluded from prose rules), and the
project glossary/banned-words from STYLE.md.

Legend: **[core]** = M0 ship set (highest precision + highest value, ~24 rules).

---

## Family A — AI-slop tells (26)

| # | id | method | sev | what it catches |
|---|----|--------|-----|-----------------|
| 1 | `overused-word` **[core]** | lexicon+density | warn | Tier-1/2 AI vocabulary spike (`delve, tapestry, testament, underscore, showcase, realm, multifaceted, intricate, nuanced, seamless, robust, leverage, boast, foster, garner`). Weighted; escalates to error on co-occurrence. |
| 2 | `marketing-buzzword` **[core]** | lexicon | warn | `streamline, empower, supercharge, world-class, enterprise-grade, cutting-edge, game-changing, next-generation, best-in-class, turnkey, mission-critical, scalable, synergy, holistic, robust solution`. |
| 3 | `cliche-opener` **[core]** | regex (anchored) | warn | Paragraph/sentence-initial `In today's fast-paced world`, `In the (ever-evolving\|ever-changing) landscape of`, `In the realm of`, `When it comes to`, `At its core`, `In the world of`. |
| 4 | `filler-phrase` **[core]** | regex | warn | `It's important to note that`, `It's worth noting/mentioning`, `Needless to say`, `At the end of the day`, `That being said`. |
| 5 | `manufactured-contrast` **[core]** | regex | warn | `(it's\|this is\|that's) not (just\|only\|merely\|simply) … (it's\|but\|rather)`; `not only … but (also)`. The single strongest cadence tell. |
| 6 | `negative-parallelism` | regex+density | advisory | Trailing `…, not Y.` and paragraph-initial `Rather,` above a density threshold. |
| 7 | `tricolon-overuse` | density | advisory | `A, B, and C` triadic lists above N per M sentences (single tricolon is fine). |
| 8 | `conclusion-restate` **[core]** | regex (anchored) | warn | Paragraph-initial `In conclusion`, `In summary`, `Overall`, `To sum up`, `In essence`, `Ultimately`; or a heading literally `Conclusion`/`Summary` on short pieces. |
| 9 | `vague-attribution` **[core]** | regex (+citation check) | warn | `studies show`, `research suggests`, `experts say`, `many believe`, `it is widely regarded` with no link/footnote/citation within N tokens. |
| 10 | `em-dash-overuse` **[core]** | density | warn | U+2014 (and spaced ` -- `) per 1k words over threshold (~3). |
| 11 | `smart-quotes` **[core]** | regex | advisory | Curly quotes/apostrophes `[‘’“”]` in plaintext/markdown/code contexts where straight ASCII is expected. |
| 12 | `emoji-decoration` **[core]** | regex | warn | Emoji as list markers or section flair (`✨🚀✅💡🎯📈🔑`) at line start, or emoji density over threshold. |
| 13 | `bold-lead-in-list` **[core]** | structural | warn | ≥K consecutive list items beginning `**Bold**:` — the AI listicle template. |
| 14 | `excessive-bold` | density | advisory | `**…**` emphasis spans per 100 words over threshold. |
| 15 | `title-case-heading` | structural | advisory | Headings in Title Case when style guide wants sentence case (also rule #39; this one is the slop-pattern framing for marketing-y over-capitalization). |
| 16 | `assistant-meta` **[core]** | regex | error | `As an AI language model`, `as of my (knowledge cutoff\|last update)`, `I hope this helps`, `Certainly!`, `I'd be happy to`, `Let me know if`, `Feel free to`, `Here's a breakdown`. Near-zero FP. |
| 17 | `sycophancy` **[core]** | regex | warn | `Great question!`, `You're absolutely right`, `That's a great point`, `Excellent question`, `What a fascinating`. |
| 18 | `unicode-artifact` **[core]** | regex | warn | Stray ` ` (nbsp), ` ` (narrow nbsp), `​-‍`/`﻿` (zero-width) — common copy-from-chatbot residue. |
| 19 | `transition-scaffolding` | density | advisory | Paragraph-initial `Firstly/Secondly/Moreover/Furthermore/Additionally/In addition` above a density threshold. |
| 20 | `promotional-puffery` **[core]** | regex | warn | `rich tapestry (of)`, `stands as a testament to`, `plays a (vital\|crucial\|pivotal\|key) role`, `a beacon of`, `a cornerstone of`, `treasure trove`, `pave(s) the way`, `unlock the potential`, `harness the power of`. |
| 21 | `hedge-overuse` **[core]** | lexicon+density | warn | `it could be argued`, `arguably`, `it depends`, `to some extent`, `in many ways`, `more often than not`, `that said` above density. |
| 22 | `listicle-reflex` | structural | advisory | Prose over-structured into lists: high ratio of list lines to sentences, or lists with ≤4-word items that should be a sentence. |
| 23 | `adjective-tricolon` | regex+density | advisory | Adjective triads (`fast, reliable, and scalable`) — the RLHF "rule of three" tic; density-gated. |
| 24 | `section-parallelism` | structural | advisory | Every section sharing one rigid template (heading + 1 sentence + 3 bullets), repeated ≥3× — the uniform AI scaffold. |
| 25 | `exclamatory-enthusiasm` | density | advisory | Multiple `!` co-occurring with enthusiasm words (`amazing, incredible, exciting, thrilled, love`). |
| 26 | `weasel-attribution-passive` | regex | advisory | Agentless authority claims: `it is (widely\|generally\|commonly) (believed\|accepted\|considered)`, `is said to be` — overlaps #9/passive but targets the AI "neutral narrator" register. |

---

## Family B — Clarity & concision (11)

| # | id | method | sev | what it catches |
|---|----|--------|-----|-----------------|
| 27 | `passive-voice` **[core]** | regex (heuristic) | warn | `(is\|are\|was\|were\|be\|been\|being) + past-participle (+ by)`. Past-participle via -ed/-en list + irregular-verb table; excludes adjectival cases best-effort. |
| 28 | `long-sentence` **[core]** | structural | warn | Sentence word count over the register ceiling (docs 25, microcopy 12, editorial 35). |
| 29 | `wordy-phrase` **[core]** | lexicon (map) | warn | Concision swaps: `in order to→to`, `due to the fact that→because`, `at this point in time→now`, `a large number of→many`, `in the event that→if`, `has the ability to→can`. |
| 30 | `complex-word` **[core]** | lexicon (map) | advisory | Plain-language swaps: `utilize→use`, `leverage→use`, `facilitate→help`, `commence→start`, `endeavor→try`, `prior to→before`, `subsequent to→after`, `in regard to→about`. |
| 31 | `nominalization` | regex+lexicon | advisory | Zombie nouns: `make a decision→decide`, `provide assistance→help`, `perform an analysis→analyze`, plus `-tion/-ment of` patterns. |
| 32 | `adverb-overuse` | density | advisory | `-ly` adverb density (Hemingway), especially intensifiers before adjectives. |
| 33 | `reading-grade` **[core]** | readability | warn | Flesch-Kincaid grade over the register ceiling (configurable; docs ~9, plain ~8). |
| 34 | `weasel-word` **[core]** | lexicon+density | warn | `very, really, quite, fairly, rather, somewhat, just, basically, actually, simply, literally` density (write-good / proselint). |
| 35 | `undefined-acronym` | structural | advisory | Acronym used before its expansion on first occurrence in the document. |
| 36 | `redundant-pair` **[core]** | lexicon | warn | `each and every`, `first and foremost`, `various different`, `end result`, `future plans`, `past history`, `absolutely essential`, `free gift`. |
| 37 | `repeated-word` **[core]** | regex | warn | Accidental adjacent duplicates (`the the`, `and and`) — lexical-illusion typos. |
| 38 | `there-is-expletive` | regex | advisory | Sentence-initial `There (is\|are\|was\|were) … that/who` and `It is … that` expletive constructions (wordy, weak subject). |

---

## Family C — Style-guide conformance (10) — gated by chosen base guide

| # | id | method | sev | gate | what it catches |
|---|----|--------|-----|------|-----------------|
| 39 | `sentence-case-heading` **[core]** | structural | warn | microsoft/google | Headings should be sentence case, not Title Case or ALL CAPS. |
| 40 | `contraction-style` | lexicon | advisory | microsoft/google | Prefer contractions (`do not→don't`, `cannot→can't`) for warm voice; inverted for formal styles. |
| 41 | `second-person` | regex | advisory | microsoft/google | Prefer `you`; flag `the user (should)`, `one should/must`, third-person address in instructions. |
| 42 | `please-overuse` | regex | advisory | google | Avoid `please` in instructions/UI (Google dev-docs style). |
| 43 | `latinism` | lexicon | advisory | google | `e.g.→for example`, `i.e.→that is`, `etc.→and so on`, `via→through`, `vs.→versus` in prose. |
| 44 | `terminology-consistency` **[core]** | glossary | warn | all | Term used inconsistently vs STYLE.md glossary (`sign in`/`log in`, `email`/`e-mail`, `dropdown`/`drop-down`). Also flags two undeclared variants of one concept in a file. |
| 45 | `exclamation-overuse` | density | advisory | microsoft | Too many `!` (Microsoft: use sparingly). |
| 46 | `feature-capitalization` | structural | advisory | microsoft/google | Capitalizing common nouns / feature names mid-sentence (`click the Save Button`). |
| 47 | `serial-comma` | regex | advisory | ap/chicago | Enforce (Chicago) or forbid (AP) the Oxford comma per chosen guide. |
| 48 | `number-style` | regex | advisory | ap/chicago | Spell out one–nine (AP) vs numerals threshold (Chicago); flag mismatches. |

---

## Family D — Inclusive & accessible language (9)

| # | id | method | sev | what it catches |
|---|----|--------|-----|-----------------|
| 49 | `gendered-language` **[core]** | lexicon | warn | `chairman→chair`, `mankind→humanity`, `manpower→staff`, `man-hours→work hours`, `he/she` generic defaults → singular `they`. |
| 50 | `ableist-language` **[core]** | lexicon | warn | `crazy, insane, lame, dumb, blind to, cripple(d), sanity check, tone-deaf` → neutral alternatives. |
| 51 | `non-inclusive-idiom` **[core]** | lexicon | warn | `blacklist/whitelist→blocklist/allowlist`, `master/slave→primary/replica`, `grandfather(ed)`, `first-class citizen`, `native (feature)`. |
| 52 | `vague-link-text` **[core]** | structural (md) | warn | Link text `click here`, `here`, `read more`, `this`, `link` — fails screen-reader link navigation (WCAG). |
| 53 | `skipped-heading` **[core]** | structural (md) | warn | Heading levels skip (h1→h3) — breaks the document outline / a11y. |
| 54 | `missing-alt-text` **[core]** | structural (md) | warn | `![](...)` image with empty/missing alt (decorative must be explicit `![]`). |
| 55 | `all-caps-shouting` | structural | advisory | Long all-caps runs (≥N words) — readability + screen readers spell out. |
| 56 | `gendered-honorific` | lexicon | advisory | Gendered-honorific assumptions / `he or she` / `(s)he` → singular they. |

---

## Hard cases — how we stay deterministic without ML

Patterns that "want" a classifier, handled with rules + thresholds instead:

- **Conclusion *restates* the intro (semantic):** we don't do embedding similarity. Approximate
  with (a) the marker rule #8, plus (b) a token-overlap heuristic — high n-gram overlap between
  the final paragraph and the first paragraph/headings → advisory finding. Cheap, explainable.
- **Cross-sentence negative parallelism / tone:** approximated by density of the local
  regexes (#5/#6/#23) rather than discourse parsing. Density gating keeps precision up.
- **Passive voice without a POS tagger:** -ed/-en participle list + ~200 irregular past
  participles + auxiliary-verb window. Accept some misses on adjectival participles; tune via
  fixtures. (Same tradeoff proselint/write-good accept.)
- **"Machine-uniform" reading (was the perplexity idea):** replaced by a pure-stats
  **sentence-length-variance** signal (low variance = monotone) — zero models, computed from
  segmentation. Surfaced as advisory, feeds the `cadence` command.
- **Buzzword vs legitimate term:** density + co-occurrence + STYLE.md allowlist
  (`ignoreValues`) so a brand that genuinely ships a "platform" isn't nagged.

Every "hard" rule ships at `advisory` until fixtures prove precision, then promotes to `warn`.

---

## Rule count

| Family | Count | Core (M0) |
|--------|------:|----------:|
| A — AI-slop tells | 26 | 13 |
| B — Clarity & concision | 11 | 7 |
| C — Style-guide conformance | 10 | 2 |
| D — Inclusive & accessible | 9 | 6 |
| **Total** | **56** | **28** |

Core ships the high-precision, high-value rules first; advisory/style-gated rules follow as
fixtures validate them.

---

## Fixtures (required per rule, mirrors impeccable)

Every rule ships a fixture pair under `tests/fixtures/<id>/`:
- `bad.md` / `bad.txt` — input that must trigger the rule.
- `good.md` — the clean rewrite that must NOT trigger it.
- `cite.md` — one line: the empirical source or style-guide section the rule enforces.

Detector tests assert: bad fires, good is silent, and inline `limpid-disable` suppresses.
