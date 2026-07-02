// Developer-asset awareness: detect the document archetype (runbook / ADR / postmortem / RFC)
// from path + content, validate its canonical structure, and scaffold a best-practice template.
//
// Grounded in the established conventions (deep-research, sources in each type's `sources`):
//   ADR        — Michael Nygard's template + MADR (https://adr.github.io/madr/)
//   postmortem — Google SRE example postmortem + PagerDuty + Atlassian incident handbook
//   runbook    — incident.io / emmer.dev / AWS IDR operational-runbook structure
//   RFC        — Rust RFC 0000-template.md + Oxide RFD + Squarespace RFC
//
// Detection is deliberately TOLERANT (tools like Log4brains enforce "no structure"), and
// structure checks WARN rather than fail — a half-written draft legitimately lacks sections.

// Normalize a heading for matching: lowercase, unwrap markdown links ("Submitting a
// [Pull Request](url)" must match "submitting a pull request"), strip markers and numbering.
function norm(s) {
  return String(s).toLowerCase().replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_#:]/g, '').replace(/^\d+[.)]\s*/, '').replace(/\s+/g, ' ').trim();
}
// A section is present if a heading equals an alias or starts with it at a WORD boundary —
// "Context and Problem Statement" matches "context", but "Non-goals" does not match "goals"
// and "Why not X?" does not match a bare "why" prefix inside another word.
function hasSection(headings, aliases) {
  return headings.some((h) => { const n = norm(h.text); return aliases.some((a) => n === a || n.startsWith(a + ' ')); });
}
function countMarkers(headings, markers) {
  let n = 0;
  for (const m of markers) if (hasSection(headings, [m])) n++;
  return n;
}

// section = { name, aliases } — `name` is what we tell the author, `aliases` are accepted headings.
const S = (name, ...aliases) => ({ name, aliases: [norm(name), ...aliases.map(norm)] });

