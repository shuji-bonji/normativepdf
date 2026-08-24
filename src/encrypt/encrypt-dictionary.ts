/**
 * Encrypt-dictionary reading — Tables 20/21/25/26 mapped onto
 * {@link StandardEncryptParams}, and password encoding.
 *
 * Every refusal names its clause. The refusals are the point: an
 * unsupported handler must never fall through to "read the bytes as if
 * they were plaintext" (ADR-0008 decision 3 — the corpus holds two
 * specimens that used to do exactly that).
 *
 * Values inside the encryption dictionary are required direct here.
 * §7.6.2 requires it of the strings ("Unlike strings within the body of
 * the document, those in the encryption dictionary shall be direct
 * objects"); for the remaining entries an indirect value would need
 * object resolution before any key exists, and no specimen has ever
 * demanded it — refused by name until one does.
 */

import type { CosDict, CosObject } from '../cos/types.js';
import { dictGet } from '../cos/types.js';
import { DocumentDecryptor } from './document-decryptor.js';
import {
  type CryptMethod,
  EncryptionError,
  type StandardEncryptParams,
  StandardSecurityHandler,
} from './standard-handler.js';

/** Options accepted by `parsePdf` for encrypted documents. */
export interface DecryptionOptions {
  /**
   * The password to authenticate with (both roles are tried). Default:
   * empty — Algorithm 6's NOTE names checking the empty user password as
   * the way a reader decides whether to prompt at all.
   *
   * A string is encoded per the handler revision: Latin-1 code points for
   * R ≤ 4 (§7.6.4.3.2 step a names PDFDocEncoding; the two agree on every
   * code point a Latin-1 string can carry except a handful of PDFDoc-only
   * glyphs, and disagreements are refused), UTF-8 for R 6. R 6 further
   * prescribes SASLprep (RFC 4013), which this library does not
   * implement — a non-ASCII R 6 password string is refused by name; pass
   * a `Uint8Array` with the normalisation already applied instead.
   */
  readonly password?: string | Uint8Array;
}

/**
 * Read the encryption dictionary, authenticate, and return the document
 * decryptor. `encryptObjectNumber` is the object number the trailer's
 * /Encrypt entry referenced (undefined when it was direct); `idFirst`
 * the first element of the trailer /ID, required for R ≤ 4 key
 * derivation (Algorithm 2 step e).
 */
