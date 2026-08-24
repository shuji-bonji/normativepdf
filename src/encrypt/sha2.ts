/**
 * SHA-256 / SHA-384 / SHA-512 — FIPS 180-4, pure TS.
 *
 * All three are named by §7.6.4.3.4 Algorithm 2.B (revision 6 key
 * derivation): each round hashes with SHA-256, SHA-384 or SHA-512
 * depending on the previous round's ciphertext modulo 3, so supporting
 * revision 6 requires all three — there is no "SHA-256 only" subset.
 *
 * Pure TS for the same reason as `md5.ts`: engine-independent runtime
 * surface; the tests replay every digest through node:crypto as a
 * differential oracle. SHA-512/384 use BigInt for the 64-bit word
 * arithmetic — the inputs here are key-derivation sized (≤ a few tens of
 * KiB), so clarity wins over a two-lane 32-bit implementation.
 */

// FIPS 180-4 §4.2.2 — first 32 bits of the fractional parts of the cube
// roots of the first 64 primes.
const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 of the concatenation of `parts` (FIPS 180-4 §6.2). */
export function sha256(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  // §5.1.1: pad with 0x80, zeros to 56 mod 64, then 64-bit big-endian bit length.
  const padded = new Uint8Array((((total + 8) >> 6) + 1) << 6);
  let offset = 0;
  for (const p of parts) {
    padded.set(p, offset);
    offset += p.length;
  }
  padded[total] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(total / 0x20000000), false);
  view.setUint32(padded.length - 4, (total << 3) >>> 0, false);

  const h = new Int32Array([
    0x6a09e667, -0x4498517b /* 0xbb67ae85 */, 0x3c6ef372, -0x5ab00ac6 /* 0xa54ff53a */, 0x510e527f,
    -0x64fa9774 /* 0x9b05688c */, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Int32Array(64);
  for (let block = 0; block < padded.length; block += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getInt32(block + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const w15 = w[i - 15] as number;
      const w2 = w[i - 2] as number;
      const s0 = (rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)) | 0;
      const s1 = (rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)) | 0;
      w[i] = ((w[i - 16] as number) + s0 + (w[i - 7] as number) + s1) | 0;
    }
    let a = h[0] as number;
    let b = h[1] as number;
    let c = h[2] as number;
    let d = h[3] as number;
    let e = h[4] as number;
    let f = h[5] as number;
    let g = h[6] as number;
    let hh = h[7] as number;
    for (let i = 0; i < 64; i += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) | 0;
      const ch = ((e & f) ^ (~e & g)) | 0;
      const t1 = (hh + s1 + ch + (K256[i] as number) + (w[i] as number)) | 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) | 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) | 0;
      const t2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = ((h[0] as number) + a) | 0;
    h[1] = ((h[1] as number) + b) | 0;
    h[2] = ((h[2] as number) + c) | 0;
    h[3] = ((h[3] as number) + d) | 0;
    h[4] = ((h[4] as number) + e) | 0;
    h[5] = ((h[5] as number) + f) | 0;
    h[6] = ((h[6] as number) + g) | 0;
    h[7] = ((h[7] as number) + hh) | 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i += 1) {
    outView.setInt32(i * 4, h[i] as number, false);
  }
  return out;
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

// FIPS 180-4 §4.2.3 — first 64 bits of the fractional parts of the cube
// roots of the first 80 primes.
const K512: readonly bigint[] = [
  0x428a2f98d728ae22n,
  0x7137449123ef65cdn,
  0xb5c0fbcfec4d3b2fn,
  0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n,
  0x59f111f1b605d019n,
  0x923f82a4af194f9bn,
  0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n,
  0x12835b0145706fben,
  0x243185be4ee4b28cn,
  0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn,
  0x80deb1fe3b1696b1n,
  0x9bdc06a725c71235n,
  0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n,
  0xefbe4786384f25e3n,
  0x0fc19dc68b8cd5b5n,
  0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n,
  0x4a7484aa6ea6e483n,
  0x5cb0a9dcbd41fbd4n,
  0x76f988da831153b5n,
  0x983e5152ee66dfabn,
  0xa831c66d2db43210n,
  0xb00327c898fb213fn,
  0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n,
  0xd5a79147930aa725n,
  0x06ca6351e003826fn,
  0x142929670a0e6e70n,
  0x27b70a8546d22ffcn,
  0x2e1b21385c26c926n,
  0x4d2c6dfc5ac42aedn,
  0x53380d139d95b3dfn,
  0x650a73548baf63den,
  0x766a0abb3c77b2a8n,
  0x81c2c92e47edaee6n,
  0x92722c851482353bn,
  0xa2bfe8a14cf10364n,
  0xa81a664bbc423001n,
  0xc24b8b70d0f89791n,
  0xc76c51a30654be30n,
  0xd192e819d6ef5218n,
  0xd69906245565a910n,
  0xf40e35855771202an,
  0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n,
  0x1e376c085141ab53n,
  0x2748774cdf8eeb99n,
  0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n,
  0x4ed8aa4ae3418acbn,
  0x5b9cca4f7763e373n,
  0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn,
  0x78a5636f43172f60n,
  0x84c87814a1f0ab72n,
  0x8cc702081a6439ecn,
  0x90befffa23631e28n,
  0xa4506cebde82bde9n,
  0xbef9a3f7b2c67915n,
  0xc67178f2e372532bn,
  0xca273eceea26619cn,
  0xd186b8c721c0c207n,
  0xeada7dd6cde0eb1en,
  0xf57d4f7fee6ed178n,
  0x06f067aa72176fban,
  0x0a637dc5a2c898a6n,
  0x113f9804bef90daen,
  0x1b710b35131c471bn,
  0x28db77f523047d84n,
  0x32caab7b40c72493n,
  0x3c9ebe0a15c9bebcn,
  0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n,
  0x597f299cfc657e2an,
  0x5fcb6fab3ad6faecn,
  0x6c44198c4a475817n,
];

