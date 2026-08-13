/**
 * Cross-reference stream and object stream writing (§7.5.7, §7.5.8).
 *
 * GUARDS T-2 as elsewhere: these read back with the same parser that wrote.
 * The outside opinion is `scripts/roundtrip-corpus.mjs --qpdf --mode stream`
 * (and `--mode objstm`), measured at 2,879/2,879 over the corpus with qpdf
 * introducing no complaint the source did not already have.
 */

import { describe, expect, it } from 'vitest';
import type { CosDict, CosObject } from '../src/cos/types.js';
import { dictGet } from '../src/cos/types.js';
import type { WritableObject } from '../src/index.js';
import { buildObjectStream, parsePdf, partitionForObjectStream, writeFile } from '../src/index.js';

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');
const dict = (entries: [string, CosObject][]): CosDict => ({
  kind: 'dict',
  entries: new Map(entries),
});
const ref = (n: number): CosObject => ({ kind: 'ref', objectNumber: n, generationNumber: 0 });
const nm = (v: string): CosObject => ({ kind: 'name', value: v });
const int = (v: number): CosObject => ({ kind: 'integer', value: v });

function baseObjects(): WritableObject[] {
  return [
    {
      objectNumber: 1,
      generationNumber: 0,
      object: dict([
        ['Type', nm('Catalog')],
        ['Pages', ref(2)],
      ]),
    },
    {
      objectNumber: 2,
      generationNumber: 0,
      object: dict([
        ['Type', nm('Pages')],
        ['Kids', { kind: 'array', items: [ref(3)] }],
        ['Count', int(1)],
      ]),
    },
    {
      objectNumber: 3,
      generationNumber: 0,
      object: dict([
        ['Type', nm('Page')],
        ['Parent', ref(2)],
      ]),
    },
  ];
}
const baseTrailer = dict([['Root', ref(1)]]);

describe('cross-reference stream output (§7.5.8)', () => {
  const written = () => writeFile(baseObjects(), baseTrailer, { version: '1.7', xref: 'stream' });

  it('🔴 stops using the xref and trailer keywords (R-7.5.8.1-3)', () => {
    // "For PDF files that use cross-reference streams entirely … the keywords
    // xref and trailer shall no longer be used." The stream dictionary is the
    // trailer.
    //
    // T-3: keep writing the classic tail and this fails.
    const text = latin1(written());
    expect(text).not.toContain('\nxref\n');
    expect(text).not.toContain('trailer\n');
    expect(text).toContain('/Type /XRef');
  });

  it('points startxref at the stream object, not at a keyword (R-7.5.8.1-2)', () => {
    const text = latin1(written());
    const at = Number.parseInt(/startxref\n(\d+)\n/.exec(text)?.[1] ?? '-1', 10);
    expect(text.slice(at)).toMatch(/^\d+ 0 obj/);
  });

  it('🔴 never carries an encoding key over from the source trailer', () => {
    // A source that used a cross-reference stream has /Filter in the very
    // dictionary that serves as its trailer. Copying it onto an unencoded
    // stream makes the file lie about its own bytes — measured at 487 of 2,879
    // corpus specimens before this exclusion existed, all of them reporting
    // "FlateDecode failed" on re-parse.
    //
    // T-3: drop Filter/DecodeParms from COMPUTED_KEYS and this fails.
    const source = dict([
      ['Root', ref(1)],
      ['Filter', nm('FlateDecode')],
      ['DecodeParms', dict([['Predictor', int(12)]])],
      ['Length', int(999)],
      ['W', { kind: 'array', items: [int(9)] }],
    ]);
    const text = latin1(writeFile(baseObjects(), source, { version: '1.7', xref: 'stream' }));
    expect(text).not.toContain('/Filter');
    expect(text).not.toContain('/DecodeParms');
    expect(text).not.toContain('/Length 999');
    expect(text).not.toContain('/W [9]');
  });

  it('writes W with a non-zero second element and a present type field (Table 17)', () => {
    // R-7.5.8.2-20: "A value of zero shall not be used for the second element."
    // R-7.5.8.2-21: a zero first element makes the type field absent and
    // default to 1, which cannot express free or compressed entries.
    const w = /\/W \[(\d+) (\d+) (\d+)\]/.exec(latin1(written()));
    expect(w).not.toBe(null);
    expect(Number(w?.[1])).toBeGreaterThan(0);
    expect(Number(w?.[2])).toBeGreaterThan(0);
  });

  it('reads back with every object resolvable', async () => {
    const doc = await parsePdf(written());
    for (const { objectNumber } of baseObjects()) {
      const object = await doc.getObject(objectNumber, 0);
      expect(object.kind, `object ${objectNumber}`).toBe('dict');
    }
    expect(dictGet(doc.trailer, 'Root')).toEqual(ref(1));
  });

  it('🔴 does not take an object number something already refers to', async () => {
    // A reference to a number no object occupies reads as null (R-7.3.10-13).
    // Creating the cross-reference stream at that number turns the dangling
    // reference into a live one pointing at this writer's bookkeeping —
    // measured on veraPDF-corpus "6-2-11-4-1-t01-fail-a.pdf", whose trailer
    // says /Info 21 0 R with nothing at 21.
    //
    // T-3: number the containers from the highest *defined* object and this
    // fails.
    const danglingTrailer = dict([
      ['Root', ref(1)],
      ['Info', ref(4)],
    ]);
    const doc = await parsePdf(
      writeFile(baseObjects(), danglingTrailer, { version: '1.7', xref: 'stream' }),
    );
    const info = dictGet(doc.trailer, 'Info');
    expect(info).toEqual(ref(4));
    // Object 4 shall still be absent — the reference stays dangling, as it was.
    expect((await doc.getObject(4, 0)).kind).toBe('null');
  });
});

