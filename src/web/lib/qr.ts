/**
 * Dependency-free QR Code encoder (byte mode, error correction level L, versions 1-20).
 * Written because the `qrcode` package cannot be installed offline; round-trip verified by decoding the output
 * with OpenCV (tests/qr.test.ts). Pure functions, no DOM.
 */

const ECC_PER_BLOCK_L = [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28];
const BLOCKS_L = [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8];
export const MAX_VERSION = 20;

function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const n = Math.floor(ver / 7) + 2;
  const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 10, i = n - 1; i > 0; i--, pos -= step) out.splice(1, 0, pos);
  return out;
}

function rawDataModules(ver: number): number {
  let r = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const n = Math.floor(ver / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (ver >= 7) r -= 36;
  }
  return r;
}

// --- Reed-Solomon over GF(256), polynomial 0x11D
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255] as number;
})();
const gmul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : (EXP[(LOG[a] as number) + (LOG[b] as number)] as number));

function rsGenerator(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j] as number) ^ gmul(poly[j] as number, 1);
      next[j + 1] = (next[j + 1] as number) ^ gmul(poly[j] as number, EXP[i] as number);
    }
    poly = next;
  }
  return poly; // highest degree first, leading coefficient 1
}

function rsRemainder(data: number[], gen: number[]): number[] {
  const degree = gen.length - 1;
  const rem = new Array<number>(degree).fill(0);
  for (const b of data) {
    const factor = b ^ (rem.shift() as number);
    rem.push(0);
    for (let i = 0; i < degree; i++) rem[i] = (rem[i] as number) ^ gmul(gen[i + 1] as number, factor);
  }
  return rem;
}

