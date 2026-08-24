/**
 * Encrypted-PDF writer — ISO 32000-2 §7.6 write side (ADR-0008), for the
 * standard security handler at revision 6 (AES-256-CBC, AESV3) and
 * revision 7 (AES-GCM, AESV4 — ISO/TS 32003:2023).
 *
 * What it does, and what it deliberately does not:
 * - Builds the encryption dictionary from a freshly generated file key
 *   (Algorithms 8/9/10), encrypts every string and stream per §7.6.2, and
 *   writes a classic cross-reference table. Object streams and
 *   cross-reference streams under encryption are not written here — they
 *   add encryption edge cases (the xref stream is never encrypted; object
 *   streams are encrypted whole) that no consumer has yet required.
 * - Encryption is inherently non-deterministic (random file key, salts,
 *   IVs), so byte-determinism — the plain writer's rule (DESIGN §4.1) — is
 *   NOT a goal. The random source is injectable so tests reproduce exactly.
 *
 * The acceptance this serves (ADR-0008): an AESV3 document is decrypted
 * whole by qpdf (independent); an AESV4 document has each object decrypted
 * by node:crypto (independent AES-GCM); and both read back through this
 * library's own decryptor to the original plaintext.
 */

import type { CosDict, CosObject } from '../cos/types.js';
import { DocumentEncryptor } from '../encrypt/document-encryptor.js';
import {
  deriveEncryptDictValues,
  type Permissions,
  type RandomBytes,
  type WriteMethod,
} from '../encrypt/standard-handler-writer.js';
import { type WritableObject, writeFile } from './file-writer.js';

/** Options for {@link encryptPdf}. */
export interface EncryptPdfOptions {
  /** Cipher: 'AESV3' (AES-256-CBC, R 6) or 'AESV4' (AES-GCM, R 7 — TS 32003). Default 'AESV3'. */
  readonly method?: WriteMethod;
  /** User password. Default: empty (the document opens without a prompt). */
  readonly userPassword?: Uint8Array;
  /** Owner password. Default: the user password (so an owner can always open). */
  readonly ownerPassword?: Uint8Array;
  /** Permission flags (§7.6.4.2 Table 22). */
  readonly permissions?: Permissions;
  /** Header version (§7.5.2). AESV4 requires 2.0. Default '2.0'. */
  readonly version?: string;
  /**
   * Random source. Default: `globalThis.crypto.getRandomValues`, which is
   * engine-independent (browser and Node ≥ 19 both expose it). Injectable
   * so tests are reproducible.
   */
  readonly random?: RandomBytes;
}

/**
 * WebCrypto's getRandomValues, typed narrowly here because the project's
 * lib is ES2022 only (no DOM) — declaring the one method used keeps the
 * runtime engine-independent without pulling the whole DOM typing in.
 */
