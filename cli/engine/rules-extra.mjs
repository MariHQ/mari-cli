// Additional deterministic rules completing Families A–F from the spec (PITCH §10–16).
// Reuses helpers/severity conventions from rules.mjs. Pack-gated rules carry a `pack`.

import * as L from './lexicons.mjs';
import { esc, wordList, phraseList, scan, emitAt, isSentenceStart, FAMILIES as FAM } from './rule-helpers.mjs';
import { syllables, gradeLevel } from './readability.mjs';

const per1k = (n, words) => (n / Math.max(words, 1)) * 1000;

// generic "phrase → replacement" rule
function mapRule(id, family, sev, map, label, pack) {
  return {
    id, family, defaultSeverity: sev, pack,
    run(ctx, emit) {
      scan(ctx, phraseList(Object.keys(map)), (m, i) => {
        const key = m[0].toLowerCase();
        const repl = map[key] ?? map[m[0]];
        if (m[0] === repl) return; // already the preferred form (case-only entries)
        emitAt(ctx, emit, id, family, sev, i, m[0].length, `${label}: "${m[0]}" → "${repl}".`);
      });
    },
  };
}
// generic "wordlist" rule (no replacement)
function listRule(id, family, sev, words, msg, pack) {
  return {
    id, family, defaultSeverity: sev, pack,
    run(ctx, emit) { scan(ctx, phraseList(words), (m, i) => emitAt(ctx, emit, id, family, sev, i, m[0].length, msg(m[0]))); },
  };
}
// density-gated wordlist: only fires when >= min hits
function densityListRule(id, family, sev, words, msg, min, pack) {
  return {
    id, family, defaultSeverity: sev, pack,
    run(ctx, emit) {
      const hits = [];
      scan(ctx, phraseList(words), (m, i) => hits.push({ m, i }));
      if (hits.length < min) return;
      for (const h of hits) emitAt(ctx, emit, id, family, sev, h.i, h.m[0].length, msg(h.m[0]));
    },
  };
}

// ======================= Family A extras =======================

const negativeParallelism = {
  id: 'negative-parallelism', family: FAM.A, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const res = [/,\s+not\s+[^.,!?\n]{2,30}[.!?]/gi, /\bNot\s+\w+\.\s+Not\s+\w+/g, /\b\w+\s+rather than\s+\w+/gi, /(^|\n)\s*Rather,\s/g];
    const hits = [];
    for (const re of res) scan(ctx, re, (m, i) => hits.push({ m, i }));
    if (hits.length < 2) return;
    for (const h of hits) emitAt(ctx, emit, this.id, this.family, 'advisory', h.i, Math.min(h.m[0].length, 40), `Negative parallelism — an AI cadence tell when stacked.`);
  },
};

const tricolonOveruse = {
  id: 'tricolon-overuse', family: FAM.A, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const hits = [];
    scan(ctx, /\b\w+,\s+\w+,\s+and\s+\w+\b/gi, (m, i) => hits.push({ m, i }));
    // ≥3 — the *reflex* is the tell, and a lower bar makes ordinary 3-item lists unwinnable
    // against serial-comma (which wants the Oxford comma this rule would then flag).
    if (hits.length < 3) return;
    for (const h of hits) emitAt(ctx, emit, this.id, this.family, 'advisory', h.i, h.m[0].length, `Tricolon "A, B, and C" — one is fine; the reflex is the tell.`);
  },
};

const servesAsCopula = densityListRule('serves-as-copula', FAM.A, 'advisory', L.SERVES_AS, (w) => `Copula avoidance "${w}" — "is" often reads cleaner.`, 2);
const mediaCoverage = listRule('media-coverage-boilerplate', FAM.A, 'advisory', L.MEDIA_COVERAGE, (w) => `Media-coverage boilerplate "${w}".`);
const futureOutlook = listRule('future-outlook-speculation', FAM.A, 'advisory', L.FUTURE_OUTLOOK, (w) => `Future-outlook filler "${w}" — vague speculation.`);
const conversational = listRule('conversational-scaffolding', FAM.A, 'advisory', L.CONVERSATIONAL_SCAFFOLDING, (w) => `Conversational scaffolding "${w}".`);

const superficialIng = {
  id: 'superficial-ing-participle', family: FAM.A, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const hits = [];
    scan(ctx, /,\s+(highlighting|underscoring|emphasizing|reflecting|symbolizing|showcasing|fostering|ensuring|contributing to|paving the way)\b/gi, (m, i) => hits.push({ m, i }));
    if (hits.length < 2) return;
    for (const h of hits) {
      const d = h.m[0].indexOf(h.m[1]); // ",\s+" separator isn't always 2 chars (",  x", comma+newline)
      emitAt(ctx, emit, this.id, this.family, 'advisory', h.i + d, h.m[0].length - d, `Clause-final "${h.m[1]}" vague-significance participle.`);
    }
  },
};

const transitionScaffolding = {
  id: 'transition-scaffolding', family: FAM.A, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const hits = [];
    scan(ctx, /(^|\n)\s*(Additionally|Moreover|Furthermore|However|Consequently|Nevertheless)\b/g, (m, i) => hits.push({ word: m[2], i: i + m[0].indexOf(m[2]) }));
    if (hits.length < 2) return;
    for (const h of hits) emitAt(ctx, emit, this.id, this.family, 'advisory', h.i, h.word.length, `Paragraph-initial "${h.word}" — transition scaffolding when overused.`);
  },
};

