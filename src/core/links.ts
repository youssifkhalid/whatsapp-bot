import { normalizeForLinks } from './normalize.ts';
import type { LinkCategory, LinkRules, Violation } from './types.ts';

/**
 * TLDs accepted for scheme-less ("bare") domains. Deliberately excludes TLDs that collide
 * with common file extensions (py, sh, md, zip, mov, pl, rs) to avoid flagging "main.py".
 */
const BARE_TLDS = new Set(
  (
    'com net org info biz io co me tv xyz online site shop store app dev link live club top vip cc ws ' +
    'ly gl gd tk ml ga cf gq sa ae eg kw qa bh om jo lb iq ps ma dz tn us uk de fr es it ru cn in ir tr pk ' +
    'edu gov mobi pro name click cloud tech news blog fun gg to ai tel ink one page wiki win bid cam art ' +
    'icu buzz cyou rest monster'
  ).split(' '),
);

const WHATSAPP_HOSTS = ['chat.whatsapp.com', 'wa.me', 'whatsapp.com', 'wa.link'];
const TELEGRAM_HOSTS = ['t.me', 'telegram.me', 'telegram.dog', 'telegram.org'];
const SOCIAL_HOSTS = [
  'instagram.com', 'instagr.am', 'facebook.com', 'fb.com', 'fb.me', 'fb.watch', 'tiktok.com',
  'twitter.com', 'x.com', 'youtube.com', 'youtu.be', 'snapchat.com', 'linkedin.com', 'discord.gg',
  'discord.com', 'reddit.com', 'pinterest.com', 'threads.net', 'twitch.tv',
];
const SHORTENER_HOSTS = [
  'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'cutt.ly', 'is.gd', 'rb.gy', 'ow.ly', 'shorturl.at',
  'tiny.cc', 'rebrand.ly', 's.id', 'buff.ly', 'v.gd', 'lnkd.in', 'shorte.st', 'adf.ly',
];

function hostMatches(host: string, list: string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

export function categorize(host: string): LinkCategory {
  if (hostMatches(host, WHATSAPP_HOSTS)) return 'whatsapp_invite';
  if (hostMatches(host, TELEGRAM_HOSTS)) return 'telegram';
  if (hostMatches(host, SHORTENER_HOSTS)) return 'shortener';
  if (hostMatches(host, SOCIAL_HOSTS)) return 'social';
  return 'generic';
}

/** Undo common obfuscations: hxxp, [.] (.) {.} [dot] (dot) and the Arabic word for "dot". */
function deobfuscate(input: string): string {
  return input
    .replace(/\bhxxps?/gi, (m) => m.replace(/xx/i, 'tt'))
    .replace(/\s*[[({<]\s*(?:\.|dot|d0t|نقطة|نقطه)\s*[\])}>]\s*/gi, '.')
    .replace(/\s+(?:dot|نقطة|نقطه)\s+(?=[a-z0-9])/gi, '.')
    .replace(/\s*[[({<]\s*(?:slash|\/)\s*[\])}>]\s*/gi, '/')
    .replace(/\s*[[({<]\s*(?:at|@)\s*[\])}>]\s*/gi, '@');
}

const SCHEME_RE = /\b(?:https?|ftp|ftps):\/\/[^\s<>"'،]+/giu;
const WWW_RE = /\bwww\d{0,3}\.[^\s<>"'،]+/giu;
const BARE_RE =
  /(?<![\p{L}\p{N}@._-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}))(?![\p{L}\p{N}-])(?::\d{1,5})?(?:[/?#][^\s<>"'،]*)?/giu;

const TRAILING_PUNCT = /[.,;:!?)\]}>'"،؛؟]+$/u;

/** Extract the real hostname from a matched URL-ish string. */
export function extractHost(raw: string): string | null {
  let s = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  s = s.split(/[/?#]/, 1)[0] ?? '';
  // user@host tricks: the real host is what follows the last "@".
  const at = s.lastIndexOf('@');
  if (at >= 0) s = s.slice(at + 1);
  s = s.replace(/:\d{0,5}$/, '').replace(TRAILING_PUNCT, '').toLowerCase();
  s = s.replace(/\.+$/, '');
  if (!s.includes('.')) return null;
  if (!/^[a-z0-9.-]+$/.test(s)) return null;
  return s;
}

function isAllowed(host: string, allowed: string[]): boolean {
  return allowed.some((raw) => {
    const d = raw.trim().toLowerCase().replace(/^\*?\./, '');
    return d.length > 0 && (host === d || host.endsWith(`.${d}`));
  });
}

/**
 * Find the first disallowed link in the given text.
 * Returns null when there is none.
 */
export function detectLink(text: string, rules: LinkRules): Violation | null {
  if (!rules.enabled || !text) return null;
  const prepared = deobfuscate(normalizeForLinks(text));

  const candidates: string[] = [];
  for (const re of [SCHEME_RE, WWW_RE]) {
    for (const m of prepared.matchAll(re)) candidates.push(m[0]);
  }
  if (rules.detectBareDomains) {
    for (const m of prepared.matchAll(BARE_RE)) {
      const tld = (m[2] ?? '').toLowerCase();
      if (BARE_TLDS.has(tld)) candidates.push(m[0]);
    }
  }

  for (const c of candidates) {
    const host = extractHost(c);
    if (!host) continue;
    if (isAllowed(host, rules.allowedDomains)) continue;
    return { type: 'link', matched: host, category: categorize(host) };
  }
  return null;
}