interface WebCryptoLike {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

const defaultRandom: RandomBytes = (length: number): Uint8Array => {
  const out = new Uint8Array(length);
  const webcrypto = (globalThis as { crypto?: WebCryptoLike }).crypto;
  if (webcrypto === undefined) {
    throw new Error(
      'no cryptographically strong random source (globalThis.crypto is absent); pass options.random',
    );
  }
  // WebCrypto — present on both browser and Node ≥ 19 globals, so the
  // runtime stays engine-independent (no node:crypto in the shipped surface).
  webcrypto.getRandomValues(out);
  return out;
};

/**
 * Encrypt a set of objects into a standard-security-handler PDF.
 *
 * The objects are the document body (as {@link writeFile} takes them);
 * `trailerSource` supplies /Root and the rest. This function generates the
 * file key, derives the encryption dictionary, encrypts the objects,
 * assigns the encryption dictionary and /ID, and writes the file.
 */
export function encryptPdf(
  objects: readonly WritableObject[],
  trailerSource: CosDict,
  options: EncryptPdfOptions = {},
): Uint8Array {
  const method = options.method ?? 'AESV3';
  const random = options.random ?? defaultRandom;
  const version = options.version ?? '2.0';
  const userPassword = options.userPassword ?? new Uint8Array(0);
  const ownerPassword = options.ownerPassword ?? userPassword;

  if (method === 'AESV4' && version !== '2.0') {
    throw new RangeError(
      `AESV4 (AES-GCM) is a PDF 2.0 feature (ISO/TS 32003); header version shall be 2.0, got ${version}`,
    );
  }

  // §7.6.4.4: the revision-6 file encryption key is 32 strong random bytes.
  const fileKey = random(32);
  const values = deriveEncryptDictValues(
    fileKey,
    userPassword,
    ownerPassword,
    method,
    random,
    options.permissions,
  );

  // Encrypt the body. R 6/7 use the file key directly, so no object number
  // is threaded through (§7.6.3.3 / TS 32003 §5.2).
  const encryptor = new DocumentEncryptor(method, fileKey, values.encryptMetadata, random);
  const encrypted: WritableObject[] = objects.map((o) => ({
    objectNumber: o.objectNumber,
    generationNumber: o.generationNumber,
    object: encryptor.transform(o.object),
  }));

  // The encryption dictionary is a new indirect object above everything the
  // body defines or references (the same "not old numbers" discipline the
  // plain writer uses for its own containers, §7.5.7 R-7.5.7-17).
  const encryptNumber = highestNumber(encrypted, trailerSource) + 1;
  const encryptDict = buildEncryptDictionary(values);
  const allObjects: WritableObject[] = [
    ...encrypted,
    { objectNumber: encryptNumber, generationNumber: 0, object: encryptDict },
  ];

  // §7.6.2: the /ID values are not encrypted and shall be direct. They are
  // required whenever an Encrypt entry is present (§7.5.5 Table 15).
  const id = random(16);
  const idObject: CosObject = {
    kind: 'array',
    items: [
      { kind: 'string', bytes: id, form: 'hex' },
      { kind: 'string', bytes: id, form: 'hex' },
    ],
  };

  const trailerEntries = new Map<string, CosObject>(trailerSource.entries);
  trailerEntries.set('Encrypt', { kind: 'ref', objectNumber: encryptNumber, generationNumber: 0 });
  trailerEntries.set('ID', idObject);
  const trailer: CosDict = { kind: 'dict', entries: trailerEntries };

  return writeFile(allObjects, trailer, { version, encryptedByEncryptPdf: true });
}

/** Assemble the standard encryption dictionary (Tables 20/21/25) for a derived key set. */
function buildEncryptDictionary(values: ReturnType<typeof deriveEncryptDictValues>): CosDict {
  const cfm = values.method; // 'AESV3' | 'AESV4' — the Table 25 / TS 32003 CFM name
  const stdCf: CosDict = {
    kind: 'dict',
    entries: new Map<string, CosObject>([
      ['Type', { kind: 'name', value: 'CryptFilter' }],
      ['CFM', { kind: 'name', value: cfm }],
      ['Length', { kind: 'integer', value: 32 }], // bytes, per Table 25 (256-bit key)
      ['AuthEvent', { kind: 'name', value: 'DocOpen' }],
    ]),
  };
  const cf: CosDict = {
    kind: 'dict',
    entries: new Map<string, CosObject>([['StdCF', stdCf]]),
  };
  const entries = new Map<string, CosObject>([
    ['Filter', { kind: 'name', value: 'Standard' }],
    ['V', { kind: 'integer', value: values.v }],
    ['R', { kind: 'integer', value: values.r }],
    ['Length', { kind: 'integer', value: 256 }],
    ['CF', cf],
    ['StmF', { kind: 'name', value: 'StdCF' }],
    ['StrF', { kind: 'name', value: 'StdCF' }],
    ['O', { kind: 'string', bytes: values.o, form: 'literal' }],
    ['U', { kind: 'string', bytes: values.u, form: 'literal' }],
    ['OE', { kind: 'string', bytes: values.oe, form: 'literal' }],
    ['UE', { kind: 'string', bytes: values.ue, form: 'literal' }],
    ['Perms', { kind: 'string', bytes: values.perms, form: 'literal' }],
    ['P', { kind: 'integer', value: values.p }],
  ]);
  if (!values.encryptMetadata) {
    entries.set('EncryptMetadata', { kind: 'boolean', value: false });
  }
  return { kind: 'dict', entries };
}

/** Highest object number defined or referenced (so the Encrypt dict never shadows a dangling ref). */
function highestNumber(objects: readonly WritableObject[], trailer: CosDict): number {
  let highest = 0;
  for (const { objectNumber } of objects) {
    highest = Math.max(highest, objectNumber);
  }
  const visit = (value: CosObject): void => {
    switch (value.kind) {
      case 'ref':
        highest = Math.max(highest, value.objectNumber);
        return;
      case 'array':
        for (const item of value.items) {
          visit(item);
        }
        return;
      case 'dict':
        for (const entry of value.entries.values()) {
          visit(entry);
        }
        return;
      case 'stream':
        visit(value.dict);
        return;
      default:
        return;
    }
  };
  visit(trailer);
  for (const { object } of objects) {
    visit(object);
  }
  return highest;
}