const interrogativeAnswer = {
  id: 'interrogative-answer', family: FAM.A, defaultSeverity: 'advisory',
  run(ctx, emit) {
    scan(ctx, /(^|[.!?]\s)((?:The|Its|Their|His|Her|Our)\s+\w+)\?\s+[A-Z]\w+\./g, (m, i) =>
      emitAt(ctx, emit, this.id, this.family, 'advisory', i + m[1].length, m[0].length - m[1].length, `Rhetorical-fragment cadence ("${m[2]}? …").`));
  },
};

const excessiveBold = {
  id: 'excessive-bold', family: FAM.A, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const n = ctx.boldSpans.length;
    if (n < 4) return;
    const rate = (n / Math.max(ctx.wordCount, 1)) * 100;
    if (rate < 3) return;
    emitAt(ctx, emit, this.id, this.family, 'advisory', ctx.boldSpans[0].start, ctx.boldSpans[0].length, `Excessive bold: ${n} spans (${rate.toFixed(1)}/100 words). Reserve emphasis.`);
  },
};

const listicleReflex = {
  id: 'listicle-reflex', family: FAM.A, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const items = ctx.listItems;
    if (items.length < 5) return;
    const shortItems = items.filter((it) => ctx.countWords(it.text) <= 4).length;
    if (shortItems < items.length * 0.5) return;
    emitAt(ctx, emit, this.id, this.family, 'advisory', items[0].start, 0, `Listicle reflex: ${items.length} list items, ${shortItems} ≤4 words — some should be prose.`);
  },
};

// uniform sentence rhythm — model-free burstiness (§9.4). CV = stddev/mean of per-sentence
// word counts. Human engaging prose CV ≈ 0.5–0.8+; flag CV < 0.25 as machine-uniform. A nudge.
const uniformCadence = {
  id: 'uniform-cadence', family: FAM.A, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const counts = ctx.sentences.map((s) => ctx.countWords(s.text)).filter((n) => n > 0);
    if (counts.length < 6) return; // need enough sentences for variance to mean anything
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    if (mean < 4) return;
    const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
    const cv = Math.sqrt(variance) / mean;
    if (cv >= 0.25) return;
    emit({ ruleId: this.id, family: this.family, severity: 'advisory', offset: ctx.sentences[0].start, length: 0, span: '', message: `Uniform sentence rhythm (CV ${cv.toFixed(2)} < 0.25) — vary sentence length; machine prose is monotone.` });
  },
};

// ======================= Family B extras =======================

const ADVERB_STOP = new Set('only family reply apply supply july italy ally rely multiply early ugly holy likely lonely friendly daily weekly monthly yearly silly jelly belly fully'.split(' '));
const adverbOveruse = {
  id: 'adverb-overuse', family: FAM.B, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const hits = [];
    scan(ctx, /\b(\w{3,}ly)\b/gi, (m, i) => { if (!ADVERB_STOP.has(m[1].toLowerCase())) hits.push({ m, i }); });
    if (hits.length < 5 || per1k(hits.length, ctx.wordCount) < 25) return;
    emitAt(ctx, emit, this.id, this.family, 'advisory', hits[0].i, hits[0].m[0].length, `Adverb density high: ${hits.length} -ly adverbs (${per1k(hits.length, ctx.wordCount).toFixed(0)}/1k). Prefer stronger verbs.`);
  },
};

const ACRONYM_ALLOW = new Set((
  // common tech
  'API URL URI URN HTTP HTTPS JSON XML YAML TOML HTML CSS SQL DDL DML DOM ID UID UUID GUID UI UX ' +
  'CLI GUI OS RAM ROM CPU GPU SSD HDD VM JVM JDK JRE SDK PDF CSV TSV FAQ OK USA US UK EU UN AI ML ' +
  'NLP CI CD NPM CDN DNS IP TCP UDP SSH FTP SFTP TLS SSL REST SOAP RPC GRPC CRUD IDE JS TS MVP MVC ' +
  'TODO FIXME ASCII UTF UTF8 UTC GMT MIT BSD GPL LGPL ORM ENV PR QA RFC ABI ACID SaaS PaaS IaaS ' +
  'GB MB KB TB PB HZ KHZ MHZ GHZ FYI ETA AKA EOF EOL JAR WAR ZIP TAR GZIP POM POJO DTO DAO SPI JMX ' +
  'JDBC ODBC YARN HDFS S3 AWS GCP K8S ETL OLAP OLTP DAG AST CSV LRU TTL QPS RPS SLA SLO IO NIO BIN ' +
  'CSV LDAP SAML OAUTH JWT CORS XSS CSRF SHA MD5 RSA AES GZ EXE DLL JNI JIT GC OOM NPE WAL CDC ' +
  // callout / common all-caps English words used as labels
  'NOTE TIP INFO WARNING IMPORTANT CAUTION DANGER ATTENTION HINT EXAMPLE SEE WARN ERROR DEBUG TRACE ' +
  'IDEA AND OR NOT NULL TRUE FALSE GET PUT POST HEAD ' +
  // Flink/data-eng common
  'CEP UDF UDTF UDAF KPI RocksDB FLIP JIRA'
).split(/\s+/));
const undefinedAcronym = {
  id: 'undefined-acronym', family: FAM.B, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const seen = new Set();
    scan(ctx, /\b([A-Z]{3,5})s?\b/g, (m, i) => {
      const acr = m[1];
      if (ACRONYM_ALLOW.has(acr) || seen.has(acr)) return;
      if (ctx.masked[i + m[0].length] === '.') return; // filename like STYLE.md, not an acronym
      seen.add(acr);
      const defined = new RegExp(`${esc(acr)}\\s*\\)|\\(${esc(acr)}\\)`).test(ctx.masked);
      if (defined) return;
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, acr.length, `Acronym "${acr}" used without a first-use expansion.`);
    });
  },
};

