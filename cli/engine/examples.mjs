// One-shot fix exemplars per rule. Surfaced with findings (the hook, audit) so an agent rewriting
// the text has a concrete bad→good to follow instead of guessing from a terse message. Kept short
// and opinionated — they encode the *preferred* fix (e.g. for listicles: strip the bold lead-in
// and keep the list; don't blindly prosify a reference doc).

export const FIX_EXAMPLES = {
  // ---- Family A: AI-slop ----
  'bold-lead-in-list': {
    bad: '- **Fast**: loads in under a second\n- **Secure**: encrypts every field',
    good: '- Fast — loads in under a second\n- Secure — encrypts every field',
    note: 'Strip the bold lead-in; keep the list. Only prosify if the items are really sentences.',
  },
  'overused-word': { bad: 'We delve into the rich tapestry of the design.', good: 'We examine the design closely.' },
  'marketing-buzzword': { bad: 'Our platform empowers seamless, world-class synergy.', good: 'Our platform syncs your data automatically.' },
  'manufactured-contrast': { bad: "It's not just a linter — it's a design system.", good: "It's a linter with a built-in style system." },
  'cliche-opener': { bad: "In today's fast-paced world, deadlines slip.", good: 'Deadlines slip when scope grows.' },
  'conversational-scaffolding': { bad: 'Think of it like construction: pour the foundation first.', good: 'Pour the foundation first.' },
  'emoji-decoration': { bad: '✅ Do this\n❌ Not that', good: 'Do this, not that.', note: 'Drop the emoji; state it in words.' },
  'tricolon-overuse': { bad: 'It is fast, simple, and powerful, with clean, modern, and flexible APIs.', good: 'It is fast and powerful, with a clean API.', note: 'One triad is fine; the reflex is the tell.' },
  'em-dash-overuse': { bad: "It's fast — really fast — and simple.", good: "It's fast and simple." },
  'conclusion-restate': { bad: 'In conclusion, the approach works well.', good: 'The approach cut our build time by 40%.' },
  'significance-boilerplate': { bad: 'It stands as a testament to careful engineering.', good: 'It has shipped without a regression for two years.' },
  'vague-attribution': { bad: 'Studies show short sentences read faster.', good: 'A 2024 Nielsen study found short sentences read 20% faster.' },
  'sycophancy': { bad: 'Great question! Here is the answer.', good: 'Here is the answer.' },
  'assistant-meta': { bad: 'As an AI language model, I hope this helps!', good: '(remove it entirely)' },
  'hedge-overuse': { bad: 'It could be argued that this is, to some extent, faster.', good: 'This is faster.' },
  'excessive-bold': { bad: 'This is **really** the **most** important **thing** to know.', good: 'This is the most important thing to know.' },
  'listicle-reflex': { bad: '- fast\n- small\n- clean', good: 'It is fast, small, and clean.', note: 'Short fragments that are really one sentence → make them a sentence.' },
  'uniform-cadence': { bad: 'It is fast. It is small. It is clean. It is cheap.', good: 'It is fast and small. Clean, too — and cheap to run.', note: 'Vary sentence length.' },

  // ---- Family B: clarity ----
  'passive-voice': { bad: 'The cache was cleared by the nightly job.', good: 'The nightly job clears the cache.' },
  'long-sentence': { bad: '(a 40-word sentence stacking clauses)', good: 'Split it at the natural break into two sentences.' },
  'wordy-phrase': { bad: 'We restarted it in order to apply the change.', good: 'We restarted it to apply the change.' },
  'nominalization': { bad: 'The team will make a decision tomorrow.', good: 'The team will decide tomorrow.' },
  'there-is-expletive': { bad: 'There are several bugs that block the release.', good: 'Several bugs block the release.' },

  // ---- Family C: style ----
  'no-space-em-dash': { bad: 'the build — slow as it is — passed', good: 'the build—slow as it is—passed' },
  'sentence-case-heading': { bad: '## A Comprehensive Overview Of The System', good: '## A comprehensive overview of the system' },
  'word-swap': { bad: 'We leverage the e-mail pipeline.', good: 'We use the email pipeline.' },
  'ap-serial-comma': { bad: 'We shipped docs, tests, and code.', good: 'We shipped docs, tests and code.', note: 'AP omits the serial comma.' },
  'ap-number-style': { bad: 'The release closed 9 issues.', good: 'The release closed nine issues.', note: 'AP spells out zero through nine.' },
  'chicago-number-style': { bad: 'The group has 42 members.', good: 'The group has forty-two members.', note: 'Chicago spells out zero through one hundred.' },
  'plain-long-sentence': { bad: '(a 22-word sentence)', good: 'Split it so each sentence stays under 20 words.' },
  'emphasis-as-heading': { bad: '**Configuration**\n\nSet the value.', good: '## Configuration\n\nSet the value.', note: 'A bold line as a header → a real heading.' },
  'bare-url': { bad: 'See https://example.com for details.', good: 'See [the docs](https://example.com) for details.' },
  'fenced-code-language': { bad: '```\nnpm install\n```', good: '```bash\nnpm install\n```', note: 'Add a language hint to the fence.' },
  'duplicate-heading': { bad: '# Setup … # Setup', good: '# Setup … # Teardown', note: 'Make repeated headings unique.' },
  'hype-intensifier': { bad: 'This greatly simplifies a crucial workflow.', good: 'This removes two manual steps from the workflow.', note: 'Replace the magnifier with the concrete benefit.' },
  'acronym-case': { bad: 'Run the DDL; then edit the ddl file.', good: 'Run the DDL; then edit the DDL file.' },
  'acronym-plural': { bad: "Register your UDF's here.", good: 'Register your UDFs here.', note: "Apostrophe only for the possessive." },
  'inconsistent-capitalization': { bad: 'The Catalog Store holds it; update the catalog store.', good: 'The catalog store holds it; update the catalog store.' },
  // ---- Vale-parity pack ----
  "microsoft-auto-hyphenation": { bad: "auto-correct", good: "autocorrect", note: "Vale Microsoft.Auto flags hyphenated auto- prefixes (token auto-\\w+); Mari ports it as a custom regex scan over ctx.masked." },
  "microsoft-avoid-words": { bad: "backend", good: "server", note: "Vale Microsoft.Avoid is an existence wordlist with some regex tokens (app(?:lication)?s? developer, etc.); ported as a single custom alternation regex preserving the embedded Vale patterns." },
  "microsoft-contractions": { bad: "cannot", good: "can't", note: "Vale Microsoft.Contractions is a substitution map encouraging contractions. The lookahead-gated entries (it is, that is, etc.) that Vale suppresses before a period/comma are honored via the GATED set so sentence-final 'It is.' does not fire." },
  "ms-adverb-hyphen": { bad: "a fully-qualified domain name", good: "a fully qualified domain name", note: "Don't hyphenate an -ly adverb to the word it modifies." },
  "ms-negative-number-endash": { bad: "a balance of -20.50 dollars", good: "a balance of –20.50 dollars", note: "Use an en dash (–), not a hyphen, to form negative numbers." },
  "ms-ordinal-ly": { bad: "Secondly, configure the settings.", good: "Second, configure the settings.", note: "Use first, second, third — not firstly, secondly, thirdly." },
  "ms-suspended-hyphen": { bad: "anti- and pro-government groups", good: "antigovernment and progovernment groups", note: "Fires on the 'word- and word-' suspended-hyphen construction; spelling each word out in full does not raise it." },
  "ms-term-swaps": { bad: "The adaptor list is in the appendixes, available 24/7.", good: "The adapter list is in the appendices, available every day.", note: "Ported from the substitution swap as a literal-key mapRule. Regex-alternation keys were expanded into literal entries (e.g. (?:mobile|smart) ?phone -> 'smart phone'/'smartphone'/'mobile phone'). The bare unit abbreviations (kb/mb/gb/tb/pb/eb/zb), 'caap', 'agent', 'the cloud', and 'alphabetic' were dropped: mapRule matching is case-insensitive and not word-bounded, so they would fire on the already-correct forms (e.g. 'GB', 'alphabetical')." },
  "ms-url-of": { bad: "Paste the URL for the page.", good: "Paste the URL of the page.", note: "Direct port of the single-entry substitution swap 'URL for' -> 'URL of' (use 'of', not 'for', to relate a URL to a resource)." },
  "google-ordinal": { bad: "Read the 3rd chapter.", good: "Read the third chapter.", note: "Numeric ordinal suffixes (st/nd/rd/th) should be spelled out." },
  "avoid-first-person-plural": { bad: "We built this so we could ship faster.", good: "This ships faster.", note: "Vale Google.We is an existence wordlist over we/we've/we're/our(s)/us/let's. These are common English words, so the port gates on density (>=2 hits) per anti-false-positive rules." },
  "avoid-will-future-tense": { bad: "The job will run nightly and will email a report.", good: "The job runs nightly and emails a report.", note: "Vale Google.Will is existence over the single token 'will'. Ported with word boundaries (so 'willing'/'goodwill' don't match) and density gating because 'will' is extremely common." },
  "google-word-list": { bad: "Click on the Wifi icon to sign into the dev console.", good: "Click the Wi-Fi icon to sign in to the API console.", note: "Vale Google.WordList is a substitution map whose keys are regexes. mapRule matches literal phrases (esc'd, case-insensitive, no word boundaries), so each regex alternation was expanded to literal keys and entries whose key is a substring of a common word or already-correct form (url, admin, synch, regex, open-source, application, above, touch, tablet, chapter) were dropped to prevent false positives." },
  "plain-hidden-verb": { bad: "The reviewer will make a recommendation by Friday.", good: "The reviewer will recommend a fix by Friday.", note: "Adds nominalizations not in L.NOMINALIZATIONS; all multiword so phraseList is low-FP." },
  "plain-shall": { bad: "The applicant shall submit the completed form.", good: "The applicant must submit the completed form.", note: "Custom wordList() gives \\b boundaries so 'marshall'/'marshalling' do not fire (listRule/phraseList would)." },
  "plain-required-to": { bad: "Users are required to verify their email address.", good: "Users must verify their email address.", note: "Plain guide: prefer 'must' over the wordy 'is/are required to'." },
  "plain-legalese-phrase": { bad: "Complete all checks prior to deployment, pursuant to the policy.", good: "Complete all checks before deployment, under the policy.", note: "Multiword legalese phrases; safe with phraseList. Single-word legalese handled by plain-legalese-word." },
  "plain-legalese-word": { bad: "All obligations described herein remain binding notwithstanding any change.", good: "All obligations in this contract remain binding despite any change.", note: "Custom wordList() gives \\b so 'herein' does not match inside 'wherein'/'therein' (phraseList would)." },
  "plain-double-negative": { bad: "This failure mode is not uncommon in production.", good: "This failure mode is common in production.", note: "Curated 'not + negated-adjective' list avoids FP traps like 'did not understand'/'not until'." },
};

export function fixExampleFor(ruleId) { return FIX_EXAMPLES[ruleId] || null; }
