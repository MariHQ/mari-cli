# Mari — Hook orchestration (Claude Code)

How the editorial hook works on **Claude Code specifically**. The pitch (`PITCH.md` §5.2,
§20) and README ("Editorial hook") describe the cross-provider surface; this doc is the
authoritative design for the Claude Code path only — the event we bind, the manifest we
write, the stdin/stdout contract, filtering, latency budget, and the on/off lifecycle.

Other providers (Cursor pre-write, Codex, Copilot) get their own docs; the shared detector
core and `hook-lib.mjs` are identical across all of them. Only the **glue** differs.

---

## 1. The one principle

> The hook runs the **deterministic detector** on a file Claude just edited and feeds the
> findings back into the *same* turn as context, so Claude self-corrects its slop before it
> moves on — without ever breaking the turn.

Two consequences drive every decision below:

- **Post-edit, not pre-edit.** Claude Code can't usefully block a write the way Cursor can;
  its value is the feedback loop — surface findings *after* the edit and let the model fix
  them on the next step. So we bind `PostToolUse`, not `PreToolUse`.
- **Never break the turn.** A hook that errors, hangs, or exits non-zero degrades the agent.
  The hook is wrapped so that *any* failure (bad config, detector throw, timeout) exits `0`
  with no output. A clean file is indistinguishable from a broken hook by design — silence is
  always safe.

---

## 2. Which event, and why

| Candidate | Fires | Verdict |
|-----------|-------|---------|
| `PreToolUse` (Edit/Write) | before the write lands | ❌ Claude Code permission-deny UX is wrong for "soft" advice; reserved for Cursor's pre-write surface. |
| **`PostToolUse` (Edit\|Write\|MultiEdit)** | after the write completes | ✅ **chosen.** File is on disk; we lint it and inject findings as context. |
| `Stop` | when Claude finishes the turn | ❌ too late and too coarse — loses the per-file locality; can't point Claude at the span while it's still editing it. |
| `UserPromptSubmit` | on user input | ❌ unrelated; the user isn't the one writing slop. |

**Matcher:** `Edit|Write|MultiEdit` (a regex against the tool name). We deliberately do **not**
match `NotebookEdit`, `Bash`, or MCP write tools in v1 — prose lives in the editable text
tools. `MultiEdit` is included because a single `MultiEdit` can rewrite an entire `.md`.

---

## 3. The manifest we install

Written by `npx mari install` / `npx mari update`. Claude Code merges hook settings from
`~/.claude/settings.json`, `.claude/settings.json`, and `.claude/settings.local.json`.

- **Default target: `.claude/settings.local.json`** (gitignored, machine-local). The hook is
  a per-developer choice, so it does not get committed by default and won't surprise teammates.
- **Respect a shared install.** If the user has already moved a Mari hook into the committed
  `.claude/settings.json`, we honor it in place and do **not** duplicate it into the local file.

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PROJECT_DIR}/.claude/skills/Mari/scripts/hook.mjs\"",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

- `${CLAUDE_PROJECT_DIR}` resolves to the project root, so the path is stable regardless of
  Claude's `cwd`. The script ships *inside the skill payload* — no `npx`, no network, no
  global install needed at hook time.
- `timeout: 10` is a backstop. The deterministic core runs in single-digit milliseconds on a
  normal file; the timeout only matters if something pathological happens, and on timeout
  Claude Code kills the command (which our wrapper treats as a no-op).

**Installer obligations (mirror §20):** preserve unrelated `PostToolUse` entries and all other
settings; if `settings.local.json` is malformed JSON, abort by default and only overwrite under
`--force` (backing up the original to `.bak`); remember the user's yes/no choice per-developer in
the gitignored `.mari/config.local.json` so they're asked once.

---

## 4. The runtime contract (stdin → stdout)

### 4.1 Input — what Claude Code pipes to the hook on **stdin**

```json
{
  "session_id": "…",
  "transcript_path": "…",
  "cwd": "/abs/project",
  "hook_event_name": "PostToolUse",
  "tool_name": "Edit",
  "tool_input":  { "file_path": "/abs/project/README.md", "old_string": "…", "new_string": "…" },
  "tool_response": { "success": true }
}
```

`hook.mjs` reads stdin to EOF, `JSON.parse`s it, and pulls `tool_input.file_path`. For
`MultiEdit` the same `file_path` applies to the whole batch; for `Write` it's the written path.