const readingGrade = {
  id: 'reading-grade', family: FAM.B, defaultSeverity: 'advisory', pack: 'plain',
  run(ctx, emit) {
    const words = ctx.masked.match(/[A-Za-z]+(?:'[A-Za-z]+)?/g) || [];
    if (words.length < 30) return;
    let syl = 0; for (const w of words) syl += syllables(w);
    const letters = (ctx.masked.match(/[A-Za-z]/g) || []).length;
    const { grade } = gradeLevel(words.length, ctx.sentences.length, syl, letters);
    if (grade <= 8) return;
    emitAt(ctx, emit, this.id, this.family, 'advisory', 0, 0, `Reading grade ≈ ${grade.toFixed(1)} (plain-language ceiling 8). Shorten sentences and words.`);
  },
};

// ======================= Family C: shared extras =======================

const serialComma = {
  id: 'serial-comma', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    if (ctx.styleGuide === 'ap') return; // AP omits the serial comma — `ap-serial-comma` handles it
    scan(ctx, /\b\w+,\s+\w+\s+(and|or)\s+\w+\b/gi, (m, i) => {
      // Sentence-initial first token is usually an introductory adverbial ("Yesterday, John
      // and Mary arrived"), not a list — skip it.
      if (isSentenceStart(ctx.masked, i)) return;
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `Missing serial (Oxford) comma before "${m[1]}".`);
    });
  },
};

const useContractions = {
  id: 'use-contractions', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const neg = Object.fromEntries(Object.entries(L.CONTRACTIONS).filter(([k]) => /not|cannot/.test(k)));
    scan(ctx, phraseList(Object.keys(neg)), (m, i) =>
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `Both guides encourage contractions: "${m[0]}" → "${neg[m[0].toLowerCase()]}".`));
  },
};

const secondPerson = {
  id: 'second-person', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    // "the user can …" and bare "users can / users have access …" — both want second person.
    scan(ctx, /\b(the user|users)\s+(should|can|must|may|need to|needs to|will|might|have|has|access|get)\b/gi, (m, i) =>
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `Prefer second person: "${m[0]}" → "you …".`));
  },
};

const presentTense = {
  id: 'present-tense', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    scan(ctx, /\byou will\s+(\w+)\b/gi, (m, i) =>
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `Prefer present tense in instructions: "you will ${m[1]}" → "you ${m[1]}".`));
  },
};

const singularThey = mapRule('singular-they', FAM.C, 'warn', L.GENDERED_PRONOUN_PAIRS, 'Use singular they');

const noPleaseInstructions = {
  id: 'no-please-instructions', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    scan(ctx, /\bplease\b/gi, (m, i) => emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `Omit "please" in instructions (both style guides).`));
  },
};

const terminologyConsistency = {
  id: 'terminology-consistency', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const lower = ctx.masked.toLowerCase();
    for (const variants of L.TERM_VARIANTS) {
      const present = variants.filter((v) => new RegExp(`\\b${esc(v)}\\b`).test(lower));
      if (present.length >= 2) {
        // Locate with the same \b regex used for verification — a plain indexOf can land
        // inside a longer word ("screenlogin").
        const at = new RegExp(`\\b${esc(present[1])}\\b`).exec(lower).index;
        emitAt(ctx, emit, this.id, this.family, 'advisory', at, present[1].length, `Inconsistent terminology: "${present.join('" / "')}" both used — pick one.`);
      }
    }
  },
};

// ======================= Family C: Microsoft pack =======================

