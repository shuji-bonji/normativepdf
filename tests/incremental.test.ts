/**
 * Incremental update tests (§7.5.6).
 *
 * The property under test is byte-level: the original contents shall be left
 * intact. That is checkable exactly, which makes these tests stronger than the
 * round-trip ones — there is no "equal enough" here.
 *
 * GUARDS T-2 still applies to everything *else* in the file (the chain is read
 * back with the same parser that wrote it). The independent measurements are
 * `qpdf --check` and pdf-verify-mcp `verify_signatures` on a real signed
 * specimen; see ADR-0005 §3.
 */

import { describe, expect, it } from 'vitest';
import type { CosDict, CosObject } from '../src/cos/types.js';
import { dictGet } from '../src/cos/types.js';
import type { WritableObject } from '../src/index.js';
import { appendUpdate, appendUpdateTo, parsePdf, readXrefChain, writeFile } from '../src/index.js';

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');

/**
 * The last cross-reference section as text.
 *
 * Anchored on the EOL before `xref` because `lastIndexOf('xref')` matches the
 * `startxref` keyword that follows it — which is how the first version of
 * these tests managed to assert against "xref\n355\n%%EOF".
 */
function lastSection(bytes: Uint8Array): string {
  const text = latin1(bytes);
  const at = text.lastIndexOf('\nxref\n');
  return at < 0 ? '' : text.slice(at + 1);
}
const dict = (entries: [string, CosObject][]): CosDict => ({ kind: 'dict', entries: new Map(entries) });
const ref = (n: number): CosObject => ({ kind: 'ref', objectNumber: n, generationNumber: 0 });
const nm = (v: string): CosObject => ({ kind: 'name', value: v });
const int = (v: number): CosObject => ({ kind: 'integer', value: v });

function baseObjects(): WritableObject[] {
  return [
    { objectNumber: 1, generationNumber: 0, object: dict([['Type', nm('Catalog')], ['Pages', ref(2)]]) },
    {
      objectNumber: 2,
      generationNumber: 0,
      object: dict([['Type', nm('Pages')], ['Kids', { kind: 'array', items: [ref(3)] }], ['Count', int(1)]]),
    },
    { objectNumber: 3, generationNumber: 0, object: dict([['Type', nm('Page')], ['Parent', ref(2)]]) },
  ];
}

const baseTrailer = dict([['Root', ref(1)], ['Info', ref(9)]]);

/** A one-revision file to update, plus the offsets an update needs. */
async function baseFile() {
  const bytes = writeFile(baseObjects(), baseTrailer, { version: '1.7' });
  const doc = await parsePdf(bytes);
  return { bytes, doc };
}

const annotation: WritableObject = {
  objectNumber: 4,
  generationNumber: 0,
  object: dict([['Type', nm('Annot')], ['Subtype', nm('Text')]]),
};

describe('the original contents are left intact (§7.5.6)', () => {
  it('🔴 copies every byte of the input through unchanged', async () => {
    // "changes shall be appended to the end of the file, leaving its original
    // contents intact" — and per §12.8.1 NOTE 1 this is what lets a signature
    // made before the update still verify after it.
    //
    // T-3: make appendUpdate rewrite anything before out.length === original
    // .length and this fails; the module also throws from its own guard.
    const { bytes, doc } = await baseFile();
    const { bytes: updated } = appendUpdateTo(doc, [annotation]);
    expect(updated.length).toBeGreaterThan(bytes.length);
    expect(Array.from(updated.slice(0, bytes.length))).toEqual(Array.from(bytes));
  });

  it('leaves the original %%EOF in place and adds its own (§7.5.6)', async () => {
    // "Each trailer shall be terminated by its own end-of-file (%%EOF) marker."
    const { bytes, doc } = await baseFile();
    const before = (latin1(bytes).match(/%%EOF/g) ?? []).length;
    const { bytes: updated } = appendUpdateTo(doc, [annotation]);
    expect((latin1(updated).match(/%%EOF/g) ?? []).length).toBe(before + 1);
  });

  it('starts the appended section on a new line when the original did not end with one', () => {
    const original = new TextEncoder().encode('%PDF-1.7\n%%EOF');
    const { bytes } = appendUpdate({
      original,
      previousXrefOffset: 0,
      previousTrailer: baseTrailer,
      objects: [annotation],
    });
    expect(latin1(bytes.slice(original.length, original.length + 1))).toBe('\n');
  });
});

