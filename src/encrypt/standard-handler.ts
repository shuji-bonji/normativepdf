/**
 * Standard security handler — §7.6.4: key derivation, password
 * authentication, and per-object decryption for the password-based
 * handler every PDF processor shall support (§7.6.2).
 *
 * Scope (ADR-0008): reading only. The three cipher suites the corpus
 * demands are covered — RC4 (V 1/2, R 2–4), AES-128-CBC (V 4, crypt
 * filter AESV2), AES-256-CBC (V 5, R 6, AESV3). Public-key handlers
 * (§7.6.5) are refused by name: no demand has ever been measured.
 * Revision 5 is refused by name as well — Table 21 R: "Shall not be
 * used. This value was used by a deprecated proprietary Adobe
 * extension"; support waits for a real specimen, like every recovery
 * decision in this repository.
 *
 * Nothing here walks a document. This module answers exactly one
 * question — "given these Encrypt-dictionary facts, these /ID bytes and
 * this password, what are the plaintext bytes of object (n, g)?" — and
 * the document-shaped rules (§7.6.2 exceptions, crypt filters chosen per
 * stream) live in `document-decryptor.ts`.
 */

import {
  aesCbcDecryptNoPad,
  aesCbcEncryptNoPad,
  aesDecryptIvPrefixed,
  aesEcbDecryptBlock,
} from './aes.js';
import { aesGcmDecryptIvPrefixed } from './aes-gcm.js';
import { md5 } from './md5.js';
import { rc4 } from './rc4.js';
import { sha256, sha384, sha512 } from './sha2.js';

/**
 * A failure the encryption layer can name: an unsupported handler or
 * algorithm, a wrong password, or bytes whose layout cannot be what the
 * clause describes. Never a silent fallthrough — returning ciphertext as
 * if it were plaintext is the failure mode this class exists to prevent
 * (ADR-0008 decision 3).
 */
export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

/** Table 25 CFM values this handler can apply (None is refused by name). */
export type CryptMethod = 'Identity' | 'RC4' | 'AESV2' | 'AESV3' | 'AESV4';

/** The facts a caller reads off a parsed Encrypt dictionary (Tables 20/21/25). */
export interface StandardEncryptParams {
  /** Table 20 V. */
  readonly v: number;
  /** Table 21 R. */
  readonly revision: number;
  /** File encryption key length in BYTES (Table 20 Length ÷ 8; 5 when V is 1). */
  readonly keyBytes: number;
  /** Table 21 O (first 32 bytes used for R ≤ 4, first 48 for R 6). */
  readonly o: Uint8Array;
  /** Table 21 U (same lengths as O). */
  readonly u: Uint8Array;
  /** Table 21 OE (R 6). */
  readonly oe: Uint8Array | undefined;
  /** Table 21 UE (R 6). */
  readonly ue: Uint8Array | undefined;
  /** Table 21 Perms (R 6). */
  readonly perms: Uint8Array | undefined;
  /** Table 21 P, as the signed 32-bit integer the file carries. */
  readonly p: number;
  /** First element of the trailer /ID (Algorithm 2 step e; empty for R 6, which does not use it). */
  readonly idFirst: Uint8Array;
  /** Table 21 EncryptMetadata (default true). */
  readonly encryptMetadata: boolean;
  /** Default crypt method for streams (Table 20 StmF resolved through CF). */
  readonly streamMethod: CryptMethod;
  /** Default crypt method for strings (Table 20 StrF resolved through CF). */
  readonly stringMethod: CryptMethod;
  /** Named crypt filters (Table 20 CF resolved to methods) for per-stream /Crypt filters (§7.4.10). */
  readonly cryptFilters: ReadonlyMap<string, CryptMethod>;
}

/** What authenticated and what the Perms check observed (facts, not verdicts). */
export interface AuthenticationResult {
  /** Which password matched (Algorithms 6/7 for R ≤ 4, 11/12 for R 6). */
  readonly authenticatedAs: 'user' | 'owner';
  /**
   * R 6 only: whether the decrypted Perms agreed with P and
   * EncryptMetadata (Algorithm 13 — "should match"). A disagreement is a
   * conformance fact for pdf-verify-mcp, not a reason to refuse reading:
   * the "adb" marker already proved the file encryption key correct.
   */
  readonly permsConsistent: boolean | undefined;
}

/** Algorithm 2 step (a) — the 32-byte padding string. */
const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

/** Algorithm 1 step (b) — "sAlT", appended for AES for backward compatibility. */
const AES_SALT = Uint8Array.from([0x73, 0x41, 0x6c, 0x54]);

const ZERO_IV = new Uint8Array(16);