const noSpaceEmDash = {
  id: 'no-space-em-dash', family: FAM.C, defaultSeverity: 'advisory', pack: 'microsoft',
  run(ctx, emit) {
    // spaced em-dashes are a common, legitimate style; flag the convention once per doc, not per use
    const hits = [];
    scan(ctx, /\s—\s/g, (m, i) => hits.push(i));
    if (!hits.length) return;
    emitAt(ctx, emit, this.id, this.family, 'advisory', hits[0], 1, `Microsoft style closes up em-dashes ("word—word") — ${hits.length} spaced em-dash${hits.length > 1 ? 'es' : ''} in this file.`);
  },
};
const noInternalCaps = {
  id: 'no-internal-caps', family: FAM.C, defaultSeverity: 'advisory', pack: 'microsoft',
  run(ctx, emit) {
    const allow = new Set(['JavaScript', 'TypeScript', 'GitHub', 'GitLab', 'GraphQL', 'PostgreSQL', 'MySQL', 'iPhone', 'iPad', 'iOS', 'macOS', 'YouTube', 'PayPal', 'WordPress', 'LinkedIn', 'DevOps', 'WiFi', 'eBay', 'OpenAI', 'npm']);
    scan(ctx, /\b[a-z]+[A-Z]\w*\b/g, (m, i) => {
      const w = m[0];
      if (allow.has(w) || /\d/.test(w) || w.length > 16) return; // identifiers/API names, not prose typos
      if (/[A-Z].*[A-Z]/.test(w)) return;                         // multi-cap camelCase = clearly code
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, w.length, `Internal caps "${w}" — avoid mid-word capitals outside known names.`);
    });
  },
};
const omitYouCan = {
  id: 'omit-you-can', family: FAM.C, defaultSeverity: 'advisory', pack: 'microsoft',
  run(ctx, emit) { scan(ctx, /\byou can\b/gi, (m, i) => emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `Microsoft style: often cut "you can" and use the imperative.`)); },
};
const avoidWe = {
  id: 'avoid-we', family: FAM.C, defaultSeverity: 'advisory', pack: 'microsoft',
  run(ctx, emit) {
    const hits = []; scan(ctx, /\b(we|we're|our|us)\b/gi, (m, i) => hits.push(i));
    if (hits.length < 3) return;
    emitAt(ctx, emit, this.id, this.family, 'advisory', hits[0], 2, `Microsoft style avoids first-person "we" in docs (${hits.length} uses). Address the reader instead.`);
  },
};
const spellOutSmall = {
  id: 'spell-out-small-numbers', family: FAM.C, defaultSeverity: 'advisory', pack: 'microsoft',
  run(ctx, emit) {
    scan(ctx, /(?<![\w.$%/-])([0-9])(?![\w.,:%/-])/g, (m, i) => {
      if (ctx.isTableLine(i)) return;
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, 1, `Microsoft style: spell out single-digit numbers in prose ("${m[1]}").`);
    });
  },
};
const numeralSentenceStart = {
  id: 'no-numeral-sentence-start', family: FAM.C, defaultSeverity: 'advisory', pack: 'microsoft',
  run(ctx, emit) {
    const listStarts = new Set(ctx.listItems.map((it) => it.start));
    for (const s of ctx.sentences) {
      if (listStarts.has(s.start)) continue; // ordered-list markers aren't prose
      const t = s.text.replace(/^[\s>*_-]+/, '');
      if (/^\d/.test(t)) emitAt(ctx, emit, this.id, this.family, 'advisory', s.start, 4, `Don't start a sentence with a numeral — spell it out or recast.`);
    }
  },
};
const largeNumberGrouping = {
  id: 'large-number-grouping', family: FAM.C, defaultSeverity: 'advisory', pack: 'microsoft',
  run(ctx, emit) {
    scan(ctx, /(?<![\w,.#/:=-])\d{5,}(?![\w,.])/g, (m, i) => {
      if (ctx.isTableLine(i)) return; // data values in tables aren't prose quantities
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `Group digits with commas ("${Number(m[0]).toLocaleString('en-US')}").`);
    });
  },
};
const noKMB = {
  id: 'no-k-m-b', family: FAM.C, defaultSeverity: 'advisory', pack: 'microsoft',
  run(ctx, emit) { scan(ctx, /\$?\b\d+(?:\.\d+)?\s?[KMB]\b/g, (m, i) => emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `Spell out the magnitude ("${m[0]}" → "… million/billion").`)); },
};
const leadingZero = {
  id: 'leading-zero', family: FAM.C, defaultSeverity: 'advisory', pack: 'microsoft',
  run(ctx, emit) { scan(ctx, /(?<![\d.])\.\d/g, (m, i) => emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `Add a leading zero (".5" → "0.5").`)); },
};

// ======================= Family C: Google pack =======================

const noGerundHeading = {
  id: 'no-gerund-heading', family: FAM.C, defaultSeverity: 'warn', pack: 'google',
  run(ctx, emit) { for (const h of ctx.headings) { const first = (h.text.match(/[A-Za-z]+/) || [''])[0]; if (/ing$/i.test(first) && first.length > 4) emit({ ruleId: this.id, family: this.family, severity: 'warn', offset: h.start, length: h.raw.length, span: h.text, message: `Google style: avoid gerund headings ("${first}…").` }); } },
};
const noLinkInHeading = {
  id: 'no-link-in-heading', family: FAM.C, defaultSeverity: 'warn', pack: 'google',
  run(ctx, emit) { for (const h of ctx.headings) if (/\[[^\]]+\]\([^)]+\)/.test(h.text)) emit({ ruleId: this.id, family: this.family, severity: 'warn', offset: h.start, length: h.raw.length, span: h.text, message: `Google style: don't put links in headings.` }); },
};
const latinismAbbrev = mapRule('latinism-abbreviation', FAM.C, 'warn', L.LATINISMS, 'Google style: spell it out', 'google');
const minimizingWords = listRule('minimizing-words', FAM.C, 'warn', L.MINIMIZING_WORDS, (w) => `Google style: drop minimizing word "${w}" — it's not easy for everyone.`, 'google');
const abbrevAsVerb = {
  id: 'no-abbreviation-as-verb', family: FAM.C, defaultSeverity: 'advisory', pack: 'google',
  run(ctx, emit) { scan(ctx, /(?<!use )(?<!using )\b(ssh|rsync|scp|ftp|chmod|grep)\s+(into|to)\b/gi, (m, i) => emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `Don't use "${m[1]}" as a verb — "use ${m[1].toUpperCase()} to …".`)); },
};
const periodsInAcronyms = {
  id: 'no-periods-in-acronyms', family: FAM.C, defaultSeverity: 'advisory', pack: 'google',
  run(ctx, emit) { scan(ctx, /\b(?:[A-Za-z]\.){2,}/g, (m, i) => { if (/^(e\.g\.|i\.e\.|etc\.)$/i.test(m[0])) return; emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `Drop the periods in the acronym ("${m[0]}" → "${m[0].replace(/\./g, '')}").`); }); },
};
const noExclamation = {
  id: 'no-exclamation', family: FAM.C, defaultSeverity: 'warn', pack: 'google',
  run(ctx, emit) { scan(ctx, /\w!(?!=)/g, (m, i) => emitAt(ctx, emit, this.id, this.family, 'warn', i + 1, 1, `Google style: avoid exclamation marks in technical prose.`)); },
};
const americanSpelling = mapRule('american-spelling', FAM.C, 'warn', L.BRITISH_SPELLINGS, 'Use American spelling', 'google');
const noPreannounce = listRule('no-preannounce', FAM.C, 'advisory', L.PREANNOUNCE, (w) => `Avoid time-relative wording "${w}" — docs outlive it.`, 'google');
const noDirectional = mapRule('no-directional', FAM.C, 'advisory', L.DIRECTIONAL, 'Avoid directional cross-refs', 'google');

