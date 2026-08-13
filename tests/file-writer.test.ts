/**
 * File-structure serializer tests (§7.5).
 *
 * ⚠️ GUARDS T-2 applies with force here: a test that writes a file with this
 * repository's writer and reads it back with this repository's parser cannot
 * detect a mistake the two share. The byte-level assertions below are the
 * defence a unit test can mount; the real second opinion is `qpdf --check` in
 * `scripts/roundtrip-corpus.mjs --qpdf` (ADR-0004 §2), measured over 2,879
 * specimens rather than the handful here.
 */

import { describe, expect, it } from 'vitest';
import type { CosDict, CosObject } from '../src/cos/types.js';
import type { WritableObject } from '../src/index.js';
import { parsePdf, writeFile } from '../src/index.js';

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');
const dict = (entries: [string, CosObject][]): CosDict => ({
  kind: 'dict',
  entries: new Map(entries),
});

/** Smallest document the clauses admit: catalog, page tree, one page. */
function minimalObjects(): WritableObject[] {
  return [
    {
      objectNumber: 1,
      generationNumber: 0,
      object: dict([
        ['Type', { kind: 'name', value: 'Catalog' }],
        ['Pages', { kind: 'ref', objectNumber: 2, generationNumber: 0 }],
      ]),
    },
    {
      objectNumber: 2,
      generationNumber: 0,
      object: dict([
        ['Type', { kind: 'name', value: 'Pages' }],
        ['Kids', { kind: 'array', items: [{ kind: 'ref', objectNumber: 3, generationNumber: 0 }] }],
        ['Count', { kind: 'integer', value: 1 }],
      ]),
    },
    {
      objectNumber: 3,
      generationNumber: 0,
      object: dict([
        ['Type', { kind: 'name', value: 'Page' }],
        ['Parent', { kind: 'ref', objectNumber: 2, generationNumber: 0 }],
        [
          'MediaBox',
          {
            kind: 'array',
            items: [
              { kind: 'integer', value: 0 },
              { kind: 'integer', value: 0 },
              { kind: 'integer', value: 612 },
              { kind: 'integer', value: 792 },
            ],
          },
        ],
      ]),
    },
  ];
}

const minimalTrailer = dict([['Root', { kind: 'ref', objectNumber: 1, generationNumber: 0 }]]);

describe('file header (§7.5.2)', () => {
  it('begins with %PDF-n.m and a binary comment line', () => {
    const text = latin1(writeFile(minimalObjects(), minimalTrailer, { version: '2.0' }));
    expect(text.startsWith('%PDF-2.0\n%')).toBe(true);
    // §7.5.2: the second line should be a comment containing at least four
    // bytes greater than 127, so transfer tools treat the file as binary.
    const commentBytes = text
      .slice(10, 14)
      .split('')
      .map((c) => c.charCodeAt(0));
    expect(commentBytes.every((b) => b > 127)).toBe(true);
  });

  it('refuses a version the header grammar does not admit', () => {
    for (const version of ['3.0', '1.10', 'x']) {
      expect(() => writeFile(minimalObjects(), minimalTrailer, { version })).toThrow(/§7.5.2/);
    }
  });
});

describe('cross-reference table (§7.5.4)', () => {
  const text = () => latin1(writeFile(minimalObjects(), minimalTrailer, { version: '1.7' }));

  it('🔴 writes entries of exactly 20 bytes', () => {
    // NOTE 1 of §7.5.4: the table "is the only part of a PDF file with a fixed
    // format, which permits entries in the table to be accessed randomly" —
    // the fixed width is load-bearing, not cosmetic.
    //
    // T-3: change the entry EOL to a single '\n' and this fails.
    const out = text();
    const start = out.indexOf('xref\n');
    const body = out.slice(out.indexOf('\n', start + 5) + 1, out.indexOf('trailer\n'));
    const entries = body.match(/.{20}/gs) ?? [];
    expect(body.length % 20).toBe(0);
    expect(entries).toHaveLength(4); // object 0 plus three objects
    for (const entry of entries) {
      expect(entry).toMatch(/^\d{10} \d{5} [nf] (\r|\n)$/);
    }
  });

  it('heads the free list with generation 65535 (§7.5.4)', () => {
    expect(text()).toContain('0000000000 65535 f \n');
  });

  it('declares one subsection covering 0..highest', () => {
    expect(text()).toContain('xref\n0 4\n');
  });

  it('🔴 writes a free entry for a gap so the table stays contiguous', () => {
    // §7.5.4: the table "shall contain one entry for each object number from 0
    // to the maximum object number defined in the PDF file, even if one or
    // more of the object numbers in this range do not actually occur". Gaps
    // arise here whenever a cross-reference or object stream was dropped
    // (ADR-0004 §4.2).
    //
    // T-3: skip absent numbers instead of writing a free entry and this fails,
    // because the entry count no longer matches the subsection header.
    const sparse = minimalObjects().filter((o) => o.objectNumber !== 2);
    const out = latin1(writeFile(sparse, minimalTrailer, { version: '1.7' }));
    expect(out).toContain('xref\n0 4\n');
    const body = out.slice(out.indexOf('xref\n0 4\n') + 9, out.indexOf('trailer\n'));
    expect(body.length).toBe(80);
    expect(body.match(/ f \n/g)).toHaveLength(2); // object 0 and the gap at 2
  });

  it('rejects object number 0 and duplicate numbers', () => {
    const zero = [{ ...minimalObjects()[0], objectNumber: 0 }] as WritableObject[];
    expect(() => writeFile(zero, minimalTrailer)).toThrow(/§7.5.4/);
    const twice = [minimalObjects()[0], minimalObjects()[0]] as WritableObject[];
    expect(() => writeFile(twice, minimalTrailer)).toThrow(/R-7.3.10-6/);
  });
});