/**
 * The standard security handler with an authenticated file encryption
 * key. Construction IS authentication: an instance exists only if some
 * password (the empty user password by default) matched /U or /O.
 */
export class StandardSecurityHandler {
  readonly params: StandardEncryptParams;
  readonly auth: AuthenticationResult;
  readonly #fileKey: Uint8Array;

  private constructor(
    params: StandardEncryptParams,
    auth: AuthenticationResult,
    fileKey: Uint8Array,
  ) {
    this.params = params;
    this.auth = auth;
    this.#fileKey = fileKey;
  }

  /**
   * Authenticate `password` (both roles are tried: user first, then
   * owner) and derive the file encryption key. Throws EncryptionError
   * when neither matches — a wrong password shall not produce a garbage
   * key that "decrypts" to mojibake.
   */
  static authenticate(
    params: StandardEncryptParams,
    password: Uint8Array,
  ): StandardSecurityHandler {
    if (params.revision >= 6) {
      return StandardSecurityHandler.#authenticateR6(params, password);
    }
    return StandardSecurityHandler.#authenticateR234(params, password);
  }

  // ----------------------------------------------------------- R 2–4

  static #authenticateR234(
    params: StandardEncryptParams,
    password: Uint8Array,
  ): StandardSecurityHandler {
    // Algorithm 6: user password.
    const userKey = fileKeyR234(params, password);
    if (validateUserKeyR234(params, userKey)) {
      return new StandardSecurityHandler(
        params,
        { authenticatedAs: 'user', permsConsistent: undefined },
        userKey,
      );
    }
    // Algorithm 7: owner password. Steps (a)–(d) of Algorithm 3 give the
    // RC4 key; decrypting /O yields the purported user password, which
    // Algorithm 6 then authenticates.
    const ownerRc4Key = ownerKeyR234(params, password);
    let purported = params.o.subarray(0, 32);
    if (params.revision === 2) {
      purported = rc4(ownerRc4Key, purported);
    } else {
      for (let i = 19; i >= 0; i -= 1) {
        purported = rc4(xorKey(ownerRc4Key, i), purported);
      }
    }
    const viaOwner = fileKeyR234(params, purported);
    if (validateUserKeyR234(params, viaOwner)) {
      return new StandardSecurityHandler(
        params,
        { authenticatedAs: 'owner', permsConsistent: undefined },
        viaOwner,
      );
    }
    throw new EncryptionError(
      'password does not match /U or /O (§7.6.4.4 Algorithm 6/7; the empty user password was tried by default)',
    );
  }

  // ------------------------------------------------------------- R 6

  static #authenticateR6(
    params: StandardEncryptParams,
    password: Uint8Array,
  ): StandardSecurityHandler {
    const { u, o, ue, oe, perms } = params;
    if (u.length < 48 || o.length < 48 || ue === undefined || oe === undefined) {
      throw new EncryptionError(
        'revision 6 requires 48-byte /U and /O plus /UE and /OE (§7.6.4.2 Table 21)',
      );
    }
    // Algorithm 2.A steps (a)/(b): SASLprep then UTF-8, truncated to 127
    // bytes. The caller did the encoding; the truncation happens here.
    const pw = password.subarray(0, 127);
    const u48 = u.subarray(0, 48);
    const none = new Uint8Array(0);

    // Algorithm 11: user password — hash2B(pw + user Validation Salt).
    let authenticatedAs: 'user' | 'owner';
    let fileKey: Uint8Array;
    if (bytesEqual(hash2B(pw, u.subarray(32, 40), none), u.subarray(0, 32))) {
      authenticatedAs = 'user';
      // Algorithm 2.A step (e): intermediate user key over the user Key
      // Salt; AES-256-CBC no padding, zero IV, over UE.
      const intermediate = hash2B(pw, u.subarray(40, 48), none);
      fileKey = aesCbcDecryptNoPad(intermediate, ZERO_IV, ue.subarray(0, 32));
    } else if (bytesEqual(hash2B(pw, o.subarray(32, 40), u48), o.subarray(0, 32))) {
      // Algorithm 12: owner password — hash2B(pw + owner Validation Salt + U).
      authenticatedAs = 'owner';
      // Algorithm 2.A step (d): intermediate owner key over the owner Key
      // Salt and the 48-byte U string; decrypt OE.
      const intermediate = hash2B(pw, o.subarray(40, 48), u48);
      fileKey = aesCbcDecryptNoPad(intermediate, ZERO_IV, oe.subarray(0, 32));
    } else {
      throw new EncryptionError(
        'password does not match /U or /O (§7.6.4.4 Algorithm 11/12; the empty user password was tried by default)',
      );
    }

    // Algorithm 2.A step (f): the decrypted Perms shall carry "adb" at
    // bytes 9–11. That marker is the proof the derived key actually
    // decrypts — without it the key is wrong even though a hash matched.
    let permsConsistent: boolean | undefined;
    if (perms !== undefined && perms.length >= 16) {
      const decrypted = aesEcbDecryptBlock(fileKey, perms.subarray(0, 16));
      if (decrypted[9] !== 0x61 || decrypted[10] !== 0x64 || decrypted[11] !== 0x62) {
        throw new EncryptionError(
          'decrypted /Perms does not carry "adb" at bytes 9-11 (§7.6.4.3.3 Algorithm 2.A step f) — the file encryption key does not decrypt this document',
        );
      }
      // Algorithm 13: P (bytes 0–3, little-endian) and the EncryptMetadata
      // marker (byte 8, "T"/"F") "should match" — recorded, not enforced;
      // the verdict belongs to pdf-verify-mcp (DESIGN §4.2).
      const view = new DataView(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength);
      const pMatches = view.getInt32(0, true) === params.p;
      const metadataByte = params.encryptMetadata ? 0x54 : 0x46;
      permsConsistent = pMatches && decrypted[8] === metadataByte;
    } else {
      throw new EncryptionError('revision 6 requires a 16-byte /Perms (§7.6.4.2 Table 21)');
    }

    return new StandardSecurityHandler(params, { authenticatedAs, permsConsistent }, fileKey);
  }

  // ------------------------------------------------------ decryption

  /**
   * Decrypt `data` belonging to object (objectNumber, generationNumber)
   * with `method`. Throws EncryptionError when the byte layout cannot be
   * what §7.6.3.2/§7.6.3.3 describe — never returns ciphertext.
   */
  decrypt(
    method: CryptMethod,
    data: Uint8Array,
    objectNumber: number,
    generationNumber: number,
  ): Uint8Array {
    if (method === 'Identity' || data.length === 0) {
      return data;
    }
    if (method === 'RC4') {
      return rc4(this.#objectKey(objectNumber, generationNumber, false), data);
    }
    if (method === 'AESV4') {
      // ISO/TS 32003 §5.2: 12-byte IV, ciphertext, 16-byte GCM tag; file
      // key used directly. A failed tag returns null — a tampered object
      // shall not yield plaintext.
      const plain = aesGcmDecryptIvPrefixed(this.#fileKey, data);
      if (plain === null) {
        throw new EncryptionError(
          `object ${objectNumber} ${generationNumber}: ${data.length} byte(s) are not valid AES-GCM data — ` +
            'ISO/TS 32003 §5.2 requires a 12-byte IV, ciphertext, and a 16-byte authentication tag that verifies',
        );
      }
      return plain;
    }
    // AESV2 / AESV3 — §7.6.3.2 / §7.6.3.3: 16-byte IV prefix, CBC, PKCS#7.
    const key =
      method === 'AESV3' ? this.#fileKey : this.#objectKey(objectNumber, generationNumber, true);
    const plain = aesDecryptIvPrefixed(key, data);
    if (plain === null) {
      throw new EncryptionError(
        `object ${objectNumber} ${generationNumber}: ${data.length} byte(s) cannot be AES-encrypted data — ` +
          'the clause requires a 16-byte initialization vector followed by whole ciphertext blocks ' +
          `(${method === 'AESV3' ? '§7.6.3.3 Algorithm 1.A' : '§7.6.3.2 Algorithm 1'})`,
      );
    }
    return plain;
  }

  /**
   * Algorithm 1 step (b)–(d): per-object key for R ≤ 4 — MD5 over the
   * file key, the low 3 bytes of the object number, the low 2 bytes of
   * the generation number, and "sAlT" for AES; truncated to
   * min(n + 5, 16). R 6 (Algorithm 1.A) uses the file key directly.
   */
  #objectKey(objectNumber: number, generationNumber: number, aes: boolean): Uint8Array {
    if (this.params.revision >= 6) {
      return this.#fileKey;
    }
    const extra = Uint8Array.from([
      objectNumber & 0xff,
      (objectNumber >> 8) & 0xff,
      (objectNumber >> 16) & 0xff,
      generationNumber & 0xff,
      (generationNumber >> 8) & 0xff,
    ]);
    const digest = aes ? md5(this.#fileKey, extra, AES_SALT) : md5(this.#fileKey, extra);
    return digest.subarray(0, Math.min(this.#fileKey.length + 5, 16));
  }
}

// ------------------------------------------------------------ helpers

/** Algorithm 2 step (a): pad or truncate a password to exactly 32 bytes. */
function padPassword(password: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  const n = Math.min(password.length, 32);
  out.set(password.subarray(0, n));
  out.set(PAD.subarray(0, 32 - n), n);
  return out;
}

/** Algorithm 2 steps (a)–(i): the R 2–4 file encryption key. */
function fileKeyR234(params: StandardEncryptParams, password: Uint8Array): Uint8Array {
  const p = new Uint8Array(4);
  new DataView(p.buffer).setInt32(0, params.p, true); // step (d): 32-bit, low-order byte first
  const parts: Uint8Array[] = [padPassword(password), params.o.subarray(0, 32), p, params.idFirst];
  if (params.revision >= 4 && !params.encryptMetadata) {
    parts.push(Uint8Array.from([0xff, 0xff, 0xff, 0xff])); // step (f)
  }
  let key = md5(...parts);
  const n = params.revision === 2 ? 5 : params.keyBytes; // step (i)
  if (params.revision >= 3) {
    for (let i = 0; i < 50; i += 1) {
      key = md5(key.subarray(0, n)); // step (h)
    }
  }
  return key.subarray(0, n);
}

/** Algorithm 3 steps (a)–(d): the RC4 key derived from the owner password. */
function ownerKeyR234(params: StandardEncryptParams, ownerPassword: Uint8Array): Uint8Array {
  let digest = md5(padPassword(ownerPassword));
  if (params.revision >= 3) {
    for (let i = 0; i < 50; i += 1) {
      digest = md5(digest);
    }
  }
  const n = params.revision === 2 ? 5 : params.keyBytes;
  return digest.subarray(0, n);
}

/** Algorithm 6 step (b): does `key` reproduce /U? (Algorithm 4 for R 2, Algorithm 5 for R 3/4.) */
function validateUserKeyR234(params: StandardEncryptParams, key: Uint8Array): boolean {
  if (params.u.length < 16) {
    return false;
  }
  if (params.revision === 2) {
    return bytesEqual(rc4(key, PAD), params.u.subarray(0, 32));
  }
  // Algorithm 5: MD5(PAD + ID), RC4, then 19 XOR-keyed rounds; the last 16
  // of the stored 32 bytes are arbitrary padding, so 16 bytes compare.
  let u = rc4(key, md5(PAD, params.idFirst));
  for (let i = 1; i <= 19; i += 1) {
    u = rc4(xorKey(key, i), u);
  }
  return bytesEqual(u.subarray(0, 16), params.u.subarray(0, 16));
}

/** Algorithm 5 step (e) / Algorithm 7 step (b): key XORed bytewise with the round counter. */
function xorKey(key: Uint8Array, round: number): Uint8Array {
  return Uint8Array.from(key, (b) => b ^ round);
}

/**
 * Algorithm 2.B — the revision 6 iterated hash. `udata` is the 48-byte
 * U string when checking the owner password, empty otherwise.
 *
 * Exported because the write side (Algorithms 8/9, `standard-handler-writer.ts`)
 * derives /U, /UE, /O and /OE with the same hash — one implementation, so a
 * document this library writes authenticates against the reader it also ships.
 */
export function hash2B(password: Uint8Array, salt: Uint8Array, udata: Uint8Array): Uint8Array {
  let k = sha256(password, salt, udata);
  const unit = new Uint8Array(password.length + 64 + udata.length);
  for (let round = 0; ; round += 1) {
    // (a) K1 = 64 repetitions of (password ‖ K ‖ udata)
    unit.set(password, 0);
    unit.set(k, password.length);
    unit.set(udata, password.length + k.length);
    const unitLen = password.length + k.length + udata.length;
    const k1 = new Uint8Array(unitLen * 64);
    for (let i = 0; i < 64; i += 1) {
      k1.set(unit.subarray(0, unitLen), i * unitLen);
    }
    // (b) E = AES-128-CBC-encrypt(key = K[0..16], iv = K[16..32], K1), no padding
    const e = aesCbcEncryptNoPad(k.subarray(0, 16), k.subarray(16, 32), k1);
    // (c) modulo 3 of the first 16 bytes as a big-endian integer — the sum
    // of the bytes has the same residue (256 ≡ 1 mod 3), which avoids
    // bignum arithmetic without changing the result.
    let sum = 0;
    for (let i = 0; i < 16; i += 1) {
      sum += e[i] as number;
    }
    const mod = sum % 3;
    // (d) rehash E with the selected algorithm
    k = mod === 0 ? sha256(e) : mod === 1 ? sha384(e) : sha512(e);
    // (e)/(f): after round 63, stop once the last byte of E ≤ round − 32.
    // `round` is 0-indexed: the check after the 64th iteration (round 63)
    // compares against 64 − 32 = 32, so the threshold is round − 31.
    if (round >= 63 && (e[e.length - 1] as number) <= round - 31) {
      break;
    }
  }
  return k.subarray(0, 32);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}