### 4.2 Output — how findings reach Claude

PostToolUse stdout on a clean exit is shown to the **user**, not the model — useless for our
loop. To put findings into **Claude's** context we emit structured JSON and exit `0`:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "Mari found 3 AI-slop tells in README.md:\n  L4  overused-word …"
  }
}
```

`additionalContext` is appended to the turn as context Claude can act on — non-blocking, no
permission prompt, no turn break. This is the **default and only** surfacing mode for v1.

> We deliberately **do not** use `decision: "block"` / exit `2` (which would feed stderr to
> Claude as a *blocking* error and force a retry). Slop is advice, not a wall. Blocking is
> reserved for the Cursor pre-write surface where the contract genuinely is "don't land this."

### 4.3 The exit-code wrapper (the safety net)

Every code path is wrapped:

```
try {
  read+parse stdin           → on any error: exit 0, no output
  decide target file         → not lintable: exit 0, no output
  load config (.mari)        → hook disabled: exit 0, no output
  run deterministic detector → throws: exit 0, no output
  render findings
    findings → print JSON {additionalContext}, exit 0
    clean    → quiet mode: exit 0 no output / else tiny ack, exit 0
} finally { exit 0 }
```

There is **no path that exits non-zero**. "Never break the turn" is enforced structurally, not
by discipline.

---

## 5. What gets linted (filtering)

The hook lints only files where prose lives, decided in this order — first miss → silent exit:

1. **Tool is a text edit** — `tool_name ∈ {Edit, Write, MultiEdit}` (the matcher already
   guarantees this; re-checked defensively).
2. **Extension is prose-bearing** — `.md`, `.mdx`, `.txt`, `.mdc` (Cursor rules), and source
   files whose **string literals + comments** carry user-facing copy (`.ts/.tsx/.js/.jsx`,
   etc.) routed through `detect-strings.mjs`. Everything else (`.json`, `.lock`, binaries) →
   silent exit.
3. **Not ignored** — honor `detector.ignoreFiles` globs and `.gitignore`-style excludes from
   `.mari/config.json`; honor inline whole-file waivers (`<!-- mari-disable … -->`).
4. **File still exists and is readable** — a delete/rename leaves nothing to lint → silent exit.

Inside the file, the usual detector scoping applies: code fences and inline code are excluded
from prose rules; quotes/citations bypass lexical and inclusive rules (PITCH §8).

---

## 6. Latency budget — deterministic core only

The hook runs on **every** edit, so it lives or dies on speed.

- **Deterministic tier only by default.** Regex / wordlist / density / structural checks —
  no model load, no download, single-digit ms. The detector is invoked through the bundled
  `detect.mjs` wrapper with models forced off (equivalent to `--no-models`).
- **ML and grounding are *never* in the hook path.** GLiNER spans, NLI, perplexity, and
  Lookback-Lens grounding are reserved for explicit `/mari detect` / `audit` / `factcheck`
  runs the user asks for. A cold model load in a per-keystroke-adjacent loop is unacceptable.
- **Single file, not the tree.** The hook lints exactly the one edited file, never the project.

This matches the pitch's hook contract (§5.2): *"runs the deterministic core only by default;
ML/grounding are reserved for explicit detect/audit/factcheck runs."*

---

## 7. Output rendering

`additionalContext` is plain text tuned for an agent reader, not a human terminal:

```
Mari — README.md: 3 findings (deterministic). Fix before continuing.
  L4   warn      overused-word        "delve" (+2 more style words; density over threshold)
  L4   warn      manufactured-contrast "It's not just X — it's Y"   → state the claim directly
  L11  advisory  em-dash-overuse      6 em-dashes / 1k words (human baseline ~3)
