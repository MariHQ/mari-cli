# Mari — Research dossier (round 2, verified + cited)

Consolidated, source-verified research backing the detector rules and skills. Everything
here is fetched-and-cited (round 2, 2026-06-26), superseding the rate-limited round 1.
This is the build reference: wordlists, regexes, formulas, swap maps, licenses.

---

## 1. Empirical AI-vocabulary evidence (hard numbers)

Only a handful of "AI words" have *measured* frequency evidence. Use the numbers to
**weight** lexicon rules; use density + co-occurrence to fire them.

### Studies
| Tag | Study | Corpus | Metric | URL |
|-----|-------|--------|--------|-----|
| K | Kobak et al., *Science Advances* 2025 | 15.1M PubMed abstracts | excess ratio r=p/q, gap δ=p−q | https://arxiv.org/abs/2406.07016 |
| L | Liang et al., ICML 2024 | ~49k AI-conf peer reviews | per-sentence prob. fold-increase | https://arxiv.org/abs/2403.07183 |
| G | Gray (UCL) 2024 | ~5.3M Dimensions articles | YoY % change 2022→23 | https://arxiv.org/abs/2403.16887 |
| J | Juzek & Ward, COLING 2025 | PubMed | per-million rate change | https://arxiv.org/abs/2412.11385 |
| Y | Yakura et al. 2024 | 740k hrs spoken (~7.35B words) | % increase over 18 mo | https://arxiv.org/abs/2409.01754 |
| S | Liang et al., *Patterns* 2025 | complaints/press/jobs/UN | % LLM-modified | https://arxiv.org/abs/2502.09747 |

**Version note:** Kobak *delves* r = **28.0** (published Science Advances); arXiv v1 said 25.2.
Both circulate; cite 28.0.

### Tier 1 — strongest measured signal (ship with numeric citation)
| Word | Evidence | Src |
|------|----------|-----|
| delve/delves/delving | r=**28.0** PubMed; *delves* per-million 0.21→14.38 (**+6,697%**); +48% spoken | K,J,Y |
| meticulous | **34.7×** peer reviews; +59% YoY; +40% spoken | L,G,Y |
| meticulously | +137% YoY | G |
| intricate | **11.2×** peer reviews; +117% YoY | L,G |
| commendable | **9.8×** peer reviews; +83% YoY | L,G |
| underscore/underscores | r=**13.8**; per-million +904% | K,J |
| showcasing/showcases | r=**10.7**; ~20× (GPTZero) | K |
| potential | δ=**0.052** (largest style-word gap, 2024) | K |
| findings | δ=0.041 | K |
| crucial | δ=0.037 | K |
| advancements | per-million +278% | J |

### Tier 2 — measured but weaker/single-source
adept (+51% spoken), realm (+35% spoken), groundbreaking (+52% YoY), garnered, aligns/aligning,
pivotal, surpassing, boasts, comprehend, swift. Plus Kobak's labeled excess set: notably,
additionally, comprehensive, enhancing, insights, valuable, highlights, exhibited, particularly.

### Tier 3 — connectors (density-only, high human baseline)
additionally, notably, moreover, furthermore, particularly, significantly, importantly,
across, within, amid/amidst, akin.

### ⚠️ NO measured evidence (popular but unproven — flag as heuristic, lower weight)
**tapestry, testament, navigate/navigating, landscape, foster, leverage, robust, seamless,
nuanced, multifaceted, holistic, vibrant, beacon, encompass.** Do NOT attach frequency
numbers to these.

### ⚠️ Debunked
- The "Nigerian RLHF annotators → 'delve'" story is anecdotal and **contradicted** by Juzek &
  Ward (no elevation in Nigerian English). Origin was a Guardian column, not data. Don't repeat.
- Liang peer-review paper only quantifies **three** words (meticulous 34.7×, intricate 11.2×,
  commendable 9.8×); any "×N" for innovative/notable/versatile/pivotal/invaluable from that
  paper is **fabricated** — its other lists are unranked word clouds.