// ======================= Family A: markdown structure tells =======================

// A whole line that is just a short, title-like bold phrase used as a fake section header
// instead of `##`. To stay clear of legitimate conventions, it must NOT end in punctuation —
// a trailing colon means a label introducing inline content ("**Fields:**") and a period means
// emphasis ("**Never give up.**"), neither of which is a heading. Distinct from bold-lead-in-list
// (a run of `- **Header**: text` items).
const emphasisAsHeading = {
  id: 'emphasis-as-heading', family: FAM.A, defaultSeverity: 'advisory',
  run(ctx, emit) {
    scan(ctx, /^[ \t]*(\*\*|__)([^*_\n]{1,48}?[^*_\n\s.:!?,;])\1[ \t]*$/gm, (m, i) => {
      if (ctx.isTableLine(i)) return;
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `Bold line used as a heading — use a real heading ("## …") instead.`);
    });
  },
};

// ======================= Family C / D: markdown quality =======================

// A raw URL dropped inline instead of a descriptive markdown link (also an accessibility tell).
const bareUrl = {
  id: 'bare-url', family: FAM.D, defaultSeverity: 'advisory',
  run(ctx, emit) {
    // URLs inside code are already masked out; skip link targets `](url)`, autolinks `<url>`,
    // attribute/quote contexts, and reference definitions `[id]: url`.
    scan(ctx, /(?<![("'<=\]])\bhttps?:\/\/[^\s)>\]"']+/g, (m, i) => {
      const ls = ctx.masked.lastIndexOf('\n', i - 1) + 1;
      if (/\]:\s*$/.test(ctx.masked.slice(ls, i))) return; // reference definition
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, Math.min(m[0].length, 50), `Bare URL — use descriptive link text ("[text](${m[0].slice(0, 30)}…)").`);
    });
  },
};

// A fenced code block with no language hint (both Microsoft & Google guides recommend one).
const fencedCodeLanguage = {
  id: 'fenced-code-language', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const re = /^([ \t]*)```([^\n`]*)$/gm; // fence lines (open and close alternate)
    let m, k = 0;
    while ((m = re.exec(ctx.text))) {
      const isOpener = (k % 2) === 0; k++;
      if (isOpener && !m[2].trim()) emitAt(ctx, emit, this.id, FAM.C, 'advisory', m.index + m[1].length, 3, `Fenced code block has no language hint — add one (e.g. \`\`\`bash).`);
    }
  },
};

// The same heading text used more than once (ambiguous anchors; an AI repetition tell).
const duplicateHeading = {
  id: 'duplicate-heading', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const seen = new Set();
    for (const h of ctx.headings) {
      const key = h.text.trim().toLowerCase();
      if (!key) continue;
      if (seen.has(key)) emit({ ruleId: this.id, family: FAM.C, severity: 'advisory', offset: h.start, length: h.raw.length, span: h.text, message: `Duplicate heading "${h.text.trim()}" — make headings unique.` });
      else seen.add(key);
    }
  },
};

// ======================= Family A: hype =======================

// Vague magnifiers the docs register bans ("greatly simplifies", "crucial", "one of the most").
const hypeIntensifier = listRule('hype-intensifier', FAM.A, 'advisory', L.HYPE_INTENSIFIERS,
  (w) => `Hype intensifier "${w}" — state the concrete benefit instead.`);

// ======================= Family C: terminology casing consistency =======================

// Words that live in ACRONYM_ALLOW only so `undefined-acronym` ignores them — they're English
// words / SQL keywords / callout labels, NOT acronyms, so casing-consistency must skip them.
const ACRO_CASE_STOP = new Set(('note tip info warning important caution danger attention hint example see ' +
  'warn error debug trace idea and or not null true false get put post head new all desc asc ok ' +
  // acronyms that are also common English words ("US ... us" must not flag the pronoun)
  'us jar war zip tar bin pr ram').split(' '));