function utf8(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

function buildCodewords(bytes: number[], ver: number): number[] {
  const capBits = Math.floor(rawDataModules(ver) / 8);
  const nBlocks = BLOCKS_L[ver] as number;
  const eccLen = ECC_PER_BLOCK_L[ver] as number;
  const dataCap = capBits - eccLen * nBlocks;

  const bits: number[] = [];
  const push = (v: number, n: number) => {
    for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, dataCap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  for (let pad = 0xec; data.length < dataCap; pad ^= 0xec ^ 0x11) data.push(pad);

  const shortLen = Math.floor(capBits / nBlocks);
  const numShort = nBlocks - (capBits % nBlocks);
  const gen = rsGenerator(eccLen);
  const blocks: number[][] = [];
  const eccs: number[][] = [];
  for (let i = 0, k = 0; i < nBlocks; i++) {
    const len = shortLen - eccLen + (i < numShort ? 0 : 1);
    const d = data.slice(k, k + len);
    k += len;
    blocks.push(d);
    eccs.push(rsRemainder(d, gen));
  }
  const out: number[] = [];
  for (let i = 0; i <= shortLen - eccLen; i++) {
    for (const b of blocks) if (i < b.length) out.push(b[i] as number);
  }
  for (let i = 0; i < eccLen; i++) for (const e of eccs) out.push(e[i] as number);
  return out;
}

type Grid = boolean[][];

function formatBits(mask: number): number {
  const data = (0b01 << 3) | mask; // ECC level L = 01
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function versionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

export interface QrMatrix {
  size: number;
  version: number;
  /** true = dark module */
  modules: boolean[][];
}

function penalty(m: Grid): number {
  const n = m.length;
  let score = 0;
  const runScore = (line: boolean[]) => {
    let s = 0;
    let run = 1;
    for (let i = 1; i <= line.length; i++) {
      if (i < line.length && line[i] === line[i - 1]) run++;
      else {
        if (run >= 5) s += 3 + (run - 5);
        run = 1;
      }
    }
    // finder-like 1:1:3:1:1 patterns with light borders
    const str = line.map((b) => (b ? '1' : '0')).join('');
    for (const pat of ['10111010000', '00001011101']) {
      let idx = str.indexOf(pat);
      while (idx !== -1) {
        s += 40;
        idx = str.indexOf(pat, idx + 1);
      }
    }
    return s;
  };
  for (let y = 0; y < n; y++) score += runScore(m[y] as boolean[]);
  for (let x = 0; x < n; x++) score += runScore(m.map((row) => row[x] as boolean));
  for (let y = 0; y < n - 1; y++)
    for (let x = 0; x < n - 1; x++) {
      const c = (m[y] as boolean[])[x];
      if (c === (m[y] as boolean[])[x + 1] && c === (m[y + 1] as boolean[])[x] && c === (m[y + 1] as boolean[])[x + 1]) score += 3;
    }
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const pct = (dark * 100) / (n * n);
  score += Math.floor(Math.abs(pct - 50) / 5) * 10;
  return score;
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

export function encodeQr(text: string, forceMask?: number): QrMatrix {
  const bytes = utf8(text);
  let ver = 1;
  for (; ver <= MAX_VERSION; ver++) {
    const dataCap = Math.floor(rawDataModules(ver) / 8) - (ECC_PER_BLOCK_L[ver] as number) * (BLOCKS_L[ver] as number);
    const needBits = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
    if (needBits <= dataCap * 8) break;
  }
  if (ver > MAX_VERSION) throw new Error(`text too long for QR (${bytes.length} bytes; max version ${MAX_VERSION})`);

  const size = ver * 4 + 17;
  const codewords = buildCodewords(bytes, ver);

  const mod: Grid = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const fn: Grid = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    (mod[y] as boolean[])[x] = dark;
    (fn[y] as boolean[])[x] = true;
  };

  // timing
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // finders + separators
  const finder = (cx: number, cy: number) => {
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, d !== 2 && d !== 4);
      }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);
  // alignment
  const pos = alignmentPositions(ver);
  for (let i = 0; i < pos.length; i++)
    for (let j = 0; j < pos.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) set((pos[i] as number) + dx, (pos[j] as number) + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  // reserve format + version areas, then fill them per mask
  const drawFormat = (put: (x: number, y: number, dark: boolean) => void, mask: number) => {
    const bits = formatBits(mask);
    const b = (i: number) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) put(8, i, b(i));
    put(8, 7, b(6));
    put(8, 8, b(7));
    put(7, 8, b(8));
    for (let i = 9; i < 15; i++) put(14 - i, 8, b(i));
    for (let i = 0; i < 8; i++) put(size - 1 - i, 8, b(i));
    for (let i = 8; i < 15; i++) put(8, size - 15 + i, b(i));
    put(8, size - 8, true); // dark module
  };
  drawFormat(set, 0); // reserves the format area as function modules
  if (ver >= 7) {
    const bits = versionBits(ver);
    for (let i = 0; i < 18; i++) {
      const dark = ((bits >>> i) & 1) !== 0;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }

  // data placement (zig-zag)
  const bitAt = (i: number) => (((codewords[i >>> 3] as number) >>> (7 - (i & 7))) & 1) !== 0;
  const total = codewords.length * 8;
  const place = (mask: number): Grid => {
    const g: Grid = mod.map((r) => r.slice());
    let i = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if ((fn[y] as boolean[])[x]) continue;
          let dark = i < total ? bitAt(i) : false;
          i++;
          if ((MASKS[mask] as (x: number, y: number) => boolean)(x, y)) dark = !dark;
          (g[y] as boolean[])[x] = dark;
        }
      }
    }
    return g;
  };

  let best: { grid: Grid; score: number } | undefined;
  for (let mask = forceMask ?? 0; mask < (forceMask === undefined ? 8 : forceMask + 1); mask++) {
    const g = place(mask);
    drawFormat((x, y, dark) => void ((g[y] as boolean[])[x] = dark), mask);
    const score = penalty(g);
    if (!best || score < best.score) best = { grid: g, score };
  }
  return { size, version: ver, modules: (best as { grid: Grid }).grid };
}

/** SVG path data (one rect per dark module run, merged per row). */
export function qrPath(m: QrMatrix, quiet = 4): { d: string; viewBox: number } {
  const parts: string[] = [];
  for (let y = 0; y < m.size; y++) {
    let x = 0;
    while (x < m.size) {
      if (!(m.modules[y] as boolean[])[x]) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < m.size && (m.modules[y] as boolean[])[x + w]) w++;
      parts.push(`M${x + quiet} ${y + quiet}h${w}v1h${-w}z`);
      x += w;
    }
  }
  return { d: parts.join(''), viewBox: m.size + quiet * 2 };
}
