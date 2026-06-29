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
};

export function fixExampleFor(ruleId) { return FIX_EXAMPLES[ruleId] || null; }
