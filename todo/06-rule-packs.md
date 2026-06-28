# Mari — Rule packs (Families C–F)

The data-driven rules mined from [03-research.md](03-research.md). These are the rules that
come straight from the style-guide tables, swap maps, inclusive-language data, formatting
taxonomy, and citation tells — far more than the curated AI-slop core in
[02-detector-rules.md](02-detector-rules.md). They're organized as **packs**: a base pack
selected per project (Microsoft/Google/AP/Chicago/plain) plus always-on packs (inclusive,
formatting, citations).

Same registry shape as 02 (`{id, category, name, description, method, severity, styleGated,
source}`). Severities: `error` (near-zero FP) / `warn` (strong) / `advisory` (context-dependent,
off in `--strict=false`). Seed lexicons from permissive prior art (proselint BSD-3, write-good
MIT, retext-equality MIT, Vale MS/Google YAML MIT — see 03 §4); preserve notices.

---

## Family C — Style-guide conformance

Two base packs (only one active at a time, set by `STYLE.md` / `detector.styleGuide`; default
`microsoft`) plus shared rules both guides agree on. AP/Chicago/plain are lighter packs (mainly
number style, serial comma, spelling).

### C-shared (both Microsoft & Google agree — always on for either base)
| id | method | sev | rule |
|----|--------|-----|------|
| `sentence-case-heading` | structural | warn | Headings in sentence case, not Title Case / ALL CAPS. |
| `heading-end-punctuation` | structural | warn | No terminal `. : ! ?` on headings / short list items. |
| `serial-comma` | regex | warn | Require the Oxford/serial comma in lists of 3+ (`X, Y and Z` → `X, Y, and Z`). |
| `use-contractions` | lexicon | advisory | Prefer common contractions (do not→don't); flag awkward/3-word forms (mightn't've). |
| `second-person` | regex | advisory | Prefer "you"; flag "the user (should)", "one should". |
| `active-voice` | heuristic | warn | Active voice default (shares the `passive-voice` engine, Family B). |
| `present-tense` | regex | advisory | Prefer present tense; flag needless "will/would". |
| `singular-they` | regex | warn | "he/she", "(s)he", "he or she", generic "he" → singular they. |
| `no-please-instructions` | regex | advisory | Drop "please" from instructions/UI. |
| `word-swap` | lexicon (map) | advisory | The master avoid→use word map (see C-data below). |

### C-microsoft (base = microsoft)
| id | method | sev | rule |
|----|--------|-----|------|
| `ms-no-internal-caps` | regex | advisory | No mid-word caps unless a brand (AutoScale→Auto scale). |
| `ms-no-space-em-dash` | regex | advisory | No spaces around em dash (`word—word`). |
| `ms-no-noun-verb-contraction` | regex | advisory | Don't contract noun+verb ("Microsoft's developing"→"is developing"). |
| `ms-omit-you-can` | regex | advisory | Drop "you can"; start with the verb. |
| `ms-avoid-we` | regex | advisory | Avoid first-person plural (we/us/our) in support/marketing. |
| `ms-start-with-verb` | regex | advisory | Cut "there is/are" openers (shares Family B `there-is-expletive`). |
| `ms-spell-out-0-9` | regex | advisory | Spell whole numbers 0–9 in prose; numerals 10+. |
| `ms-no-numeral-sentence-start` | regex | advisory | No numeral starting a sentence. |
| `ms-numerals-for-measure` | regex | advisory | Numerals for measurements/%/time even <10 (3 cm). |
| `ms-comma-in-numbers` | regex | advisory | Comma in 4+ digit numbers (1,024). |
| `ms-no-kmb` | regex | advisory | No K/M/B abbreviations ($30M→$30 million). |
| `ms-leading-zero` | regex | advisory | Leading zero before decimals <1 (0.5). |
| `ms-acronym-first-use` | structural | advisory | Spell out an acronym on first use; skip well-known (URL/USB/FAQ). |
| `ms-no-single-use-acronym` | structural | advisory | Don't define an acronym used only once. |

### C-google (base = google)
| id | method | sev | rule |
|----|--------|-----|------|
| `goog-no-gerund-heading` | structural | warn | No -ing first word in headings (use infinitive/noun). |
| `goog-no-link-in-heading` | structural | advisory | No links in headings. |
| `goog-no-eg` / `goog-no-ie` / `goog-no-etc` | regex | advisory | Latin abbreviations → "for example" / "that is" / rephrase. |
| `goog-no-easy` | lexicon | warn | Avoid easy/easily/simple/simply/just/quick/quickly (minimizing words). |
| `goog-no-abbr-as-verb` | regex | advisory | No acronyms as verbs ("ssh into"→"use SSH to log in to"). |
| `goog-no-acronym-periods` | regex | advisory | No periods in acronyms (A.P.I.→API). |
| `goog-no-exclamation` | density | advisory | Avoid exclamation points. |
| `goog-american-spelling` | lexicon | advisory | American spelling (colour→color, -ise→-ize). |
| `goog-no-preannounce` | lexicon | advisory | Drop currently/eventually/latest/new/now/presently (or give a version). |
| `goog-no-directional` | lexicon | advisory | above/below/higher/lower → preceding/later (for versions/UI). |
| `goog-descriptive-links` | structural (md) | warn | Descriptive link text; no "click here"/"here"/"read more" (shares Family D `vague-link-text`). |
| `goog-a-an-by-sound` | regex | advisory | a/an chosen by sound (a URL, an SQL). |

### C-data — the master word-swap map (one rule, big lexicon)
`word-swap` fires from a single deduplicated **avoid→use** table; the **full A–Z is the Google
word list** (https://developers.google.com/style/word-list), layered with Microsoft's entries.
High-confidence shared subset (encode first): utilize→use · in order to→to · leverage→use ·
since(causal)→because · impact(verb)→affect · e.g.→for example · i.e.→that is · etc.→rephrase ·
please→omit · abort→stop/cancel · execute→run · hit→click/press · log in/login→sign in ·
check box→checkbox · e-mail→email · above/below→preceding/following · allows you to→lets you ·
deselect→clear · grayed out→unavailable · and/or→or · Internet/Web(cap)→internet/the web.
Per-pack divergences (03 §3): `terminate`, `via`, `easy/simple/just`, "you can", number
spell-out — apply only under the matching base pack.

### C-ap / C-chicago / C-plain (light packs)
- `number-style` (AP: spell one–nine; Chicago: spell zero–one hundred) · `serial-comma` (AP:
  *omit* unless ambiguity — overrides C-shared when base=ap) · `oxford-default` (Chicago: require).
- `plain` pack tightens `reading-grade` ceiling to ≤8 and turns on all concision rules (Family B).

---

## Family D — Inclusive & accessible language

Always-on pack (independent of base style guide). Backbone data is reusable: retext-equality
`data/en/{ablist,gender,race,misc}.yml` (MIT) + Inclusive Naming `index.json` + Google/MS
tables. **Universal scoping to cut noise:** skip fenced/inline code, identifiers, URLs, paths;
skip capitalized proper nouns; prefer phrase matches for idioms; per-term exemption bigrams;
allow quotes/citations to bypass; suggest, never auto-fix; contested terms individually
toggle-able. Each rule = `{pattern, replacements[], reason, source, severity, scope, exemptions[]}`.

| id | sev | catches (avoid→preferred) | scoping note |
|----|-----|---------------------------|--------------|
| `ableist-language` | warn | crazy/insane/psycho→baffling · lame→weak · dumb→foolish · dummy→placeholder · cripple→degrade · tone-deaf→insensitive · OCD/bipolar(metaphor)→meticulous/volatile | only metaphorical "blind to/deaf to", not literal "blind users"; "sanity check"/"sane" idiomatic in CS = warn not error |
| `person-first-language` | warn | suffers from/victim of/wheelchair-bound/an epileptic → has X / uses a wheelchair / person with epilepsy | — |
| `gendered-language` | warn | chairman→chair · mankind→humanity · manpower→workforce · man-hours→person-hours · manned→staffed · salesman/spokesman/policeman→neutral · layman→layperson · middleman→intermediary | curated `-man` compound whitelist (NOT blanket `*man` — exempt human/manage/command/Germany) |
| `gendered-address` | advisory | guys→everyone/folks · Mrs./Miss (assumed)→Ms./omit | "guys" only as collective address; exempt the name "Guy" + quotes |
| `tech-historical-terms` | warn | blacklist/whitelist→blocklist/allowlist · master/slave→primary/replica · grandfathered→legacy · blackhat/whitehat→unethical/ethical · first-class citizen→fully supported | `master`/`native`/`primitive`/`tribe` = advisory (high FP); exempt "master's degree"/"Scrum Master"/"native speaker"/"primitive type"/capitalized "Native"; allow code spans |
| `violent-tech-metaphor` | advisory | abort→stop · kill→end · hang→stop responding · hit(endpoint)→call · blast radius→scope of impact · DMZ→perimeter network | **suppress inside code/identifiers** (kill -9, AbortController, cache hit, page hits); individually toggle-able; user-docs only |
| `ageist-classist-cultural` | advisory | ghetto→makeshift · gypsy/gypped→Roma/cheated · oriental→Asian · eskimo→Inuit · the elderly→older adults · third-world→developing · illegal immigrant→undocumented immigrant | full-phrase matches not single tokens; exempt historical/quoted contexts |

### Accessibility (text a11y — also always-on)
| id | sev | catches |
|----|-----|---------|
| `vague-link-text` | warn | "click here", "here", "read more", "this link" as link text (WCAG). |
| `skipped-heading` | warn | Heading levels skip (h1→h3); >1 h1. |
| `missing-alt-text` | warn | `![](...)` image with empty/missing alt; decorative must be explicit `![]`. |
| `all-caps-shouting` | advisory | Long all-caps runs (≥N words) — screen readers spell out. |

---

## Family E — Punctuation & formatting tells

From the AI-writing formatting taxonomy (03 §2) + typography rules. Mostly DET; density rules
gated by per-document rate. Markdown-aware (exclude code fences / inline code).

| id | method | sev | catches |
|----|--------|-----|---------|
| `em-dash-overuse` | density | warn | U+2014 (and ` -- `) rate per 1k words (human baseline ~3/1k; flag well above). |
| `smart-quotes` | regex | advisory | Curly quotes/apostrophes `[‘’“”]` where ASCII expected. |
| `emoji-decoration` | regex | warn | Emoji as bullets/section flair (✨🚀✅💡🎯) at line start or above density. |
| `bold-lead-in-list` | structural | warn | ≥K consecutive `- **Header**: text` items — WP:AILIST inline-header lists. |
| `excessive-bold` | density | advisory | `**…**` emphasis density per 100 words, esp. in running prose. |
| `title-case-heading` | structural | advisory | Title Case headings (overlaps `sentence-case-heading`; this is the slop framing). |
| `markup-leak` | regex | advisory | Markdown (`**bold**`, `*italics*`, backticks) leaking into plain-text/non-md context. |
| `thematic-break-before-heading` | regex | advisory | `---` immediately preceding a heading (AI scaffold). |
| `bullet-overuse` | density | advisory | Ratio of list lines to prose lines over threshold; prose answered as a bullet dump. |
| `transition-scaffolding` | density | advisory | Paragraph-initial Additionally/Moreover/Furthermore/However above rate. |
| `unicode-artifact` | regex | warn | Stray nbsp (U+00A0), narrow-nbsp (U+202F), zero-width (U+200B–200D/FEFF) — chatbot copy residue. |
| `double-space` | regex | advisory | Two spaces after a period (style-dependent; advisory). |
| `repeated-word` | regex | warn | Accidental adjacent duplicates ("the the"). |
| `redundant-acronym` | regex | advisory | "ATM machine", "PIN number", "LCD display" (from prior-art gap analysis). |
| `indefinite-article` | regex | advisory | a/an mismatch by sound (retext-indefinite-article logic). |

---

## Family F — Citations & references

From the WP "Citations" tells (03 §2 / round-2 agent 2). High value for docs/academic
registers; ties into Family G grounding (`fabricated-citation`).

| id | method | sev | catches |
|----|--------|-----|---------|
| `dead-link` | IO (opt-in) | warn | External link returns 404/unreachable. Network — opt-in (`--check-links`), off by default. |
| `malformed-doi-isbn` | regex | warn | DOI/ISBN that fails format validation; opt-in resolve-check flags non-resolving DOIs. |
| `tracking-param-in-citation` | regex | advisory | `utm_source=`/tracking params in cited URLs (copy-paste tell). |
| `citation-missing-page` | structural | advisory | Book/long-source citation with no page numbers or locator. |
| `unused-named-ref` | structural | advisory | A named reference declared but never used (markdown/wiki ref). |
| `fabricated-quote` | structural | warn | A quoted passage / citation not present in `FACTS.md` or `--source` (bridges to Family G). |
| `placeholder-citation` | regex | warn | "[citation needed]", "[source]", "[ref]", "(Author, Year)" placeholder left in text. |

---

## Register × pack matrix (which packs fire where)

| Register | Base style pack | Inclusive | Formatting (E) | Citations (F) | Grounding (G) |
|----------|-----------------|:---------:|:--------------:|:-------------:|:-------------:|
| docs | microsoft/google | ✅ | ✅ | ✅ | ✅ (if FACTS.md) |
| marketing | microsoft | ✅ | ✅ (looser bold) | — | ✅ |
| editorial | chicago/ap | ✅ | ✅ (em-dash relaxed) | ✅ | ✅ |
| microcopy | microsoft | ✅ | ✅ (strict length) | — | ✅ |
| academic | chicago | ✅ | ✅ | ✅ (strict) | ✅ (strict) |

Register defaults live in the register references (01-skills.md); users override per-rule via
`.Mari/config.json` and inline `<!-- Mari-disable id: reason -->`.

---

## Note on counts
Intentionally not maintaining a hard rule total here — the registry is the source of truth and
will grow as packs land. Families A–B (02), C–F (this doc), and G (05) together form the full
registry; the build assembles them from the lexicons/packs above.