export function buildDocumentDecryptor(
  encryptDict: CosObject,
  encryptObjectNumber: number | undefined,
  idFirst: Uint8Array | undefined,
  options?: DecryptionOptions,
): DocumentDecryptor {
  if (encryptDict.kind !== 'dict') {
    throw new EncryptionError(
      `trailer Encrypt shall resolve to a dictionary (§7.5.5 Table 15), got ${encryptDict.kind}`,
    );
  }
  const dict = encryptDict;

  const filter = name(dict, 'Filter');
  if (filter === undefined) {
    throw new EncryptionError('encryption dictionary shall have a Filter name (§7.6.2 Table 20)');
  }
  if (filter !== 'Standard') {
    throw new EncryptionError(
      `security handler /${filter} is not supported — only the standard password-based handler is implemented (§7.6.2 Table 20; public-key handlers are §7.6.5)`,
    );
  }

  const v = integer(dict, 'V');
  if (v === undefined || v === 0 || v === 3) {
    // Table 20 V: 0 "shall not be used"; 3 is "an unpublished algorithm"
    // that "shall not appear in a conforming PDF file".
    throw new EncryptionError(
      `encryption dictionary V shall be 1, 2, 4, 5 or 6 (§7.6.2 Table 20; 6 is ISO/TS 32003), got ${v ?? 'nothing'}`,
    );
  }
  if (v !== 1 && v !== 2 && v !== 4 && v !== 5 && v !== 6) {
    // V 6 is ISO/TS 32003 (AES-GCM); everything else is undefined.
    throw new EncryptionError(
      `encryption algorithm V ${v} is not defined by §7.6.2 Table 20 or ISO/TS 32003`,
    );
  }

  const revision = integer(dict, 'R');
  if (revision === undefined) {
    throw new EncryptionError(
      'standard security handler requires an integer R (§7.6.4.2 Table 21)',
    );
  }
  if (revision === 5) {
    throw new EncryptionError(
      'security handler revision 5 shall not be used (§7.6.4.2 Table 21: a deprecated proprietary extension); no specimen has demanded reading it',
    );
  }
  const revisionOk =
    (v <= 2 && (revision === 2 || revision === 3)) ||
    (v === 4 && revision === 4) ||
    (v === 5 && revision === 6) ||
    (v === 6 && revision === 7); // ISO/TS 32003 §5.1: V 6 ⇒ R 7
  if (!revisionOk) {
    throw new EncryptionError(
      `security handler revision ${revision} does not go with V ${v} (§7.6.4.2 Table 21: R 2/3 for V < 4, R 4 for V 4, R 6 for V 5; ISO/TS 32003: R 7 for V 6)`,
    );
  }

  // R 6 and R 7 (V 5 / V 6) both carry the 48-byte AES-256 password strings.
  const isR6Family = revision === 6 || revision === 7;
  const o = byteString(dict, 'O');
  const u = byteString(dict, 'U');
  const minOU = isR6Family ? 48 : 32;
  if (o === undefined || o.length < minOU || u === undefined || u.length < minOU) {
    throw new EncryptionError(
      `standard security handler requires O and U byte strings of at least ${minOU} bytes for R ${revision} (§7.6.4.2 Table 21)`,
    );
  }

  const p = integer(dict, 'P');
  if (p === undefined) {
    throw new EncryptionError(
      'standard security handler requires an integer P (§7.6.4.2 Table 21)',
    );
  }

  if (revision <= 4 && idFirst === undefined) {
    // Algorithm 2 step (e) hashes the first /ID element into the file
    // encryption key; without it no key can be derived. Table 15 makes
    // /ID required "if an Encrypt entry is present".
    throw new EncryptionError(
      'trailer of an encrypted document shall have an ID entry (§7.5.5 Table 15); Algorithm 2 step e requires its first element',
    );
  }

  // Table 20 Length: bits, multiple of 8, 40–128; "only if V is 2 or 3",
  // default 40. V 1 is fixed at 40 bits; V 4 files commonly carry
  // Length 128 and Algorithm 1 reads n from it, so it is honoured there
  // too (default 128 for V 4 — the only length AESV2/V2-with-V4 use).
  const lengthBits =
    integer(dict, 'Length') ?? (v === 2 ? 40 : v === 4 ? 128 : v === 5 || v === 6 ? 256 : 40);
  if (lengthBits % 8 !== 0 || lengthBits < 40 || lengthBits > 256) {
    throw new EncryptionError(
      `encryption key Length shall be a multiple of 8 in 40..128 bits (§7.6.2 Table 20; 256 for V 5/6 per Table 25 AESV3/AESV4), got ${lengthBits}`,
    );
  }
  const keyBytes = v === 1 ? 5 : lengthBits / 8;

  const encryptMetadata = ((): boolean => {
    const value = dictGet(dict, 'EncryptMetadata');
    if (value === undefined) {
      return true; // Table 21: default true
    }
    if (value.kind !== 'boolean') {
      throw new EncryptionError(
        `EncryptMetadata shall be a boolean (§7.6.4.2 Table 21), got ${value.kind}`,
      );
    }
    return value.value;
  })();

  // Crypt filters (V 4/5): CF maps names to methods; StmF/StrF select the
  // defaults (Table 20; default Identity). For V 1/2 the method is RC4 by
  // definition of Algorithm 1.
  let streamMethod: CryptMethod;
  let stringMethod: CryptMethod;
  const cryptFilters = new Map<string, CryptMethod>();
  if (v === 4 || v === 5 || v === 6) {
    const cf = dictGet(dict, 'CF');
    if (cf !== undefined) {
      if (cf.kind !== 'dict') {
        throw new EncryptionError(`CF shall be a dictionary (§7.6.2 Table 20), got ${cf.kind}`);
      }
      for (const [cfName, cfValue] of cf.entries) {
        cryptFilters.set(cfName, cryptFilterMethod(cfName, cfValue, v));
      }
    }
    streamMethod = resolveDefaultFilter(dict, 'StmF', cryptFilters);
    stringMethod = resolveDefaultFilter(dict, 'StrF', cryptFilters);
  } else {
    streamMethod = 'RC4';
    stringMethod = 'RC4';
  }

  const params: StandardEncryptParams = {
    v,
    revision,
    keyBytes,
    o,
    u,
    oe: byteString(dict, 'OE'),
    ue: byteString(dict, 'UE'),
    perms: byteString(dict, 'Perms'),
    p,
    idFirst: idFirst ?? new Uint8Array(0),
    encryptMetadata,
    streamMethod,
    stringMethod,
    cryptFilters,
  };

  const handler = StandardSecurityHandler.authenticate(
    params,
    encodePassword(options?.password, revision),
  );
  return new DocumentDecryptor(handler, encryptObjectNumber);
}

