import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { encodeQr, qrPath } from '../src/web/lib/qr.ts';

const hasCv2 = spawnSync('python3', ['-c', 'import cv2, numpy'], { encoding: 'utf8' }).status === 0;

// A realistic WhatsApp Web pairing payload shape: "ref,publicKeyB64,identityKeyB64,advSecretB64"
const sample = (n: number) => {
  let s = '2@';
  let x = 12345;
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=,';
  while (s.length < n) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    s += chars[x % chars.length];
  }
  return s;
};

test('encoder picks the smallest version and produces a square matrix with finder patterns', () => {
  const m = encodeQr('hello');
  assert.equal(m.version, 1);
  assert.equal(m.size, 21);
  // finder pattern corners are dark
  for (const [x, y] of [[0, 0], [20, 0], [0, 20]] as const) assert.equal(m.modules[y]?.[x], true);
  assert.equal(encodeQr(sample(300)).version >= 10, true);
  assert.equal(encodeQr(sample(300)).size, encodeQr(sample(300)).version * 4 + 17);
});

test('rejects payloads that do not fit instead of producing a bad code', () => {
  assert.throws(() => encodeQr('x'.repeat(2000)), /too long/);
});

test('qrPath produces SVG path data for dark modules within the quiet-zone viewBox', () => {
  const m = encodeQr('hi');
  const { d, viewBox } = qrPath(m);
  assert.equal(viewBox, m.size + 8);
  assert.match(d, /^M4 4h7v1h-7z/, 'first row starts with the 7-module finder bar after the quiet zone');
});

test('round trip: OpenCV decodes our QR codes across versions 1-20 and realistic payload sizes', { skip: hasCv2 ? false : 'python3 with cv2+numpy not available' }, () => {
  const texts = ['a', 'hello world', 'https://example.com/path?q=1', sample(60), sample(120), sample(200), sample(260), sample(330), sample(450), sample(600), sample(800), 'مرحبا بالعالم', sample(850)];
  const items = texts.map((text) => {
    const m = encodeQr(text);
    return { text, size: m.size, rows: m.modules.map((r) => r.map((c) => (c ? '1' : '0')).join('')), version: m.version };
  });
  const res = spawnSync('python3', ['-I', 'scripts/qr_decode.py'], { input: JSON.stringify(items), encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout) as { ok: boolean; decoded: string }[];
  const failures = out.map((o, i) => (o.ok ? null : `v${items[i]?.version} len=${items[i]?.text.length}`)).filter(Boolean);
  assert.deepEqual(failures, []);
  assert.ok(items.some((i) => i.version >= 10) && items.some((i) => i.version === 1));
});

test('every one of the 8 masks yields a decodable code (codeword placement is mask-independent)', { skip: hasCv2 ? false : 'python3 with cv2+numpy not available' }, () => {
  const items = [sample(20), sample(110), sample(300), sample(429), sample(792), sample(850)].flatMap((text) =>
    Array.from({ length: 8 }, (_, mask) => {
      const m = encodeQr(text, mask);
      return { text, size: m.size, rows: m.modules.map((r) => r.map((c) => (c ? '1' : '0')).join('')), version: m.version, mask };
    }),
  );
  const res = spawnSync('python3', ['-I', 'scripts/qr_decode.py'], { input: JSON.stringify(items), encoding: 'utf8', maxBuffer: 1 << 26 });
  assert.equal(res.status, 0, res.stderr);
  const out = JSON.parse(res.stdout) as { ok: boolean }[];
  assert.deepEqual(out.map((o, i) => (o.ok ? null : `v${items[i]?.version} mask${items[i]?.mask}`)).filter(Boolean), []);
  assert.equal(out.length, 48);
});
