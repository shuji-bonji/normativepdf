/**
 * Document decryption — §7.6 read side (ADR-0008).
 *
 * The fixtures were encrypted by qpdf (an independent implementation —
 * GUARDS T-2), all from the same plaintext base document; recovery of
 * that exact plaintext is what the tests assert. Refusals are asserted
 * by name: an unsupported handler, a wrong password, or a write against
 * an encrypted document must produce a clause-carrying error, never
 * ciphertext wearing a plaintext face (decision 3).
 */

import { describe, expect, it } from 'vitest';
import type { CosDict, CosObject, CosStream } from '../src/cos/types.js';
import { dictGet } from '../src/cos/types.js';
import { buildDocumentDecryptor } from '../src/encrypt/encrypt-dictionary.js';
import { EncryptionError } from '../src/encrypt/standard-handler.js';
import { PdfDocument, parsePdf, readXrefChain } from '../src/file/file-parser.js';
import { decodeStream } from '../src/filter/decode.js';
import { rewrite, writeFile } from '../src/serialize/file-writer.js';
import { appendUpdate } from '../src/serialize/incremental.js';
import {
  aes128,
  aes128_pw,
  aes256,
  aes256_objstm,
  aes256_pw,
  rc4_40,
  rc4_128,
  rc4_128_pw,
} from './helpers/encrypted-fixtures.js';

const CONTENT = 'BT /F1 12 Tf 72 720 Td (Hello normative) Tj ET';
const NOTE = 'plain string payload';
const latin1 = (u: Uint8Array): string => Buffer.from(u).toString('latin1');