// A known tech acronym written lowercase when the doc also uses the uppercase form (ddl vs DDL).
const acronymCase = {
  id: 'acronym-case', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const text = ctx.masked;
    const present = new Set(); // known acronyms that appear UPPERCASE in this doc
    let m; const ure = /\b[A-Z]{2,6}\b/g;
    while ((m = ure.exec(text))) if (ACRONYM_ALLOW.has(m[0]) && !ACRO_CASE_STOP.has(m[0].toLowerCase())) present.add(m[0].toLowerCase());
    if (!present.size) return;
    const seen = new Set(); let lm; const lre = /\b[a-z]{2,6}\b/g;
    while ((lm = lre.exec(text))) {
      const k = lm[0]; if (!present.has(k) || seen.has(k)) continue;
      seen.add(k);
      emitAt(ctx, emit, this.id, this.family, 'advisory', lm.index, k.length, `Acronym "${k}" appears as "${k.toUpperCase()}" elsewhere — use one casing.`);
    }
  },
};

// `UDF's` used as a plural — should be `UDFs` (apostrophe only for the possessive).
const acronymPlural = {
  id: 'acronym-plural', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    scan(ctx, /\b([A-Z]{2,5})'s\b/g, (m, i) =>
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `"${m[0]}" — use "${m[1]}s" for the plural; keep "'s" only for the possessive.`));
  },
};

// A multi-word Title-Case term used capitalized in one place and lowercase in another
// ("Catalog Store" vs "catalog store"). Multi-word only — single capitalized words (Table, Group)
// usually carry a real proper-vs-generic distinction and are too noisy to flag. Skips headings/tables.
const CAP_STOP = new Set(('the a an this that these those it he she they we you i if when while for and but or ' +
  'not as at by in on to of is are was were be note tip see use run add get set so such each any all').split(' '));
const inconsistentCapitalization = {
  id: 'inconsistent-capitalization', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const text = ctx.masked;
    const headingLines = new Set(ctx.headings.map((h) => h.line));
    const seen = new Set();
    let m; const re = /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g; // 2+ consecutive capitalized words
    while ((m = re.exec(text))) {
      let words = m[0].split(/\s+/), off = m.index;
      // drop a leading sentence-initial stopword ("The Catalog Store" → "Catalog Store")
      while (words.length && CAP_STOP.has(words[0].toLowerCase())) { off += words[0].length + 1; words.shift(); }
      if (words.length < 2) continue;
      const phrase = words.join(' '), key = phrase.toLowerCase();
      if (seen.has(key)) continue;
      if (ctx.isTableLine(off) || headingLines.has(ctx.locate(off).line)) continue;
      if (new RegExp('\\b' + esc(key) + '\\b').test(text)) { // same phrase, lowercase, elsewhere?
        seen.add(key);
        emitAt(ctx, emit, this.id, this.family, 'advisory', off, phrase.length, `Inconsistent capitalization: "${phrase}" and "${key}" both used — pick one.`);
      }
    }
  },
};

// ======================= Family C: AP pack =======================

// AP omits the Oxford/serial comma; flag its presence so prose drops it (the shared
// `serial-comma` rule self-suppresses under ap, so the two never both fire).
const apSerialComma = {
  id: 'ap-serial-comma', family: FAM.C, defaultSeverity: 'advisory', pack: 'ap',
  run(ctx, emit) {
    scan(ctx, /\b\w+,\s+\w+(,)\s+(and|or)\s+\w+\b/gi, (m, i) => {
      const commaOff = i + m[0].indexOf(`, ${m[2]}`);
      emitAt(ctx, emit, this.id, this.family, 'advisory', commaOff, 1, `AP style omits the serial comma before "${m[2]}".`);
    });
  },
};

// AP spells out whole numbers zero through nine in prose; numerals for 10 and up.
const apNumberStyle = {
  id: 'ap-number-style', family: FAM.C, defaultSeverity: 'advisory', pack: 'ap',
  run(ctx, emit) {
    scan(ctx, /(?<![\w.$%/-])([0-9])(?![\w.,:%/-])/g, (m, i) => {
      if (ctx.isTableLine(i)) return;
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, 1, `AP style: spell out whole numbers zero through nine ("${m[1]}").`);
    });
  },
};

// ======================= Family C: Chicago pack =======================

// Chicago spells out whole numbers zero through one hundred in prose (numerals above 100).
// Chicago also requires the Oxford comma — that's the always-on shared `serial-comma` rule.
const chicagoNumberStyle = {
  id: 'chicago-number-style', family: FAM.C, defaultSeverity: 'advisory', pack: 'chicago',
  run(ctx, emit) {
    scan(ctx, /(?<![\w.$%/:-])(\d{1,3})(?![\w.,:%/-])/g, (m, i) => {
      if (ctx.isTableLine(i)) return;
      if (parseInt(m[1], 10) > 100) return;
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[1].length, `Chicago style: spell out whole numbers zero through one hundred ("${m[1]}").`);
    });
  },
};

// ======================= Family C: plain pack =======================

// plainlanguage.gov keeps sentences short — stricter than the shared long-sentence ceiling (30).
// Cover the 21–30 band the shared rule misses so the two don't double-report.
const plainLongSentence = {
  id: 'plain-long-sentence', family: FAM.C, defaultSeverity: 'advisory', pack: 'plain',
  run(ctx, emit) {
    for (const s of ctx.sentences) {
      const n = ctx.countWords(s.text);
      if (n > 20 && n <= 30) emitAt(ctx, emit, this.id, this.family, 'advisory', s.start, Math.min(s.text.length, 40), `Plain language keeps sentences under 20 words (this one is ${n}).`);
    }
  },
};

