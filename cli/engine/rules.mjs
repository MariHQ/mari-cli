// Deterministic rule implementations + registry. Each rule is { id, family, defaultSeverity,
// run(ctx, emit) }. `emit` records a finding. Density rules require a per-document rate; none
// fire on a single match. Code is already masked out of ctx.masked.

import * as L from './lexicons.mjs';
import { FAMILIES as FAM, esc, wordList, phraseList, scan, isSentenceStart, emitAt } from './rule-helpers.mjs';

// ---- Family A: AI-slop tells ----------------------------------------------

const overusedWord = {
  id: 'overused-word', family: FAM.A, defaultSeverity: 'warn',
  run(ctx, emit) {
    const re = wordList(Object.keys(L.OVERUSED_WEIGHTS));
    const hits = [];
    scan(ctx, re, (m, i) => hits.push({ word: m[1].toLowerCase(), i, raw: m[1] }));
    if (!hits.length) return;
    const distinct = new Set(hits.map((h) => h.word));
    let weighted = 0;
    for (const h of hits) weighted += L.OVERUSED_WEIGHTS[h.word] || 1;
    const density = (hits.length / Math.max(ctx.wordCount, 1)) * 1000; // real per-1k rate
    const score = (weighted / Math.max(ctx.wordCount, 1)) * 1000;       // weighted by over-use ratio
    // co-occurrence of distinct style words is the real signal; a lone hit never fires
    const gate = distinct.size >= 2 || density >= 4;
    if (!gate) return;
    // never 'error' — "overused word" is a judgment call (meta-docs about writing quote these
    // words densely), so it caps at warn to avoid false CI failures.
    const sev = distinct.size >= 3 || score >= 20 ? 'warn' : 'advisory';
    for (const h of hits) {
      emitAt(ctx, emit, this.id, this.family, sev, h.i, h.raw.length,
        `"${h.raw}" — AI-overused style word (${distinct.size} distinct slop words, ${density.toFixed(1)}/1k). Prefer a plainer word.`,
        'Kobak 2025 / Liang 2024');
    }
  },
};

const marketingBuzzword = {
  id: 'marketing-buzzword', family: FAM.A, defaultSeverity: 'warn',
  run(ctx, emit) {
    scan(ctx, wordList(L.MARKETING_BUZZWORDS), (m, i) =>
      emitAt(ctx, emit, this.id, this.family, 'warn', i, m[0].length,
        `"${m[0]}" — marketing buzzword; state the concrete benefit instead.`));
  },
};

