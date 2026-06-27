# Product Pitch

*A design system for text. It strips AI slop, enforces house style, and checks claims against
the truth — delivered as one skill, native editor hooks, and a standalone detector that any
writing or coding agent can call.*

Mari is to AI-written **prose** what [Impeccable](https://impeccable.style) is to AI-built
**interfaces**: a shared, opinionated quality vocabulary that an AI agent loads, plus a
deterministic linter that catches the tells automatically. This document is the complete
pitch and the complete spec — the *what*, the *why*, and an exhaustive *how* for every part.

---

## 1. The one-liner

> Every model was trained on the same internet and RLHF'd toward the same voice, so every
> draft carries the same fingerprints: *delve*, *tapestry*, *underscore*; "In today's
> fast-paced world…"; "It's not just X — it's Y"; em-dashes everywhere; a tidy "In conclusion"
> that restates the intro; a bulleted list where a sentence would do. Mari removes those
> fingerprints, holds the text to a real style guide, and flags claims that aren't true.

Three jobs, in priority order:

1. **De-slop** — remove the statistically-measurable tells of machine prose.
2. **Conform** — enforce a chosen house style (Microsoft, Google, AP, Chicago, plain language),
   readability, and inclusive/accessible language.
3. **Ground** — verify factual claims against a user-supplied fact base; flag contradictions
   and unsupported assertions (confident hallucination is the most damaging slop of all).

---

## 2. The problem, with evidence

The "AI voice" is not a vibe — it's measured. Mari's rules are weighted by real corpus studies:

- **Kobak et al., *Science Advances* 2025** (15.1M PubMed abstracts): a sudden 2024 surge in
  "excess words," overwhelmingly *style* words (verbs/adjectives/adverbs). *delves* excess
  ratio **r = 28.0**; *underscore* r = 13.8; *showcasing* r = 10.7; *potential* the largest
  single style-word frequency gap (δ = 0.052). https://arxiv.org/abs/2406.07016
- **Liang et al., ICML 2024** (~49k AI-conference peer reviews): adjective frequency jumps —
  *meticulous* **34.7×**, *intricate* **11.2×**, *commendable* **9.8×**. https://arxiv.org/abs/2403.07183
- **Gray 2024**, **Juzek & Ward 2025**, **Yakura et al. 2024** (740k hours of speech): the same
  shift in scientific writing, and now in *spoken* English (*delve* +48%, *meticulous* +40%).
- **GPTZero (~3.3M texts)** on phrases: "crucial role in shaping" **182×**, "in today's
  fast-paced world" **107×**, "notable works include" **120×** more frequent in AI text.
- **The honest counterweight — Liang et al., *Patterns* 2023:** AI-text *detectors* flag ~61%
  of non-native-English (TOEFL) essays as AI vs ~5% for native writers. So Mari **never
  adjudicates authorship.** It fixes slop; it does not accuse. https://doi.org/10.1016/j.patter.2023.100779

Two design consequences fall directly out of this evidence:

- **A single "AI word" is noise; density and co-occurrence are signal.** Even in real ChatGPT
  output these words are absolutely rare — the studies measure *relative over-use*. So lexicon
  rules never fire on first hit; they score per-1,000-word density and apply a **super-linear
  co-occurrence bonus** (the joint probability of several rare style words in one human passage
  is tiny).
- **Weight by measured ratio, not intuition.** Words with hard numbers (Tier 1) outweigh
  popular-but-unproven ones (Tier 2/heuristic). We seed the style-word allow/deny list from the
  authoritative POS-labeled corpus (`berenslab/chatgpt-excess-words` → `excess_words.csv`) so we
  only flag style words, never topical content nouns.

---

## 3. The product

Mari is a **design system for text**: a small set of named, opinionated operations a writer
(or an AI agent) invokes, backed by a detector that grounds every operation in concrete findings.

It ships as **one skill** (`/mari`) with sub-commands, **provider-native hooks** that run the
detector automatically on edits, and a **standalone CLI** that runs the detector with no agent,
no model, and no key. Same architecture as Impeccable, retargeted from pixels to prose.

The detector is **layered** — each layer is independent and degrades gracefully:

| Layer | Runs by default? | What it does | Cost |
|-------|:---:|--------------|------|
| **Deterministic core** | ✅ always | Regex, wordlists, density thresholds, structural/markdown analysis | instant, explainable |
| **ML layer** | opt-in | Span extraction (GLiNER), AI-likelihood gauge, perplexity/burstiness — catches fuzzy/paraphrased slop | a model on-device |
| **Grounding layer** | opt-in (needs `FACTS.md`) | Claim extraction + fact verification (typed-span match, NLI entailment, attention grounding) | a model + a fact base |

The core alone is a complete, useful product. The other layers are sharpening.

---

## 4. Positioning & differentiation

Prior-art prose linters exist (Vale, proselint, write-good, alex, retext, textlint,
LanguageTool). They give us a reusable lexical/sensitivity foundation under permissive licenses
(proselint BSD-3, write-good MIT, retext-equality/alex MIT, Vale style YAML MIT). **None of them
do the three things Mari is built around:**

1. **AI-slop-specific rules.** They predate LLMs. None target the *delve*-density, "boasts a
   rich tapestry," "it's important to note," negative parallelism, "Despite challenges… continues
   to," or em-dash-as-LLM-signature pattern. This is genuinely new.
2. **Harness-native, agent-loop-aware integration.** They're external batch linters or editor
   plugins. Mari installs as an agent skill + post-edit/pre-write hooks, so the AI self-lints
   *as it writes*.
3. **Grounding against user facts.** No prose linter checks claims against a user-supplied fact
   base. Confident hallucination is the highest-signal failure of AI writing, and we treat it
   as a first-class rule family.

We **reuse** the permissive corpora for the boring lexical work and spend our novel effort on
the AI-slop families, the agent integration, and grounding. (Anything LanguageTool-class /
copyleft we reimplement rather than vendor.)

---

## 5. How it's delivered (the surfaces)

### 5.1 The skill
A single user-invocable skill, `/mari <command> <target>`, discoverable by the agent through a
rich description (write / rewrite / edit / critique / audit / polish / tighten / clarify / deslop
/ factcheck …). Invoking it loads setup, the relevant command reference, the project's voice and
style context, and the register guidance — so the AI applies *this project's* bar, not a generic one.

### 5.2 The hook (automatic, the killer feature)
A provider-native hook runs the detector on direct edits to text files (`.md`, `.mdx`, `.txt`,
and string literals/comments in source) and feeds findings back into the agent turn:
- **Claude Code / Codex / GitHub Copilot:** post-edit — findings surface as context after a write.
- **Cursor:** pre-write — a slop-laden proposed edit is blocked before it lands.
The hook contract is strict: **never break the turn, always exit cleanly.** Clean files emit a
tiny ack (or nothing in quiet mode). The hook runs the deterministic core only by default
(latency); ML/grounding are reserved for explicit `detect`/`audit`/`factcheck` runs.

### 5.3 The CLI
A standalone detector for CI and humans, no agent required:
```
mari detect docs/                 # scan a tree
mari detect README.md             # scan a file
mari detect --json .              # CI output
mari detect --style=microsoft .   # pick the base style guide
mari detect --stdin               # scan piped text
mari factcheck draft.md --source notes.md
mari facts add "…"                # manage the fact base
mari ignores add-value overused-word delve --reason "quoting a source"
```
Exit non-zero on `error`-severity findings (CI gate); `--strict` promotes `warn` too.

### 5.4 Context files (the project's brain)
Three optional markdown files, written by `/mari init`, read by every command and the detector:

- **`PRODUCT.md`** — audience, **register** (docs / marketing / editorial / microcopy), voice
  (3-word personality), **anti-references** (what NOT to sound like), banned words, reading-grade target.
- **`STYLE.md`** — base style guide; a **terminology glossary** (preferred term + forbidden
  variants → drives consistency checks); formatting rules (heading case, lists, emphasis, oxford
  comma, numbers); approved/forbidden phrasings; voice do/don't examples.
- **`FACTS.md`** — ground-truth facts/claims the grounding layer checks against; one fact per
  line, optionally grouped and sourced; editable by hand or `mari facts add`.

All three are optional: absent → the dependent checks simply don't run.

---

## 6. Setup & the routing model (how a command actually executes)

When `/mari …` is invoked, the skill runs a fixed setup before doing anything:

1. **Load context.** Print `PRODUCT.md` (+ `STYLE.md`, `FACTS.md`) if present. If `PRODUCT.md`
   is missing → route to `init` first (it's the blocker), then resume.
2. **Load the command reference.** If a sub-command was named, read its reference file — that's
   the authoritative flow; skipping it produces generic edits.
3. **Read the existing writing.** Sample at least one representative file so edits match the
   project's *actual* voice, not an imposed one.
4. **Load the register reference** (docs / marketing / editorial / microcopy), chosen by first
   match: task cue → surface in focus → `register` in `PRODUCT.md`. Non-optional.
5. **Load the base style guide** (default `microsoft`). The register + style guide define the
   bar; the detector enforces the mechanical subset.

**Routing:** (a) no argument → a context-aware menu that runs the detector over changed files and
leads with the 2–3 highest-value commands (many buzzword hits → `deslop`; long-sentence/grade hits
→ `tighten`; passive/jargon → `clarify`); (b) first word matches a command → load its reference;
(c) intent maps to a command ("make this punchier" → `sharpen`) → load it; (d) otherwise a general
editing pass using setup + register + the full line.

---

## 7. The commands (the editorial vocabulary)

Grouped like Impeccable: Build · Evaluate · Refine · Enhance · Fix · Iterate. "Leans on" = the
rule families the command runs first, so its edits are grounded in concrete findings.

**Build** — `init` (gather voice/register/style, write the context files, offer the hook),
`document` (reverse: infer `STYLE.md` from existing good writing), `draft` (outline → write →
self-deslop/tighten), `outline` (plan structure & cadence, guarding against the uniform AI
template), `glossary` (extract approved terms into `STYLE.md`).

**Evaluate** — `critique` (editorial judgment: argument, structure, voice fidelity, reader
experience; emits a scored snapshot that `polish` later consumes), `audit` (the human-facing
front end of `mari detect` — every finding grouped by family with bad→good fixes).

**Refine** — `polish` (final pre-publish pass; resolves the latest critique + all findings),
**`deslop`** *(signature)* (strip AI tells and rewrite in human voice — Family A + buzzword/
concision swaps), `sharpen` (kill hedges, passive→active, nominalizations→verbs), `soften` (tone
down hype/overclaiming/exclamation), `tighten` (cut wordiness/redundancy/filler), `harden`
(edge-case copy: errors, empty states, microcopy, i18n length).

**Enhance** — `voice` (inject brand personality into flat copy), `cadence` (fix sentence rhythm
and length variance), `format` (heading hierarchy/case, list-vs-prose, emphasis discipline, link
text), `delight` (memorable human touches, restraint-first).

**Fix** — `clarify` (rewrite unclear copy; define jargon, resolve ambiguity, fix the error-message
formula), **`factcheck`** (extract claims, check against `FACTS.md`/`--source`, report Supported/
Contradicted/Unsupported with evidence), `adapt` (re-target a piece for another channel),
`localize` (global English: simplify idioms, separate variables from sentences, flag length budgets).

**Iterate** — `live` (in-place: select a sentence/paragraph, generate alternatives at different
intensities, apply the chosen one).

**Management** — `pin`/`unpin` (create `/<command>` shortcuts across harness dirs), `hooks`
(on/off/status/ignore-rule/ignore-file/ignore-value/reset), `facts` (add/list/remove/import).

---

## 8. The detection engine — architecture

```
input (file | stdin | string literal)
   │
   ├─ segment ─────────────► sentences, words, headings, lists, links, code fences, paragraphs
   │
   ├─ DETERMINISTIC CORE ──► Families A–F: regex / wordlist / density / structural checks
   │                          (+ readability, burstiness, terminology vs STYLE.md)
   │
   ├─ ML LAYER (opt-in) ───► GLiNER spans · AI-likelihood gauge · perplexity/burstiness
   │                          (de-duped & merged against core hits)
   │
   ├─ GROUNDING (opt-in) ──► Family G: claim extraction → fact retrieval → typed-span match
   │                          + NLI entailment + (advanced) attention grounding, vs FACTS.md
   │
   └─ findings ───────────► dedupe → score → severity-sort → render (human | JSON)
```

Every finding carries: `rule id`, `category/family`, `severity` (error/warn/advisory),
`source` (rule | ml-span | ml-score | grounding), location, the offending span, a one-line
fix, and the citation/style-section it enforces. Findings are suppressible by config
(`ignoreRules`/`ignoreFiles`/`ignoreValues`) and by inline waiver
`<!-- mari-disable <id>: reason -->` (whole-file, or `-line` / `-next-line`).

Code fences and inline code are excluded from prose rules; quoted spans and citations bypass
the lexical/inclusive rules (you can quote a slur in a citation).

---

## 9. Shared analysis primitives (the HOW under the rules)

These are computed once per document and reused by many rules.

### 9.1 Segmentation
- **Words:** tokens matching letters/digits with internal apostrophes/hyphens kept as one word.
- **Sentences:** split on terminal `.!?` followed by whitespace/EOL, **after masking**
  abbreviations (Mr. Dr. vs. etc. e.g. i.e. Inc. No. U.S.) and decimals (`\d\.\d`); `:`/`;`/
  newlines are *not* boundaries; guard sentence-count ≥ 1.
- **Markdown structure:** headings (level + text + case), list items (marker + content),
  links (text + target), emphasis spans, code fences/inline code (excluded), thematic breaks.

### 9.2 Readability
Compute per document; ship **Flesch-Kincaid Grade** as the headline plus a **syllable-free
cross-check** (Coleman-Liau or ARI) — large FKGL↔CLI disagreement means the syllable heuristic
misfired on this text.
```
ASL = words/sentences ; ASW = syllables/word
FKGL = 0.39·ASL + 11.8·ASW − 15.59
FRE  = 206.835 − 1.015·ASL − 84.6·ASW
CLI  = 0.0588·(letters/words·100) − 0.296·(sentences/words·100) − 15.8
ARI  = 4.71·(chars/words) + 0.5·ASL − 21.43        # ceil to grade
Fog  = 0.4·(ASL + 100·complexWords/words)          # complex = ≥3 syllables
```
**Per-register grade ceilings:** plain/gov ≤ 8 (FRE ≥ 60) · marketing/consumer 7–9 · news 9–11 ·
technical docs 10–12 · specialist ≤ 14 (flag > 16). Health content 6–8.

### 9.3 Syllable counting (the fragile part — ~3–8% word error after corrections, fine for
aggregate scoring): exception table → strip silent `-e`/`-es`/`-ed` → count vowel groups
(`[aeiouy]{1,2}` so diphthongs collapse to one) → `+1` for consonant+`-le`/`-les` → keep `-ted`/
`-ded` → `+1` for hiatus (`ia/io/ua/eo`) → minimum 1. Seed a small exceptions map (every:2,
business:2, different:3, comfortable:3, vegetable:3, february:4, area:3, idea:3, science:2, …)
and grow it by diffing a pronunciation dictionary offline.

### 9.4 Density & burstiness
- **Density:** matches per 1,000 words (or per N sentences) — the gate for cadence/formatting rules.
- **Burstiness:** over per-sentence word counts, `CV = stddev/mean` (scale-independent). Human
  engaging prose CV ≈ 0.5–0.8+; flag **CV < 0.25** as "uniform sentence rhythm." Always a *nudge*,
  never a verdict (technical/reference/translated prose is naturally low-variance).

### 9.5 Passive voice (no grammar engine required)
`(am|is|are|was|were|be|been|being)` + optional `(adverb|not|been|being){0,2}` + past participle
(`-ed`/`-en` candidate **or** a maintained ~190-entry irregular-participle list: arisen, awoken,
beaten, begun, broken, brought, built, chosen, done, drawn, driven, eaten, fallen, forgotten,
frozen, given, gone, grown, hidden, known, made, paid, seen, sold, sent, shown, taken, thrown,
told, thought, woven, written, …). **False-positive reduction, in order:** (1) an adjectival-
participle stoplist (is interested/located/excited/based on/related to/done/born…) suppresses
unless a `by`-agent follows; (2) `by` within ~4 words → confirm true passive; (3) following
`in/about/with/at/of` → down-weight (predicate adjective); (4) down-weight zero-change irregulars
(read/cut/set/put). Report as **% of sentences with passive**; target < 10–15%. Always a
*suggestion* with a confidence, never a hard error.

---

## 10. Family A — AI-slop tells (the heart)

The signature family. `method` says HOW each fires. Severities: `error` (≈0 false positives),
`warn` (strong), `advisory` (context-dependent). All density rules require a per-document rate;
none fire on a single match.

| id | method | sev | HOW it fires |
|----|--------|-----|-------------|
| `overused-word` | weighted lexicon + density + co-occurrence | warn | Each word carries a weight = its measured over-use ratio (Tier 1: delve r28, meticulous 34.7×, intricate 11.2×, commendable 9.8×, underscore r13.8, showcase r10.7; Tier 2: realm, pivotal, garner, boasts, adept, groundbreaking; heuristic/no-evidence at low weight: tapestry, testament, leverage, robust, seamless, nuanced, multifaceted). Document score = Σ(weight × occurrences)/1k words with a **super-linear bonus for N distinct style words** co-occurring. Only style words (verbs/adj/adv) from the POS-labeled corpus; never content nouns. Escalates advisory→warn→error with density. |
| `marketing-buzzword` | lexicon | warn | streamline, empower, supercharge, world-class, enterprise-grade, cutting-edge, game-changing, next-generation, best-in-class, turnkey, mission-critical, synergy, holistic, "robust solution". |
| `cliche-opener` | regex (anchored to sentence/paragraph start) | warn | "In today's fast-paced world", "In the (ever-evolving\|ever-changing) landscape of", "In the realm of", "When it comes to", "At its core", "In the world of". |
| `filler-phrase` | regex | warn | "It's important to note that", "It's worth noting/mentioning", "Needless to say", "At the end of the day", "That being said". |
| `manufactured-contrast` | regex | warn | `(it's\|this is\|that's) not (just\|only\|merely\|simply) … (it's\|but\|rather)`; `not only … but (also)`; `it's not X. it's Y.` — the single strongest cadence tell. |
| `negative-parallelism` | regex + density | advisory | Trailing `…, not Y.`; "Not X. Not Y. Just Z."; "X rather than Y"; leading "Rather,". Density-gated. |
| `tricolon-overuse` | density | advisory | `A, B, and C` triads (adjectives/short phrases) above N per M sentences. One tricolon is fine; the reflex is the tell. |
| `conclusion-restate` | regex + overlap heuristic | warn | Markers: paragraph-initial "In conclusion/In summary/Overall/To sum up/In essence/Ultimately". Plus a token-overlap check between the final and first paragraphs/headings → flags a conclusion that *restates* the intro. |
| `vague-attribution` | regex + citation check | warn | "studies show", "research suggests", "experts (say\|argue)", "many believe", "observers have cited", "industry reports", "it is widely regarded", "efforts are ongoing to" — fired only when no link/footnote/citation appears within N tokens. |
| `despite-challenges-closer` | regex | warn | `despite (its\|these\|the) … (challenges\|difficulties)` paired with `continues to (thrive\|evolve\|grow\|serve\|play)` — the signature AI wrap-up, near-zero FP. |
| `significance-boilerplate` | regex | warn | "stands as a testament", "marking a pivotal moment", "leaving an indelible mark", "enduring legacy", "key turning point", "plays a (vital\|crucial\|pivotal\|key) role". |
| `serves-as-copula` | regex + density | advisory | Copula avoidance — "serves as", "stands as", "refers to", "exemplifies", "represents a" where "is" would do. |
| `media-coverage-boilerplate` | regex | advisory | "featured in … and other (prominent) outlets", "profiled in", "maintains a (strong\|active) (social media\|digital) presence". |
| `superficial-ing-participle` | density | advisory | Clause-final vague-significance participles: `, (highlighting\|underscoring\|emphasizing\|reflecting\|symbolizing\|contributing to\|fostering\|ensuring) …` stacked above a rate. |
| `future-outlook-speculation` | regex | advisory | "the future of … lies in", "evolving landscape", "continues to evolve"; section titles "Future Outlook" / "Challenges and Legacy". |
| `conversational-scaffolding` | regex | advisory | "let's (delve into\|break this down)", "think of it (as\|like)", "imagine a world where", "to put it simply", "at its core", "here's the (kicker\|thing)". |
| `transition-scaffolding` | density | advisory | Paragraph-initial Additionally/Moreover/Furthermore/However above rate. |
| `interrogative-answer` | regex | advisory | "The result? Devastating." / "The X? A Y." rhetorical-fragment cadence. |
| `hedge-overuse` | lexicon + density | warn | "it could be argued", "arguably", "to some extent", "in many ways", "more often than not", "generally/broadly speaking", "tends to". |
| `em-dash-overuse` | density | warn | U+2014 (and ` -- `) per 1k words over threshold (human baseline ~3/1k). |
| `smart-quotes` | regex | advisory | Curly quotes/apostrophes `‘ ’ “ ”` where ASCII is expected. |
| `emoji-decoration` | regex | warn | Emoji as bullets/section flair (✨🚀✅💡🎯) at line start, or emoji density over threshold. |
| `bold-lead-in-list` | structural | warn | ≥K consecutive list items shaped `- **Header**: text` — the AI listicle template. |
| `excessive-bold` | density | advisory | `**…**` emphasis density per 100 words, especially in running prose. |
| `assistant-meta` | regex | error | "As an AI language model", "as of my (knowledge cutoff\|last update)", "I hope this helps", "Certainly!", "I'd be happy to", "Let me know if", "Feel free to", "Here's a breakdown", leftover `[insert X]`/`[Your Name]`. Near-zero FP. |
| `sycophancy` | regex | warn | "Great question!", "You're absolutely right", "That's a great point", "Excellent question", "What a fascinating". |
| `unicode-artifact` | regex | warn | Stray nbsp (U+00A0), narrow nbsp (U+202F), zero-width (U+200B–200D/FEFF) — chatbot copy residue. |
| `listicle-reflex` | structural | advisory | Prose over-structured into lists (high list-line/sentence ratio; ≤4-word items that should be a sentence). |

**Negative signals (lower the slop score, don't raise it):** contractions, slang, and genuine
first-person anecdote correlate with *human* writing — their presence discounts the document-level
slop score so casual human writing isn't flagged.

---

## 11. Family B — Clarity & concision

| id | method | sev | HOW |
|----|--------|-----|-----|
| `passive-voice` | heuristic (§9.5) | warn | be-aux + participle with the FP-reduction ladder; reported as % of sentences. |
| `long-sentence` | structural | warn | Word count over the register ceiling (docs 25, microcopy 12, editorial 35). |
| `wordy-phrase` | lexicon map (longest-match first) | warn | "in order to"→to, "due to the fact that"→because, "at this point in time"→now, "a number of"→some/many, "in the event that"→if, "has the ability to"→can. |
| `complex-word` | lexicon map | advisory | utilize→use, leverage→use, facilitate→help, commence→start, endeavor→try, ascertain→find out, numerous→many, sufficient→enough, methodology→method. |
| `nominalization` | regex + lexicon | advisory | Light-verb + `-tion/-ment/-ance/-ence/-ity/-sion` noun → suggest the verb ("make a decision"→decide, "conduct an investigation"→investigate, "provide assistance"→assist). Pattern-based so it catches novel cases. |
| `adverb-overuse` | density | advisory | `-ly` adverb density, especially intensifiers before adjectives (very/really/extremely). |
| `reading-grade` | readability (§9.2) | warn | FKGL over the register ceiling. |
| `weasel-word` | lexicon + density | warn | very, really, quite, fairly, rather, somewhat, just, basically, actually, simply, literally. |
| `undefined-acronym` | structural | advisory | Acronym used before its first-use expansion. |
| `redundant-pair` | lexicon | warn | "each and every", "first and foremost", "end result", "free gift", "past history", "future plans", "various different", "absolutely essential". |
| `repeated-word` | regex | warn | Accidental adjacent duplicates ("the the"). |
| `there-is-expletive` | regex | advisory | Sentence-initial "There (is\|are\|was\|were) … that/who" and "It is … that" — wordy, weak subject. |

---

## 12. Family C — Style-guide conformance (packs)

One **base pack** active per project (`microsoft` default; or google/ap/chicago/plain) plus
always-on **shared** rules where Microsoft and Google agree. (Research resolved the supposed
conflicts: both **require** the Oxford comma and both **encourage** contractions.)

**C-shared:** `sentence-case-heading`, `heading-end-punctuation` (no terminal punctuation),
`serial-comma` (require), `use-contractions`, `second-person`, `active-voice` (shares §9.5),
`present-tense`, `singular-they`, `no-please-instructions`, `word-swap`.

**`word-swap`** is one rule fed by a large deduplicated avoid→use map (the Google A–Z word list,
layered with Microsoft's): utilize→use, in order to→to, leverage→use, since(causal)→because,
impact(verb)→affect, e.g.→for example, i.e.→that is, etc.→rephrase, please→omit, abort→stop/
cancel, execute→run, hit→click/press, log in/login→sign in, check box→checkbox, e-mail→email,
above/below→preceding/following, deselect→clear, grayed out→unavailable, and/or→or.

**C-microsoft adds:** no-internal-caps, no-space-em-dash (`word—word`), no-noun-verb-contraction,
omit-"you can", avoid-"we", spell-out-0–9, no-numeral-sentence-start, numerals-for-measure,
comma-in-4-digit-numbers, no-K/M/B ($30M→$30 million), leading-zero, acronym-first-use,
no-single-use-acronym.

**C-google adds:** no-gerund-heading, no-link-in-heading, no e.g./i.e./etc., no
easy/simple/just/quick (minimizing words), no-abbreviation-as-verb ("ssh into"→"use SSH to"),
no-periods-in-acronyms, no-exclamation, american-spelling, no-preannounce (currently/latest/new),
no-directional (above/below→preceding/later), descriptive-links.

**Per-pack divergences** (apply only under the matching base): `terminate` (MS avoid / Google ok),
`via` (Google ok), `easy/simple/just` (Google-only ban), "you can" (MS deletes), number spell-out
(MS-only). **AP/Chicago/plain** are light packs (number style, serial-comma stance, spelling; plain
tightens the grade ceiling and turns on all concision rules).

**`terminology-consistency`** (cross-pack, glossary-driven): flags a term used inconsistently vs
`STYLE.md`'s glossary, or two undeclared variants of one concept in a file (sign in/log in,
email/e-mail, dropdown/drop-down).

---

## 13. Family D — Inclusive & accessible language

Always-on, independent of base style. Backbone data reused from retext-equality (MIT) +
Inclusive Naming list + Google/MS tables. Each rule = `{pattern, replacements, reason, source,
severity, scope, exemptions}`.

**Universal scoping (how we keep false positives down):** skip fenced/inline code, identifiers,
URLs, paths; skip capitalized proper nouns; prefer multi-word phrase matches for idioms;
per-term exemption bigrams; allow quotes/citations to bypass; **suggest, never auto-fix**;
contested terms individually toggle-able.

| id | sev | HOW (avoid→preferred + scoping) |
|----|-----|-------------------------------|
| `ableist-language` | warn | crazy/insane/psycho→baffling, lame→weak, dumb→foolish, dummy→placeholder, cripple→degrade, tone-deaf→insensitive, OCD/bipolar(metaphor)→meticulous/volatile. Only metaphorical "blind to/deaf to", not literal "blind users"; "sanity check"/"sane" idiomatic in CS = warn not error. |
| `person-first-language` | warn | "suffers from/victim of/wheelchair-bound/an epileptic" → "has X / uses a wheelchair / person with epilepsy". |
| `gendered-language` | warn | chairman→chair, mankind→humanity, manpower→workforce, man-hours→person-hours, manned→staffed, salesman/policeman→neutral, layman→layperson. Curated `-man` whitelist — NOT blanket `*man` (exempt human/manage/command/Germany). |
| `gendered-address` | advisory | guys→everyone/folks; Mrs./Miss(assumed)→Ms./omit. "guys" only as collective address; exempt the name "Guy" + quotes. |
| `tech-historical-terms` | warn | blacklist/whitelist→blocklist/allowlist, master/slave→primary/replica, grandfathered→legacy, blackhat/whitehat→unethical/ethical, first-class citizen→fully supported. `master`/`native`/`primitive`/`tribe` = advisory (high FP); exempt "master's degree", "Scrum Master", "native speaker", "primitive type", capitalized "Native"; allow code spans. |
| `violent-tech-metaphor` | advisory | abort→stop, kill→end, hang→stop responding, hit(endpoint)→call, blast radius→scope of impact, DMZ→perimeter network. **Suppress inside code/identifiers** (kill -9, AbortController, cache hit, page hits); individually toggle-able; user-docs only. |
| `ageist-classist-cultural` | advisory | ghetto→makeshift, gypsy/gypped→Roma/cheated, oriental→Asian, eskimo→Inuit, the elderly→older adults, third-world→developing, illegal immigrant→undocumented immigrant. Full-phrase matches; exempt historical/quoted contexts. |
| `vague-link-text` | warn | "click here", "here", "read more", "this link" as link text (WCAG). |
| `skipped-heading` | warn | Heading levels skip (h1→h3); more than one h1. |
| `missing-alt-text` | warn | Image with empty/missing alt; decorative must be explicit empty alt. |
| `all-caps-shouting` | advisory | Long all-caps runs (≥N words) — screen readers spell them out. |

---

## 14. Family E — Punctuation & formatting tells

Markdown-aware (code excluded); density rules gated by per-document rate.

`em-dash-overuse`, `smart-quotes`, `emoji-decoration`, `bold-lead-in-list`, `excessive-bold`
(several shared with Family A), plus: `title-case-heading`, `markup-leak` (markdown bleeding into
plain text), `thematic-break-before-heading` (`---` directly before a heading — an AI scaffold),
`bullet-overuse` (list-line/prose-line ratio), `unicode-artifact`, `double-space`,
`redundant-acronym` ("ATM machine", "PIN number"), `indefinite-article` (a/an by sound).

---

## 15. Family F — Citations & references

High value for docs/academic registers; bridges to grounding.

`dead-link` (404/unreachable — network, opt-in `--check-links`), `malformed-doi-isbn`,
`tracking-param-in-citation` (`utm_source=` in a cited URL), `citation-missing-page`,
`unused-named-ref`, `placeholder-citation` ("[citation needed]", "(Author, Year)" left in),
`fabricated-quote` (a quote/citation not present in `FACTS.md`/`--source` — shared with Family G).

---

## 16. Family G — Grounding & factuality (the differentiator)

The user supplies **`FACTS.md`**; Mari flags claims in the text that **contradict** or are
**unsupported by** those facts. Two truth modes:
- **Closed-world** (`FACTS.md` present): contradiction → `error`; unsupported checkable claim →
  `advisory` (absence isn't disproof unless the user sets `facts.exhaustive`).
- **Source-grounded** (`--source <file>`): check a summary against the doc it came from; stricter —
  unsupported → `warn`.

### How it runs — cheapest first
**Tier 0 — Typed-span match (no model, highest precision).** Extract numbers, dates, quantities,
money, percentages, and named entities from both the text and `FACTS.md`; align them; flag value
mismatches. Catches the wrong-number/wrong-date/wrong-name hallucination with full traceability.
→ rules `number-date-mismatch`, `contradicts-fact`.

**Tier 1 — Retrieve relevant facts.** For each claim pull the most relevant `FACTS.md` entries —
default keyword/BM25 (zero downloads), or small sentence-embeddings when the ML layer is on.

**Tier 2 — Claim extraction.** Default: sentence segmentation = candidate claims. Better:
atomic-claim decomposition via a small local instruct model ("split into self-contained,
decontextualized, single-fact claims, resolving pronouns"). Entity-level via GLiNER.

**Tier 3 — NLI entailment (the practical backbone).** For each claim vs its retrieved facts,
classify premise(fact)→hypothesis(claim): entailment→**Supported**, contradiction→**Refuted**
(contradicts-fact), neutral→**Unsupported**. Uses a small natural-language-inference model
(DeBERTa-v3 trained on MNLI/FEVER/ANLI; or a dedicated small fact-checker like MiniCheck / a
groundedness model like HHEM-2.1-Open). Each finding cites the exact evidence line for the user
to judge.

**Tier 4 — Attention grounding (advanced, opt-in).** Only when the text was generated *locally
with `FACTS.md` in context*. Method: **Lookback Lens** (Chuang et al., EMNLP 2024,
arXiv:2407.07071). At each generated token, compute the **lookback ratio** = attention mass on the
context (the facts) ÷ (context + already-generated tokens), concatenated across all layers×heads,
averaged over a span, fed to a tiny **logistic-regression probe**. A low ratio ⇒ the span isn't
grounded in the facts ⇒ likely hallucination. The probe transfers across model sizes and is cheap.
→ rule `ungrounded-span`.

> **Model note:** the natural model for Tier 4 is a small **standard** causal LM whose attention
> is accessible (e.g. **Qwen3-0.6B**, Apache-2.0, 28 layers × 16 heads). The user-suggested
> **Qwen3.5-0.8B is real and Apache-2.0 but multimodal with hybrid linear/gated attention + MoE**,
> so it doesn't emit conventional attention matrices — it's a poor fit for Lookback Lens and is
> better reserved for future multimodal/long-context generation. Tier 4 needs raw attention maps,
> which requires running the model in a mode that exposes them; we treat it as an advanced add-on,
> not the backbone (Tiers 0–3 are the product).

### Grounding rules
`contradicts-fact` (error), `unsupported-claim` (advisory / warn in source mode), `number-date-
mismatch` (error), `fabricated-citation`/`fabricated-quote` (warn), `ungrounded-span` (advisory),
`stale-fact` (advisory — text asserts a value a newer `FACTS.md` entry supersedes).

These compose with the style families: "studies show" with no citation is a *style* tell
(`vague-attribution`); a concrete number that contradicts `FACTS.md` is a *grounding* error. Both
fire, at different severities.

---

## 17. The ML layer (HOW)

Optional, on-device, lazy-loaded; the deterministic core always runs without it. The guiding
principle: **ML points at spans worth rewriting; it never adjudicates authorship.**

- **GLiNER span extraction (primary investment).** A generalist span model that takes arbitrary
  natural-language labels at inference. We pass slop labels — `marketing_buzzword`, `hedge_phrase`,
  `filler_phrase`, `vague_attribution`, `puffery`, `cliche` — and get back spans to highlight.
  Strength: surfaces *fixable* spans (paraphrased buzzwords the wordlists miss). It de-dupes
  against Family-A hits — a span found by both rule and model is boosted to high confidence. Ship
  zero-shot first; fine-tune on our own labeled fixtures for the abstract rhetorical labels.
- **AI-likelihood gauge (soft only).** A small classifier emits a 0–1 "reads-machine-generated"
  signal, surfaced *with the ESL/technical-prose bias caveat attached*, feeding the document score
  as one weak feature. Never a per-line error, never a verdict. Gated behind an explicit flag.
- **Perplexity + burstiness.** A tiny local language model scores how predictable the text is;
  combined with the model-free burstiness statistic (§9.4) it yields a "uniform, machine-like
  rhythm" nudge that feeds the `cadence` command.

(Heavier zero-shot detectors — DetectGPT, Fast-DetectGPT, Binoculars — are documented as advanced
opt-ins only; they need large models/GPUs and aren't in the default experience. Watermark
detection is out of scope: it needs generator cooperation and a key, so it can't read arbitrary
third-party text.)

---

## 18. Scoring model (how findings become a verdict)

- **Per-finding severity** drives CI behavior: any `error` fails `mari detect` (exit non-zero);
  `--strict` promotes `warn`. `advisory` never fails CI.
- **Document slop score (0–100)** is a weighted blend: lexical-density (weighted by measured
  ratios, with the co-occurrence bonus) + cadence/formatting density + (if on) the ML gauge and
  perplexity — **minus** the human-signal discount (contractions/slang/first-person). The ML
  signals contribute but never dominate; the breakdown is always shown so a user sees *why*.
- **Dedup & provenance:** overlapping rule+ML findings merge into one with boosted confidence;
  every finding records its `source` so nothing a model produced is mistaken for a hard rule.
- **Register-aware thresholds:** the same rule fires at different rates by register (em-dash is
  relaxed for editorial; sentence length is strict for microcopy; grade ceiling tightens for plain).

---

## 19. Configuration, waivers, registers

- `.mari/config.json` (+ machine-local `.mari/config.local.json`): `detector.styleGuide`,
  `detector.ignoreRules/ignoreFiles/ignoreValues`, register defaults, `ml.*`, `grounding.*`,
  `facts.*`, `hook.*`.
- **Inline waivers:** `<!-- mari-disable <id>: reason -->` (whole file), `-line` / `-next-line`
  variants; bypassable with `--no-inline-ignores`. Reasons are encouraged so waivers are auditable.
- **Register × pack matrix** (which packs fire where): docs → MS/Google + inclusive + formatting +
  citations + grounding; marketing → MS + inclusive + formatting(looser bold); editorial →
  Chicago/AP + relaxed em-dash; microcopy → MS + strict length; academic → Chicago + strict
  citations + strict grounding.

---

## 20. Distribution & harness integration

- **Install:** a single command detects the harness folders present (Claude Code, Cursor, Codex,
  Gemini, Copilot, OpenCode, Pi, Kiro, Trae, Rovo, Qoder), installs the skill payload, and wires
  the provider-native hook. Project or global scope. `update` refreshes; `link`/submodule for
  vendored teams.
- **The hook** installs per-provider manifests, preserves unrelated entries, aborts on a malformed
  manifest unless `--force`, and remembers the user's hook choice per-developer.
- **Skill packaging** mirrors Impeccable's build: one source skill compiled to each harness's
  layout, with `pin` creating standalone `/<command>` shortcuts.

---

## 21. Honesty principles (non-negotiable)

1. **We fix slop; we never accuse.** No "this is AI-written" verdict. Detectors are biased
   against non-native English (61% vs 5% false-positive gap) — authorship detection is an explicit
   non-goal.
2. **Unsupported ≠ false.** A claim absent from `FACTS.md` is advisory, not an error, unless the
   user declares the fact base exhaustive or supplies a source.
3. **Density over presence.** One "delve" is nothing; we score patterns, not words.
4. **Show the evidence.** Every finding cites the rule, the offending span, the fix, and the
   source/style-section — and ML findings are labeled as such.
5. **The deterministic core stands alone.** Every higher layer is optional sharpening.

---

## 22. Roadmap

- **M0 — Detector core.** Segmentation + readability + density + lexicons + Families A/B + the
  core of C–F + CLI + JSON + inline waivers + a fixture pair per rule.
- **M1 — Skill core.** Setup/context/routing + core commands (init, document, deslop, tighten,
  clarify, critique, audit, polish).
- **M2 — Hooks + install** across the harnesses; ignore management; pin/unpin.
- **M3 — Full command set + rule packs** (remaining commands, register references, `live`, the
  full C–F packs).
- **M4 — ML layer** (GLiNER spans, AI-likelihood gauge, perplexity), wired into deslop/audit scoring.
- **M5 — Grounding & facts** (`FACTS.md`, `facts`/`factcheck`, Tier 0–3 grounding; Tier 4 attention
  grounding as an advanced add-on).

Every rule ships with a fixture pair (`bad` triggers, `good` is silent) and a one-line citation of
the empirical source or style-guide section it enforces. Hard/contested rules ship `advisory` and
promote to `warn` only once fixtures prove precision.

---

## Appendix A — Evidence & citations

- Kobak et al., *Science Advances* 2025 — https://arxiv.org/abs/2406.07016 — POS-labeled excess
  words: `github.com/berenslab/chatgpt-excess-words` → `excess_words.csv`.
- Liang et al., ICML 2024 (peer reviews) — https://arxiv.org/abs/2403.07183
- Gray 2024 — https://arxiv.org/abs/2403.16887 · Juzek & Ward 2025 — https://arxiv.org/abs/2412.11385
  · Yakura et al. 2024 — https://arxiv.org/abs/2409.01754 · Liang et al. *Patterns* 2025 —
  https://arxiv.org/abs/2502.09747
- Liang et al., *Patterns* 2023 (detector bias) — https://doi.org/10.1016/j.patter.2023.100779
- Wikipedia "Signs of AI writing" — https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing ·
  tropes.fyi · Grammarly common AI words · Reuters Institute on AI prose.
- Microsoft Writing Style Guide — https://learn.microsoft.com/style-guide/ · Google developer
  documentation style guide — https://developers.google.com/style/ (word list:
  https://developers.google.com/style/word-list).
- plainlanguage.gov / Federal Plain Language Guidelines · GOV.UK A–Z style.
- Prior art: Vale (vale.sh), proselint, write-good, alex/retext-equality, textlint, LanguageTool.
- GLiNER — https://arxiv.org/abs/2311.08526 · Lookback Lens — https://arxiv.org/abs/2407.07071 ·
  MiniCheck — https://arxiv.org/abs/2404.10774 · FActScore — https://arxiv.org/abs/2305.14251 ·
  SAFE — https://arxiv.org/abs/2403.18802.

## Appendix B — License posture

We are permissive-licensed. Reusable as data/logic: proselint (BSD-3), write-good (MIT),
retext-equality/alex (MIT), Vale Microsoft/Google style YAML (MIT). Style-guide *prose* is not
copied (Microsoft proprietary; Google text CC BY) — only the mechanical rules are reimplemented.
LanguageTool (LGPL) is reimplemented or kept external, never vendored. Candidate models are all
permissively licensed (Apache-2.0 / MIT) and run on-device; the deterministic core has no model
dependency at all.

---

*Companion design docs live in `todo/` (skills, rules, research dossier, ML layer, grounding,
rule packs). This PITCH.md is the single consolidated source of truth.*