/** Fetch every in-use/compressed object; returns the decoded page content and the /Note string. */
async function readEverything(doc: PdfDocument): Promise<{ content: string; note: string }> {
  let content = '';
  let note = '';
  for (const [num, entry] of doc.xref) {
    if (entry.type !== 'in-use' && entry.type !== 'compressed') {
      continue;
    }
    const object = await doc.getObject(num, entry.type === 'in-use' ? entry.generation : 0);
    if (object.kind === 'stream') {
      const type = dictGet(object.dict, 'Type');
      if (
        type?.kind === 'name' &&
        (type.value === 'XRef' || type.value === 'ObjStm' || type.value === 'Metadata')
      ) {
        continue;
      }
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
  const catalog = await doc.getCatalog();
  expect(catalog.kind).toBe('dict');
  return { content, note };
}

describe('empty user password (Algorithm 6 NOTE: the no-prompt case)', () => {
  const cases = [
    ['RC4 40-bit (V 1, R 2)', rc4_40, 1, 2, 'RC4'],
    ['RC4 128-bit (V 2, R 3)', rc4_128, 2, 3, 'RC4'],
    ['AES-128 (V 4, R 4, AESV2)', aes128, 4, 4, 'AESV2'],
    ['AES-256 (V 5, R 6, AESV3)', aes256, 5, 6, 'AESV3'],
    ['AES-256 with object streams', aes256_objstm, 5, 6, 'AESV3'],
  ] as const;

  it.each(cases)(
    '%s: full read recovers the plaintext',
    async (_name, fixture, v, revision, method) => {
      const doc = await parsePdf(fixture);
      expect(doc.encryption).toBeDefined();
      expect(doc.encryption?.v).toBe(v);
      expect(doc.encryption?.revision).toBe(revision);
      expect(doc.encryption?.streamMethod).toBe(method);
      expect(doc.encryption?.authenticatedAs).toBe('user');
      const { content, note } = await readEverything(doc);
      expect(content).toBe(CONTENT);
      expect(note).toBe(NOTE);
    },
  );

  it('R 6 records the Perms agreement (Algorithm 13 is a "should" — recorded, not enforced)', async () => {
    const doc = await parsePdf(aes256);
    expect(doc.encryption?.permsConsistent).toBe(true);
  });

  it('unencrypted documents expose no encryption facts', async () => {
    const { plainBase } = await import('./helpers/encrypted-fixtures.js');
    const doc = await parsePdf(plainBase);
    expect(doc.encryption).toBeUndefined();
  });
});

describe('passwords (Algorithms 6/7 and 11/12)', () => {
  const cases = [
    ['RC4 128-bit', rc4_128_pw],
    ['AES-128', aes128_pw],
    ['AES-256', aes256_pw],
  ] as const;

  it.each(cases)('%s: the user password authenticates as user', async (_name, fixture) => {
    const doc = await parsePdf(fixture, { password: 'usr' });
    expect(doc.encryption?.authenticatedAs).toBe('user');
    const { content, note } = await readEverything(doc);
    expect(content).toBe(CONTENT);
    expect(note).toBe(NOTE);
  });

  it.each(cases)('%s: the owner password authenticates as owner', async (_name, fixture) => {
    const doc = await parsePdf(fixture, { password: 'own' });
    expect(doc.encryption?.authenticatedAs).toBe('owner');
    const { content } = await readEverything(doc);
    expect(content).toBe(CONTENT);
  });

  it.each(cases)(
    '%s: a wrong password is refused by name, not given a garbage key',
    async (_name, fixture) => {
      await expect(parsePdf(fixture, { password: 'wrong' })).rejects.toThrow(EncryptionError);
      await expect(parsePdf(fixture)).rejects.toThrow(/does not match \/U or \/O/);
    },
  );
});

describe('refusals name their clause (decision 3: no silent ciphertext)', () => {
  /** Parse a fixture's structure WITHOUT attaching decryption. */
  async function undecrypted(fixture: Uint8Array): Promise<PdfDocument> {
    const { origin, headerVersion, sections, stop } = await readXrefChain(fixture);
    const newest = sections[0];
    if (newest === undefined) {
      throw new Error('fixture has no cross-reference section');
    }
    const merged = new Map();
    for (const section of sections) {
      for (const [num, entry] of section.entries) {
        if (!merged.has(num)) {
          merged.set(num, entry);
        }
      }
    }
    return new PdfDocument(
      fixture,
      origin,
      headerVersion,
      headerVersion,
      newest.trailer,
      merged,
      stop,
    );
  }

  it('an encrypted document without a decryptor hands out no objects', async () => {
    // 🔴 T-3 for the guard: before it existed, a classic-table encrypted
    // file returned every stream as ciphertext with a plaintext face —
    // two corpus specimens (isartor/PDF_A-2b 6-1-3-t02-fail-a) did
    // exactly that through this exact path.
    const doc = await undecrypted(rc4_128);
    await expect(doc.getObject(1, 0)).rejects.toThrow(EncryptionError);
    await expect(doc.getObject(1, 0)).rejects.toThrow(/§7\.6/);
  });

  it('writeFile refuses a trailer that declares /Encrypt', async () => {
    const doc = await parsePdf(rc4_128);
    expect(() => writeFile([], doc.trailer)).toThrow(EncryptionError);
    await expect(rewrite(doc)).rejects.toThrow(/writing an encrypted document is not supported/);
  });

  it('appendUpdate refuses an encrypted previous trailer', async () => {
    const doc = await parsePdf(rc4_128);
    expect(() =>
      appendUpdate({
        original: rc4_128,
        previousXrefOffset: 0,
        previousTrailer: doc.trailer,
        objects: [{ objectNumber: 100, generationNumber: 0, object: { kind: 'null' } }],
      }),
    ).toThrow(/appending to an encrypted document is not supported/);
  });

  it('a public-key security handler is refused by name', async () => {
    const dict: CosDict = {
      kind: 'dict',
      entries: new Map<string, CosObject>([['Filter', { kind: 'name', value: 'Adobe.PPKLite' }]]),
    };
    expect(() => buildDocumentDecryptor(dict, undefined, undefined)).toThrow(
      /security handler \/Adobe\.PPKLite is not supported/,
    );
  });

  it('V 3 and R 5 are refused with their Table 20/21 wording', async () => {
    const base = (entries: [string, CosObject][]): CosDict => ({
      kind: 'dict',
      entries: new Map<string, CosObject>([
        ['Filter', { kind: 'name', value: 'Standard' }],
        ...entries,
      ]),
    });
    expect(() =>
      buildDocumentDecryptor(base([['V', { kind: 'integer', value: 3 }]]), undefined, undefined),
    ).toThrow(/V shall be 1, 2, 4, 5 or 6/);
    expect(() =>
      buildDocumentDecryptor(
        base([
          ['V', { kind: 'integer', value: 5 }],
          ['R', { kind: 'integer', value: 5 }],
        ]),
        undefined,
        undefined,
      ),
    ).toThrow(/revision 5 shall not be used/);
  });

  it('a crypt filter with CFM None is refused as handler-private', async () => {
    const doc = await parsePdf(aes128);
    const encRef = dictGet(doc.trailer, 'Encrypt');
    if (encRef?.kind !== 'ref') {
      throw new Error('fixture trailer shall reference the encryption dictionary');
    }
    const encDict = await doc.getObject(encRef.objectNumber, encRef.generationNumber);
    if (encDict.kind !== 'dict') {
      throw new Error('encryption dictionary shall be a dict');
    }
    const entries = new Map(encDict.entries);
    entries.set('CF', {
      kind: 'dict',
      entries: new Map<string, CosObject>([
        [
          'StdCF',
          {
            kind: 'dict',
            entries: new Map<string, CosObject>([['CFM', { kind: 'name', value: 'None' }]]),
          },
        ],
      ]),
    });
    expect(() =>
      buildDocumentDecryptor({ kind: 'dict', entries }, undefined, new Uint8Array(16)),
    ).toThrow(/CFM None/);
  });
});

describe('§7.6.2 exceptions travel with the shape of the object', () => {
  /** A decryptor reconstructed from the aes128 fixture's own dictionary. */
  async function fixtureDecryptor() {
    const doc = await parsePdf(aes128);
    const encRef = dictGet(doc.trailer, 'Encrypt');
    if (encRef?.kind !== 'ref') {
      throw new Error('fixture trailer shall reference the encryption dictionary');
    }
    const encDict = await doc.getObject(encRef.objectNumber, encRef.generationNumber);
    const id = dictGet(doc.trailer, 'ID');
    const idFirst =
      id?.kind === 'array' && id.items[0]?.kind === 'string' ? id.items[0].bytes : undefined;
    return buildDocumentDecryptor(encDict, encRef.objectNumber, idFirst);
  }

  it('the /Contents of a signature dictionary stays untouched (§7.6.2 4th exception)', async () => {
    const decryptor = await fixtureDecryptor();
    // 17 bytes can NEVER be AES data (§7.6.3.2: a 16-byte IV plus whole
    // blocks), so the pair below is a T-3 in one test regardless of key
    // material: with /ByteRange present the value passes through
    // untouched; take /ByteRange away and the same dictionary throws,
    // proving the decryption path is live and the exception is what kept
    // the bytes intact.
    const contents = Uint8Array.from({ length: 17 }, () => 0xff);
    const entries: [string, CosObject][] = [
      ['ByteRange', { kind: 'array', items: [] }],
      ['Contents', { kind: 'string', bytes: contents, form: 'hex' }],
    ];
    const sig: CosDict = { kind: 'dict', entries: new Map(entries) };
    const out = decryptor.transform(sig, 7, 0) as CosDict;
    const outContents = out.entries.get('Contents');
    expect(outContents?.kind === 'string' && Buffer.from(outContents.bytes).equals(contents)).toBe(
      true,
    );

    const noByteRange: CosDict = { kind: 'dict', entries: new Map(entries.slice(1)) };
    expect(() => decryptor.transform(noByteRange, 7, 0)).toThrow(EncryptionError);
  });

  it('a cross-reference stream passes through whole — its dictionary is the trailer', async () => {
    // 🔴 Measured: both cross-reference-stream corpus specimens carry /ID
    // inside the stream dictionary; "decrypting" those 16-byte values was
    // this module's first live failure.
    const decryptor = await fixtureDecryptor();
    const idBytes = Uint8Array.from({ length: 16 }, (_, i) => i * 3);
    const xref: CosStream = {
      kind: 'stream',
      dict: {
        kind: 'dict',
        entries: new Map<string, CosObject>([
          ['Type', { kind: 'name', value: 'XRef' }],
          ['ID', { kind: 'array', items: [{ kind: 'string', bytes: idBytes, form: 'hex' }] }],
        ]),
      },
      raw: Uint8Array.from([1, 2, 3, 4]),
    };
    expect(decryptor.transform(xref, 9, 0)).toBe(xref);
  });

  it('a /Crypt filter naming /Identity leaves the stream data alone', async () => {
    const decryptor = await fixtureDecryptor();
    const raw = Uint8Array.from({ length: 24 }, (_, i) => i);
    const stream: CosStream = {
      kind: 'stream',
      dict: {
        kind: 'dict',
        entries: new Map<string, CosObject>([
          ['Filter', { kind: 'array', items: [{ kind: 'name', value: 'Crypt' }] }],
          [
            'DecodeParms',
            {
              kind: 'dict',
              entries: new Map<string, CosObject>([['Name', { kind: 'name', value: 'Identity' }]]),
            },
          ],
        ]),
      },
      raw,
    };
    const out = decryptor.transform(stream, 11, 0) as CosStream;
    expect(Buffer.from(out.raw).equals(raw)).toBe(true);
  });

  it('a /Crypt filter naming an undefined crypt filter is refused by name', async () => {
    const decryptor = await fixtureDecryptor();
    const stream: CosStream = {
      kind: 'stream',
      dict: {
        kind: 'dict',
        entries: new Map<string, CosObject>([
          ['Filter', { kind: 'name', value: 'Crypt' }],
          [
            'DecodeParms',
            {
              kind: 'dict',
              entries: new Map<string, CosObject>([
                ['Name', { kind: 'name', value: 'NoSuchFilter' }],
              ]),
            },
          ],
        ]),
      },
      raw: Uint8Array.from([1, 2, 3]),
    };
    expect(() => decryptor.transform(stream, 12, 0)).toThrow(/NoSuchFilter/);
  });

  it('the encryption dictionary object itself keeps its strings (O, U are key material)', async () => {
    const doc = await parsePdf(aes128);
    const encRef = dictGet(doc.trailer, 'Encrypt');
    if (encRef?.kind !== 'ref') {
      throw new Error('fixture trailer shall reference the encryption dictionary');
    }
    // Fetched through the DECRYPTING document: were the skip missing, O/U
    // would come back mangled and re-authentication would fail.
    const encDict = await doc.getObject(encRef.objectNumber, encRef.generationNumber);
    const id = dictGet(doc.trailer, 'ID');
    const idFirst =
      id?.kind === 'array' && id.items[0]?.kind === 'string' ? id.items[0].bytes : undefined;
    expect(() => buildDocumentDecryptor(encDict, encRef.objectNumber, idFirst)).not.toThrow();
  });
});