const clicheOpener = {
  id: 'cliche-opener', family: FAM.A, defaultSeverity: 'warn',
  run(ctx, emit) {
    const re = /(In today's (?:fast-paced|modern|digital) world|In the (?:ever-evolving|ever-changing|rapidly changing) (?:landscape|world) of|In the realm of|When it comes to|At its core|In the world of)/gi;
    scan(ctx, re, (m, i) => {
      if (!isSentenceStart(ctx.masked, i)) return;
      emitAt(ctx, emit, this.id, this.family, 'warn', i, m[0].length, `Cliché opener "${m[0]}…" — open with the substance.`);
    });
  },
};

const fillerPhrase = {
  id: 'filler-phrase', family: FAM.A, defaultSeverity: 'warn',
  run(ctx, emit) {
    const re = /(It'?s important to note that|It is important to note|It'?s worth noting|It is worth noting|worth mentioning that|Needless to say|At the end of the day|That being said|It should be noted that)/gi;
    scan(ctx, re, (m, i) =>
      emitAt(ctx, emit, this.id, this.family, 'warn', i, m[0].length, `Filler "${m[0]}" — cut it and state the point.`));
  },
};

const manufacturedContrast = {
  id: 'manufactured-contrast', family: FAM.A, defaultSeverity: 'warn',
  run(ctx, emit) {
    const res = [
      /\bnot\s+(just|only|merely|simply)\b[^.!?\n]*?\b(it'?s|but|rather|they'?re|we'?re)\b/gi,
      /\bnot only\b[^.!?\n]*?\bbut(?:\s+also)?\b/gi,
    ];
    for (const re of res) scan(ctx, re, (m, i) =>
      emitAt(ctx, emit, this.id, this.family, 'warn', i, m[0].length, `Manufactured contrast — the strongest AI cadence tell. State the claim directly.`));
  },
};

const conclusionRestate = {
  id: 'conclusion-restate', family: FAM.A, defaultSeverity: 'warn',
  run(ctx, emit) {
    const re = /^(\s{0,3}>?\s*)(In conclusion|In summary|To sum up|In essence|Overall|Ultimately|All in all)\b/gim;
    scan(ctx, re, (m, i) =>
      emitAt(ctx, emit, this.id, this.family, 'warn', i + m[1].length, m[2].length,
        `"${m[2]}" — formulaic conclusion marker; end on a specific point, don't restate the intro.`));
  },
};

const vagueAttribution = {
  id: 'vague-attribution', family: FAM.A, defaultSeverity: 'warn',
  run(ctx, emit) {
    const re = /\b(studies show|research suggests|research shows|experts (?:say|argue|believe)|many believe|it is widely (?:regarded|believed|known)|industry reports|some say|critics argue)\b/gi;
    scan(ctx, re, (m, i) => {
      const window = ctx.masked.slice(i, i + 200);
      if (/\]\(|https?:\/\/|\[\d+\]|\^\d/.test(window)) return; // a citation/link is near
      emitAt(ctx, emit, this.id, this.family, 'warn', i, m[0].length, `"${m[0]}" with no citation — name the source or cut the claim.`);
    });
  },
};

const despiteCloser = {
  id: 'despite-challenges-closer', family: FAM.A, defaultSeverity: 'warn',
  run(ctx, emit) {
    const re = /despite (?:its|these|the|ongoing|numerous)[^.!?\n]*?(?:challenges|difficulties|obstacles|setbacks)[^.!?\n]*?(?:continues to|remains|still)\s+(?:thrive|evolve|grow|serve|play|stand|endure)/gi;
    scan(ctx, re, (m, i) =>
      emitAt(ctx, emit, this.id, this.family, 'warn', i, m[0].length, `The "despite challenges… continues to…" AI wrap-up. Cut or rewrite concretely.`));
  },
};

const significanceBoilerplate = {
  id: 'significance-boilerplate', family: FAM.A, defaultSeverity: 'warn',
  run(ctx, emit) {
    const re = /(stands as a testament|marking a pivotal moment|leaving an indelible mark|enduring legacy|key turning point|plays a (?:vital|crucial|pivotal|key|significant) role|rich (?:history|tapestry|tradition))/gi;
    scan(ctx, re, (m, i) =>
      emitAt(ctx, emit, this.id, this.family, 'warn', i, m[0].length, `Significance boilerplate "${m[0]}" — show it, don't assert it.`));
  },
};

const emDashOveruse = {
  id: 'em-dash-overuse', family: FAM.A, defaultSeverity: 'warn',
  run(ctx, emit) {
    const positions = [];
    scan(ctx, /—|(?<=\s)--(?=\s)/g, (m, i) => positions.push(i));
    if (positions.length < 3) return; // a few dashes are fine; need a pattern
    const per1k = (positions.length / Math.max(ctx.wordCount, 1)) * 1000;
    if (per1k <= 4) return; // human baseline ~3/1k
    emitAt(ctx, emit, this.id, this.family, 'warn', positions[0], 1,
      `Em-dash overuse: ${positions.length} dashes (${per1k.toFixed(1)}/1k words; human baseline ~3). Vary the punctuation.`);
  },
};

const emojiDecoration = {
  id: 'emoji-decoration', family: FAM.A, defaultSeverity: 'warn',
  run(ctx, emit) {
    const re = /^\s*(?:[-*+]\s*)?([☀-➿⬀-⯿️\u{1F000}-\u{1FAFF}])/gmu;
    scan(ctx, re, (m, i) => {
      const at = i + m[0].indexOf(m[1]);
      emitAt(ctx, emit, this.id, this.family, 'warn', at, m[1].length, `Emoji used as decoration/bullet — drop it in prose and docs.`);
    });
  },
};

const boldLeadInList = {
  id: 'bold-lead-in-list', family: FAM.A, defaultSeverity: 'warn',
  run(ctx, emit) {
    const items = ctx.listItems;
    let runStart = -1, runLen = 0;
    const flush = (endItem) => {
      if (runLen >= 3 && runStart >= 0) {
        const it = items[runStart];
        emitAt(ctx, emit, this.id, this.family, 'warn', it.start, 0,
          `${runLen} consecutive bold-lead-in list items — the AI listicle template. Convert some to prose.`);
      }
      runStart = -1; runLen = 0;
    };
    for (let k = 0; k < items.length; k++) {
      const shaped = /^\s*\*\*[^*]+\*\*\s*[:—-]/.test(items[k].text);
      const contiguous = runStart >= 0 && items[k].line === items[k - 1].line + 1;
      if (shaped && (runStart < 0 || contiguous)) { if (runStart < 0) runStart = k; runLen++; }
      else { flush(); if (shaped) { runStart = k; runLen = 1; } }
    }
    flush();
  },
};

const assistantMeta = {
  id: 'assistant-meta', family: FAM.A, defaultSeverity: 'error',
  run(ctx, emit) {
    const re = /(As an AI language model|as of my (?:knowledge cutoff|last (?:update|training))|I hope this helps|Certainly!|I'd be happy to|Let me know if you|Feel free to (?:ask|reach)|Here's a breakdown|\[insert [^\]]+\](?![([])|\[Your Name\]|\[Your Company\])/gi;
    scan(ctx, re, (m, i) =>
      emitAt(ctx, emit, this.id, this.family, 'error', i, m[0].length, `Assistant boilerplate "${m[0]}" left in the text. Remove it.`));
  },
};

const sycophancy = {
  id: 'sycophancy', family: FAM.A, defaultSeverity: 'warn',
  run(ctx, emit) {
    const re = /\b(Great question|You're absolutely right|That's a great point|Excellent question|What a fascinating)\b/gi;
    scan(ctx, re, (m, i) =>
      emitAt(ctx, emit, this.id, this.family, 'warn', i, m[0].length, `Chatbot sycophancy "${m[0]}" — cut it.`));
  },
};

const smartQuotes = {
  id: 'smart-quotes', family: FAM.A, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const positions = [];
    scan(ctx, /[‘’“”]/g, (m, i) => positions.push(i));
    if (positions.length < 3) return; // a stray pair is fine; a pattern is the tell
    emitAt(ctx, emit, this.id, this.family, 'advisory', positions[0], 1, `Curly quotes/apostrophes (${positions.length}) where ASCII is usually expected.`);
  },
};

const unicodeArtifact = {
  id: 'unicode-artifact', family: FAM.A, defaultSeverity: 'warn',
  run(ctx, emit) {
    scan(ctx, /[  ​‌‍﻿]/g, (m, i) =>
      emitAt(ctx, emit, this.id, this.family, 'warn', i, 1, `Invisible Unicode artifact (U+${m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}) — chatbot copy residue.`));
  },
};

const hedgeOveruse = {
  id: 'hedge-overuse', family: FAM.A, defaultSeverity: 'warn',
  run(ctx, emit) {
    const hits = [];
    scan(ctx, phraseList(L.HEDGES), (m, i) => hits.push({ m, i }));
    const per1k = (hits.length / Math.max(ctx.wordCount, 1)) * 1000;
    if (hits.length < 2 && per1k < 3) return;
    for (const h of hits)
      emitAt(ctx, emit, this.id, this.family, hits.length >= 4 ? 'warn' : 'advisory', h.i, h.m[0].length, `Hedge "${h.m[0]}" — commit to the claim.`);
  },
};

// ---- Family B: clarity & concision ----------------------------------------

const IRREGULAR_PP = new Set('arisen awoken beaten begun broken brought built chosen done drawn driven eaten fallen forgotten frozen given gone grown hidden known made paid seen sold sent shown taken thrown told thought woven written found held kept led lost meant met put read run set'.split(' '));
const ADJ_PARTICIPLE = new Set('interested located excited based related done born involved supposed used pleased concerned tired limited known given dedicated committed advanced detailed'.split(' '));

const passiveVoice = {
  id: 'passive-voice', family: FAM.B, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const re = /\b(am|is|are|was|were|be|been|being)\s+(?:\w+ly\s+){0,2}([a-z]+(?:ed|en))\b/gi;
    scan(ctx, re, (m, i) => {
      const pp = m[2].toLowerCase();
      const isPP = pp.endsWith('ed') || pp.endsWith('en') || IRREGULAR_PP.has(pp);
      if (!isPP) return;
      const after = ctx.masked.slice(i + m[0].length, i + m[0].length + 30);
      const byAgent = /^\s+by\b/.test(after);
      if (ADJ_PARTICIPLE.has(pp) && !byAgent) return; // predicate adjective
      if (/^\s+(in|about|with|at|of|to|for)\b/.test(after) && !byAgent) return;
      emitAt(ctx, emit, this.id, this.family, byAgent ? 'warn' : 'advisory', i, m[0].length, `Passive voice "${m[0].trim()}" — prefer active ("X ${pp} …").`);
    });
  },
};

const longSentence = {
  id: 'long-sentence', family: FAM.B, defaultSeverity: 'warn',
  run(ctx, emit) {
    const ceiling = 30;
    for (const s of ctx.sentences) {
      const n = ctx.countWords(s.text);
      if (n > ceiling) emitAt(ctx, emit, this.id, this.family, 'warn', s.start, Math.min(s.text.length, 60), `Sentence is ${n} words (ceiling ${ceiling}). Split it.`);
    }
  },
};

function mapRule(id, sev, map, label) {
  return {
    id, family: FAM.B, defaultSeverity: sev,
    run(ctx, emit) {
      scan(ctx, phraseList(Object.keys(map)), (m, i) => {
        const key = m[0].toLowerCase();
        emitAt(ctx, emit, id, this.family, sev, i, m[0].length, `${label}: "${m[0]}" → "${map[key] || map[m[0]]}".`);
      });
    },
  };
}

const wordyPhrase = mapRule('wordy-phrase', 'warn', L.WORDY_PHRASES, 'Wordy');
const complexWord = mapRule('complex-word', 'advisory', L.COMPLEX_WORDS, 'Complex word');
const nominalization = mapRule('nominalization', 'advisory', L.NOMINALIZATIONS, 'Nominalization');

const weaselWord = {
  id: 'weasel-word', family: FAM.B, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const hits = [];
    scan(ctx, wordList(L.WEASEL_WORDS), (m, i) => hits.push({ m, i }));
    const per1k = (hits.length / Math.max(ctx.wordCount, 1)) * 1000;
    if (hits.length < 3 && per1k < 4) return;
    for (const h of hits) emitAt(ctx, emit, this.id, this.family, 'advisory', h.i, h.m[0].length, `Weasel word "${h.m[0]}" — usually deletable.`);
  },
};