describe('file trailer (§7.5.5)', () => {
  it('🔴 points startxref at the xref keyword', () => {
    // §7.5.5: startxref carries "the byte offset … to the beginning of the
    // xref keyword in the last cross-reference section".
    //
    // T-3: write `xrefOffset + 1` and this fails — as it did when tried
    // deliberately against the corpus, where every specimen stopped parsing.
    const out = latin1(writeFile(minimalObjects(), minimalTrailer, { version: '1.7' }));
    const declared = Number.parseInt(/startxref\n(\d+)\n/.exec(out)?.[1] ?? '-1', 10);
    expect(out.slice(declared, declared + 4)).toBe('xref');
  });

  it('ends with %%EOF on the last line', () => {
    expect(latin1(writeFile(minimalObjects(), minimalTrailer)).endsWith('\n%%EOF\n')).toBe(true);
  });

  it('recomputes /Size as one greater than the highest object number (Table 15)', () => {
    // Copying the source /Size would be copying a fact about a different file.
    const stale = dict([
      ['Root', { kind: 'ref', objectNumber: 1, generationNumber: 0 }],
      ['Size', { kind: 'integer', value: 999 }],
    ]);
    const out = latin1(writeFile(minimalObjects(), stale, { version: '1.7' }));
    expect(out).toContain('/Size 4');
    expect(out).not.toContain('/Size 999');
  });

  it('drops /Prev, which describes a file that no longer exists (Table 15)', () => {
    // Table 15: Prev is "present only if the file has more than one
    // cross-reference section". A full rewrite has exactly one.
    const withPrev = dict([
      ['Root', { kind: 'ref', objectNumber: 1, generationNumber: 0 }],
      ['Prev', { kind: 'integer', value: 4096 }],
    ]);
    expect(latin1(writeFile(minimalObjects(), withPrev))).not.toContain('/Prev');
  });

  it('🔴 drops the keys that belong to a cross-reference stream (§7.5.8.2 Table 17)', () => {
    // When the source used a cross-reference stream its stream dictionary
    // served as the trailer. Copying it wholesale would produce a classic
    // trailer carrying /W, /Index and a /Length describing bytes this file
    // does not have (ADR-0004 §4.3).
    //
    // T-3: empty XREF_STREAM_ONLY_KEYS and this fails.
    const streamTrailer = dict([
      ['Type', { kind: 'name', value: 'XRef' }],
      ['Root', { kind: 'ref', objectNumber: 1, generationNumber: 0 }],
      ['W', { kind: 'array', items: [{ kind: 'integer', value: 1 }] }],
      ['Index', { kind: 'array', items: [{ kind: 'integer', value: 0 }] }],
      ['Filter', { kind: 'name', value: 'FlateDecode' }],
      ['Length', { kind: 'integer', value: 123 }],
      ['ID', { kind: 'array', items: [] }],
    ]);
    const out = latin1(writeFile(minimalObjects(), streamTrailer, { version: '1.7' }));
    // Scoped to the trailer: /Type legitimately appears on the catalog, the
    // page tree and the page, so asserting over the whole file would fail on
    // the body rather than on what this test is about.
    const trailer = out.slice(out.indexOf('trailer\n'));
    for (const key of ['/Type', '/W', '/Index', '/Filter', '/Length']) {
      expect(trailer, `${key} shall not survive into a classic trailer`).not.toContain(`${key} `);
    }
    expect(trailer).toContain('/Root 1 0 R');
    expect(trailer).toContain('/ID');
  });
});

describe('deterministic output (DESIGN §4.1)', () => {
  it('produces identical bytes for the same input', () => {
    const a = writeFile(minimalObjects(), minimalTrailer, { version: '2.0' });
    const b = writeFile(minimalObjects(), minimalTrailer, { version: '2.0' });
    expect(latin1(a)).toBe(latin1(b));
  });

  it('does not invent an /ID', () => {
    // §7.5.5 Table 15 requires /ID in PDF 2.0, but inventing one would make
    // the output depend on something other than the input (DESIGN §4.1 lists
    // /ID as an injected value, not a generated one).
    expect(latin1(writeFile(minimalObjects(), minimalTrailer, { version: '2.0' }))).not.toContain(
      '/ID',
    );
  });
});

describe('the parser reads what the writer wrote (self-consistency only — GUARDS T-2)', () => {
  it('resolves the catalog through a written file', async () => {
    const bytes = writeFile(minimalObjects(), minimalTrailer, { version: '2.0' });
    const doc = await parsePdf(bytes);
    expect(doc.headerVersion).toBe('2.0');
    // Four entries, not three: object 0 is the head of the free list and
    // §7.5.4 requires it in the table.
    expect(doc.xref.size).toBe(4);
    expect(doc.xref.get(0)?.type).toBe('free');
    for (const number of [1, 2, 3]) {
      expect(doc.xref.get(number)?.type, `object ${number}`).toBe('in-use');
    }
    const catalog = await doc.getCatalog();
    expect(catalog.kind).toBe('dict');
  });

  it('carries a stream through unchanged', async () => {
    const raw = new Uint8Array([1, 2, 3, 0x0d, 0x0a, 255]);
    const objects: WritableObject[] = [
      ...minimalObjects(),
      {
        objectNumber: 4,
        generationNumber: 0,
        object: { kind: 'stream', dict: dict([]), raw },
      },
    ];
    const doc = await parsePdf(writeFile(objects, minimalTrailer, { version: '1.7' }));
    const back = await doc.getObject(4, 0);
    expect(back.kind).toBe('stream');
    if (back.kind !== 'stream') return;
    expect(Array.from(back.raw)).toEqual(Array.from(raw));
  });
});