describe('object stream output (§7.5.7)', () => {
  it('🔴 refuses the objects the clause excludes', () => {
    // "Stream objects", "Objects with a generation number other than zero",
    // "A document's encryption dictionary", and R-7.5.7-10's bare reference.
    const objects: WritableObject[] = [
      { objectNumber: 1, generationNumber: 0, object: dict([['Type', nm('Catalog')]]) },
      {
        objectNumber: 2,
        generationNumber: 0,
        object: { kind: 'stream', dict: dict([]), raw: new Uint8Array() },
      },
      { objectNumber: 3, generationNumber: 2, object: dict([['Gen', int(2)]]) },
      { objectNumber: 4, generationNumber: 0, object: ref(1) },
      { objectNumber: 5, generationNumber: 0, object: dict([['Encrypt', nm('here')]]) },
    ];
    const { compressible, plain } = partitionForObjectStream(objects, 5);
    expect(compressible.map((o) => o.objectNumber)).toEqual([1]);
    expect(plain.map((o) => o.objectNumber)).toEqual([2, 3, 4, 5]);
  });

  it('states N, First and offsets that increase (§7.5.7 Table 16)', () => {
    const { stream, placements } = buildObjectStream([
      { objectNumber: 7, generationNumber: 0, object: dict([['A', int(1)]]) },
      { objectNumber: 4, generationNumber: 0, object: dict([['B', int(2)]]) },
    ]);
    expect(stream.kind).toBe('stream');
    if (stream.kind !== 'stream') return;
    expect(dictGet(stream.dict, 'Type')).toEqual(nm('ObjStm'));
    expect(dictGet(stream.dict, 'N')).toEqual(int(2));
    // Placed in ascending object-number order (NOTE 6 leaves the order free;
    // a fixed one is what makes the output deterministic).
    expect(placements.map((p) => p.objectNumber)).toEqual([4, 7]);

    const text = latin1(stream.raw);
    const first = dictGet(stream.dict, 'First');
    expect(first?.kind).toBe('integer');
    if (first?.kind !== 'integer') return;
    // The pair list occupies everything before /First, and the offsets in it
    // shall increase.
    const pairs = text.slice(0, first.value).trim().split(/\s+/).map(Number);
    expect(pairs[0]).toBe(4);
    expect(pairs[2]).toBe(7);
    expect(pairs[3]).toBeGreaterThan(pairs[1]);
    // "Only the object values are stored in the stream; the obj and endobj
    // keywords shall not be used."
    expect(text).not.toContain('obj');
  });

  it('requires a cross-reference stream to address it (§7.5.7 NOTE 3)', () => {
    expect(() => writeFile(baseObjects(), baseTrailer, { objectStreams: true })).toThrow(/NOTE 3/);
  });

  it('reads compressed objects back through a type 2 entry', async () => {
    const doc = await parsePdf(
      writeFile(baseObjects(), baseTrailer, {
        version: '1.7',
        xref: 'stream',
        objectStreams: true,
      }),
    );
    expect(doc.xref.get(1)?.type).toBe('compressed');
    const catalog = await doc.getObject(1, 0);
    expect(catalog.kind).toBe('dict');
    if (catalog.kind !== 'dict') return;
    expect(dictGet(catalog, 'Type')).toEqual(nm('Catalog'));
  });
});

describe('deterministic output (DESIGN §4.1)', () => {
  it('produces identical bytes in every mode', () => {
    for (const options of [
      { xref: 'stream' as const },
      { xref: 'stream' as const, objectStreams: true },
    ]) {
      const a = writeFile(baseObjects(), baseTrailer, { version: '1.7', ...options });
      const b = writeFile(baseObjects(), baseTrailer, { version: '1.7', ...options });
      expect(latin1(a)).toBe(latin1(b));
    }
  });
});
