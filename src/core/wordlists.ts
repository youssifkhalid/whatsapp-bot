/**
 * Default blocked terms. Deliberately conservative because the default policy removes members:
 * ambiguous words that are also common names or ordinary vocabulary (dick, cock, ass) are left out
 * and can be added per group as custom terms. Entries are normalised at load time, so spelling
 * variants (ة/ه, أ/ا, diacritics) fold together.
 */
export const DEFAULT_ENGLISH: string[] = [
  'fuck', 'fucker', 'motherfucker', 'shit', 'bullshit', 'bitch', 'asshole', 'bastard', 'cunt',
  'dickhead', 'pussy', 'whore', 'slut', 'cocksucker', 'wanker', 'twat', 'asses',
];

export const DEFAULT_ARABIC: string[] = [
  'كسمك', 'كسامك', 'كسختك', 'كسم', 'كس', 'شرموطة', 'شرموط', 'شراميط', 'عرص', 'معرص', 'منيوك',
  'خول', 'قحبة', 'زب', 'طيز', 'متناك', 'ديوث', 'ابن الكلب', 'ابن الوسخة', 'ابن الشرموطة',
  'ولاد الكلب', 'ولاد الشرموطة', 'كس امك', 'يلعن ابوك', 'يلعن دينك', 'انيكك',
];

/**
 * Arabic terms that are also ordinary words, names or surnames once an affix is attached
 * (e.g. the surname "الخولي"). These match only as an exact whole token.
 */
export const ARABIC_EXACT_ONLY: string[] = ['كس', 'كسم', 'زب', 'خول', 'طيز', 'عرص'];

/** Words that must never be flagged. */
export const DEFAULT_SAFE_WORDS: string[] = [
  'class', 'pass', 'mass', 'grass', 'glass', 'brass', 'bass', 'assist', 'assistant', 'assess',
  'assume', 'cocktail', 'peacock', 'dickens', 'scunthorpe', 'analysis', 'bitcoin',
];