export const ASSET_TYPES = [
  {
    type: 'adr', label: 'ADR (Architecture Decision Record)',
    file: [/(^|[-_/])adr[-_]/i, /\badr\b/i, /^\d{1,4}[-_].+\.(md|mdx)$/i, /^\d{8}[-_].+\.(md|mdx)$/i],
    dir: [/(^|\/)(adr|adrs|decisions)(\/|$)/i, /(^|\/)docs\/(adr|decisions)(\/|$)/i],
    statusEnum: ['proposed', 'accepted', 'rejected', 'deprecated', 'superseded'],
    markers: ['decision', 'consequences', 'context', 'considered options', 'decision outcome', 'status'],
    strong: ['consequences', 'considered options', 'decision outcome'],
    required: [{ ...S('Status'), meta: true }, S('Context', 'context and problem statement'), S('Decision', 'decision outcome'), S('Consequences')],
    recommended: [S('Considered Options', 'options', 'alternatives')],
    tone: ['Write the Decision in active voice ("We will…").', 'Keep Context value-neutral — describe the forces, not the verdict.', 'List Consequences both positive and negative.'],
  },
  {
    type: 'postmortem', label: 'Postmortem / incident retrospective',
    file: [/post[-_]?mortem/i, /\bretro(spective)?\b/i, /(^|[-_/])incident[-_]/i],
    dir: [/(^|\/)(postmortems?|post-mortems?|incidents?|retros?)(\/|$)/i],
    markers: ['timeline', 'root cause', 'root causes', 'contributing factors', 'impact', 'action items', 'corrective actions', 'lessons learned', 'detection', 'resolution'],
    strong: ['root cause', 'root causes', 'contributing factors', 'action items', 'corrective actions', 'lessons learned'],
    required: [S('Summary', 'overview', 'what happened'), S('Impact'), S('Timeline'), S('Root Cause', 'root causes', 'contributing factors', 'fault'), S('Action Items', 'corrective actions', 'follow-up', 'follow-ups'), S('Lessons Learned', 'what went well', "how'd we do")],
    recommended: [S('Detection'), S('Resolution', 'recovery')],
    tone: ['Stay blameless — attribute to systems and process, not individuals.', 'Distinguish the proximate cause from the root cause (five whys).', 'Give every action item an owner.'],
    blameWords: [/\bblame[ds]?\b/i, /\bat fault\b/i, /\b(his|her|their) (fault|mistake|error)\b/i, /\bshould have known\b/i, /\bincompeten/i, /\bcareless\b/i, /\bnegligen/i],
  },
  {
    type: 'runbook', label: 'Runbook / operational guide',
    file: [/run[-_]?book/i, /play[-_]?book/i],
    dir: [/(^|\/)(runbooks?|playbooks?|ops|operations)(\/|$)/i],
    markers: ['prerequisites', 'steps', 'procedure', 'rollback', 'escalation', 'trigger', 'triggers', 'when to use', 'validation', 'verification'],
    strong: ['rollback', 'escalation'],
    required: [S('Overview', 'purpose', 'summary', 'objective', 'description'), S('Prerequisites', 'preconditions', 'requirements', 'before you begin'), S('Steps', 'procedure', 'instructions', 'resolution', 'mitigation'), S('Rollback', 'recovery', 'remediation', 'cleanup'), S('Escalation', 'contacts', 'contact', 'on-call', 'who to contact')],
    recommended: [S('Triggers', 'trigger', 'when to use'), S('Validation', 'verification')],
    tone: ['Write steps as numbered, imperative actions ("Restart the service").', 'Give each step an expected outcome to check against.', 'Keep one runbook per procedure — branch into linked runbooks, not nested ifs.'],
  },
  {
    type: 'rfc', label: 'RFC / design doc',
    file: [/(^|[-_/])rfc[-_]/i, /(^|[-_/])rfd[-_]/i, /[-_]design\.(md|mdx)$/i, /(^|[-_/])design[-_]/i, /proposal/i, /[-_]plan\.(md|mdx)$/i],
    dir: [/(^|\/)(rfcs?|rfds?|designs?|proposals?|plans?)(\/|$)/i, /(^|\/)docs\/(design|rfcs?|proposals?|plans?)(\/|$)/i],
    markers: ['motivation', 'goals', 'non-goals', 'alternatives', 'drawbacks', 'rationale and alternatives', 'guide-level explanation', 'reference-level explanation', 'unresolved questions', 'open questions', 'prior art', 'summary', 'problem', 'problem statement', 'problem frame', 'background', 'requirements', 'out of scope', 'in scope', 'proposed', 'design', 'verification'],
    strong: ['non-goals', 'drawbacks', 'alternatives', 'rationale and alternatives', 'unresolved questions', 'out of scope', 'prior art', 'guide-level explanation', 'reference-level explanation', 'problem frame'],
    required: [S('Summary', 'abstract', 'overview', 'tldr'), S('Motivation', 'goals', 'problem', 'problem statement', 'problem frame', 'background', 'requirements', 'why'), S('Alternatives', 'rationale and alternatives', 'alternatives considered', 'other approaches'), S('Drawbacks', 'risks', 'tradeoffs', 'trade-offs', 'downsides')],
    recommended: [S('Non-goals', 'non goals', 'out of scope', 'scope boundaries'), S('Unresolved Questions', 'open questions', 'open product decisions')],
    tone: ['State Non-goals explicitly — scope is defined by what you exclude.', 'Show the alternatives you considered and why you rejected them.', 'Name the Drawbacks honestly; a proposal with no downsides is unfinished.'],
  },
  // Community-health docs (GitHub's canonical set). Identified almost entirely by their exact
  // filename — they live at the repo root, in .github/, or in docs/. Grounded in GitHub's
  // community-standards checklist, the Contributor Covenant, and GitHub's SECURITY.md convention.
  {
    type: 'contributing', label: 'Contributing guide',
    exact: [/^contributing(\.[a-z-]+)?\.(md|mdx|rst|txt)$/i], file: [],
    dir: [/(^|\/)\.github(\/|$)/i, /(^|\/)docs\/contributing(\/|$)/i],
    markers: ['how to contribute', 'ways to contribute', 'getting started', 'development', 'development setup', 'local development', 'building', 'pull request', 'pull requests', 'pull request process', 'submitting changes', 'submitting a pull request', 'reporting bugs', 'reporting issues', 'issues', 'code of conduct', 'style guide', 'coding style', 'coding conventions', 'testing', 'running tests', 'commit messages'],
    strong: ['pull request process', 'submitting changes', 'submitting a pull request', 'development setup', 'how to contribute', 'ways to contribute'],
    required: [S('How to Contribute', 'contributing', 'ways to contribute', 'getting started'), S('Development Setup', 'development', 'building', 'local development', 'setup', 'getting started'), S('Pull Request Process', 'pull requests', 'pull request', 'submitting changes', 'submitting a pull request', 'opening a pull request', 'making changes'), S('Reporting Bugs', 'reporting issues', 'bug reports', 'issues', 'filing issues')],
    recommended: [S('Code of Conduct'), S('Style Guide', 'coding style', 'code style', 'coding conventions'), S('Testing', 'tests', 'running tests')],
    tone: ['Open with the fastest path to a first contribution.', 'Link the Code of Conduct rather than restating it.', 'Give exact commands for setup, tests, and submitting a PR.'],
  },
  {
    type: 'code-of-conduct', label: 'Code of Conduct',
    exact: [/^code[-_]?of[-_]?conduct(\.[a-z-]+)?\.(md|mdx|rst|txt)$/i], file: [],
    dir: [/(^|\/)\.github(\/|$)/i],
    markers: ['our pledge', 'pledge', 'our standards', 'standards', 'expected behavior', 'unacceptable behavior', 'our responsibilities', 'enforcement', 'enforcement responsibilities', 'enforcement guidelines', 'scope', 'reporting', 'attribution'],
    strong: ['our pledge', 'our standards', 'enforcement guidelines', 'enforcement responsibilities'],
    required: [S('Our Pledge', 'pledge'), S('Our Standards', 'standards', 'expected behavior', 'our responsibilities'), S('Enforcement', 'reporting', 'reporting guidelines', 'enforcement responsibilities')],
    recommended: [S('Scope'), S('Attribution')],
    tone: ['State the pledge in the first person plural ("We pledge…").', 'Give a real reporting contact, not a placeholder.', 'If you adapt the Contributor Covenant, keep the Attribution.'],
  },
  {
    type: 'governance', label: 'Governance',
    exact: [/^governance(\.[a-z-]+)?\.(md|mdx|rst|txt)$/i], file: [],
    dir: [/(^|\/)\.github(\/|$)/i, /(^|\/)docs\/governance(\/|$)/i],
    markers: ['roles', 'roles and responsibilities', 'project roles', 'responsibilities', 'decision making', 'decision-making', 'decision-making process', 'how decisions are made', 'maintainers', 'becoming a maintainer', 'becoming a committer', 'committers', 'contributors', 'meetings', 'voting', 'code of conduct', 'amendments', 'changing this document'],
    strong: ['decision-making process', 'becoming a maintainer', 'becoming a committer', 'roles and responsibilities'],
    required: [S('Roles', 'roles and responsibilities', 'project roles', 'responsibilities'), S('Decision Making', 'decision-making', 'decision-making process', 'decisions', 'how decisions are made'), S('Maintainers', 'becoming a maintainer', 'becoming a committer', 'committers')],
    recommended: [S('Meetings'), S('Code of Conduct'), S('Changing This Document', 'amendments', 'changing the governance')],
    tone: ['Define each role by its concrete rights and duties, not just a title.', 'Make the path from contributor to maintainer explicit and measurable.', 'Say how the governance document itself gets amended.'],
  },
  {
    type: 'security', label: 'Security policy',
    exact: [/^security(\.[a-z-]+)?\.(md|mdx|rst|txt)$/i], file: [],
    dir: [/(^|\/)\.github(\/|$)/i, /(^|\/)docs\/security(\/|$)/i],
    markers: ['supported versions', 'supported version', 'reporting a vulnerability', 'reporting security issues', 'reporting a security issue', 'report a vulnerability', 'how to report', 'disclosure', 'disclosure policy', 'coordinated disclosure', 'responsible disclosure', 'security updates', 'response', 'scope', 'safe harbor', 'preferred languages'],
    strong: ['supported versions', 'reporting a vulnerability', 'coordinated disclosure', 'disclosure policy'],
    required: [S('Supported Versions', 'supported version', 'affected versions'), S('Reporting a Vulnerability', 'reporting security issues', 'reporting a security issue', 'report a vulnerability', 'how to report')],
    recommended: [S('Disclosure Policy', 'disclosure', 'coordinated disclosure', 'responsible disclosure'), S('Security Update Policy', 'security updates', 'response')],
    tone: ['Give a private reporting channel — never "just open an issue".', 'State a response-time expectation you can actually meet.', 'List exactly which versions receive security fixes.'],
  },
];

