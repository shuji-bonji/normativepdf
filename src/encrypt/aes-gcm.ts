/**
 * AES-GCM — NIST SP 800-38D, pure TS over the {@link aesEcbEncryptBlock}
 * block cipher.
 *
 * Named by ISO/TS 32003:2023 §5.2: the AESV4 crypt filter (V 6, R 7)
 * encrypts each object with AES-GCM, "the first 12 bytes … the
 * initialization vector, followed by the ciphertext … The 16-byte GCM
 * authentication tag shall be appended to the end", and "the AAD input …
 * shall be nil". This module encrypts and decrypts that exact framing.
 *
 * Pure TS keeps the runtime engine-independent (the read side's whole
 * point, ADR-0003): GCM = counter-mode encryption over the AES block
 * cipher plus GHASH, a GF(2^128) multiply-accumulate. node:crypto's
 * aes-256-gcm is the differential oracle in the tests — an independent
 * implementation of the same standard, which matters more here than
 * anywhere else because no PDF tool in reach reads AES-GCM PDFs (qpdf
 * 11.9.0 does not; veraPDF is absent).
 */

import { aesEcbEncryptBlock } from './aes.js';

const TAG_BYTES = 16;
const IV_BYTES = 12; // TS 32003 §5.2 fixes the IV at 96 bits

/**
 * GF(2^128) multiply, GCM's bit and byte convention (SP 800-38D §6.3):
 * bit 0 is the most-significant bit of byte 0, and the reduction
 * polynomial's representation is 0xE1 in the top byte. Operates on 16-byte
 * blocks as two 64-bit halves via BigInt — key-derivation-sized inputs, so
 * clarity over a four-lane 32-bit version.
 */
function gfMul(x: Uint8Array, y: Uint8Array): Uint8Array {
  let xhi = beU64(x, 0);
  let xlo = beU64(x, 8);
  const yhi = beU64(y, 0);
  const ylo = beU64(y, 8);
  let zhi = 0n;
  let zlo = 0n;
  const R = 0xe1n << 56n; // reduction, applied to the high half
  for (let i = 0; i < 128; i += 1) {
    // If the current bit of Y (from MSB down) is set, Z ^= X.
    const bit = i < 64 ? (yhi >> BigInt(63 - i)) & 1n : (ylo >> BigInt(127 - i)) & 1n;
    if (bit === 1n) {
      zhi ^= xhi;
      zlo ^= xlo;
    }
    // X >>= 1 across the 128-bit value; if a 1 falls out the bottom, reduce.
    const lsb = xlo & 1n;
    xlo = (xlo >> 1n) | ((xhi & 1n) << 63n);
    xhi >>= 1n;
    if (lsb === 1n) {
      xhi ^= R;
    }
  }
  const out = new Uint8Array(16);
  putBeU64(out, 0, zhi);
  putBeU64(out, 8, zlo);
  return out;
}

function beU64(b: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 0; i < 8; i += 1) {
    v = (v << 8n) | BigInt(b[offset + i] as number);
  }
  return v;
}

