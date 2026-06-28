# init — one-time project setup

Write the context files every later command reads. This is the blocker `context.mjs` routes to
on `NO_PRODUCT_MD`.

## Flow
1. **Ask the register** (pick one): docs / marketing / editorial / microcopy. This sets the bar
   for ceilings and tone.
2. **Ask the base style guide** (default **microsoft**; or google / ap / chicago / plain).
3. **Sample existing writing** — read 1–3 representative files (README, a docs page, UI strings)
   and infer the current voice in three adjectives. Don't impose a generic voice.
4. **Write `PRODUCT.md`** with: audience, register, voice (3-word personality), anti-references
   (what NOT to sound like), banned words, reading-grade target (if plain).
5. **Offer `STYLE.md`** — base style guide, terminology glossary (preferred term + forbidden
   variants), formatting rules, approved/forbidden phrasings.
6. **Offer the hook** — run `node cli/bin/cli.js install` (Claude Code post-edit hook).
7. **Recommend next commands** — usually `audit` then `deslop`.

## PRODUCT.md skeleton
```markdown
# PRODUCT
- Audience: <who reads this>
- Register: docs | marketing | editorial | microcopy
- Voice: <three adjectives>
- Anti-references: <brands/styles to avoid sounding like>
- Banned words: <project-specific>
- Reading-grade target: <n, or "n/a">
```

Write the file; don't lecture. Keep it short and specific to this project.
