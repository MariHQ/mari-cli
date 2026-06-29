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
7. **Discover rules** — run `node cli/bin/cli.js rules discover --json`. It scans the repo for
   code↔docs couplings (API surface ↔ API docs, schema/migrations ↔ data-model docs, CLI ↔ usage
   docs, config/env ↔ config reference, monorepo packages ↔ per-package README). Also read the
   repo structure yourself and infer couplings the scan misses (e.g. a `proto/` dir paired with
   generated client docs, a public SDK entrypoint, a feature-flags file). For each candidate, show
   the user the paths + proposed notify message; let them keep/edit/drop it; add the accepted ones
   with `node cli/bin/cli.js rules add <name> --paths "…" --notify "…" [--exclude "…"]`. The point:
   when code changes, the hook reminds the agent to update the matching docs. Don't add a rule the
   user hasn't confirmed; skip this step if the repo has no clear code↔docs structure.
8. **Recommend next commands** — usually `audit` then `deslop`.

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
