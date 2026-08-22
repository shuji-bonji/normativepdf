/**
 * Pure-TS inflate (RFC 1950/1951) against two oracles:
 *
 * 1. node:zlib as the GENERATOR — deterministic inputs are compressed at
 *    every level and strategy, so the fixtures cover stored (level 0),
 *    fixed-Huffman (Z_FIXED) and dynamic-Huffman blocks without any
 *    hand-rolled bit streams drifting from the assertion.
 * 2. The interim native implementation as the DIFFERENTIAL oracle
 *    (ADR-0003 decision 5, GUARDS G-6): where native succeeds, the pure
 *    decoder must produce byte-identical output; the hand-built error
 *    cases assert both sides refuse.
 */

import { constants, deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { setInflateOracle } from '../src/filter/inflate.js';
import { inflateNative } from '../src/filter/inflate-native.js';
import { inflate } from '../src/index.js';

/** Deterministic pseudo-random bytes (no RNG in tests). */
function patternBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = (i * 37 + ((i * i) % 251)) & 0xff;
  }
  return out;
}

const enc = (s: string) => new TextEncoder().encode(s);

/**
 * Byte equality without vitest's element-wise deep compare — toEqual on a
 * 1MB Uint8Array costs seconds; Buffer.compare costs microseconds.
 */
function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length);
  expect(Buffer.compare(Buffer.from(actual), Buffer.from(expected))).toBe(0);
}

const DATASETS: ReadonlyArray<readonly [string, Uint8Array]> = [
  ['empty', new Uint8Array(0)],
  ['one byte', enc('a')],
  ['short text', enc('Hello, FlateDecode — RFC 1950/1951.')],
  // Overlapping LZ77 copies (§3.2.3: the referenced string may overlap).
  ['repeated text', enc('abcabc'.repeat(20_000))],
  ['all zero', new Uint8Array(300_000)],
  ['pattern 1KB', patternBytes(1024)],
  // Large enough that zlib emits multiple blocks and long distances.
  ['pattern 1MB', patternBytes(1024 * 1024)],
];

const MODES: ReadonlyArray<readonly [string, number, number]> = [
  ['stored (level 0)', 0, constants.Z_DEFAULT_STRATEGY],
  ['fast (level 1)', 1, constants.Z_DEFAULT_STRATEGY],
  ['default (level 6)', 6, constants.Z_DEFAULT_STRATEGY],
  ['max (level 9)', 9, constants.Z_DEFAULT_STRATEGY],
  ['fixed Huffman (Z_FIXED)', 6, constants.Z_FIXED],
  ['RLE strategy', 6, constants.Z_RLE],
  ['Huffman-only strategy', 6, constants.Z_HUFFMAN_ONLY],
];

describe('inflate — round-trips against node:zlib across block types', () => {
  for (const [dataName, data] of DATASETS) {
    for (const [modeName, level, strategy] of MODES) {
      it(`${dataName}, ${modeName}`, async () => {
        const compressed = new Uint8Array(deflateSync(data, { level, strategy }));
        const decoded = await inflate(compressed);
        expectSameBytes(decoded, data);
        // Differential oracle (G-6): byte-identical with native.
        expectSameBytes(decoded, await inflateNative(compressed));
      });
    }
  }
});

