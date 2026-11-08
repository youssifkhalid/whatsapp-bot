import { collapseRuns, normalizeText } from './normalize.ts';
import type { ProfanityRules, Violation } from './types.ts';
import { ARABIC_EXACT_ONLY, DEFAULT_ARABIC, DEFAULT_ENGLISH, DEFAULT_SAFE_WORDS } from './wordlists.ts';

const LEET: Record<string, string> = { '@': 'a', $: 's', '!': 'i', '+': 't', '0': 'o', '3': 'e', '4': 'a', '5': 's', '7': 't', '1': 'i' };
const LEET_CHARS = /[@$!+013457]/;
const SYMBOLS = '@$!+';
const EN_SUFFIXES = ['s', 'es', 'ed', 'er', 'ers', 'ing', 'in', 'y'];
const AR_PREFIXES = ['و', 'ف', 'ب', 'ل', 'ك', 'ال', 'وال'];
const MAX_RUN = 30;

const ARABIC_ONLY = /^[؀-ۿ]+$/u;
const LATIN_ONLY = /^[a-z]+$/;

function leet(token: string, oneAsL: boolean): string {
  let out = '';
  for (const ch of token) out += ch === '1' && oneAsL ? 'l' : (LEET[ch] ?? ch);
  return out;
}

function stripSymbols(token: string): string {
  let a = 0;
  let b = token.length;
  while (a < b && SYMBOLS.includes(token[a] as string)) a++;
  while (b > a && SYMBOLS.includes(token[b - 1] as string)) b--;
  return token.slice(a, b);
}

function isSingleUnit(token: string): boolean {
  return [...token].length === 1;
}

export class ProfanityDetector {
  private readonly words = new Set<string>();
  private readonly phrases = new Set<string>();
  private readonly exactOnly = new Set<string>();
  private readonly safe = new Set<string>();
  private readonly enabled: boolean;

  constructor(rules: ProfanityRules) {
    this.enabled = rules.enabled;
    for (const w of [...DEFAULT_ENGLISH, ...DEFAULT_ARABIC, ...rules.customWords]) {
      const n = normalizeText(w).trim().replace(/\s+/g, ' ');
      if (!n) continue;
      if (n.includes(' ')) this.phrases.add(n);
      else this.words.add(n);
    }
    for (const w of ARABIC_EXACT_ONLY) this.exactOnly.add(normalizeText(w));
    for (const w of [...DEFAULT_SAFE_WORDS, ...rules.allowWords]) this.safe.add(normalizeText(w));
  }

  /** Match one already-normalised form against the word list. Returns the list entry hit. */
  private matchForm(form: string): string | null {
    if (!form || this.safe.has(form)) return null;
    if (this.words.has(form)) return form;

    if (LATIN_ONLY.test(form)) {
      for (const sfx of EN_SUFFIXES) {
        if (form.endsWith(sfx)) {
          const stem = form.slice(0, -sfx.length);
          if (stem.length >= 4 && this.words.has(stem) && !this.safe.has(form)) return stem;
        }
      }
    } else if (ARABIC_ONLY.test(form)) {
      for (const pre of AR_PREFIXES) {
        if (form.startsWith(pre)) {
          const stem = form.slice(pre.length);
          if (stem.length >= 3 && this.words.has(stem) && !this.exactOnly.has(stem)) return stem;
        }
      }
    }
    return null;
  }

  /** Try a token (and its leet / stretch variants) against the list. */
  private matchToken(token: string): string | null {
    const base = stripSymbols(token);
    if (!base || this.safe.has(base)) return null;

    const variants = new Set<string>([base]);
    if (LEET_CHARS.test(token) && /\p{L}/u.test(token)) {
      for (const oneAsL of [false, true]) {
        variants.add(leet(base, oneAsL));
        variants.add(leet(token, oneAsL));
      }
    }
    for (const v of variants) {
      for (const form of new Set([v, collapseRuns(v, 1), collapseRuns(v, 2)])) {
        const hit = this.matchForm(form);
        if (hit) return hit;
      }
    }
    return null;
  }

  detect(text: string): Violation | null {
    if (!this.enabled || !text) return null;
    const tokens = normalizeText(text)
      .split(/[^\p{L}\p{N}@$!+]+/u)
      .filter((t) => t.length > 0);

    // 1. Individual tokens.
    for (const t of tokens) {
      const hit = this.matchToken(t);
      if (hit) return { type: 'profanity', matched: hit };
    }

    // 2. Multi-word phrases.
    if (this.phrases.size > 0) {
      const clean = tokens.map((t) => stripSymbols(t)).filter((t) => t.length > 0);
      for (let size = 2; size <= 4; size++) {
        for (let i = 0; i + size <= clean.length; i++) {
          const slice = clean.slice(i, i + size);
          for (const forms of [slice, slice.map((t) => collapseRuns(t, 1))]) {
            const joined = forms.join(' ');
            if (this.phrases.has(joined)) return { type: 'profanity', matched: joined };
          }
        }
      }
    }

    // 3. Spacing evasion: runs of single characters ("f u c k", "f.u.c.k").
    let i = 0;
    while (i < tokens.length) {
      if (!isSingleUnit(tokens[i] as string)) {
        i++;
        continue;
      }
      let j = i;
      while (j < tokens.length && isSingleUnit(tokens[j] as string) && j - i < MAX_RUN) j++;
      if (j - i >= 3) {
        const run = tokens.slice(i, j);
        for (let a = 0; a < run.length; a++) {
          for (let b = a + 3; b <= run.length; b++) {
            const hit = this.matchToken(run.slice(a, b).join(''));
            if (hit) return { type: 'profanity', matched: hit };
          }
        }
      }
      i = j;
    }
    return null;
  }
}
