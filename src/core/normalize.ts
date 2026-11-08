const INVISIBLES = /[​-‏‪-‮⁠-⁤؜­﻿]/g;

const ARABIC_INDIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const EXT_ARABIC_INDIC_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

function mapDigits(input: string): string {
  let out = '';
  for (const ch of input) {
    const a = ARABIC_INDIC_DIGITS.indexOf(ch);
    if (a >= 0) {
      out += String(a);
      continue;
    }
    const b = EXT_ARABIC_INDIC_DIGITS.indexOf(ch);
    out += b >= 0 ? String(b) : ch;
  }
  return out;
}

const ARABIC_FOLD: Record<string, string> = {
  'ى': 'ي',
  'ی': 'ي', // Persian yeh
  'ې': 'ي',
  'ة': 'ه',
  'ہ': 'ه',
  'ھ': 'ه',
  'ک': 'ك', // Persian kaf
  'ڪ': 'ك',
  'أ': 'ا',
  'إ': 'ا',
  'آ': 'ا',
  'ٱ': 'ا',
  'ؤ': 'و',
  'ئ': 'ي',
};

/**
 * Normalisation used for profanity matching: compatibility-fold, lowercase, strip
 * diacritics and tatweel, fold Arabic letter variants, remove invisible characters.
 */
export function normalizeText(input: string): string {
  let s = input.normalize('NFKC').replace(INVISIBLES, '');
  s = s.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC');
  s = s.replace(/ـ/g, '');
  s = mapDigits(s).toLowerCase();
  let out = '';
  for (const ch of s) out += ARABIC_FOLD[ch] ?? ch;
  return out;
}

/** Normalisation used before URL scanning. Keeps case-insensitive structure intact. */
export function normalizeForLinks(input: string): string {
  let s = input.normalize('NFKC').replace(INVISIBLES, '');
  s = mapDigits(s);
  // Alternative full stops used to dodge detection.
  s = s.replace(/[。｡۔․‧∙·﹒．]/g, '.');
  return s;
}

/** Collapse runs of 3+ identical characters to `keep` copies. */
export function collapseRuns(input: string, keep: 1 | 2): string {
  return input.replace(/(.)\1{2,}/gu, (_m, ch: string) => ch.repeat(keep));
}