const redundantPair = {
  id: 'redundant-pair', family: FAM.B, defaultSeverity: 'warn',
  run(ctx, emit) {
    scan(ctx, phraseList(L.REDUNDANT_PAIRS), (m, i) =>
      emitAt(ctx, emit, this.id, this.family, 'warn', i, m[0].length, `Redundant pair "${m[0]}" — keep one word.`));
  },
};

const repeatedWord = {
  id: 'repeated-word', family: FAM.B, defaultSeverity: 'warn',
  run(ctx, emit) {
    scan(ctx, /\b(\w+)\s+\1\b/gi, (m, i) => {
      if (/^(that|had)$/i.test(m[1])) return; // legitimate doublings ("the fact that that…", "had had")
      emitAt(ctx, emit, this.id, this.family, 'warn', i, m[0].length, `Repeated word "${m[1]} ${m[1]}".`);
    });
  },
};

const thereIsExpletive = {
  id: 'there-is-expletive', family: FAM.B, defaultSeverity: 'advisory',
  run(ctx, emit) {
    const re = /\b(There (?:is|are|was|were)|It is)\s+[^.!?\n]{3,40}?\b(that|who|which)\b/gi;
    scan(ctx, re, (m, i) => {
      if (!isSentenceStart(ctx.masked, i)) return;
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, Math.min(m[0].length, 40), `Expletive "${m[1]}…${m[2]}" — weak subject; rewrite directly.`);
    });
  },
};