const H512: readonly bigint[] = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
];

const H384: readonly bigint[] = [
  0xcbbb9d5dc1059ed8n,
  0x629a292a367cd507n,
  0x9159015a3070dd17n,
  0x152fecd8f70e5939n,
  0x67332667ffc00b31n,
  0x8eb44a8768581511n,
  0xdb0c2e0d64f98fa7n,
  0x47b5481dbefa4fa4n,
];

const MASK64 = 0xffffffffffffffffn;

function rotr64(x: bigint, n: bigint): bigint {
  return ((x >> n) | (x << (64n - n))) & MASK64;
}

/** Shared SHA-512 family compression (FIPS 180-4 §6.4/§6.5). */
function sha512Family(
  iv: readonly bigint[],
  outBytes: number,
  parts: readonly Uint8Array[],
): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  // §5.1.2: pad with 0x80, zeros to 112 mod 128, then a 128-bit big-endian
  // bit length. Message sizes here are far below 2^53 bits, so the high
  // 64 bits of the length are always zero.
  const padded = new Uint8Array((Math.floor((total + 16) / 128) + 1) * 128);
  let offset = 0;
  for (const p of parts) {
    padded.set(p, offset);
    offset += p.length;
  }
  padded[total] = 0x80;
  const view = new DataView(padded.buffer);
  view.setBigUint64(padded.length - 8, BigInt(total) << 3n, false);

  const h = [...iv];
  const w = new Array<bigint>(80);
  for (let block = 0; block < padded.length; block += 128) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = view.getBigUint64(block + i * 8, false);
    }
    for (let i = 16; i < 80; i += 1) {
      const w15 = w[i - 15] as bigint;
      const w2 = w[i - 2] as bigint;
      const s0 = rotr64(w15, 1n) ^ rotr64(w15, 8n) ^ (w15 >> 7n);
      const s1 = rotr64(w2, 19n) ^ rotr64(w2, 61n) ^ (w2 >> 6n);
      w[i] = ((w[i - 16] as bigint) + s0 + (w[i - 7] as bigint) + s1) & MASK64;
    }
    let [a, b, c, d, e, f, g, hh] = h as [
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    for (let i = 0; i < 80; i += 1) {
      const s1 = rotr64(e, 14n) ^ rotr64(e, 18n) ^ rotr64(e, 41n);
      const ch = (e & f) ^ (~e & g & MASK64);
      const t1 = (hh + s1 + ch + (K512[i] as bigint) + (w[i] as bigint)) & MASK64;
      const s0 = rotr64(a, 28n) ^ rotr64(a, 34n) ^ rotr64(a, 39n);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) & MASK64;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) & MASK64;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & MASK64;
    }
    h[0] = ((h[0] as bigint) + a) & MASK64;
    h[1] = ((h[1] as bigint) + b) & MASK64;
    h[2] = ((h[2] as bigint) + c) & MASK64;
    h[3] = ((h[3] as bigint) + d) & MASK64;
    h[4] = ((h[4] as bigint) + e) & MASK64;
    h[5] = ((h[5] as bigint) + f) & MASK64;
    h[6] = ((h[6] as bigint) + g) & MASK64;
    h[7] = ((h[7] as bigint) + hh) & MASK64;
  }

  const out = new Uint8Array(outBytes);
  const outView = new DataView(out.buffer);
  for (let i = 0; i * 8 < outBytes; i += 1) {
    outView.setBigUint64(i * 8, h[i] as bigint, false);
  }
  return out;
}

/** SHA-512 of the concatenation of `parts` (FIPS 180-4 §6.4). */
export function sha512(...parts: readonly Uint8Array[]): Uint8Array {
  return sha512Family(H512, 64, parts);
}

/** SHA-384 of the concatenation of `parts` (FIPS 180-4 §6.5). */
export function sha384(...parts: readonly Uint8Array[]): Uint8Array {
  return sha512Family(H384, 48, parts);
}