const byType = Object.fromEntries(ASSET_TYPES.map((a) => [a.type, a]));
export function assetSpec(type) { return byType[type] || null; }

// Parse a leading YAML/TOML front-matter block into a flat key→value map (best-effort).
function frontmatter(text) {
  const m = text.match(/^(---|\+\+\+)\r?\n([\s\S]*?)\r?\n\1(?:\r?\n|$)/);
  if (!m) return {};
  const out = {};
  for (const line of m[2].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*[:=]\s*(.+?)\s*$/);
    if (kv) out[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').toLowerCase();
  }
  return out;
}

// Score each type from path + content; return the best match above threshold, or null.
// Signals: directory (strong, unambiguous), filename keyword (strong), numeric/date filename
// (weak — ambiguous between ADR and RFC), heading markers (the real disambiguator), and an
// ADR-style front-matter `status`.
export function detectAssetType(path, text, headings) {
  const rel = String(path || '').replace(/\\/g, '/');
  const base = rel.split('/').pop() || '';
  const fm = frontmatter(text || '');
  const scores = [];
  for (const a of ASSET_TYPES) {
    let score = 0; const signals = []; let qualified = false;
    if (a.dir.some((re) => re.test(rel))) { score += 3; signals.push('directory'); qualified = true; }
    // A canonical, unambiguous filename (CONTRIBUTING.md, SECURITY.md, …) is enough on its own —
    // these community-health docs live by their exact name, wherever they sit in the tree.
    if (a.exact && a.exact.some((re) => re.test(base))) { score += 4; signals.push('canonical filename'); qualified = true; }
    if ((a.file || []).some((re) => re.test(base))) {
      // a bare NNNN-*.md / date filename is only a weak, ambiguous signal
      const weak = /^\d{1,8}[-_].+\.(md|mdx)$/i.test(base) && !/(adr|rfc|rfd|runbook|playbook|postmortem|design|proposal)/i.test(base);
      score += weak ? 1 : 3; signals.push('filename'); if (!weak) qualified = true;
    }
    if (a.statusEnum && a.statusEnum.includes(fm.status)) { score += 3; signals.push('front-matter status'); qualified = true; }
    const markerHits = countMarkers(headings || [], a.markers);
    if (markerHits) { score += Math.min(markerHits, 3) * 2; signals.push(`${markerHits} heading markers`); }
    // A distinctive ("strong") heading qualifies a content-only match; generic headings
    // (Summary, Context, Impact, Design…) alone must NOT classify an ordinary doc.
    if (countMarkers(headings || [], a.strong || [])) qualified = true;
    if (score > 0 && qualified) scores.push({ type: a.type, label: a.label, score, signals });
  }
  scores.sort((x, y) => y.score - x.score);
  const best = scores[0];
  if (!best || best.score < 4) return null;
  return best;
}