function putBeU64(b: Uint8Array, offset: number, v: bigint): void {
  for (let i = 7; i >= 0; i -= 1) {
    b[offset + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

/** GHASH over `data` (already a multiple of 16 bytes) with hash subkey H. */
function ghashBlocks(h: Uint8Array, data: Uint8Array, y: Uint8Array): void {
  for (let i = 0; i < data.length; i += 16) {
    for (let j = 0; j < 16; j += 1) {
      y[j] = (y[j] as number) ^ (data[i + j] as number);
    }
    const product = gfMul(y, h);
    y.set(product);
  }
}

/** Increment the low 32 bits of a 16-byte counter block (SP 800-38D inc32). */
function inc32(counter: Uint8Array): void {
  for (let i = 15; i >= 12; i -= 1) {
    counter[i] = ((counter[i] as number) + 1) & 0xff;
    if (counter[i] !== 0) {
      break;
    }
  }
}

/** Counter-mode keystream XOR over `data`, starting from `counter` (mutated). */
function ctrXor(key: Uint8Array, counter: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i += 16) {
    const keystream = aesEcbEncryptBlock(key, counter);
    const chunk = Math.min(16, data.length - i);
    for (let j = 0; j < chunk; j += 1) {
      out[i + j] = (data[i + j] as number) ^ (keystream[j] as number);
    }
    inc32(counter);
  }
  return out;
}

/**
 * The GCM tag for `ciphertext` with no AAD (TS 32003: AAD is nil).
 * J0 for a 96-bit IV is IV‖0x00000001 (SP 800-38D §7.1).
 */
function gcmTag(key: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const h = aesEcbEncryptBlock(key, new Uint8Array(16));
  const y = new Uint8Array(16);
  // AAD is empty, so GHASH covers only the ciphertext (zero-padded to a
  // block boundary) and the length block.
  const padded =
    ciphertext.length % 16 === 0
      ? ciphertext
      : (() => {
          const p = new Uint8Array(ciphertext.length + (16 - (ciphertext.length % 16)));
          p.set(ciphertext);
          return p;
        })();
  ghashBlocks(h, padded, y);
  // Length block: [ len(AAD) in bits | len(C) in bits ], each 64-bit BE.
  const lengths = new Uint8Array(16);
  putBeU64(lengths, 0, 0n);
  putBeU64(lengths, 8, BigInt(ciphertext.length) * 8n);
  ghashBlocks(h, lengths, y);
  // Tag = GHASH ⊕ E(J0), where J0 = IV‖0x00000001.
  const j0 = new Uint8Array(16);
  j0.set(iv.subarray(0, IV_BYTES));
  j0[15] = 1;
  const ej0 = aesEcbEncryptBlock(key, j0);
  const tag = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    tag[i] = (y[i] as number) ^ (ej0[i] as number);
  }
  return tag;
}

/**
 * Encrypt `plaintext` and serialise as TS 32003 §5.2: 12-byte IV,
 * ciphertext, 16-byte tag. `iv` is caller-supplied (the RNG lives in one
 * place) and shall never repeat for a given key (§5.2 NOTE 2).
 */
export function aesGcmEncryptIvPrefixed(
  key: Uint8Array,
  iv: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  if (key.length !== 32) {
    throw new RangeError(`AESV4 uses a 256-bit key; got ${key.length} bytes`);
  }
  if (iv.length !== IV_BYTES) {
    throw new RangeError(`AES-GCM IV shall be 12 bytes (TS 32003 §5.2); got ${iv.length}`);
  }
  // Counter starts at J0 + 1 = IV‖0x00000002 for the first data block.
  const counter = new Uint8Array(16);
  counter.set(iv);
  counter[15] = 2;
  const ciphertext = ctrXor(key, counter, plaintext);
  const tag = gcmTag(key, iv, ciphertext);
  const out = new Uint8Array(IV_BYTES + ciphertext.length + TAG_BYTES);
  out.set(iv, 0);
  out.set(ciphertext, IV_BYTES);
  out.set(tag, IV_BYTES + ciphertext.length);
  return out;
}

/**
 * Decrypt TS 32003 §5.2 framing (12-byte IV ‖ ciphertext ‖ 16-byte tag).
 * Returns null when the layout is too short to hold IV + tag, or when the
 * authentication tag does not verify — a tampered or misparsed object
 * shall never yield plaintext.
 */
export function aesGcmDecryptIvPrefixed(key: Uint8Array, data: Uint8Array): Uint8Array | null {
  if (key.length !== 32 || data.length < IV_BYTES + TAG_BYTES) {
    return null;
  }
  const iv = data.subarray(0, IV_BYTES);
  const ciphertext = data.subarray(IV_BYTES, data.length - TAG_BYTES);
  const providedTag = data.subarray(data.length - TAG_BYTES);
  const expectedTag = gcmTag(key, iv, ciphertext);
  let diff = 0;
  for (let i = 0; i < TAG_BYTES; i += 1) {
    diff |= (expectedTag[i] as number) ^ (providedTag[i] as number);
  }
  if (diff !== 0) {
    return null; // authentication failed
  }
  const counter = new Uint8Array(16);
  counter.set(iv);
  counter[15] = 2;
  return ctrXor(key, counter, ciphertext);
}
