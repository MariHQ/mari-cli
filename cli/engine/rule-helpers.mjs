// Shared rule helpers and family constants. Standalone so rules.mjs and rules-extra.mjs can
// both import without a circular dependency.

export const FAMILIES = { A: 'ai-slop', B: 'clarity', C: 'style', D: 'inclusive' };

export const FAMILY_LABELS = {
  'ai-slop': 'AI-slop tells',
  clarity: 'Clarity & concision',
  style: 'Style-guide conformance',
  inclusive: 'Inclusive & accessible',
};

export function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function wordList(words) { return new RegExp(`\\b(${words.map(esc).join('|')})\\b`, 'gi'); }

export function phraseList(phrases) {
  const sorted = [...phrases].sort((a, b) => b.length - a.length); // longest first
  return new RegExp(`(${sorted.map(esc).join('|')})`, 'gi');
}

export function scan(ctx, re, cb) {
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(ctx.masked))) {
    cb(m, m.index);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
}

export function isSentenceStart(masked, i) {
  let j = i - 1;
  while (j >= 0 && /[ \t>*_#-]/.test(masked[j])) j--;
  return j < 0 || /[.!?\n]/.test(masked[j]);
}

export function emitAt(ctx, emit, ruleId, family, severity, offset, length, message, ref) {
  const span = ctx.text.slice(offset, offset + Math.min(length, 80)).replace(/\s+/g, ' ').trim();
  emit({ ruleId, family, severity, offset, length, span, message, ref });
}
