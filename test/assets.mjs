#!/usr/bin/env node
// Developer-asset awareness: detection (path + content), structure validation, blameless tone,
// and scaffold round-trips (a scaffolded doc must pass its own structure check).

import { detectAssetType, validateAsset, scaffold, ASSET_TYPES } from '../cli/engine/assets.mjs';
import { segment } from '../cli/engine/segment.mjs';

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => { if (cond) pass++; else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); } };

const detect = (path, text) => detectAssetType(path, text, segment(text).headings);
const typeOf = (path, text) => detect(path, text)?.type ?? null;

// --- detection by directory + content ---
const adrText = '# 1. Use Postgres\n- Status: accepted\n## Context\nx\n## Decision\nWe will use it.\n## Consequences\ny';
check('ADR detected by docs/adr path + headings', typeOf('docs/adr/0001-use-postgres.md', adrText) === 'adr');
check('ADR detected by content alone (no telltale path)', typeOf('notes.md', adrText) === 'adr', `(${typeOf('notes.md', adrText)})`);

const pmText = '# Postmortem: Outage\n## Summary\nx\n## Impact\ny\n## Timeline\n- 10:00 down\n## Root Cause\nz\n## Action Items\n- fix\n## Lessons Learned\n- a';
check('postmortem detected', typeOf('incidents/2026-01-checkout.md', pmText) === 'postmortem', `(${typeOf('incidents/2026-01-checkout.md', pmText)})`);

const rbText = '# Runbook: Restart\n## Overview\nx\n## Prerequisites\ny\n## Steps\n1. go\n## Rollback\nz\n## Escalation\npage';
check('runbook detected by filename', typeOf('restart-runbook.md', rbText) === 'runbook');

const rfcText = '# RFC: Thing\n## Summary\nx\n## Motivation\ny\n## Non-goals\nz\n## Alternatives\nw\n## Drawbacks\nv';
check('RFC detected by content', typeOf('docs/design/thing.md', rfcText) === 'rfc', `(${typeOf('docs/design/thing.md', rfcText)})`);

// --- community-health docs: detected by their canonical filename, anywhere in the tree ---
check('CONTRIBUTING.md detected by canonical name alone', typeOf('CONTRIBUTING.md', '# Contributing\n\nThanks for helping out.') === 'contributing', `(${typeOf('CONTRIBUTING.md', '# Contributing\n\nThanks.')})`);
check('.github/CONTRIBUTING.md detected', typeOf('.github/CONTRIBUTING.md', '# Contributing') === 'contributing');
check('CODE_OF_CONDUCT.md detected', typeOf('CODE_OF_CONDUCT.md', '# Code of Conduct\n## Our Pledge\nx') === 'code-of-conduct', `(${typeOf('CODE_OF_CONDUCT.md', '# Code of Conduct')})`);
check('GOVERNANCE.md detected', typeOf('GOVERNANCE.md', '# Governance\n## Roles\nx') === 'governance', `(${typeOf('GOVERNANCE.md', '# Governance')})`);
check('SECURITY.md detected', typeOf('SECURITY.md', '# Security Policy\n## Reporting a Vulnerability\nx') === 'security', `(${typeOf('SECURITY.md', '# Security')})`);
check('docs/security.md detected', typeOf('docs/security.md', '# Security\n## Supported Versions\nx') === 'security');
// a filename that merely starts with "security" is NOT the policy (a guide, not SECURITY.md)
check('security-guide.md is not auto-classified by name', typeOf('security-guide.md', '# Security guide\n\nHow to lock things down.') === null, `(${typeOf('security-guide.md', '# Security guide\n\ntext.')})`);
// CONTRIBUTING that links a Code of Conduct is still a contributing guide, not a CoC
check('CONTRIBUTING mentioning code of conduct stays contributing', typeOf('CONTRIBUTING.md', '# Contributing\n## How to Contribute\nx\n## Code of Conduct\nSee CODE_OF_CONDUCT.md') === 'contributing');

// structure validation: an incomplete SECURITY.md warns on the missing required section
const incompleteSec = validateAsset(segment('# Security Policy\n## Supported Versions\n| latest | yes |'), 'security');
check('security missing Reporting a Vulnerability warns', incompleteSec.some((f) => f.severity === 'warn' && /Reporting a Vulnerability/.test(f.message)));

// --- non-assets are not misclassified ---
check('a plain README is not an asset', detect('README.md', '# My Project\n\nInstall it and go.') === null);
check('a doc with one generic heading is not an asset', detect('guide.md', '# Guide\n## Overview\ntext') === null);

// --- ambiguity: NNNN-*.md filename alone is too weak to classify ---
check('bare NNNN filename without dir/headings is unclassified', detect('0001-thing.md', '# 0001 Thing\n\nbody text') === null);

// --- a generic doc with only common headings (Summary/Design/Background) must NOT classify ---
const genericDoc = '# Session lifecycle\n## Summary\nx\n## Design\ny\n## Background\nz';
check('generic doc with only common headings is not an RFC', detect('docs/session-lifecycle.md', genericDoc) === null, `(${typeOf('docs/session-lifecycle.md', genericDoc)})`);
// but a distinctive heading (Non-goals / Drawbacks) does qualify a content-only match
const rfcByStrong = '# Thing\n## Summary\nx\n## Motivation\ny\n## Non-goals\nz\n## Alternatives\nw\n## Drawbacks\nv';
check('distinctive RFC heading qualifies content-only detection', typeOf('thing.md', rfcByStrong) === 'rfc');

// --- structure validation: missing required sections warn ---
const incompleteRunbook = '# Runbook: x\n## Overview\na\n## Prerequisites\nb\n## Steps\n1. go';
const rbFinds = validateAsset(segment(incompleteRunbook), 'runbook');
check('runbook missing Rollback warns', rbFinds.some((f) => f.severity === 'warn' && /Rollback/.test(f.message)));
check('runbook missing Escalation warns', rbFinds.some((f) => f.severity === 'warn' && /Escalation/.test(f.message)));

// ADR Status accepted as a metadata line (not only a heading)
const adrMeta = '# 1. x\n- Status: accepted\n## Context\na\n## Decision\nWe will.\n## Consequences\nb';
const adrFinds = validateAsset(segment(adrMeta), 'adr');
check('ADR Status satisfied by a metadata line', !adrFinds.some((f) => /"Status"/.test(f.message)));

// --- blameless tone check (postmortem) ---
const blamey = '# Postmortem\n## Summary\nThe outage was the engineer\'s fault and they were careless.';
const blameFinds = validateAsset(segment(blamey), 'postmortem');
check('postmortem flags blameful phrasing', blameFinds.some((f) => f.ruleId === 'postmortem-blame'));
const blameless = '# Postmortem\n## Summary\nA config change removed the index, so queries timed out.';
check('postmortem clean of blame words is not flagged', !validateAsset(segment(blameless), 'postmortem').some((f) => f.ruleId === 'postmortem-blame'));

// --- scaffold round-trip: every scaffold passes its own required-section check ---
for (const a of ASSET_TYPES) {
  const tpl = scaffold(a.type, 'Test');
  const finds = validateAsset(segment(tpl), a.type);
  const missingRequired = finds.filter((f) => f.severity === 'warn');
  check(`scaffold(${a.type}) has no missing required sections`, missingRequired.length === 0, `(${missingRequired.map((f) => f.span).join(',')})`);
}

console.log(`\nAssets: ${pass + fail} checks · ${pass} passed · ${fail} failed`);
console.log(fail === 0 ? '✓ assets green\n' : '');
process.exit(fail === 0 ? 0 : 1);
