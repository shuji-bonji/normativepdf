/**
 * AES-GCM primitive — differential oracle against node:crypto's
 * aes-256-gcm (ADR-0003 / GUARDS G-6). This is the strongest independent
 * check available for TS 32003 writing, because no PDF tool in reach
 * reads AES-GCM PDFs: qpdf 11.9.0 refuses R 7 / V 6, and veraPDF is not
 * installed. node:crypto is a separate implementation of the same NIST
 * standard.
 */

import { createCipheriv, createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { aesGcmDecryptIvPrefixed, aesGcmEncryptIvPrefixed } from '../src/encrypt/aes-gcm.js';

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

// TS 32003 §5.2 serialisation: 12-byte IV, ciphertext, 16-byte tag.
const IV = 12;
const TAG = 16;
const LENGTHS = [0, 1, 15, 16, 17, 37, 64, 255, 1000];

describe('AES-GCM encryption agrees with node:crypto', () => {
  it.each(LENGTHS)('our ciphertext+tag decrypts under node:crypto at length %i', (length) => {
    const key = bytes(32, length + 1);
    const iv = bytes(IV, length + 7);
    const plaintext = bytes(length, length + 3);
    const packed = aesGcmEncryptIvPrefixed(key, iv, plaintext);
    expect(hex(packed.subarray(0, IV))).toBe(hex(iv)); // IV prefix per §5.2

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(packed.subarray(packed.length - TAG));
    const nodePlain = Buffer.concat([
      decipher.update(packed.subarray(IV, packed.length - TAG)),
      decipher.final(),
    ]);
    expect(hex(new Uint8Array(nodePlain))).toBe(hex(plaintext));
  });

  it.each(LENGTHS)('node:crypto ciphertext decrypts under ours at length %i', (length) => {
    const key = bytes(32, length + 11);
    const iv = bytes(IV, length + 13);
    const plaintext = bytes(length, length + 5);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    const packed = new Uint8Array(IV + ct.length + TAG);
    packed.set(iv);
    packed.set(ct, IV);
    packed.set(tag, IV + ct.length);
    const ours = aesGcmDecryptIvPrefixed(key, packed);
    expect(ours).not.toBeNull();
    expect(hex(ours as Uint8Array)).toBe(hex(plaintext));
  });

  it('a tampered ciphertext or tag decrypts to null (authentication)', () => {
    const key = bytes(32, 99);
    const iv = bytes(IV, 98);
    const packed = aesGcmEncryptIvPrefixed(key, iv, bytes(40, 97));
    // flip one ciphertext byte
    const tamperedCt = packed.slice();
    tamperedCt[IV] = (tamperedCt[IV] as number) ^ 0x01;
    expect(aesGcmDecryptIvPrefixed(key, tamperedCt)).toBeNull();
    // flip one tag byte
    const tamperedTag = packed.slice();
    tamperedTag[tamperedTag.length - 1] = (tamperedTag[tamperedTag.length - 1] as number) ^ 0x01;
    expect(aesGcmDecryptIvPrefixed(key, tamperedTag)).toBeNull();
  });

  it('data too short to hold IV + tag decrypts to null', () => {
    const key = bytes(32, 1);
    expect(aesGcmDecryptIvPrefixed(key, bytes(IV + TAG - 1, 2))).toBeNull();
  });
});
