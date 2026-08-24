/**
 * MD5 message digest — RFC 1321, pure TS.
 *
 * Why MD5 exists in this codebase at all: the standard security handler's
 * revision-4-and-earlier algorithms are *defined over* MD5 — the file
 * encryption key (§7.6.4.3.2 Algorithm 2 steps b–h), the per-object key
 * (§7.6.3.2 Algorithm 1 step c), and the /U computation (§7.6.4.4.4
 * Algorithm 5 step b) all name it. This is key derivation prescribed by
 * ISO 32000, not a choice of hash for security; MD5's collision weakness
 * is irrelevant to reproducing a published derivation.
 *
 * Pure TS for the same reason as `filter/inflate.ts` (ADR-0003): the
 * runtime surface stays engine-independent (WebCrypto has no MD5, and
 * node:crypto is Node-only). The differential oracle in the tests replays
 * every digest through node:crypto.
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14,
  20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6,
  10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// K[i] = floor(2^32 × abs(sin(i + 1))) — RFC 1321 §3.4. Precomputed so the
// table is data, not a runtime dependency on Math.sin rounding.
const K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];

/** MD5 of the concatenation of `parts` (RFC 1321). */
export function md5(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  // RFC 1321 §3.1–3.2: pad with 0x80 then zeros to 56 mod 64, then the
  // 64-bit little-endian bit length.
  const padded = new Uint8Array((((total + 8) >> 6) + 1) << 6);
  let offset = 0;
  for (const p of parts) {
    padded.set(p, offset);
    offset += p.length;
  }
  padded[total] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (total << 3) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(total / 0x20000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const m = new Uint32Array(16);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i += 1) {
      m[i] = view.getUint32(block + i * 4, true);
    }
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const rotated = (a + f + (K[i] as number) + (m[g] as number)) | 0;
      const shift = S[i] as number;
      const newB = (b + ((rotated << shift) | (rotated >>> (32 - shift)))) | 0;
      a = d;
      d = c;
      c = b;
      b = newB;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, a0 >>> 0, true);
  outView.setUint32(4, b0 >>> 0, true);
  outView.setUint32(8, c0 >>> 0, true);
  outView.setUint32(12, d0 >>> 0, true);
  return out;
}