// ---- Family C: style (Microsoft + shared) ---------------------------------

const SMALL_WORDS = new Set('a an the and or but for nor of to in on at by as is are with from into via per vs'.split(' '));

const sentenceCaseHeading = {
  id: 'sentence-case-heading', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    for (const h of ctx.headings) {
      const before = h.text.split(/[:—]/)[0];
      const words = before.match(/[A-Za-z][A-Za-z'’-]*/g) || [];
      if (words.length < 3) continue;
      let capped = 0;
      words.forEach((w, idx) => {
        if (idx === 0) return;
        if (SMALL_WORDS.has(w.toLowerCase())) return;
        if (/^[A-Z]{2,}$/.test(w)) return; // acronym
        if (/^[A-Z]/.test(w) && w.toLowerCase() === w.slice(1).toLowerCase() + w[0]) {} // noop
        if (/^[A-Z][a-z]/.test(w)) capped++;
      });
      if (capped >= 2) {
        emit({ ruleId: this.id, family: this.family, severity: 'advisory', offset: h.start, length: h.raw.length, span: h.text, message: `Heading looks Title Case — Microsoft/Google use sentence case ("${sentenceCase(before)}").`, ref: 'MS/Google style' });
      }
    }
  },
};
function sentenceCase(s) {
  let first = true;
  return s.replace(/[A-Za-z][A-Za-z'’-]*/g, (w) => {
    if (first) { first = false; return w; }
    if (/^[A-Z]{2,}/.test(w)) return w; // keep acronyms
    return w.charAt(0).toLowerCase() + w.slice(1);
  });
}

const headingEndPunctuation = {
  id: 'heading-end-punctuation', family: FAM.C, defaultSeverity: 'warn',
  run(ctx, emit) {
    for (const h of ctx.headings) {
      if (/[.:!]$/.test(h.text.trim())) emit({ ruleId: this.id, family: this.family, severity: 'warn', offset: h.start, length: h.raw.length, span: h.text, message: `Heading ends with terminal punctuation — drop it.` });
    }
  },
};

const wordSwap = {
  id: 'word-swap', family: FAM.C, defaultSeverity: 'advisory',
  run(ctx, emit) {
    scan(ctx, phraseList(Object.keys(L.WORD_SWAP)), (m, i) => {
      const key = m[0].toLowerCase();
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `Style swap: "${m[0]}" → "${L.WORD_SWAP[key]}".`, 'MS/Google word list');
    });
  },
};