// ======================= Family D extras =======================

const personFirst = mapRule('person-first-language', FAM.D, 'warn', L.PERSON_FIRST, 'Person-first language');
const genderedAddress = {
  id: 'gendered-address', family: FAM.D, defaultSeverity: 'advisory',
  run(ctx, emit) {
    scan(ctx, /\b(guys|gentlemen|ladies)\b/gi, (m, i) => emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `Gendered address "${m[0]}" → "everyone / folks".`));
  },
};
const techHistorical = {
  id: 'tech-historical-terms', family: FAM.D, defaultSeverity: 'warn',
  run(ctx, emit) {
    scan(ctx, phraseList(Object.keys(L.TECH_HISTORICAL)), (m, i) => emitAt(ctx, emit, this.id, this.family, 'warn', i, m[0].length, `Prefer inclusive term: "${m[0]}" → "${L.TECH_HISTORICAL[m[0].toLowerCase()]}".`));
    const exempt = /master'?s|scrum master|master class|native speaker|primitive type|native to/i;
    scan(ctx, wordList(Object.keys(L.TECH_HISTORICAL_ADVISORY)), (m, i) => {
      const ctxStr = ctx.masked.slice(Math.max(0, i - 12), i + m[0].length + 12);
      if (exempt.test(ctxStr)) return;
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `Consider "${m[0]}" → "${L.TECH_HISTORICAL_ADVISORY[m[0].toLowerCase()]}" (context-dependent).`);
    });
  },
};
const violentTech = {
  id: 'violent-tech-metaphor', family: FAM.D, defaultSeverity: 'advisory',
  run(ctx, emit) {
    scan(ctx, wordList(Object.keys(L.VIOLENT_TECH)), (m, i) => {
      const after = ctx.masked.slice(i + m[0].length, i + m[0].length + 8);
      if (/^\s*-?\d/.test(after)) return; // kill -9, etc.
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `Violent metaphor "${m[0]}" → "${L.VIOLENT_TECH[m[0].toLowerCase()]}" (in user docs).`);
    });
  },
};
const ageistClassist = mapRule('ageist-classist-cultural', FAM.D, 'advisory', L.AGEIST_CLASSIST, 'Reconsider');
const missingAltText = {
  id: 'missing-alt-text', family: FAM.D, defaultSeverity: 'warn',
  run(ctx, emit) { for (const img of ctx.images) if (!img.alt.trim()) emit({ ruleId: this.id, family: this.family, severity: 'warn', offset: img.start, length: 4, span: img.target, message: `Image has no alt text — add a description (or explicit empty alt if decorative).` }); },
};
const allCapsShouting = {
  id: 'all-caps-shouting', family: FAM.D, defaultSeverity: 'advisory',
  run(ctx, emit) { scan(ctx, /\b[A-Z]{2,}(?:\s+[A-Z]{2,}){2,}\b/g, (m, i) => emitAt(ctx, emit, this.id, this.family, 'advisory', i, Math.min(m[0].length, 40), `All-caps run — screen readers spell it out; use normal case.`)); },
};

// ======================= Family E extras =======================

const markupLeak = {
  id: 'markup-leak', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) { scan(ctx, /^\s{0,3}#{1,6}[^\s#]/gm, (m, i) => emitAt(ctx, emit, this.id, FAM.C, 'advisory', i, m[0].length, `Heading needs a space after "#".`)); },
};
const thematicBreakBeforeHeading = {
  id: 'thematic-break-before-heading', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const headingLines = new Set(ctx.headings.map((h) => h.line));
    const lines = ctx.text.split('\n'); // hoisted — don't re-split per break
    for (const tb of ctx.thematicBreaks) {
      let n = tb.line + 1;
      while (n <= lines.length && /^\s*$/.test(lines[n - 1] || '')) n++;
      if (headingLines.has(n)) emitAt(ctx, emit, this.id, FAM.C, 'advisory', tb.start, 3, `Thematic break "---" right before a heading — an AI scaffold; remove it.`);
    }
  },
};
const bulletOveruse = {
  id: 'bullet-overuse', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const nonBlank = ctx.text.split('\n').filter((l) => l.trim()).length;
    if (ctx.listItems.length < 8 || ctx.listItems.length < nonBlank * 0.5) return;
    emitAt(ctx, emit, this.id, FAM.C, 'advisory', ctx.listItems[0].start, 0, `Bullet overuse: ${ctx.listItems.length}/${nonBlank} lines are list items — convert some to prose.`);
  },
};
const doubleSpace = {
  id: 'double-space', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    scan(ctx, /([^\s.!?:;])(  )(\S)/g, (m, i) => { // skip sentence spacing; require word chars on both sides
      if (ctx.isTableLine(i)) return; // table column alignment isn't a typo
      emitAt(ctx, emit, this.id, FAM.C, 'advisory', i + 1, 2, `Double space between words.`);
    });
  },
};
const redundantAcronym = listRule('redundant-acronym', FAM.C, 'warn', L.REDUNDANT_ACRONYMS, (w) => `Redundant acronym "${w}" — the last word is already in the acronym.`);
const indefiniteArticle = {
  id: 'indefinite-article', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const anConsonant = new Set(L.AN_BEFORE_CONSONANT_LETTER);
    const aVowel = new Set(L.A_BEFORE_VOWEL_LETTER);
    scan(ctx, /(?<![&\w.])(a|an)\s+([a-z][a-z'-]*)/gi, (m, i) => {
      // skip single-letter "A" inside abbreviations (D&A, S&M, G&A) — not an article
      if (/[&.]/.test(ctx.masked[i - 1] || '')) return;
      const art = m[1].toLowerCase(), w = m[2].toLowerCase();
      const startsVowel = /^[aeiou]/.test(w);
      if (art === 'a' && startsVowel && !aVowel.has(w)) emitAt(ctx, emit, this.id, FAM.C, 'advisory', i, m[0].length, `"a ${m[2]}" → "an ${m[2]}".`);
      else if (art === 'an' && !startsVowel && !anConsonant.has(w)) emitAt(ctx, emit, this.id, FAM.C, 'advisory', i, m[0].length, `"an ${m[2]}" → "a ${m[2]}".`);
      else if (art === 'an' && startsVowel && aVowel.has(w)) emitAt(ctx, emit, this.id, FAM.C, 'advisory', i, m[0].length, `"an ${m[2]}" → "a ${m[2]}" (consonant sound).`); // "an user"
      else if (art === 'a' && !startsVowel && anConsonant.has(w)) emitAt(ctx, emit, this.id, FAM.C, 'advisory', i, m[0].length, `"a ${m[2]}" → "an ${m[2]}" (vowel sound).`); // "a hour"
    });
  },
};

