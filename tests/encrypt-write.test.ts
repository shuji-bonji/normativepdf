/**
 * Encrypted-PDF writing — §7.6 write side (ADR-0008), AES-256-CBC (AESV3,
 * R 6) and AES-GCM (AESV4, R 7 — ISO/TS 32003).
 *
 * The acceptance is two-sided, as the repository requires (GUARDS T-2):
 * - self-consistency: write encrypted, read back through this library's
 *   own decryptor, recover the original plaintext;
 * - independent reader: for AESV4, node:crypto (an independent AES-GCM
 *   implementation) decrypts each stream object given the file key — and
 *   the encrypted file is confirmed to hold no plaintext. The whole-file
 *   independent check for AESV3 (qpdf --decrypt) runs in the corpus/host
 *   harness, not here, because vitest has no qpdf; it is recorded in the
 *   ROADMAP with its measured result.
 *
 * Encryption is non-deterministic, so the random source is injected: a
 * counter-based generator makes every run reproducible without ever
 * reusing an IV within a document.
 */

import { createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { CosObject } from '../src/cos/types.js';
import { dictGet } from '../src/cos/types.js';
import { EncryptionError } from '../src/encrypt/standard-handler.js';
import type { RandomBytes } from '../src/encrypt/standard-handler-writer.js';
import { type PdfDocument, parsePdf } from '../src/file/file-parser.js';
import { decodeStream } from '../src/filter/decode.js';
import { encryptPdf } from '../src/serialize/encrypt-writer.js';
import { collectObjects } from '../src/serialize/file-writer.js';
import { plainBase } from './helpers/encrypted-fixtures.js';

const CONTENT = 'BT /F1 12 Tf 72 720 Td (Hello normative) Tj ET';
const NOTE = 'plain string payload';
const latin1 = (u: Uint8Array): string => Buffer.from(u).toString('latin1');
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A reproducible, non-repeating byte source (never a real RNG — deterministic tests). */
function counterRandom(seed: number): RandomBytes {
  let state = seed >>> 0;
  return (length: number): Uint8Array => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      out[i] = state & 0xff;
    }
    return out;
  };
}

async function readEverything(doc: PdfDocument): Promise<{ content: string; note: string }> {
  let content = '';
  let note = '';
  for (const [num, entry] of doc.xref) {
    if (entry.type !== 'in-use' && entry.type !== 'compressed') {
      continue;
    }
    const object = await doc.getObject(num, entry.type === 'in-use' ? entry.generation : 0);
    if (object.kind === 'stream' && dictGet(object.dict, 'Type')?.kind !== 'name') {
      const decoded = latin1(await decodeStream(object));
      if (decoded.includes('Hello normative')) {
        content = decoded.trim();
      }
    }
    if (object.kind === 'dict') {
      const value = dictGet(object, 'Note');
      if (value?.kind === 'string') {
        note = latin1(value.bytes);
      }
    }
  }
  expect((await doc.getCatalog()).kind).toBe('dict');
  return { content, note };
}

async function baseObjects(): Promise<Awaited<ReturnType<typeof collectObjects>>> {
  const src = await parsePdf(plainBase);
  return collectObjects(src);
}

async function baseTrailer() {
  return (await parsePdf(plainBase)).trailer;
}

describe('write then read back (self-consistency)', () => {
  it.each(['AESV3', 'AESV4'] as const)(
    '%s: an empty-password document round-trips to the original plaintext',
    async (method) => {
      const objects = await baseObjects();
      const trailer = await baseTrailer();
      const bytes = encryptPdf(objects, trailer, { method, random: counterRandom(42) });
      // The written file carries no plaintext.
      expect(latin1(bytes).includes('Hello normative')).toBe(false);

      const doc = await parsePdf(bytes);
      expect(doc.encryption?.streamMethod).toBe(method);
      expect(doc.encryption?.v).toBe(method === 'AESV4' ? 6 : 5);
      expect(doc.encryption?.revision).toBe(method === 'AESV4' ? 7 : 6);
      const { content, note } = await readEverything(doc);
      expect(content).toBe(CONTENT);
      expect(note).toBe(NOTE);
    },
  );

  it.each(['AESV3', 'AESV4'] as const)(
    '%s: user and owner passwords both open the document',
    async (method) => {
      const objects = await baseObjects();
      const trailer = await baseTrailer();
      const bytes = encryptPdf(objects, trailer, {
        method,
        userPassword: utf8('user'),
        ownerPassword: utf8('owner'),
        random: counterRandom(7),
      });
      const asUser = await parsePdf(bytes, { password: utf8('user') });
      expect(asUser.encryption?.authenticatedAs).toBe('user');
      expect((await readEverything(asUser)).content).toBe(CONTENT);

      const asOwner = await parsePdf(bytes, { password: utf8('owner') });
      expect(asOwner.encryption?.authenticatedAs).toBe('owner');
      expect((await readEverything(asOwner)).content).toBe(CONTENT);

      await expect(parsePdf(bytes, { password: utf8('wrong') })).rejects.toThrow(EncryptionError);
    },
  );
});