// ---- Family D: inclusive & accessible -------------------------------------

const gendered = {
  id: 'gendered-language', family: FAM.D, defaultSeverity: 'warn',
  run(ctx, emit) {
    scan(ctx, wordList(Object.keys(L.GENDERED)), (m, i) => {
      const key = m[0].toLowerCase();
      emitAt(ctx, emit, this.id, this.family, 'warn', i, m[0].length, `Gendered term "${m[0]}" → "${L.GENDERED[key]}".`);
    });
  },
};

const ableist = {
  id: 'ableist-language', family: FAM.D, defaultSeverity: 'warn',
  run(ctx, emit) {
    scan(ctx, phraseList(Object.keys(L.ABLEIST_WARN)), (m, i) =>
      emitAt(ctx, emit, this.id, this.family, 'warn', i, m[0].length, `Ableist "${m[0]}" → "${L.ABLEIST_WARN[m[0].toLowerCase()]}".`));
    scan(ctx, phraseList(Object.keys(L.ABLEIST_ADVISORY)), (m, i) =>
      emitAt(ctx, emit, this.id, this.family, 'advisory', i, m[0].length, `"${m[0]}" reads as ableist idiom → "${L.ABLEIST_ADVISORY[m[0].toLowerCase()]}".`));
  },
};

const vagueLinkText = {
  id: 'vague-link-text', family: FAM.D, defaultSeverity: 'warn',
  run(ctx, emit) {
    for (const link of ctx.links) {
      if (L.VAGUE_LINK_TEXT.includes(link.text.trim().toLowerCase()))
        emit({ ruleId: this.id, family: this.family, severity: 'warn', offset: link.start, length: link.text.length + 2, span: link.text, message: `Vague link text "${link.text}" — describe the destination (WCAG).` });
    }
  },
};

const skippedHeading = {
  id: 'skipped-heading', family: FAM.D, defaultSeverity: 'warn',
  run(ctx, emit) {
    let prev = 0, h1 = 0;
    for (const h of ctx.headings) {
      if (h.level === 1) h1++;
      if (prev && h.level > prev + 1)
        emit({ ruleId: this.id, family: this.family, severity: 'warn', offset: h.start, length: h.raw.length, span: h.text, message: `Heading jumps h${prev}→h${h.level}; don't skip levels.` });
      prev = h.level;
    }
    if (h1 > 1) {
      const second = ctx.headings.filter((h) => h.level === 1)[1];
      emit({ ruleId: 'skipped-heading', family: this.family, severity: 'advisory', offset: second.start, length: second.raw.length, span: second.text, message: `More than one h1 in the document.` });
    }
  },
};

// ---- registry --------------------------------------------------------------

import { EXTRA_RULES } from './rules-extra.mjs';
import { VALE_RULES } from './rules-vale.mjs';

export const RULES = [
  overusedWord, marketingBuzzword, clicheOpener, fillerPhrase, manufacturedContrast,
  conclusionRestate, vagueAttribution, despiteCloser, significanceBoilerplate,
  emDashOveruse, emojiDecoration, boldLeadInList, assistantMeta, sycophancy,
  smartQuotes, unicodeArtifact, hedgeOveruse,
  passiveVoice, longSentence, wordyPhrase, complexWord, nominalization, weaselWord,
  redundantPair, repeatedWord, thereIsExpletive,
  sentenceCaseHeading, headingEndPunctuation, wordSwap,
  gendered, ableist, vagueLinkText, skippedHeading,
  ...EXTRA_RULES,
  ...VALE_RULES,
];

export const FAMILIES = FAM;
export const FAMILY_LABELS = {
  'ai-slop': 'AI-slop tells',
  clarity: 'Clarity & concision',
  style: 'Style-guide conformance',
  inclusive: 'Inclusive & accessible',
  grounding: 'Grounding & factuality',
};
