// Flesch-Kincaid grade + Coleman-Liau cross-check (PITCH §9.2/§9.3). Opt-in (plain pack only).
// Syllable counting is the fragile part (~3-8% word error); fine for aggregate scoring.

const SYLL_EXCEPTIONS = {
  every: 2, business: 2, different: 3, comfortable: 3, vegetable: 3, february: 4,
  area: 3, idea: 3, science: 2, being: 2, create: 2, people: 2, simile: 3, queue: 1,
  the: 1, average: 3, naive: 2, real: 1, cereal: 3,
};

export function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (Object.hasOwn(SYLL_EXCEPTIONS, w)) return SYLL_EXCEPTIONS[w];
  let s = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, ''); // strip silent endings
  s = s.replace(/^y/, '');
  const groups = s.match(/[aeiouy]{1,2}/g);
  let count = groups ? groups.length : 0;
  if (/[^aeiouy]le$/.test(w)) count += 1;        // consonant + -le
  if (/(?:ia|io|ua|eo)/.test(w)) count += 1;      // hiatus
  return Math.max(1, count);
}

export function gradeLevel(words, sentences, syllableTotal, letterTotal) {
  const W = Math.max(words, 1), S = Math.max(sentences, 1);
  const asl = W / S, asw = syllableTotal / W;
  const fkgl = 0.39 * asl + 11.8 * asw - 15.59;
  const cli = 0.0588 * (letterTotal / W * 100) - 0.296 * (S / W * 100) - 15.8;
  return { fkgl, cli, grade: (fkgl + cli) / 2 };
}