/** Table 25 — one crypt filter dictionary to a method this handler can apply. */
function cryptFilterMethod(cfName: string, value: CosObject, v: number): CryptMethod {
  if (value.kind !== 'dict') {
    throw new EncryptionError(
      `crypt filter /${cfName} shall be a dictionary (§7.6.2 Table 20 CF), got ${value.kind}`,
    );
  }
  const cfm = name(value, 'CFM') ?? 'None'; // Table 25: default None
  switch (cfm) {
    case 'V2':
      return 'RC4';
    case 'AESV2':
      if (v !== 4) {
        throw new EncryptionError(
          `crypt filter method AESV2 requires V 4 (§7.6.6 Table 25: key size 128 bits), the dictionary declares V ${v}`,
        );
      }
      return 'AESV2';
    case 'AESV3':
      if (v !== 5) {
        throw new EncryptionError(
          `crypt filter method AESV3 requires V 5 (§7.6.6 Table 25: key size 256 bits), the dictionary declares V ${v}`,
        );
      }
      return 'AESV3';
    case 'AESV4':
      // ISO/TS 32003 §5.1: AESV4 (AES-GCM) is declared with V 6.
      if (v !== 6) {
        throw new EncryptionError(
          `crypt filter method AESV4 requires V 6 (ISO/TS 32003 §5.1: AES-GCM, key size 256 bits), the dictionary declares V ${v}`,
        );
      }
      return 'AESV4';
    case 'None':
      // Table 25: "the application shall not decrypt data but shall
      // direct the input stream to the security handler" — a private
      // scheme this library cannot apply.
      throw new EncryptionError(
        `crypt filter /${cfName} declares CFM None — a security-handler-private scheme this library cannot decrypt (§7.6.6 Table 25)`,
      );
    default:
      // Table 25: "Only the values listed here shall be supported.
      // Applications that encounter other values shall report that the
      // file is encrypted with an unsupported algorithm."
      throw new EncryptionError(
        `crypt filter /${cfName} declares CFM /${cfm}, which is not a Table 25 method — the file is encrypted with an unsupported algorithm (§7.6.6)`,
      );
  }
}

/** Table 20 StmF/StrF — a standard name (Identity) or a key of CF. Default Identity. */
function resolveDefaultFilter(
  dict: CosDict,
  key: 'StmF' | 'StrF',
  cryptFilters: ReadonlyMap<string, CryptMethod>,
): CryptMethod {
  const value = dictGet(dict, key);
  if (value === undefined) {
    return 'Identity'; // Table 20: "Default value: Identity"
  }
  if (value.kind !== 'name') {
    throw new EncryptionError(`${key} shall be a name (§7.6.2 Table 20), got ${value.kind}`);
  }
  if (value.value === 'Identity') {
    return 'Identity'; // Table 26
  }
  const method = cryptFilters.get(value.value);
  if (method === undefined) {
    throw new EncryptionError(
      `${key} names crypt filter /${value.value}, which CF does not define (§7.6.2 Table 20: the name shall be a key in the CF dictionary or a standard crypt filter name)`,
    );
  }
  return method;
}

/** Encode a password option per the handler revision (see {@link DecryptionOptions}). */
function encodePassword(password: string | Uint8Array | undefined, revision: number): Uint8Array {
  if (password === undefined) {
    return new Uint8Array(0);
  }
  if (password instanceof Uint8Array) {
    return password;
  }
  if (revision >= 6) {
    for (const ch of password) {
      if ((ch.codePointAt(0) as number) > 0x7e) {
        throw new EncryptionError(
          'revision 6 passwords shall be SASLprep-normalised UTF-8 (§7.6.4.3.3 Algorithm 2.A step a); this library does not implement SASLprep — pass a Uint8Array with the normalisation already applied',
        );
      }
    }
    return new TextEncoder().encode(password);
  }
  const bytes = new Uint8Array(password.length);
  for (let i = 0; i < password.length; i += 1) {
    const code = password.charCodeAt(i);
    if (code > 0xff) {
      throw new EncryptionError(
        'revision 4 and earlier passwords are PDFDocEncoding bytes (§7.6.4.3.2 Algorithm 2 step a); this string does not fit — pass a Uint8Array encoded as the document expects',
      );
    }
    bytes[i] = code;
  }
  return bytes;
}

function name(dict: CosDict, key: string): string | undefined {
  const value = dictGet(dict, key);
  if (value === undefined) {
    return undefined;
  }
  if (value.kind !== 'name') {
    throw new EncryptionError(
      `encryption dictionary ${key} shall be a name (§7.6.2), got ${value.kind}`,
    );
  }
  return value.value;
}

function integer(dict: CosDict, key: string): number | undefined {
  const value = dictGet(dict, key);
  if (value === undefined) {
    return undefined;
  }
  if (value.kind !== 'integer') {
    throw new EncryptionError(
      `encryption dictionary ${key} shall be an integer (§7.6.2), got ${value.kind}`,
    );
  }
  return value.value;
}

function byteString(dict: CosDict, key: string): Uint8Array | undefined {
  const value = dictGet(dict, key);
  if (value === undefined) {
    return undefined;
  }
  if (value.kind !== 'string') {
    throw new EncryptionError(
      `encryption dictionary ${key} shall be a byte string (§7.6.4.2 Table 21), got ${value.kind}`,
    );
  }
  return value.bytes;
}