describe('AESV4 independent oracle: node:crypto decrypts each object', () => {
  it('every AES-GCM stream decrypts under node:crypto with the shared file key', async () => {
    // The file key is not exposed by the public API, so recover it the way a
    // reader does — but verify the CIPHER independently: node:crypto's
    // aes-256-gcm, given the same key, must reproduce the plaintext of every
    // encrypted stream. This is the independent side qpdf cannot provide for
    // AES-GCM.
    const objects = await baseObjects();
    const trailer = await baseTrailer();
    const random = counterRandom(123);
    const bytes = encryptPdf(objects, trailer, { method: 'AESV4', random });

    // Reach the file key through the reader's own authentication path by
    // decrypting a known stream two ways and requiring agreement: the library
    // (pure-TS GCM) and node:crypto (independent GCM). We extract the raw
    // encrypted stream bytes from the parsed-but-untransformed structure and
    // the plaintext from the decrypting parse, then confirm node:crypto turns
    // one into the other.
    const encDoc = await parsePdf(bytes); // decrypts
    // Find the content stream's plaintext (decrypted) and its ciphertext (raw).
    let matched = 0;
    for (const [num, entry] of encDoc.xref) {
      if (entry.type !== 'in-use') {
        continue;
      }
      const decrypted = await encDoc.getObject(num, entry.generation);
      if (decrypted.kind !== 'stream') {
        continue;
      }
      const type = dictGet(decrypted.dict, 'Type');
      if (type?.kind === 'name') {
        continue; // skip XRef etc.
      }
      // Re-parse WITHOUT decryption to get the ciphertext bytes for this object.
      const rawDoc = await parseRawStream(bytes, num);
      if (rawDoc === null) {
        continue;
      }
      const { fileKey, ciphertext } = rawDoc;
      // node:crypto decrypts: 12-byte IV, ciphertext, 16-byte tag.
      const iv = ciphertext.subarray(0, 12);
      const tag = ciphertext.subarray(ciphertext.length - 16);
      const body = ciphertext.subarray(12, ciphertext.length - 16);
      const decipher = createDecipheriv('aes-256-gcm', fileKey, iv);
      decipher.setAuthTag(tag);
      const nodePlain = Buffer.concat([decipher.update(body), decipher.final()]);
      expect(latin1(new Uint8Array(nodePlain))).toBe(latin1(decrypted.raw));
      matched += 1;
    }
    expect(matched).toBeGreaterThan(0);
  });
});

/**
 * Recover the file key and a chosen object's raw ciphertext by
 * re-deriving the key the way the reader does, but returning both so a
 * test can hand the ciphertext to node:crypto. Kept in the test because it
 * reaches through non-public seams deliberately.
 */
async function parseRawStream(
  bytes: Uint8Array,
  objectNumber: number,
): Promise<{ fileKey: Uint8Array; ciphertext: Uint8Array } | null> {
  const { readXrefChain } = await import('../src/file/file-parser.js');
  const { ByteCursor } = await import('../src/syntax/byte-cursor.js');
  const { TokenReader } = await import('../src/syntax/token-reader.js');
  const { parseIndirectObject } = await import('../src/syntax/object-parser.js');

  const chain = await readXrefChain(bytes);
  const merged = new Map<number, { type: string; offset?: number; generation?: number }>();
  for (const section of chain.sections) {
    for (const [n, e] of section.entries) {
      if (!merged.has(n)) {
        merged.set(n, e as never);
      }
    }
  }
  const entry = merged.get(objectNumber);
  if (entry === undefined || entry.type !== 'in-use' || entry.offset === undefined) {
    return null;
  }
  const cursor = new ByteCursor(bytes);
  cursor.seek(chain.origin + entry.offset);
  const parsed = parseIndirectObject(new TokenReader(cursor), {
    resolveStreamLength: () => undefined,
  });
  if (parsed.object.kind !== 'stream') {
    return null;
  }
  // Return the raw ciphertext and the file key (recovered the way the reader
  // does), so the caller can hand both to node:crypto — the independent side.
  const fileKey = await recoverFileKey(bytes);
  if (fileKey === null) {
    return null;
  }
  return { fileKey, ciphertext: parsed.object.raw };
}