describe('the update section (§7.5.4, §7.5.6)', () => {
  it('carries entries only for the objects it changed', async () => {
    const { doc } = await baseFile();
    const { bytes } = appendUpdateTo(doc, [annotation]);
    // One subsection, one entry — not a table covering 0..4.
    expect(lastSection(bytes)).toMatch(/^xref\n4 1\n\d{10} \d{5} n \n/);
  });

  it('🔴 splits non-contiguous object numbers into subsections (§7.5.4)', async () => {
    // "Each cross-reference subsection shall contain entries for a contiguous
    // range of object numbers." Changed objects are rarely contiguous.
    //
    // T-3: emit one subsection spanning min..max and this fails.
    const { doc } = await baseFile();
    const { bytes } = appendUpdateTo(doc, [
      annotation,
      { objectNumber: 9, generationNumber: 0, object: dict([['Type', nm('Info')]]) },
    ]);
    const tail = lastSection(bytes);
    expect(tail).toContain('4 1\n');
    expect(tail).toContain('9 1\n');
    expect(tail).not.toContain('4 6\n');
  });

  it('writes a deleted object as a free entry (§7.5.6)', async () => {
    // "Deleted objects shall be left unchanged in the PDF file, but shall be
    // marked as deleted by means of their cross-reference entries."
    const { doc } = await baseFile();
    const { bytes } = appendUpdateTo(doc, [annotation], [{ objectNumber: 3, generationNumber: 1 }]);
    expect(lastSection(bytes)).toContain('0000000000 00001 f \n');
  });

  it('refuses the object numbers an update may not write', async () => {
    const { doc } = await baseFile();
    // §7.5.4 NOTE 3: "cross reference subsections of incremental updates can
    // never have an object number of zero".
    expect(() => appendUpdateTo(doc, [{ ...annotation, objectNumber: 0 }])).toThrow(/NOTE 3/);
    expect(() => appendUpdateTo(doc, [annotation, annotation])).toThrow(/R-7.3.10-6/);
    expect(() => appendUpdateTo(doc, [])).toThrow(/§7.5.6/);
    expect(() => appendUpdateTo(doc, [annotation], [{ objectNumber: 4, generationNumber: 1 }])).toThrow(
      /both written and deleted/,
    );
  });
});

