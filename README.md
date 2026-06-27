# Limpid

Editorial guidance for AI writing agents. 1 skill, 21 commands, live in-editor iteration, and 56 deterministic detector rules for AI-generated prose.

> **Quick start:** From your project root, run `npx limpid install`, then run `/limpid init` inside your AI coding or writing tool. Full docs: [limpid.style](https://limpid.style).

## Why Limpid?

Microsoft's [Writing Style Guide](https://learn.microsoft.com/style-guide/welcome/) and the [Google developer documentation style guide](https://developers.google.com/style) set the bar for clear, human prose. Limpid starts from there.

Every model trained on the same internet, then got RLHF'd toward the same register. Skip the guidance and you get the same handful of tells on every draft: *delve*, *tapestry*, *testament*, *underscore*; "In today's fast-paced world…"; "It's not just X — it's Y"; em-dashes everywhere; a tidy "In conclusion" that restates the intro; a bulleted list where a sentence would do. The vocabulary spike is measured, not vibes — *delve* and its cohort show large excess-frequency jumps in post-ChatGPT academic text ([Kobak et al., 2024](https://arxiv.org/abs/2406.07016); [Liang et al., 2024](https://arxiv.org/abs/2403.07183)).

Limpid is a **design system for text**. It adds:

- **One setup flow.** `/limpid init` writes `PRODUCT.md` and offers `STYLE.md`, so every later command knows the audience, register (docs / marketing / editorial / UX microcopy), voice, banned words, terminology, and which base style guide you write to (Microsoft, Google, AP, Chicago, plain language).
- **21 commands.** A shared editorial vocabulary with your AI: `deslop`, `tighten`, `sharpen`, `clarify`, `critique`, `audit`, `polish`, and more.
- **56 deterministic detector rules** plus an optional local ML pass. The CLI runs the deterministic rules with no model, no download, and no API key.

## What's Included

### The Skill: limpid

The skill installs as one command:

```bash
/limpid <command> <target>
```

Start every new project with:

```bash
/limpid init
```

`init` asks what register you're writing in (technical docs, product UI copy, marketing, or long-form editorial) and which base style guide governs the project, then writes editorial context that every later command reads.

### 21 Commands

All commands are accessed through `/limpid`:

| Command | What it does |
|---------|--------------|
| `/limpid draft` | Outline, then write a piece end-to-end in your voice |
| `/limpid init` | One-time setup: gather voice context, write PRODUCT.md and STYLE.md, configure the hook, recommend next steps |
| `/limpid document` | Generate a house STYLE.md from your existing writing |
| `/limpid outline` | Plan structure and argument before writing a word |
| `/limpid glossary` | Pull approved terms and phrasings into the style system |
| `/limpid critique` | Editorial review: argument, structure, clarity, voice |
| `/limpid audit` | Run mechanical checks (readability, grammar, inclusivity, link text) |
| `/limpid polish` | Final copyedit and style-system alignment before publishing |
| `/limpid deslop` | Strip the AI tells: buzzwords, clichés, cadence, em-dash overuse |
| `/limpid sharpen` | Make timid, hedged prose direct and confident |
| `/limpid soften` | Tone down hype and overclaiming |
| `/limpid tighten` | Cut wordiness, redundancy, and filler |
| `/limpid harden` | Edge-case copy: errors, empty states, microcopy, i18n |
| `/limpid voice` | Inject brand voice and personality into flat copy |
| `/limpid cadence` | Fix sentence rhythm, flow, and length variation |
| `/limpid format` | Fix headings, lists, emphasis, and markdown structure |
| `/limpid delight` | Add memorable, human touches |
| `/limpid clarify` | Rewrite unclear or confusing copy |
| `/limpid adapt` | Adapt a piece for a different channel (email, docs, social, UI) |
| `/limpid localize` | Prepare copy for translation and global English |
| `/limpid live` | In-place iteration: pick sentences in the editor, generate alternatives |

Use `/limpid pin <command>` to create standalone shortcuts (e.g., `pin deslop` creates `/deslop`).

#### Usage Examples

```
/limpid deslop README.md          # Strip AI tells from the readme
/limpid critique docs/intro.md    # Editorial review of the intro
/limpid tighten the changelog     # Cut the changelog down to essentials
/limpid clarify the error copy    # Rewrite confusing error messages
```

Or use `/limpid` directly with a description:
```
/limpid rewrite this paragraph so it sounds like a person
```

### Anti-Patterns

The skill includes explicit guidance on what to avoid — the recognizable tells of machine prose:

- Don't reach for the AI vocabulary spike (*delve, tapestry, testament, underscore, leverage, seamless, robust, realm, multifaceted*)
- Don't open with "In today's fast-paced world…" or "In the ever-evolving landscape of…"
- Don't manufacture contrast ("It's not just X — it's Y", "not only… but…")
- Don't close with an "In conclusion" that restates the intro
- Don't attribute vaguely ("studies show", "experts say", "many believe") without a citation
- Don't carpet the page with em-dashes, bold lead-ins on every bullet, or a list where a sentence works
- Don't hedge by reflex ("it's important to note that", "it could be argued that")

## See It In Action

Visit [limpid.style](https://limpid.style#casestudies) to see before/after rewrites of real AI-generated drafts — documentation, release notes, marketing copy, and UI microcopy.

## Installation

### Option 1: CLI installer (Recommended)

From the root of your project, run:

```bash
npx limpid install
```

This shows the harness folders it detected (for example `~/.claude`, `~/.codex`, or project-local `.cursor`), lets you keep the detected set or customize providers, then asks whether to install into the current project or globally. Use `--providers=claude,codex,cursor` and `--scope=project|global` to skip those choices in scripts. On Claude Code, Cursor, and Codex, it also installs the provider-native hook manifest for the current project. Works with Cursor, Claude Code, Gemini CLI, Codex CLI, and every other supported tool. Reload your harness afterward.

To refresh an existing install, run:

```bash
npx limpid update
```

Codex users should open `/hooks` after install or update and approve the project hook when prompted. Codex tracks trust by hook definition, so updates that change `.codex/hooks.json` can require approval again.

## Usage

Once installed, every command runs through the single `/limpid` skill:

```
/limpid audit        # Find issues
/limpid deslop       # Strip AI tells
/limpid tighten      # Cut wordiness
/limpid critique     # Full editorial review
```

Type `/limpid` alone to see the full command list.

Most commands accept an optional argument to focus on a specific file or passage:

```
/limpid deslop the introduction
/limpid clarify the onboarding emails
```

If you reach for one command often, pin it with `/limpid pin deslop` to get `/deslop` as a standalone shortcut.

**Note:** Codex uses skills here, not `/prompts:` commands. Open `/skills` or type `$limpid`. Repo-local installs live in `.agents/skills/`; user-wide installs live in `~/.agents/skills/`. GitHub Copilot uses `.github/skills/`. Restart the tool if a newly installed skill does not appear.

## Editorial hook

On Claude Code, GitHub Copilot, Codex, and Cursor, `npx limpid install` and `npx limpid update` install a provider-native hook manifest along with the skill payload. The hook runs the Limpid detector on direct edits to text files (`.md`, `.mdx`, `.txt`, `.mdc`, and the string literals in UI source) and surfaces findings back into the agent flow. Claude Code, GitHub Copilot, and Codex surface findings after the edit. Cursor blocks slop-laden proposed writes before they land.

Installed hook surfaces:

- Claude Code: `.claude/settings.local.json` (gitignored, machine-local) runs `${CLAUDE_PROJECT_DIR}/.claude/skills/limpid/scripts/hook.mjs`. A hook moved into the shared `settings.json` is honored in place.
- GitHub Copilot: `.github/hooks/limpid.json` (committed, shared by the Copilot CLI and the cloud agent) runs `.github/skills/limpid/scripts/hook.mjs`. The Copilot CLI activates it once the file is on the repository's default branch and the folder is trusted.
- Cursor: `.cursor/hooks.json` runs `.cursor/skills/limpid/scripts/hook-before-edit.mjs`.
- Codex: `.codex/hooks.json` runs `.agents/skills/limpid/scripts/hook.mjs`.

The installer preserves unrelated hook entries and settings. If a hook manifest is malformed, install/update aborts by default; rerun with `--force` to back up the malformed file as `.bak` and replace it.

On an interactive `install`/`update`, Limpid explains the hook and offers to install it (default yes). Your choice is remembered per-developer in the gitignored `.limpid/config.local.json`, so you are not asked again; `--no-hooks` skips it for that run without recording anything. Hook lifecycle settings live under the `hook` key of `.limpid/config.json`; detector ignores live under `detector`, shared by `/limpid hooks` and `npx limpid detect`.

Codex requires one platform step that Limpid cannot safely skip: open `/hooks` after install or update and approve the project hook.

Full hook docs: [limpid.style/docs/hooks](https://limpid.style/docs/hooks).

## CLI

Limpid includes a standalone CLI for detecting AI slop and style issues without an AI harness:

```bash
npx limpid detect docs/                   # scan a directory of prose
npx limpid detect README.md               # scan a single file
npx limpid detect --json .                # CI-friendly JSON output
npx limpid detect --style=microsoft .     # pick the base style guide (microsoft|google|ap|chicago|plain)
npx limpid detect --stdin < draft.txt     # scan piped text
npx limpid detect --no-config docs/       # raw scan, ignoring project config/context
npx limpid ignores list                   # show detector ignores
npx limpid ignores add-file "vendor/**"
npx limpid ignores add-value overused-word delve --reason "Quoting a source"
```

The detector catches **56 deterministic issues** across four families:

| Family | Rules | Examples |
|--------|------:|----------|
| **AI-slop tells** | 26 | overused vocabulary (*delve / tapestry / underscore*), cliché openers, manufactured contrast ("not just X — it's Y"), conclusion-that-restates, vague attribution, em-dash overuse, smart quotes in plaintext, emoji bullets, assistant meta-phrases ("I hope this helps"), bold-lead-in lists, tricolon density |
| **Clarity & concision** | 11 | passive voice, long sentences, wordy phrases ("in order to" → "to"), zombie nouns, adverb overuse, reading-grade ceiling, weasel words, undefined jargon |
| **Style-guide conformance** | 10 | sentence-case headings, contractions, second person, "please"/latinism bans (Google), terminology consistency, exclamation overuse, feature-noun capitalization |
| **Inclusive & accessible language** | 9 | gendered defaults, ableist terms, non-inclusive idioms, vague link text ("click here"), skipped heading levels, missing alt text |

The base style guide selects which conformance rules fire — Limpid ships rule packs for the **Microsoft Writing Style Guide**, the **Google developer documentation style guide**, **AP**, **Chicago**, and **plainlanguage.gov**, in the spirit of [Vale](https://vale.sh)'s style packages but tuned for AI-generated drafts.

By default, `detect` respects the same `.limpid/config.json` and `.limpid/config.local.json` detector config as the hook: `detector.ignoreRules`, `detector.ignoreFiles`, `detector.ignoreValues`, and `detector.styleGuide`.

For a waiver that should travel with one file instead of the repo config, add an inline comment: `<!-- limpid-disable overused-word: quoting a primary source -->`. The marker works in any comment syntax, scopes to the whole file (or one line with `limpid-disable-line` / `limpid-disable-next-line`), and is bypassed by `--no-inline-ignores` or `--no-config`.

Full detector docs: [limpid.style/docs/detector](https://limpid.style/docs/detector).

## Supported Tools

- [Cursor](https://cursor.com)
- [Claude Code](https://claude.ai/code)
- [GitHub Copilot](https://github.com/features/copilot)
- [Gemini CLI](https://github.com/google-gemini/gemini-cli)
- [Codex CLI](https://github.com/openai/codex)
- [OpenCode](https://opencode.ai)
- [Pi](https://pi.dev)
- [Kiro](https://kiro.dev)
- [Trae](https://trae.ai)
- [Rovo Dev](https://www.atlassian.com/software/rovo)
- [Qoder](https://qoder.com)

## Community & Ecosystem

Join the community and ecosystem conversations:

- GitHub Discussions: file bugs, request rules, and help newcomers.
- Limpid on npm: grab the CLI, follow releases, and star the package.
- Follow along for release notes, sample lint reports, and new-rule highlights.

## Contributing

See [DEVELOP.md](docs/DEVELOP.md) for contributor guidelines and build instructions. New detector rules should ship with fixture pairs (a sloppy input and its clean rewrite) and cite the empirical source or style-guide section they enforce.

## License

Apache 2.0. See [LICENSE](LICENSE).

---

Built as the textual counterpart to [Impeccable](https://impeccable.style).