Waive a rule inline: <!-- mari-disable <id>: reason -->
```

- **Severity-sorted**, capped (e.g. top 10) with a `(+N more — run /mari audit)` tail so a
  pathological file can't flood the turn.
- Each line carries `id`, severity, the offending span, and a one-line fix — enough for Claude
  to act without a second tool call.
- **Quiet mode** (`hook.quiet: true`, the default): clean files emit **nothing**. Verbose mode
  emits a one-line ack (`Mari: README.md clean ✓`) for users who want positive confirmation.

---

## 8. Configuration & lifecycle

All hook state lives under the `hook` key of `.mari/config.json` (shared, committable) and
`.mari/config.local.json` (machine-local); detector ignores live under `detector`, shared by the
hook and `npx mari detect`.

```jsonc
// .mari/config.json
{
  "hook": {
    "enabled": true,
    "quiet": true,
    "events": ["PostToolUse"],          // reserved; Claude Code uses PostToolUse only
    "extensions": [".md", ".mdx", ".txt", ".mdc"],
    "maxFindings": 10
  },
  "detector": {
    "styleGuide": "microsoft",
    "ignoreRules":  ["em-dash-overuse"],
    "ignoreFiles":  ["CHANGELOG.md", "vendor/**"],
    "ignoreValues": { "overused-word": ["delve"] }
  }
}
```

Managed through the skill's `hooks` management command (PITCH §7, `01-skills.md` §Management):

| `/mari hooks …` | Effect |
|-----------------|--------|
| `on` / `off` | flip `hook.enabled`; `off` makes `hook.mjs` exit `0` immediately (the manifest stays installed, so no settings churn). |
| `status` | report installed?/enabled?/quiet?, which settings file holds it, and the active ignores. |
| `ignore-rule <id>` | append to `detector.ignoreRules`. |
| `ignore-file <glob>` | append to `detector.ignoreFiles`. |
| `ignore-value <rule> <value> [--reason]` | append to `detector.ignoreValues` (e.g. allow `delve` when quoting). |
| `reset` | clear ignores back to defaults. |

The CLI mirrors these: `npx mari ignores add-rule|add-file|add-value`.

**Toggle vs uninstall:** `off` is a config flag (instant, reversible, no settings edit).
Removing the hook entirely is an installer action (`npx mari update --no-hooks` or editing the
manifest), which rewrites `settings.local.json` and preserves unrelated entries.

---

## 9. Failure modes & how each is handled

| Situation | Behavior |
|-----------|----------|
| Malformed stdin / no `file_path` | exit 0, no output. |
| File deleted/renamed by the edit | exit 0, no output. |
| Non-prose extension | exit 0, no output. |
| `.mari/config.json` malformed | treat as defaults (or disabled if unsure); never throw into the turn. |
| Detector throws on weird input | caught; exit 0, no output. |
| Detector exceeds `timeout` | Claude Code kills it; turn proceeds as if clean. |
| Hook disabled (`enabled:false`) | exit 0 immediately, before any work. |
| Findings exceed `maxFindings` | truncate, append `(+N more — run /mari audit)`. |
| Settings snapshotted at session start | Claude Code re-reads hooks on edit via `/hooks` review or restart — documented in install output so a fresh install takes effect. |

---

## 10. Build notes (where this lands)

- **Scripts** (`skill/scripts/`, per `todo/README.md` architecture):
  - `hook.mjs` — the Claude Code / Codex / Copilot **post-edit** entry point (this doc).
  - `hook-before-edit.mjs` — Cursor **pre-write** entry (separate doc; blocking contract).
  - `hook-lib.mjs` — shared: stdin parse, file-target decision, config load, detector invoke,
    finding render. Both entry points are thin wrappers over this.
- **Installer** (`cli/bin/cli.js` → `install`/`update`): writes the §3 manifest into
  `.claude/settings.local.json`, preserves unrelated entries, honors a shared-settings
  override, records the per-developer choice.
- **Milestone:** **M2 — Hooks + install** (`todo/README.md`). Depends on M0 (detector core)
  for `detect.mjs`; independent of M3 models since the hook is deterministic-only.

---

## 11. Open questions

- **Debounce across rapid edits.** A burst of `MultiEdit`s on one file fires the hook each
  time. v1 lints every fire (cheap, deterministic). If turn-context noise becomes a problem,
  add a short per-file dedupe window keyed on `session_id + file_path` written to a temp marker.
- **Source-file string-literal linting in the hook.** Worth the parse cost on every `.ts` edit,
  or reserve string-literal linting for explicit `/mari detect`? Lean toward **prose files only**
  in the hook (M2) and add source-string linting behind `hook.lintSource` later.
- **Surfacing budget.** Is 10 findings the right cap for an agent turn, or should the hook emit
  only `error`/`warn` and drop `advisory` to keep the injected context tight? Decide with real
  transcripts.