// Validate canonical structure: a missing REQUIRED section warns; a missing RECOMMENDED one is
// advisory. Findings are anchored to the document's first heading (or the top of the file).
export function validateAsset(ctx, type) {
  const spec = byType[type];
  if (!spec) return [];
  const headings = ctx.headings || [];
  const anchor = headings[0]?.start ?? 0;
  const at = ctx.locate ? ctx.locate(anchor) : { line: 1, col: 1 };
  const out = [];
  const emit = (sev, section, kind) => out.push({
    ruleId: 'asset-missing-section', family: 'structure', source: 'asset', severity: sev,
    offset: anchor, length: 0, line: at.line, col: at.col, span: section,
    message: `${spec.label}: missing ${kind} section "${section}".`,
  });
  // Some sections (e.g. ADR Status) are conventionally a metadata field, not a heading —
  // accept `Status:` lines and front-matter keys too.
  const hasField = (aliases) => {
    const t = ctx.text || '';
    return aliases.some((a) => new RegExp(`^[\\s>*-]*${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:=]`, 'im').test(t));
  };
  const present = (s) => hasSection(headings, s.aliases) || (s.meta && hasField(s.aliases));
  for (const s of spec.required) if (!present(s)) emit('warn', s.name, 'required');
  for (const s of (spec.recommended || [])) if (!present(s)) emit('advisory', s.name, 'recommended');

  // Postmortem-only deterministic tone check: blameless language.
  if (spec.blameWords && ctx.masked) {
    for (const re of spec.blameWords) {
      const m = re.exec(ctx.masked);
      if (m) {
        const loc = ctx.locate ? ctx.locate(m.index) : { line: 1, col: 1 };
        out.push({ ruleId: 'postmortem-blame', family: 'structure', source: 'asset', severity: 'advisory',
          offset: m.index, length: m[0].length, line: loc.line, col: loc.col, span: m[0],
          message: `Blameful phrasing "${m[0]}" — postmortems stay blameless; attribute to systems and process, not people.` });
      }
    }
  }
  return out;
}