/** Recover the 32-byte R6/R7 file key from the empty user password (Algorithm 2.A step e). */
async function recoverFileKey(bytes: Uint8Array): Promise<Uint8Array | null> {
  const { readXrefChain } = await import('../src/file/file-parser.js');
  const { hash2B } = await import('../src/encrypt/standard-handler.js');
  const { aesCbcDecryptNoPad } = await import('../src/encrypt/aes.js');
  const { ByteCursor } = await import('../src/syntax/byte-cursor.js');
  const { TokenReader } = await import('../src/syntax/token-reader.js');
  const { parseIndirectObject } = await import('../src/syntax/object-parser.js');

  const chain = await readXrefChain(bytes);
  const newest = chain.sections[0];
  if (newest === undefined) {
    return null;
  }
  const encRef = dictGet(newest.trailer, 'Encrypt');
  if (encRef?.kind !== 'ref') {
    return null;
  }
  const merged = new Map<number, { type: string; offset?: number; generation?: number }>();
  for (const section of chain.sections) {
    for (const [n, e] of section.entries) {
      if (!merged.has(n)) {
        merged.set(n, e as never);
      }
    }
  }
  const entry = merged.get(encRef.objectNumber);
  if (entry === undefined || entry.offset === undefined) {
    return null;
  }
  const cursor = new ByteCursor(bytes);
  cursor.seek(chain.origin + entry.offset);
  const enc = parseIndirectObject(new TokenReader(cursor), {
    resolveStreamLength: () => undefined,
  }).object;
  if (enc.kind !== 'dict') {
    return null;
  }
  const u = dictGet(enc, 'U');
  const ue = dictGet(enc, 'UE');
  if (u?.kind !== 'string' || ue?.kind !== 'string') {
    return null;
  }
  // Empty user password: intermediate key = hash2B('', userKeySalt); file key
  // = AES-256-CBC-no-pad decrypt of UE with zero IV (Algorithm 2.A step e).
  const keySalt = u.bytes.subarray(40, 48);
  const intermediate = hash2B(new Uint8Array(0), keySalt, new Uint8Array(0));
  return aesCbcDecryptNoPad(intermediate, new Uint8Array(16), ue.bytes.subarray(0, 32));
}

describe('§7.6.2 write-side rules and T-3', () => {
  it('EncryptMetadata false leaves the metadata stream plaintext', async () => {
    // Add a /Type /Metadata stream to the body and encrypt with the flag off.
    const objects = await baseObjects();
    const trailer = await baseTrailer();
    const metadataRaw = utf8('<?xpacket?><x:xmpmeta>MARKER</x:xmpmeta>');
    const withMeta = [
      ...objects,
      {
        objectNumber: 900,
        generationNumber: 0,
        object: {
          kind: 'stream',
          dict: {
            kind: 'dict',
            entries: new Map<string, CosObject>([
              ['Type', { kind: 'name', value: 'Metadata' }],
              ['Subtype', { kind: 'name', value: 'XML' }],
            ]),
          },
          raw: metadataRaw,
        } as CosObject,
      },
    ];
    const bytes = encryptPdf(withMeta, trailer, {
      method: 'AESV3',
      permissions: { encryptMetadata: false },
      random: counterRandom(5),
    });
    // The plaintext XMP marker survives in the file (metadata not encrypted).
    expect(latin1(bytes).includes('MARKER')).toBe(true);

    const doc = await parsePdf(bytes);
    expect(doc.encryption?.encryptMetadata).toBe(false);
  });

  it('T-3: a one-byte change to an AESV4 object body makes the read fail the tag', async () => {
    const objects = await baseObjects();
    const trailer = await baseTrailer();
    const bytes = encryptPdf(objects, trailer, { method: 'AESV4', random: counterRandom(9) });

    // Find a content-stream object's body in the file and flip one byte.
    const marker = utf8('stream\n');
    const idx = indexOf(bytes, marker);
    expect(idx).toBeGreaterThan(0);
    const tampered = bytes.slice();
    // flip a byte a few positions into the first stream body (inside IV/ciphertext)
    tampered[idx + marker.length + 4] = (tampered[idx + marker.length + 4] as number) ^ 0x01;

    // Reading fails by NAME (tag mismatch), never returns ciphertext.
    const doc = await parsePdf(tampered);
    await expect(readEverything(doc)).rejects.toThrow(EncryptionError);
  });

  it('AESV4 requires header version 2.0', async () => {
    const objects = await baseObjects();
    const trailer = await baseTrailer();
    expect(() =>
      encryptPdf(objects, trailer, { method: 'AESV4', version: '1.7', random: counterRandom(1) }),
    ).toThrow(/PDF 2\.0/);
  });
});

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}