describe('the added trailer (§7.5.6, §7.5.5 Table 15)', () => {
  it('🔴 points /Prev at the previous cross-reference section', async () => {
    // T-3: omit Prev, or write the offset of this section instead of the
    // previous one, and the chain stops at one revision.
    const { bytes, doc } = await baseFile();
    const before = await readXrefChain(bytes);
    const { bytes: updated } = appendUpdateTo(doc, [annotation]);
    const after = await readXrefChain(updated);
    expect(after.sections).toHaveLength(before.sections.length + 1);
    expect(dictGet(after.sections[0].trailer, 'Prev')).toEqual({
      kind: 'integer',
      value: before.startxref,
    });
  });

  it('carries all entries from the previous trailer (§7.5.6)', async () => {
    // "The added trailer shall contain all the entries except the Prev entry
    // (if present) from the previous trailer, whether modified or not."
    const { bytes, doc } = await baseFile();
    const { bytes: updated } = appendUpdateTo(doc, [annotation]);
    const after = await readXrefChain(updated);
    expect(dictGet(after.sections[0].trailer, 'Root')).toEqual(ref(1));
    expect(dictGet(after.sections[0].trailer, 'Info')).toEqual(ref(9));
    expect(latin1(bytes)).toContain('/Info 9 0 R');
  });

  it('drops a /Prev inherited from the previous trailer rather than keeping both', () => {
    const previous = dict([['Root', ref(1)], ['Prev', int(111)], ['Size', int(4)]]);
    const { bytes } = appendUpdate({
      original: new TextEncoder().encode('%PDF-1.7\n%%EOF\n'),
      previousXrefOffset: 222,
      previousTrailer: previous,
      objects: [annotation],
    });
    const tail = latin1(bytes);
    expect(tail).toContain('/Prev 222');
    expect(tail).not.toContain('/Prev 111');
  });

  it('drops /XRefStm, which describes the previous section (§7.5.8.4 Table 19)', () => {
    const previous = dict([['Root', ref(1)], ['XRefStm', int(555)], ['Size', int(4)]]);
    const { bytes } = appendUpdate({
      original: new TextEncoder().encode('%PDF-1.7\n%%EOF\n'),
      previousXrefOffset: 222,
      previousTrailer: previous,
      objects: [annotation],
    });
    expect(latin1(bytes)).not.toContain('/XRefStm');
  });

  it('raises /Size for a new high object number and keeps it otherwise (Table 15)', () => {
    // Size counts "the combination of the original section and all update
    // sections", so it can rise but must not fall.
    const original = new TextEncoder().encode('%PDF-1.7\n%%EOF\n');
    const grow = appendUpdate({
      original,
      previousXrefOffset: 0,
      previousTrailer: dict([['Root', ref(1)], ['Size', int(4)]]),
      objects: [{ ...annotation, objectNumber: 99 }],
    });
    expect(latin1(grow.bytes)).toContain('/Size 100');

    const keep = appendUpdate({
      original,
      previousXrefOffset: 0,
      previousTrailer: dict([['Root', ref(1)], ['Size', int(500)]]),
      objects: [annotation],
    });
    expect(latin1(keep.bytes)).toContain('/Size 500');
  });
});

describe('offsets are measured from the header (§7.5.2)', () => {
  it('🔴 writes origin-relative offsets when bytes precede %PDF-', async () => {
    // A file may carry bytes before its header, and §7.5.2 measures every
    // offset from the PERCENT SIGN. Writing absolute offsets would point each
    // entry past its object — and the round-trip would not notice, because it
    // re-reads with the same origin.
    //
    // T-3: drop the `- origin` in appendUpdate and this fails.
    const plain = writeFile(baseObjects(), baseTrailer, { version: '1.7' });
    const lead = new TextEncoder().encode('%!PS-Adobe-3.0 leading bytes\n');
    const shifted = new Uint8Array(lead.length + plain.length);
    shifted.set(lead, 0);
    shifted.set(plain, lead.length);

    const doc = await parsePdf(shifted);
    expect(doc.origin).toBe(lead.length);
    const { bytes: updated } = appendUpdateTo(doc, [annotation]);

    const back = await parsePdf(updated);
    const added = await back.getObject(4, 0);
    expect(added.kind).toBe('dict');
    if (added.kind !== 'dict') return;
    expect(dictGet(added, 'Subtype')).toEqual(nm('Text'));
  });
});

describe('the newest copy of an object is the one that resolves (§7.5.6)', () => {
  it('returns the replacement, not the original', async () => {
    // "the most recent copy of each object shall be the one accessed".
    const { doc } = await baseFile();
    const { bytes } = appendUpdateTo(doc, [
      { objectNumber: 3, generationNumber: 0, object: dict([['Type', nm('Page')], ['Rotate', int(90)]]) },
    ]);
    const back = await parsePdf(bytes);
    const page = await back.getObject(3, 0);
    expect(page.kind).toBe('dict');
    if (page.kind !== 'dict') return;
    expect(dictGet(page, 'Rotate')).toEqual(int(90));
    // The original object is still in the file, untouched — only shadowed.
    expect(latin1(bytes).indexOf('/Parent 2 0 R')).toBeGreaterThan(-1);
  });
});