// Best-practice scaffolding for `mari asset scaffold <type>`.
const TEMPLATES = {
  adr: (t) => `# ${t || 'NNNN. Short decision title'}

- Status: proposed
- Date: YYYY-MM-DD
- Deciders: <names>

## Context

What is the issue we're facing? Describe the forces at play — technical, political,
project-local — in value-neutral, factual language.

## Options Considered

- Option A — tradeoffs.
- Option B — tradeoffs.

## Decision

What is the change we're making? State it in active voice: "We will …".

## Consequences

What becomes easier or harder as a result? List the outcomes, positive and negative.
`,
  postmortem: (t) => `# Postmortem: ${t || '<incident name>'}

- Date: YYYY-MM-DD
- Authors: <names>
- Status: draft

## Summary

One paragraph: what happened, impact, and resolution. Blameless throughout.

## Impact

Who/what was affected, for how long, and how severely.

## Detection

How the incident was detected, and how long that took.

## Resolution

What was done to mitigate and recover.

## Timeline

- HH:MM — event (use a consistent timezone)

## Root Cause

The systemic cause. Distinguish the proximate trigger from the root cause (five whys).

## Action Items

| Action | Owner | Due |
|--------|-------|-----|
|        |       |     |

## Lessons Learned

- What went well
- What went wrong
- Where we got lucky
`,
  runbook: (t) => `# Runbook: ${t || '<procedure name>'}

## Overview

What this runbook does and when to reach for it.

## Triggers

The alerts or conditions that mean you should run this.

## Prerequisites

Access, tools, and state required before you start.

## Steps

1. Do the first action. Expected: <what you should see>.
2. Do the next action. Expected: <…>.

## Validation

How to confirm the procedure worked.

## Rollback

How to undo it if something goes wrong.

## Escalation

Who to page and when, if the steps don't resolve it.
`,
  rfc: (t) => `# RFC: ${t || '<title>'}

- Status: draft
- Authors: <names>

## Summary

One paragraph explaining the proposal.

## Motivation

Why are we doing this? What problem does it solve? What are the goals?

## Non-goals

What this proposal explicitly does not address.

## Design

The proposal itself, in enough detail to implement and evaluate.

## Alternatives

Other approaches considered, and why they were not chosen.

## Drawbacks

Why might we *not* do this? The honest costs and risks.

## Unresolved Questions

What's still open and needs to be decided.
`,
  contributing: (t) => `# Contributing to ${t || '<project>'}

Thanks for contributing! This guide gets you from clone to merged PR.

## How to Contribute

The quickest ways to help: fix a bug, improve docs, or pick up a \`good first issue\`.
By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

## Development Setup

\`\`\`bash
git clone <repo> && cd <project>
<install deps>
<run the app / tests>
\`\`\`

## Pull Request Process

1. Fork and branch from \`main\`.
2. Make your change, with tests and updated docs.
3. Ensure the test suite and linters pass.
4. Open a PR describing the what and the why; link any related issue.

## Reporting Bugs

Open an issue with steps to reproduce, expected vs. actual behavior, and your environment.
Search existing issues first to avoid duplicates.
`,
  'code-of-conduct': (t) => `# Contributor Covenant Code of Conduct

## Our Pledge

We as members, contributors, and leaders pledge to make participation in ${t || 'our project'}
a harassment-free experience for everyone.

## Our Standards

Examples of behavior that contributes to a positive environment:

- Demonstrating empathy and kindness toward other people.
- Being respectful of differing opinions, viewpoints, and experiences.
- Giving and gracefully accepting constructive feedback.

Unacceptable behavior includes harassment, insults, and other unprofessional conduct.

## Enforcement

Report abusive, harassing, or otherwise unacceptable behavior to <contact>. All complaints
will be reviewed and investigated promptly and fairly.

## Scope

This Code of Conduct applies within all community spaces and when an individual is
representing the project in public spaces.

## Attribution

Adapted from the [Contributor Covenant](https://www.contributor-covenant.org), version 2.1.
`,
  governance: (t) => `# ${t || '<project>'} Governance

## Roles

- **Contributors** — anyone who submits issues or pull requests.
- **Maintainers** — trusted contributors with merge rights and release duties.

Describe the concrete rights and responsibilities of each role.

## Decision Making

How decisions are made — lazy consensus by default; describe when a vote is required and
what threshold carries it.

## Maintainers

How a contributor becomes a maintainer (the measurable bar), and how maintainers step down
or are removed.

## Meetings

When the project meets, where notes live, and how to add an agenda item.

## Changing This Document

How this governance document itself is amended.
`,
  security: (t) => `# Security Policy${t ? ` — ${t}` : ''}

## Supported Versions

| Version | Supported |
|---------|-----------|
| latest  | ✅        |
| older   | ❌        |

## Reporting a Vulnerability

**Do not open a public issue for security problems.** Report privately via <security contact>
(or GitHub's private "Report a vulnerability" advisory). Include steps to reproduce and impact.

We aim to acknowledge reports within <N business days> and to keep you updated as we
investigate and ship a fix.

## Disclosure Policy

We follow coordinated disclosure: we'll agree a disclosure timeline with you and credit you
in the advisory unless you prefer otherwise.
`,
};
export function scaffold(type, title) {
  const fn = TEMPLATES[type];
  return fn ? fn(title) : null;
}
