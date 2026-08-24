/**
 * Crypto primitives — differential oracle against node:crypto (the same
 * discipline as the inflate oracle, ADR-0003 / GUARDS G-6): every digest
 * and every cipher operation this library computes is replayed through an
 * independent implementation and must be byte-identical.
 *
 * RC4 is the exception with pinned vectors instead: OpenSSL 3 removed
 * RC4, so node:crypto cannot answer — RFC 6229's published keystreams
 * stand in as the independent side.
 */

import { createCipheriv, createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  aesCbcDecryptNoPad,
  aesCbcEncryptNoPad,
  aesDecryptIvPrefixed,
  aesEcbDecryptBlock,
} from '../src/encrypt/aes.js';
import { md5 } from '../src/encrypt/md5.js';
import { rc4 } from '../src/encrypt/rc4.js';
import { sha256, sha384, sha512 } from '../src/encrypt/sha2.js';

/** Deterministic pseudo-content — no randomness, so a failure replays exactly. */
function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed | 1;
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = state & 0xff;
  }
  return out;
}

const hex = (u: Uint8Array): string => Buffer.from(u).toString('hex');

// Lengths straddling every padding boundary of both hash families
// (64-byte blocks with the length in the last 8; 128-byte blocks with it
// in the last 16).
const LENGTHS = [
  0, 1, 3, 55, 56, 57, 63, 64, 65, 111, 112, 113, 119, 120, 127, 128, 129, 1000, 10000,
];

describe('hash primitives vs node:crypto', () => {
  it.each(LENGTHS)('md5 / sha256 / sha384 / sha512 agree at length %i', (length) => {
    const data = bytes(length, length + 1);
    expect(hex(md5(data))).toBe(createHash('md5').update(data).digest('hex'));
    expect(hex(sha256(data))).toBe(createHash('sha256').update(data).digest('hex'));
    expect(hex(sha384(data))).toBe(createHash('sha384').update(data).digest('hex'));
    expect(hex(sha512(data))).toBe(createHash('sha512').update(data).digest('hex'));
  });

  it('multi-part input hashes as the concatenation', () => {
    const a = bytes(37, 7);
    const b = bytes(91, 8);
    const c = bytes(3, 9);
    expect(hex(md5(a, b, c))).toBe(
      createHash('md5')
        .update(Buffer.concat([a, b, c]))
        .digest('hex'),
    );
    expect(hex(sha256(a, b, c))).toBe(
      createHash('sha256')
        .update(Buffer.concat([a, b, c]))
        .digest('hex'),
    );
  });
});

describe('AES vs node:crypto', () => {
  it.each([128, 256] as const)('CBC no-padding encrypt/decrypt agree (AES-%i)', (bits) => {
    const key = bytes(bits / 8, bits);
    const iv = bytes(16, 5);
    for (const blocks of [1, 2, 5]) {
      const data = bytes(blocks * 16, blocks);
      const cipher = createCipheriv(`aes-${bits}-cbc`, key, iv);
      cipher.setAutoPadding(false);
      const expected = new Uint8Array(Buffer.concat([cipher.update(data), cipher.final()]));
      expect(hex(aesCbcEncryptNoPad(key, iv, data))).toBe(hex(expected));
      expect(hex(aesCbcDecryptNoPad(key, iv, expected))).toBe(hex(data));
    }
  });

  it.each([128, 256] as const)(
    'IV-prefixed PKCS#7 decryption recovers node:crypto ciphertext (AES-%i)',
    (bits) => {
      const key = bytes(bits / 8, bits + 1);
      const iv = bytes(16, 6);
      const plain = bytes(37, 4); // deliberately not block-aligned
      const cipher = createCipheriv(`aes-${bits}-cbc`, key, iv); // autopadding on = PKCS#7
      const enc = new Uint8Array(Buffer.concat([iv, cipher.update(plain), cipher.final()]));
      expect(hex(aesDecryptIvPrefixed(key, enc) ?? new Uint8Array(0))).toBe(hex(plain));
    },
  );

  it('IV-prefixed decryption returns null for layouts the clause cannot describe', () => {
    const key = bytes(16, 1);
    expect(aesDecryptIvPrefixed(key, bytes(16, 2))).toBeNull(); // IV only, no blocks
    expect(aesDecryptIvPrefixed(key, bytes(40, 2))).toBeNull(); // not block-aligned
  });

  it.each([128, 256] as const)('single-block ECB decryption agrees (AES-%i)', (bits) => {
    const key = bytes(bits / 8, bits + 2);
    const block = bytes(16, 3);
    const cipher = createCipheriv(`aes-${bits}-ecb`, key, null);
    cipher.setAutoPadding(false);
    const enc = new Uint8Array(Buffer.concat([cipher.update(block), cipher.final()]));
    expect(hex(aesEcbDecryptBlock(key, enc))).toBe(hex(block));
  });
});

describe('RC4 vs RFC 6229 vectors', () => {
  it('40-bit key 0x0102030405 produces the published keystream', () => {
    // RFC 6229 §2, key length 40 bits, stream offset 0 (keystream =
    // encryption of zeros).
    expect(hex(rc4(Uint8Array.from([1, 2, 3, 4, 5]), new Uint8Array(16)))).toBe(
      'b2396305f03dc027ccc3524a0a1118a8',
    );
  });

  it('128-bit key 0x0102..10 produces the published keystream', () => {
    const key = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    expect(hex(rc4(key, new Uint8Array(16)))).toBe('9ac7cc9a609d1ef7b2932899cde41b97');
  });

  it('is its own inverse', () => {
    const key = bytes(16, 11);
    const data = bytes(999, 12);
    expect(hex(rc4(key, rc4(key, data)))).toBe(hex(data));
  });
});