// ======================= Family F: citations =======================

const placeholderCitation = {
  id: 'placeholder-citation', family: FAM.C, defaultSeverity: 'warn',
  run(ctx, emit) { scan(ctx, /\[citation needed\]|\(Author,\s*Year\)|\(Year\)|\[REF\]|\[TODO\]|\[TK\]|\[\?\?\]/gi, (m, i) => emitAt(ctx, emit, 'placeholder-citation', FAM.C, 'warn', i, m[0].length, `Placeholder citation "${m[0]}" left in the text.`)); },
};
const trackingParam = {
  id: 'tracking-param-in-citation', family: FAM.C, defaultSeverity: 'warn',
  run(ctx, emit) { scan(ctx, /https?:\/\/\S*[?&](utm_[a-z]+|fbclid|gclid)=/gi, (m, i) => emitAt(ctx, emit, 'tracking-param-in-citation', FAM.C, 'warn', i, m[0].length, `Tracking parameter "${m[1]}" in a cited URL — strip it.`)); },
};
const malformedDoiIsbn = {
  id: 'malformed-doi-isbn', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    scan(ctx, /\bdoi:\s*(\S+)/gi, (m, i) => { if (!/^10\.\d{4,}\/\S+/.test(m[1])) emitAt(ctx, emit, 'malformed-doi-isbn', FAM.C, 'advisory', i, m[0].length, `DOI "${m[1]}" doesn't match 10.NNNN/suffix.`); });
    scan(ctx, /\bISBN[:\s-]*([\d Xx-]{8,})/g, (m, i) => { const d = m[1].replace(/[^\dXx]/g, ''); if (d.length !== 10 && d.length !== 13) emitAt(ctx, emit, 'malformed-doi-isbn', FAM.C, 'advisory', i, m[0].length, `ISBN has ${d.length} digits (expected 10 or 13).`); });
  },
};
const unusedNamedRef = {
  id: 'unused-named-ref', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) { for (const d of ctx.refDefs) if (!ctx.refUses.has(d.id)) emitAt(ctx, emit, this.id, FAM.C, 'advisory', d.start, d.raw.length, `Reference "[${d.id}]" defined but never used.`); },
};

export const EXTRA_RULES = [
  // Family A
  negativeParallelism, tricolonOveruse, servesAsCopula, mediaCoverage, futureOutlook,
  conversational, superficialIng, transitionScaffolding, interrogativeAnswer, excessiveBold, listicleReflex,
  uniformCadence, emphasisAsHeading, hypeIntensifier,
  // markdown quality (Family C/D)
  bareUrl, fencedCodeLanguage, duplicateHeading,
  // terminology casing consistency (Family C)
  acronymCase, acronymPlural, inconsistentCapitalization,
  // Family B
  adverbOveruse, undefinedAcronym, readingGrade,
  // Family C shared
  serialComma, useContractions, secondPerson, presentTense, singularThey, noPleaseInstructions, terminologyConsistency,
  // Family C microsoft
  noSpaceEmDash, noInternalCaps, omitYouCan, avoidWe, spellOutSmall, numeralSentenceStart, largeNumberGrouping, noKMB, leadingZero,
  // Family C google
  noGerundHeading, noLinkInHeading, latinismAbbrev, minimizingWords, abbrevAsVerb, periodsInAcronyms, noExclamation, americanSpelling, noPreannounce, noDirectional,
  // Family C ap / chicago / plain
  apSerialComma, apNumberStyle, chicagoNumberStyle, plainLongSentence,
  // Family D
  personFirst, genderedAddress, techHistorical, violentTech, ageistClassist, missingAltText, allCapsShouting,
  // Family E
  markupLeak, thematicBreakBeforeHeading, bulletOveruse, doubleSpace, redundantAcronym, indefiniteArticle,
  // Family F
  placeholderCitation, trackingParam, malformedDoiIsbn, unusedNamedRef,
];
