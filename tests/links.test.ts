import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLink } from '../src/core/links.ts';
import type { LinkRules } from '../src/core/types.ts';

const rules: LinkRules = { enabled: true, allowedDomains: [], detectBareDomains: true };
const hit = (t: string, r: LinkRules = rules) => detectLink(t, r);

test('detects http and https links', () => {
  assert.equal(hit('check https://evil.example/path?x=1')?.matched, 'evil.example');
  assert.equal(hit('http://foo.org')?.matched, 'foo.org');
});

test('detects www and bare domains', () => {
  assert.equal(hit('visit www.site.com now')?.matched, 'www.site.com');
  assert.equal(hit('go to casino-win.xyz/free')?.matched, 'casino-win.xyz');
});

test('detects links glued to Arabic text', () => {
  assert.equal(hit('زوروا موقعنا example.com الان')?.matched, 'example.com');
  assert.equal(hit('الرابطhttps://spam.net/x')?.matched, 'spam.net');
});

test('categorises WhatsApp, Telegram, social and shorteners', () => {
  assert.equal(hit('https://chat.whatsapp.com/AbC123')?.category, 'whatsapp_invite');
  assert.equal(hit('wa.me/201000000000')?.category, 'whatsapp_invite');
  assert.equal(hit('t.me/channel')?.category, 'telegram');
  assert.equal(hit('instagram.com/someone')?.category, 'social');
  assert.equal(hit('bit.ly/3abc')?.category, 'shortener');
});

test('detects disguised URLs', () => {
  assert.equal(hit('hxxps://evil[.]com/login')?.matched, 'evil.com');
  assert.equal(hit('evil (dot) com')?.matched, 'evil.com');
  assert.equal(hit('evil dot com')?.matched, 'evil.com');
  assert.equal(hit('evil نقطة com')?.matched, 'evil.com');
  assert.equal(hit('goo​gle.com')?.matched, 'google.com');
  assert.equal(hit('sitex。com')?.matched, 'sitex.com');
});

test('uses the real host when userinfo is used to spoof', () => {
  assert.equal(hit('https://google.com@evil.org/')?.matched, 'evil.org');
});

test('allowed domains pass, including subdomains, but not lookalikes', () => {
  const r = { ...rules, allowedDomains: ['school.edu'] };
  assert.equal(hit('https://school.edu/a', r), null);
  assert.equal(hit('https://portal.school.edu/a', r), null);
  assert.equal(hit('https://school.edu.evil.com/a', r)?.matched, 'school.edu.evil.com');
  assert.equal(hit('https://notschool.edu/a', r)?.matched, 'notschool.edu');
});

test('does not flag ordinary text, filenames, numbers or emails', () => {
  for (const t of [
    'مرحبا كيف حالكم؟', 'see you at 3.5 pm', 'open main.py and index.js', 'version 2.0.1 released',
    'e.g. this one', 'Hello.How are you', 'mail me user@gmail.com', 'ok... fine', '',
  ]) {
    assert.equal(hit(t), null, `false positive on: ${t}`);
  }
});

test('bare domain detection can be turned off but schemes still match', () => {
  const r = { ...rules, detectBareDomains: false };
  assert.equal(hit('example.com', r), null);
  assert.equal(hit('https://example.com', r)?.matched, 'example.com');
});

test('disabled rule never matches', () => {
  assert.equal(hit('https://evil.com', { ...rules, enabled: false }), null);
});
