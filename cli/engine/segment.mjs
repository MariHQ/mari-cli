// Segmentation: code masking, lines, words, sentences/blocks, and markdown structure.
// Everything downstream works off a single `ctx` built here. Offsets always refer to the
// ORIGINAL text so findings point at the right place; prose scanning uses `masked` (code
// replaced by spaces of equal length) so rules never fire inside code.

const WORD_RE = /[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g;

const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'inc', 'ltd', 'co',
  'no', 'fig', 'al', 'eg', 'ie', 'e.g', 'i.e', 'u.s', 'u.k', 'a.m', 'p.m', 'approx',
]);

export function maskCode(text) {
  // Replace fenced blocks and inline code with spaces of equal length (offsets preserved).
  const chars = text.split('');
  const blankRange = (start, end) => { for (let i = start; i < end; i++) if (chars[i] !== '\n') chars[i] = ' '; };
  const blank = (re) => {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) blankRange(m.index, m.index + m[0].length);
  };
  // Front matter (metadata, not prose): YAML (--- … ---) and TOML (+++ … +++).
  const fm = text.match(/^(---|\+\+\+)\n[\s\S]*?\n\1(?:\n|$)/);
  if (fm) blankRange(0, fm[0].length);
  blank(/```[\s\S]*?```/g);
  blank(/~~~[\s\S]*?~~~/g);
  blank(/`[^`\n]+`/g);
  blank(/<!--[\s\S]*?-->/g);    // HTML comments — license headers, notes; not prose
  blank(/\{\{[\s\S]*?\}\}/g);   // Hugo/Liquid/templating shortcodes: {{< ref >}}, {{% %}}, {{ .Var }}
  blank(/<\/?[a-zA-Z][^>]*>/g); // inline HTML tags
  return chars.join('');
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function makeLocator(starts) {
  return (offset) => {
    let lo = 0, hi = starts.length - 1, line = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= offset) { line = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return { line: line + 1, col: offset - starts[line] + 1 };
  };
}

function countWords(s) {
  const m = s.match(WORD_RE);
  return m ? m.length : 0;
}

// Blocks: paragraphs split on blank lines; headings and list items are their own blocks.
function buildBlocks(masked) {
  const lines = masked.split('\n');
  const blocks = [];
  let cur = null, off = 0;
  const flush = () => { if (cur) { blocks.push(cur); cur = null; } };
  for (const line of lines) {
    const start = off;
    off += line.length + 1;
    const isBlank = /^\s*$/.test(line);
    const isHeading = /^\s{0,3}#{1,6}\s/.test(line);
    const isList = /^\s*([-*+]|\d+[.)])\s/.test(line);
    if (isBlank) { flush(); continue; }
    if (isHeading) { flush(); blocks.push({ start, end: start + line.length, text: line, kind: 'heading' }); continue; }
    if (isList) { flush(); cur = { start, end: start + line.length, text: line, kind: 'list' }; continue; }
    if (!cur) cur = { start, end: start + line.length, text: line, kind: 'para' };
    else cur = { ...cur, end: start + line.length, text: masked.slice(cur.start, start + line.length) };
  }
  flush();
  return blocks;
}

// Sentence splitter within a block (abbreviation- and decimal-aware).
function splitSentences(masked, block) {
  const seg = masked.slice(block.start, block.end);
  const out = [];
  const re = /[.!?]+["')\]”’]?(\s+|$)/g;
  let last = 0, m;
  while ((m = re.exec(seg))) {
    const end = m.index + m[0].length;
    const prevChar = seg[m.index - 1] || '';
    const isDecimal = /\d/.test(prevChar) && /^[.]\d/.test(seg.slice(m.index));
    const wm = seg.slice(last, m.index).match(/([A-Za-z.]+)$/);
    const lastWord = (wm ? wm[1] : '').toLowerCase().replace(/\.+$/, '');
    if (isDecimal || ABBREV.has(lastWord)) continue;
    out.push({ start: block.start + last, end: block.start + end, text: seg.slice(last, end) });
    last = end;
  }
  if (last < seg.length && seg.slice(last).trim()) {
    out.push({ start: block.start + last, end: block.end, text: seg.slice(last) });
  }
  return out;
}

function parseMarkdown(text, masked) {
  const lines = text.split('\n');
  const maskedLines = masked.split('\n');
  const headings = [];
  const listItems = [];
  let off = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const mLine = maskedLines[i] ?? line;
    const start = off;
    off += line.length + 1;
    // Skip lines that are masked (inside code fence): masked line differs and is whitespace.
    if (/^\s*$/.test(mLine) && !/^\s*$/.test(line)) continue;
    const h = line.match(/^(\s{0,3})(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      headings.push({ level: h[2].length, text: h[3], line: i + 1, start, raw: line });
      continue;
    }
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) listItems.push({ indent: li[1].length, marker: li[2], text: li[3], line: i + 1, start });
  }
  // Images first so link parsing can skip them (images are ![..](..)).
  const images = [];
  const imgRe = /!\[([^\]]*)\]\(([^)\s]*)[^)]*\)/g;
  let im;
  while ((im = imgRe.exec(masked))) images.push({ alt: text.slice(im.index + 2, im.index + 2 + im[1].length), target: im[2], start: im.index });
  const imgStarts = new Set(images.map((g) => g.start));

  // Inline links (skip code via masked; skip images by checking preceding '!').
  const links = [];
  const linkRe = /\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g;
  let lm;
  while ((lm = linkRe.exec(masked))) {
    if (masked[lm.index - 1] === '!') continue;
    links.push({ text: text.slice(lm.index + 1, lm.index + 1 + lm[1].length), target: lm[2], start: lm.index });
  }

  // Bold spans (** or __), thematic breaks, reference defs/uses, all-caps runs.
  const boldSpans = [];
  let bm; const boldRe = /\*\*[^*\n]+\*\*|__[^_\n]+__/g;
  while ((bm = boldRe.exec(masked))) boldSpans.push({ start: bm.index, length: bm[0].length });

  const thematicBreaks = [];
  const tableLines = new Set();
  let tOff = 0;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    // test the masked line so frontmatter/code "---" delimiters don't count
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(maskedLines[i] ?? ln)) thematicBreaks.push({ line: i + 1, start: tOff });
    // markdown table rows / separators (leading pipe, or a separator like |---|---|)
    if (/^\s*\|/.test(ln) || /^\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+$/.test(ln) || (ln.match(/\|/g) || []).length >= 2) tableLines.add(i + 1);
    tOff += ln.length + 1;
  }

  const refDefs = [];
  let dm; const defRe = /^\s{0,3}\[([^\]]+)\]:\s+\S+/gm;
  while ((dm = defRe.exec(masked))) refDefs.push({ id: dm[1].toLowerCase(), start: dm.index, raw: dm[0] });
  const refUses = new Set();
  let um; const useRe = /\]\[([^\]]*)\]/g;
  while ((um = useRe.exec(masked))) refUses.add((um[1] || '').toLowerCase());
  // shortcut form [id] referencing a def
  let sm; const shortRe = /(?<!\!)\[([^\]]+)\](?!\s*[[(:])/g;
  while ((sm = shortRe.exec(masked))) refUses.add(sm[1].toLowerCase());

  return { headings, listItems, links, images, boldSpans, thematicBreaks, tableLines, refDefs, refUses };
}

export function segment(text) {
  const masked = maskCode(text);
  const starts = lineStarts(text);
  const locate = makeLocator(starts);
  const blocks = buildBlocks(masked);
  const sentences = [];
  for (const b of blocks) {
    if (b.kind === 'heading') continue;
    sentences.push(...splitSentences(masked, b));
  }
  const wordCount = countWords(masked);
  const md = parseMarkdown(text, masked);
  return {
    text, masked, locate, blocks, sentences, wordCount,
    headings: md.headings, listItems: md.listItems, links: md.links,
    images: md.images, boldSpans: md.boldSpans, thematicBreaks: md.thematicBreaks,
    tableLines: md.tableLines, refDefs: md.refDefs, refUses: md.refUses,
    isTableLine: (offset) => md.tableLines.has(locate(offset).line),
    countWords,
  };
}

// Heuristic: is this text predominantly a non-Latin script (CJK, Cyrillic, Arabic, …)? English
// prose rules are meaningless on it, so the detector skips such files.
export function isNonLatinProse(text) {
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const nonLatin = (text.match(/[　-鿿぀-ヿ가-힯Ѐ-ӿ؀-ۿ฀-๿]/g) || []).length;
  // skip when a meaningful share (≥25%) of letters are non-Latin — English prose rules
  // don't apply, and partially-translated docs would otherwise produce noise.
  return nonLatin > 80 && nonLatin * 3 > latin;
}