### Authoritative POS-labeled list (USE THIS as the seed allow/deny list)
Kobak's manual style/content labels for ~900 words: **`github.com/berenslab/chatgpt-excess-words`**
→ `results/excess_words.csv`. Use it instead of guessing POS; only flag **style** words
(verbs/adj/adv), never content nouns (Covid-era nouns hit r>1000 with zero AI involvement).

### How to weight (critical)
1. Single word = noise; **density** per 1k words is the signal. (Originality.ai: even in real
   ChatGPT output these words are rare in absolute terms — the ratios are *relative over-use*.)
2. Weight by measured ratio: Tier 1 (r≈10–28) ≫ Tier 2 ≫ Tier 3 ≫ no-evidence heuristics.
3. **Co-occurrence multiplies confidence super-linearly** — N distinct style words in a window
   is near-conclusive (joint probability of multiple rare style words in human text is tiny).
   Gray: "intricate + meticulous" pairing rose 468%.
4. Phrase-level measured tells (GPTZero, ~3.3M texts): "crucial role in shaping" **182×**,
   "notable works include" **120×**, "in today's fast-paced world" **107×**, "aims to explore" **50×**.

---

## 2. AI-writing taxonomy (Wikipedia:Signs of AI writing + tropes.fyi + Reuters)

Tags: **DET** regex/wordlist · **DENSITY** rate-gated · **HARD** needs semantics (deterministic
approximation given). Sources: [WP](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing) ·
[tropes.fyi](https://tropes.fyi) · [Grammarly](https://www.grammarly.com/blog/ai/common-ai-words/) ·
[Reuters Institute](https://reutersinstitute.politics.ox.ac.uk/news/how-ai-generated-prose-diverges-human-writing-and-why-it-matters).

### Highest-precision (ship first)
- **Chatbot artifacts (DET, ~0 FP):** "As an AI language model", "I hope this helps", "Certainly!",
  "Is there anything else", "Here's the revised/updated", knowledge-cutoff disclaimers ("as of my
  last update", "I don't have access to real-time"), leftover placeholders `[insert X]`, `[Your Name]`,
  "In this essay I will". WP §"Communication intended for the user."
- **"Despite challenges… continues to" closer (DET, distinctive):** `despite (its|these|the) … (challenges|difficulties)` + `continues to (thrive|evolve|grow|serve)`. WP §Outline-like conclusions; tropes.fyi.
- **Negative parallelism (DET, tropes.fyi's #1 named tell):**
  - `(not just|not only) … (but|it's)` · `it's not … , it's …` · `Not X. Not Y. Just Z.` · `X rather than Y`
- **Significance/legacy boilerplate (DET phrase list):** "stands as a testament", "marking a pivotal
  moment", "leaving an indelible mark", "enduring legacy", "key turning point", "plays a (vital|crucial|
  pivotal|key) role". WP §Undue emphasis on significance.
- **Canned media-coverage emphasis (DET):** "featured in … and other prominent outlets", "profiled in",
  "maintains a strong (social media|digital) presence". WP §Canned emphasis on notability.

### Other lexical/cadence
- **"Serves as" copula avoidance (DET):** `serves? as`, `stands? as`, `refers to`, `exemplifies`,
  `represents a` where "is" would do. WP; tropes.fyi "Serves As Dodge."
- **Editorializing emphasis (DET):** "it's important to note", "it is worth noting", "it should be
  noted", "a key takeaway is", "this underscores/highlights the importance of".
- **Promotional puffery (DET+DENSITY):** nestled, in the heart of, rich (cultural) heritage,
  breathtaking, must-visit, vibrant, renowned, groundbreaking, diverse array, natural beauty.
- **Conversational scaffolding (DET):** "let's delve into", "let's break this down", "think of it
  as/like", "imagine a world where", "to put it simply", "at its core".
- **Vague attribution (DET, confirm no citation nearby):** "experts argue", "observers have cited",
  "industry reports", "some critics argue", "it is widely interpreted", "efforts are ongoing to",
  "studies show". WP §Vague attributions.
- **Rule of three / tricolon (DENSITY):** `X, Y, and Z` adjective/short-phrase triads above rate.
- **Superficial -ing participle analysis (DENSITY):** clause-final `, (highlighting|underscoring|
  emphasizing|reflecting|symbolizing|contributing to|fostering|ensuring) …`. WP §Superficial analyses.
- **Future-outlook speculation (DET):** "the future of … lies in", "evolving landscape", "continues
  to evolve", section titles "Future Outlook"/"Challenges and Legacy".
- **Transition-word overuse (DENSITY):** paragraph-initial Additionally/Moreover/Furthermore/However.
- **Interrogative-then-answer (DET):** "The result? Devastating.", "Here's the kicker."
- **Hedge softeners (DENSITY):** "generally speaking", "broadly speaking", "to some extent", "tends to".

### Formatting (all DET unless noted)
- Em-dash overuse (DENSITY): U+2014 rate. (GPTZero preprint: GPT-4.1 ~10.6/1k vs human ~3.2/1k — provisional.)
- Boldface overuse (DENSITY): `**…**` per section, esp. in running prose.
- **Inline-header vertical lists (DET):** `^\s*[-*•]\s*\*\*[^*]+\*\*\s*:` — WP:AILIST.
- Title Case headings (DET): heading with ≥2 capitalized non-minor words.
- Curly quotes (DET): `[‘’“”]` in ASCII contexts.
- Markdown/markup artifacts leaking into plain text (DET).
- Emoji in formal text (DET): emoji unicode ranges.
- Thematic break `---` immediately before a heading (DET).
- Skipped heading levels (DET); bulleted-list overuse (DENSITY: list lines / prose lines).

### HARD (deterministic approximations)
- **Elegant variation** (synonym-cycling for one entity): approx = chains of distinct abstract NPs
  in adjacent sentences without verbatim noun repetition. Tag advisory.
- **Fractal summaries / restatement** (intro≈body≈conclusion): approx = high n-gram overlap between
  first and last paragraphs/headings; verbatim duplication is exact-match DET.
- **Grandiosity / stakes inflation:** DET trigger `(fundamentally|radically|forever) (reshape|change|
  redefine)`, `(game-?chang|paradigm shift|usher in a new era)`; full detection HARD.
- **False balance** ("has generated debate", "raises questions about"): DET trigger + confirm no
  citation follows.
- **Uniform section templating:** structural — repeated heading-name templates / equal-length sections
  each ending in a significance sentence.

### Negative signals (LOWER AI probability — useful for not-firing)
Contractions, slang, genuine passive-voice variation, first-person anecdote. Reuters notes AI prose
*avoids* contractions/slang — their presence should discount slop scoring.

---

## 3. Style-guide rule packs (Microsoft + Google) — concrete & encodable

Sources: [Microsoft Writing Style Guide](https://learn.microsoft.com/style-guide/) ·
[Google dev docs style guide](https://developers.google.com/style/) (CC BY 4.0 text).

### Resolved (these settle our open questions)
- **Oxford/serial comma: BOTH REQUIRE it.** Not a disagreement. → one shared rule, default on.
- **Contractions: BOTH ENCOURAGE** common contractions, BOTH ban awkward/3-word forms. → shared rule.
- **Also agree:** sentence-case headings, second person, active voice, present tense, no "please"
  in instructions, "to" over "in order to", singular they.

### Genuine MS↔Google divergences (encode per-pack, not shared)
| Topic | Microsoft | Google |
|-------|-----------|--------|
| terminate | avoid → close/exit | acceptable for processes/connections |
| via | unspecified | acceptable in technical contexts |
| easy/simple/just/currently/new/latest | no ban | **explicit ban** (G-only rule) |
| "you can" | delete it | permitted |
| numbers spell-out (0–9 / numerals 10+) | detailed rules | not emphasized |
| heading gerunds ("Creating…") | allowed | **prohibited** (use infinitive) |
| exclamation points | sparingly | avoid |
| hit | → select/press | → click/press/type |

### Microsoft mechanical rules (rule-id → trigger)
ms-sentence-case-headings, ms-no-all-caps, ms-no-end-punct-headings, ms-oxford-comma,
ms-one-space-after-period, ms-no-space-em-dash (MS wants `word—word`, no spaces),
ms-use-contractions, ms-no-noun-verb-contraction, ms-second-person, ms-omit-you-can,
ms-avoid-we, ms-active-voice, ms-present-tense, ms-start-with-verb (cut "there is/are"),
ms-spell-out-0-9, ms-no-numeral-sentence-start, ms-numerals-for-measure, ms-comma-in-numbers,
ms-no-kmb ($30M→$30 million), ms-leading-zero, ms-acronym-first-use, ms-no-single-use-acronym.

### Google mechanical rules
goog-sentence-case-headings, goog-no-heading-period, goog-no-gerund-heading, goog-no-link-in-heading,
goog-no-skipped-heading, goog-second-person, goog-active-voice, goog-present-tense, goog-no-please,
goog-no-eg, goog-no-ie, goog-no-etc, goog-no-easy (easy/simple/just/quick), goog-no-abbr-as-verb
("ssh into"→"use SSH to"), goog-serial-comma, goog-singular-they, goog-no-exclamation,
goog-american-spelling, goog-no-preannounce (currently/eventually/latest/new/now),
goog-no-directional (above/below→preceding/later), goog-descriptive-links (no "click here").

### Master word-choice swap map (deduped; "Both" = high confidence)
The **full A–Z is the Google word list** (https://developers.google.com/style/word-list) — treat it
as the master table. High-confidence shared subset:

```
utilize / make use of   -> use            (Both)
in order to             -> to             (Both)
leverage (verb)         -> use            (Both)
since (causal)          -> because        (Both)
impact (verb)           -> affect         (Both)
e.g.                    -> for example    (Both)
i.e.                    -> that is        (Both)
etc. / and so on        -> rephrase/such as (Both)
please (instructions)   -> omit           (Both)
abort                   -> stop/cancel/end (Both)
execute (when run fits) -> run            (Both)
hit                     -> click/press    (Both)
log in / login / log on -> sign in        (Both)
check box               -> checkbox       (Both)
e-mail                  -> email          (Both)
above / below (xref)    -> preceding/earlier / following/later (Both)
allows/enables you to   -> lets you / rewrite (Both)
deselect                -> clear          (Both)
grayed out              -> unavailable    (Both)
and/or                  -> or / rephrase  (Both)
Internet / Web (cap)    -> internet / the web (Both)
easy/simple/simply/just/quick -> remove/rephrase (Google)
currently/eventually/latest/new/now/presently -> remove or give version (Google)
click on / click here   -> click / descriptive link text (Google)
comprise                -> consist of/contain (Google)
toggle (verb)           -> switch/turn on/off (Microsoft)
```

### Inclusive (bias-free) from both guides — see §6 for the full merged list.

---

## 4. Prior art + license matrix (we are Apache-2.0)

| Tool | Approach | License | Reuse? |
|------|----------|---------|--------|
| **proselint** | regex/wordlists, 70+ checks | **BSD-3** | ✅ richest borrowable corpus (clichés, jargon, weasel, redundancy, Latinisms) |
| **write-good** | regex/wordlists, 9 rules | **MIT** | ✅ passive/weasel/wordy/adverb/thereIs/illusion/cliches |
| **alex / retext-equality / retext-profanities** | YAML term data | **MIT** (© Titus Wormer) | ✅ best-curated inclusive-language data (`data/en/*.yml`) |
| **retext plugins** (passive, simplify, intensify, redundant-acronyms, repeated-words, indefinite-article, quotes, readability) | unified AST | **MIT** | ✅ logic + lists |
| **Vale + Microsoft/Google styles** | YAML over Go engine | **MIT** (rule files) | ✅ YAML rules reusable; don't copy guide *prose* (MS proprietary; Google CC BY) |
| **textlint** ecosystem | AST plugins | **MIT** | ✅ engine + most rules |
| **LanguageTool** | XML patterns + POS + n-gram | **LGPL-2.1+** | ⚠️ reimplement grammar rules or shell out as external; don't vendor its XML |

**Reuse plan:** seed Family A/B lexicons from proselint (BSD-3) + write-good (MIT); seed Family D
from retext-equality (MIT) + Inclusive Naming `index.json`; mirror Vale MS/Google YAML for Family C.
Preserve license notices. Reimplement anything LanguageTool-class.

### What NONE of them do (our differentiation — confirmed whitespace)
1. **AI-slop-specific rules** (delve-density, "boasts a rich tapestry", "it's important to note",
   negative parallelism, "Despite challenges… continues to", em-dash-as-LLM-signature). proselint/
   write-good predate LLMs; alex is sensitivity-only.
2. **Harness-native hooks** (agent post-edit/pre-write lint). None are agent-loop-aware.
3. **Agent skill packaging** — an LLM self-linting mid-generation. None ship as an invokable skill.

Distinct check types across all prior art = **39** (lexical flags, grammar/POS, structural,
punctuation/typography, inclusive, statistical/readability, IO/dead-link). Our 56 cover Families
A–E; confirmed gaps to consider adding: **readability metrics** (have: `reading-grade`),
**Hunspell spelling** (out of scope v1), **dead-link checking** (candidate), **a/an indefinite
article** (candidate), **redundant acronyms** "ATM machine" (candidate → fold into `redundant-pair`).

---

## 5. Readability, passive voice, concision — implementable specs

### Readability formulas (ship FKGL headline + Coleman-Liau/ARI syllable-free cross-check)
```
ASL = W/S ; ASW = Sy/W
FRE  = 206.835 − 1.015·ASL − 84.6·ASW              # higher=easier
FKGL = 0.39·ASL + 11.8·ASW − 15.59                 # US grade  ← headline
Fog  = 0.4·(ASL + 100·complexWords/W)              # complex = ≥3 syllables
SMOG = 1.0430·sqrt(polysyll·30/S) + 3.1291         # needs ~30 sentences
CLI  = 0.0588·(letters/W·100) − 0.296·(S/W·100) − 15.8   # syllable-free
ARI  = 4.71·(chars/W) + 0.5·ASL − 21.43            # syllable-free, ceil to grade
```
Pair FKGL with CLI/ARI: large FKGL–CLI disagreement = syllable heuristic misfired on that text.

**Per-register grade ceilings (config):** plain/gov FKGL ≤ 8 (FRE ≥ 60) · marketing/consumer 7–9 ·
news 9–11 · technical docs 10–12 · specialist ≤ 14 (flag >16). Health content: 6–8 (CDC/AMA).

**Sentence splitting:** split on `/[.!?]+(?=\s|$)/`; mask abbreviations (Mr. Dr. vs. etc. e.g. i.e.
Inc. No. U.S.) and decimals `\d\.\d` first; `:`/`;`/newlines are NOT boundaries; guard S≥1.

**Syllable heuristic** (~3–8% word error after corrections — fine for aggregate scoring, not
per-word display): exception table → strip silent `-e`/`-es`/`-ed` → count vowel groups
`[aeiouy]{1,2}` → `+1` for consonant+`-le`/`-les` → min 1. Add `-ted`/`-ded` keep +1; hiatus
`ia/io/ua/eo` +1. Seed `SYLLABLE_EXCEPTIONS` (simile:3, every:2, business:2, different:3,
interesting:3, comfortable:3, vegetable:3, family:3, february:4, area:3, idea:3, being:2,
science:2, evening:2, …); grow by diffing CMUdict offline.

### Passive voice without POS (write-good/Hemingway heuristic)
`(am|is|are|was|were|be|been|being)` + optional `(\w+ly|not|been|being){0,2}` + `(\w+ed | IRREGULAR)`.
**Irregular past-participle list (~190)** to maintain: arisen, awoken, beaten, become, begun, bent,
bound, bitten, bled, blown, broken, brought, built, bought, caught, chosen, come, cost, crept, cut,
dealt, dug, done, drawn, driven, drunk, eaten, fallen, fed, felt, fought, found, fled, flown,
forbidden, forgotten, forgiven, frozen, gotten, given, gone, ground, grown, hung, heard, hidden,
hit, held, hurt, kept, known, laid, led, left, lent, let, lain, lit, lost, made, meant, met, paid,
put, read, ridden, rung, risen, run, said, seen, sought, sold, sent, set, shaken, shed, shone, shot,
shown, shrunk, shut, sung, sunk, sat, slept, slid, sworn, swept, swum, swung, taken, taught, torn,
told, thought, thrown, thrust, trodden, understood, woken, worn, woven, wept, wound, won, withheld,
written, undergone, withdrawn, foreseen, redone, rewritten, misunderstood (+ zero-change ambiguous:
read, cut, put, set, cost, hit, let, spread, bet, shut, hurt, burst, cast, quit, bid, rid, wed, shed,
split, slit — keep but down-weight).
**FP reduction (apply in order):** (1) adjectival-participle stoplist (is interested/located/excited/
concerned/based on/related to/limited/done/born…) suppress unless `by`-agent; (2) `by` within ~4
words → boost to true passive; (3) following `in/about/with/at/of` → down-weight (predicate adj);
(4) down-weight zero-change irregulars. Report as **% of sentences with passive**; target <10–15%.
Ship as *suggestion* with confidence, not hard error (~10–20% residual FP on natural prose).

### Plain-language swaps (PLAIN/plainlanguage.gov + GOV.UK; apply longest-phrase first)
Wordy phrases: "due to the fact that"→because · "in the event that"→if · "at this point in time"→now ·
"in order to"→to · "has the ability to"/"is able to"→can · "a number of"→some/many · "in regard to"/
"pertaining to"/"relative to"→about · "prior to"→before · "subsequent to"→after · "with the exception
of"→except for · "in accordance with"→under/per · "for the purpose of"→to.
Complex words: utilize→use · facilitate→help · commence→start · endeavor→try · ascertain→find out ·
demonstrate→show · numerous→many · sufficient→enough · terminate→end · methodology→method ·
leverage→use · optimum→best · remuneration→pay · disseminate→send.
Redundancy pairs (drop bracketed): [absolutely] essential · [end] result · [free] gift · [past]
history · [future] plans · [each and] every · [first and] foremost · [new] innovation · [exact] same ·
[various] different · [ATM] machine · [PIN] number · [general] consensus.
Nominalizations (detect light-verb + `-tion/-ment/-ance/-ence/-ity/-sion` and suggest the verb):
"make a decision"→decide · "conduct an investigation"→investigate · "provide assistance"→assist ·
"give consideration to"→consider · "perform an analysis"→analyze · "reach a conclusion"→conclude.

### Burstiness (pure stat, no model)
Over per-sentence word counts: CV = SD/mean (scale-independent). Human engaging prose CV ≈ 0.5–0.8+;
flag CV < **0.25** as "uniform sentence rhythm." Report mean sentence length too (target ~15–20 words;
nudge sentences >25). **Weak stylistic nudge, never a verdict** (tech/reference/translated prose is
naturally low-variance). Feeds the `cadence` command.

---

## 6. Inclusive-language term lists (with severity + scoping)

Backbone data (reusable): retext-equality `data/en/{ablist,gender,race,misc}.yml` (MIT) +
Inclusive Naming `inclusivenaming.org/word-lists/index.json` + Google/Microsoft tables.
Encode each as `{pattern, replacements[], reason, source, severity, scope, exemptions[]}`.

### Ableist — WARN
crazy/insane/nuts/psycho/mental(metaphor)→baffling/intense · insanely→incredibly ·
sanity check→confidence check/validation · sane(value)→valid/correct · lame→weak/dull ·
dumb→foolish/(literal)nonverbal · dummy→placeholder/stub · blind to/deaf to→unaware of/ignoring ·
tone-deaf→insensitive · cripple(d)→impair/degrade · OCD/bipolar/schizophrenic(metaphor)→meticulous/
volatile/inconsistent · suffers from/victim of/wheelchair-bound→has X/uses a wheelchair (person-first).
Scope: only metaphorical "blind to/deaf to", not literal "blind users"; skip code spans; "sanity
check"/"sane" idiomatic in CS → WARN not error.

### Gendered — WARN
chairman→chair · mankind→humanity · manpower→workforce · man-hours→person-hours · manned→staffed/
crewed · man-made→synthetic · "man the X"→staff/operate · guys→everyone/folks · salesman/spokesman/
foreman/policeman/fireman/mailman→neutral · layman→layperson · middleman→intermediary · freshman→
first-year · he/she·s/he·generic he→singular they/role. Scope: curated `-man` compound whitelist (NOT
blanket `*man` — exempt human/manage/manual/command/Germany/semantic); "guys" only as collective
address; generic-pronoun only for indefinite role antecedents; allow gendered pronouns for real people.

### Racialized / tech-historical — WARN (master/native/primitive/tribe = ADVISORY, high FP)
blacklist/whitelist→blocklist/allowlist · master/slave→primary/replica · master(branch/node)→main ·
grandfathered→legacy/exempt · blackhat/whitehat→unethical/ethical hacker · first-class citizen→fully
supported · tribe→team/group · spirit animal→inspiration · powwow→meeting · off the reservation→out
of line. Scope: exempt "master's degree/master copy/mastermind/Scrum Master/webmaster"; never flag
capitalized "Native"; "primitive type"/"native app"/"native speaker" exempt; allow code spans.

### Violent/aggressive tech metaphors — ADVISORY (off by default for code; user-docs only)
abort→stop/cancel · kill(process)→stop/end · hang→stop responding · hit(endpoint)→call/request ·
pull the trigger→proceed · blast radius→scope of impact · man-in-the-middle→on-path/adversary-in-the-
middle · DMZ→perimeter network. Scope: **suppress inside code/identifiers** (kill -9, AbortController,
SIGABRT, cache hit, page hits); contested across guides → individually toggle-able.

### Other (ageist/classist/cultural) — ADVISORY
ghetto(adj)→makeshift · gypsy/gypped→Roma/cheated · oriental(people)→Asian · eskimo→Inuit ·
"long time no see"/"no can do"→plain English · totem pole(rank)→junior · the elderly→older adults ·
third-world→developing/specific region · illegal immigrant→undocumented immigrant · "cattle not
pets"→managed/unmanaged instances. Scope: full-phrase matches not single tokens; exempt code +
established bigrams (IllegalArgumentException, native code, poor signal).

**Universal scoping (cut noise):** skip fenced/inline code, identifiers, URLs, paths; skip capitalized
proper nouns; prefer phrase matches for idioms; per-term exemption bigrams; allow quotes/citations to
bypass; suggest, never auto-fix (pronoun rewrites are context-sensitive); make contested terms
(abort/kill/master/native/sanity check) individually toggle-able.

---

## 7. What changed vs the design docs (action items)

- **Resolved open question:** Oxford comma + contractions — MS & Google AGREE; encode as shared
  rules, default on. (Updated in README.md open questions.)
- **New high-value candidate rules** to add to `02-detector-rules.md` Family A: `serves-as-copula`,
  `despite-challenges-closer`, `significance-boilerplate`, `media-coverage-boilerplate`,
  `superficial-ing-participle`, `future-outlook-speculation`, `interrogative-answer`. These are
  DET, high-precision, and uniquely AI (none in prior-art tools).
- **Weighting:** `overused-word` must be density+co-occurrence weighted by measured ratio, seeded
  from the berenslab CSV; never fire on first hit; separate the no-evidence heuristic words at lower
  weight.
- **Reuse/licensing** decided (§4): seed lexicons from proselint/write-good/retext-equality; mirror
  Vale YAML; reimplement LanguageTool-class grammar.
- **Readability:** ship FKGL + CLI/ARI cross-check; per-register ceilings in §5.
- **Inclusive language:** adopt severity + scoping from §6 (master/native/abort/kill = advisory/
  toggle to control false positives).
