# deslop — strip AI tells, rewrite in human voice (signature)

The reason the product exists. Rewrite — don't just delete — the statistically-measurable tells
of machine prose, preserving meaning and the project's voice.

## Flow
1. Run the detector first (`detect.mjs <target>`) and read the Family A findings.
2. Rewrite, targeting in priority order:
   - overused vocabulary (delve, tapestry, underscore, meticulous, …) → plain words
   - marketing buzzwords, cliché openers, manufactured contrast ("not just X — it's Y")
   - conclusion-restate, vague attribution, significance/legacy boilerplate
   - em-dash overuse, emoji decoration, bold-lead-in lists
   - assistant meta-phrases, sycophancy, transition/conversational scaffolding, listicle reflex
3. Keep the author's meaning and register. Replace, don't gut — a deslopped sentence should say
   the same thing in a human voice.
4. Re-run the detector; confirm Family A is quiet and nothing else regressed.

## Guardrails
- Don't flatten a real voice into generic plainness. Read a representative file first.
- A single "AI word" is noise; act on density and co-occurrence, which the detector already gates.
- Leans on: Family A (all) + `wordy-phrase`, `complex-word`.
