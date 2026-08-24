/**
 * Standard security handler — the write side (§7.6.4 Algorithms 8/9/10;
 * ISO/TS 32003:2023 for AESV4). Given a file encryption key and a
 * password, produce the /U, /UE, /O, /OE and /Perms byte strings a
 * conforming reader authenticates against, and encrypt individual
 * strings and streams.
 *
 * Scope (ADR-0008 write side): the revision-6 password algorithm only —
 * AES-256-CBC (AESV3, R 6) and AES-GCM (AESV4, R 7, TS 32003). Both use
 * the file encryption key directly (§7.6.3.3 / TS 32003 §5.2: no
 * per-object key derivation), so nothing here depends on object numbers.
 * RC4 and the R ≤ 4 write path are not built: they are deprecated in
 * PDF 2.0 and no demand exists (this repository builds to measured
 * requirement).
 *
 * Why the key derivation is shared with the reader: {@link hash2B} is the
 * same function the reader uses to authenticate, so a document written
 * here opens with the decryptor this library also ships — the strongest
 * self-consistency check there is, paired in the tests with qpdf
 * (independent) for AESV3 and node:crypto (independent) for AESV4.
 */

import { aesCbcEncryptNoPad, aesEcbEncryptBlock, aesEncryptIvPrefixed } from './aes.js';
import { aesGcmEncryptIvPrefixed } from './aes-gcm.js';
import { hash2B } from './standard-handler.js';

/** Which AES-256 cipher the crypt filter applies. */
export type WriteMethod = 'AESV3' | 'AESV4';

/** A source of cryptographically strong random bytes (injected so tests are deterministic). */
export type RandomBytes = (length: number) => Uint8Array;

const ZERO_IV = new Uint8Array(16);

/** The permission bits a reader honours (§7.6.4.2 Table 22); default: allow all. */
export interface Permissions {
  /** The signed 32-bit /P value. Default −4 (all high bits set, nothing forbidden). */
  readonly p?: number;
  /** Table 21 EncryptMetadata. Default true. */
  readonly encryptMetadata?: boolean;
}

/** The byte strings the encryption dictionary carries, plus the settings that shaped them. */
export interface EncryptDictValues {
  /** Table 20 V: 5 for AESV3 (ISO 32000-2), 6 for AESV4 (ISO/TS 32003). */
  readonly v: 5 | 6;
  /** Table 21 R: 6 for AESV3, 7 for AESV4. */
  readonly r: 7 | 6;
  readonly method: WriteMethod;
  readonly o: Uint8Array;
  readonly u: Uint8Array;
  readonly oe: Uint8Array;
  readonly ue: Uint8Array;
  readonly perms: Uint8Array;
  readonly p: number;
  readonly encryptMetadata: boolean;
}

/**
 * Algorithms 8/9/10 — derive /U, /UE, /O, /OE and /Perms for a revision-6
 * document from `fileKey`, the user and owner passwords, and the
 * permission settings. AESV3 ⇒ R 6; AESV4 (TS 32003) ⇒ R 7.
 */
export function deriveEncryptDictValues(
  fileKey: Uint8Array,
  userPassword: Uint8Array,
  ownerPassword: Uint8Array,
  method: WriteMethod,
  random: RandomBytes,
  permissions: Permissions = {},
): EncryptDictValues {
  if (fileKey.length !== 32) {
    throw new RangeError(`the revision-6 file encryption key is 32 bytes; got ${fileKey.length}`);
  }
  const p = permissions.p ?? -4;
  const encryptMetadata = permissions.encryptMetadata ?? true;

  // Algorithm 8: /U and /UE from the user password.
  const userValidationSalt = random(8);
  const userKeySalt = random(8);
  const uHash = hash2B(userPassword, userValidationSalt, EMPTY);
  const u = concat([uHash, userValidationSalt, userKeySalt]); // 48 bytes
  const intermediateUserKey = hash2B(userPassword, userKeySalt, EMPTY);
  const ue = aesCbcEncryptNoPad(intermediateUserKey, ZERO_IV, fileKey); // 32 bytes

  // Algorithm 9: /O and /OE from the owner password, salted with the 48-byte /U.
  const ownerValidationSalt = random(8);
  const ownerKeySalt = random(8);
  const oHash = hash2B(ownerPassword, ownerValidationSalt, u);
  const o = concat([oHash, ownerValidationSalt, ownerKeySalt]); // 48 bytes
  const intermediateOwnerKey = hash2B(ownerPassword, ownerKeySalt, u);
  const oe = aesCbcEncryptNoPad(intermediateOwnerKey, ZERO_IV, fileKey);

  // Algorithm 10: /Perms — a 16-byte block AES-256-ECB-encrypted with the file key.
  const permsBlock = new Uint8Array(16);
  const view = new DataView(permsBlock.buffer);
  view.setInt32(0, p, true); // bytes 0-3: P, low byte first
  view.setInt32(4, -1, false); // bytes 4-7: 0xFFFFFFFF (upper 32 bits of the extended permissions)
  permsBlock[8] = encryptMetadata ? 0x54 : 0x46; // 'T' / 'F'
  permsBlock[9] = 0x61; // 'a'
  permsBlock[10] = 0x64; // 'd'
  permsBlock[11] = 0x62; // 'b'
  random(4).forEach((b, i) => {
    permsBlock[12 + i] = b; // bytes 12-15: ignored random data
  });
  const perms = aesEcbEncryptBlock(fileKey, permsBlock);

  return {
    // ISO 32000-2 Table 20: AES-256 (AESV3) is V 5 / R 6. ISO/TS 32003
    // introduces V 6 / R 7 specifically for AES-GCM (AESV4).
    v: method === 'AESV4' ? 6 : 5,
    r: method === 'AESV4' ? 7 : 6,
    method,
    o,
    u,
    oe,
    ue,
    perms,
    p,
    encryptMetadata,
  };
}

/** Encrypt one string or stream body with the document's method (no per-object key for R 6/7). */
export function encryptBytes(
  method: WriteMethod,
  fileKey: Uint8Array,
  data: Uint8Array,
  random: RandomBytes,
): Uint8Array {
  if (method === 'AESV4') {
    // TS 32003 §5.2: 12-byte IV, unique per object under a shared key.
    return aesGcmEncryptIvPrefixed(fileKey, random(12), data);
  }
  // AESV3 — §7.6.3.3: 16-byte IV, CBC, PKCS#7.
  return aesEncryptIvPrefixed(fileKey, random(16), data);
}

const EMPTY = new Uint8Array(0);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