describe('inflate — refusals (both implementations must refuse)', () => {
  /** A small valid stream to corrupt. */
  const valid = () => new Uint8Array(deflateSync(enc('corrupt me'), { level: 6 }));

  async function expectBothRefuse(bytes: Uint8Array, pattern: RegExp): Promise<void> {
    await expect(inflate(bytes)).rejects.toThrow(pattern);
    await expect(inflateNative(bytes)).rejects.toThrow(/FlateDecode failed/);
  }

  it('empty and one-byte inputs (RFC 1950 §2.2 header)', async () => {
    await expectBothRefuse(new Uint8Array(0), /zlib header/);
    await expectBothRefuse(new Uint8Array([0x78]), /zlib header/);
  });

  it('compression method other than 8 (RFC 1950 §2.3)', async () => {
    // CM = 7; FLG chosen so FCHECK verifies: (0x77*256 + flg) % 31 == 0.
    const cmf = 0x77;
    let flg = 0;
    while ((cmf * 256 + flg) % 31 !== 0) {
      flg += 1;
    }
    await expectBothRefuse(new Uint8Array([cmf, flg, 0x03, 0x00]), /compression method 7/);
  });

  it('failed FCHECK (RFC 1950 §2.2)', async () => {
    const bytes = valid();
    bytes[1] = (bytes[1] ?? 0) ^ 0x01;
    await expectBothRefuse(bytes, /FCHECK/);
  });

  it('FDICT set (RFC 1950 §2.3)', async () => {
    const cmf = 0x78;
    let flg = 0x20; // FDICT
    while ((cmf * 256 + flg) % 31 !== 0) {
      flg += 1;
    }
    await expectBothRefuse(new Uint8Array([cmf, flg, 0x03, 0x00]), /FDICT/);
  });

  it('reserved block type 11 (RFC 1951 §3.2.3)', async () => {
    // BFINAL=1, BTYPE=11 packed LSB-first: 0b111.
    await expectBothRefuse(new Uint8Array([0x78, 0x9c, 0x07]), /reserved block type/);
  });

  it('stored block whose NLEN is not the complement of LEN (RFC 1951 §3.2.4)', async () => {
    // BFINAL=1, BTYPE=00 → 0x01; LEN=1, NLEN=0 (wrong), one data byte.
    const bytes = new Uint8Array([0x78, 0x9c, 0x01, 0x01, 0x00, 0x00, 0x00, 0x41]);
    await expectBothRefuse(bytes, /complement of LEN/);
  });

  it('distance past the start of the output (RFC 1951 §3.2.3)', async () => {
    // Fixed-Huffman block: BFINAL=1, BTYPE=01, symbol 257 (length 3,
    // 7-bit code 0000001), distance code 0 (5-bit code 00000) — with an
    // empty output, distance 1 has nothing to point at.
    const bytes = new Uint8Array([0x78, 0x9c, 0x03, 0x02]);
    await expectBothRefuse(bytes, /past the start of the output/);
  });

  it('truncated stream (RFC 1951 §3.2.3)', async () => {
    const bytes = valid().subarray(0, 6);
    await expectBothRefuse(bytes, /unexpected end of data/);
  });

  it('ADLER32 mismatch (RFC 1950 §2.3)', async () => {
    const bytes = valid();
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    await expectBothRefuse(bytes, /ADLER32 mismatch/);
  });

  it('bytes after ADLER32 (RFC 1950 §2.2) — pure refuses; native is runtime-dependent', async () => {
    const clean = valid();
    const bytes = new Uint8Array(clean.length + 2);
    bytes.set(clean, 0);
    bytes[clean.length] = 0x0a;
    // The pure decoder refuses: §2.2 ends the stream at ADLER32, and a
    // deterministic decoder does not silently ignore bytes it never read.
    await expect(inflate(bytes)).rejects.toThrow(/after ADLER32/);
    // 🔴 Native is RUNTIME-DEPENDENT here (measured, CI 2026-08-22):
    // Node 20's DecompressionStream ignores trailing junk and resolves;
    // Node >= 21 rejects it ("Trailing junk found ..."). Either way it must
    // never return anything but the clean decode. This variance — the same
    // input, two behaviours, decided by the runtime — is the ADR-0003
    // argument for the pure implementation being canonical.
    try {
      expectSameBytes(await inflateNative(bytes), enc('corrupt me'));
    } catch (cause) {
      expect(String(cause)).toMatch(/FlateDecode failed/);
    }
  });
});

describe('inflate — differential oracle hook (GUARDS G-6)', () => {
  it('calls the registered oracle with input and output, and can be removed', async () => {
    const data = enc('oracle check');
    const compressed = new Uint8Array(deflateSync(data));
    const seen: Array<readonly [Uint8Array, Uint8Array]> = [];
    setInflateOracle(async (input, output) => {
      seen.push([input, output]);
    });
    try {
      await inflate(compressed);
    } finally {
      setInflateOracle(null);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toEqual(compressed);
    expect(seen[0]?.[1]).toEqual(data);

    await inflate(compressed);
    expect(seen).toHaveLength(1);
  });

  it('a mismatch reported by the oracle fails the decode', async () => {
    const compressed = new Uint8Array(deflateSync(enc('mismatch')));
    setInflateOracle(async () => {
      throw new Error('oracle mismatch');
    });
    try {
      await expect(inflate(compressed)).rejects.toThrow(/oracle mismatch/);
    } finally {
      setInflateOracle(null);
    }
  });
});
