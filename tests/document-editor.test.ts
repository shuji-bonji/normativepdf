/**
 * The editable document (§7.5.6, §7.3.10).
 *
 * The acceptance for this layer is that reading a file and writing it back
 * unchanged produces what the existing round-trip gate already measures, so
 * the corpus keeps its meaning. That equivalence is asserted over specimens
 * here and was measured over the whole corpus separately: `open → save` is
 * byte-identical to `rewrite` for all 2,890 readable files (2026-08-14).
 */

import { describe, expect, it } from 'vitest';
import type { CosObject } from '../src/cos/types.js';
import { dictGet } from '../src/cos/types.js';
import { PdfDocumentEditor, parsePdf, rewrite } from '../src/index.js';
import { buildPdf, obj } from './helpers/build-pdf.js';
import { PAGE_TREES } from './helpers/page-trees.js';

const fixture = (id: string): Uint8Array => {
  const found = PAGE_TREES.find((f) => f.id === id);
  if (found === undefined) throw new Error(`fixture ${id} is missing`);
  return found.bytes;
};

const name = (value: string): CosObject => ({ kind: 'name', value });

describe('an unchanged document writes back exactly as the round-trip gate writes it', () => {
  for (const f of PAGE_TREES) {
    it(f.id, async () => {
      const viaGate = await rewrite(await parsePdf(f.bytes));
      const viaEditor = await (await PdfDocumentEditor.open(f.bytes)).save();
      expect(viaEditor).toEqual(viaGate);
    });
  }
});

describe('the overlay holds only what was touched', () => {
  it('reports nothing changed until something is set', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-1page'));
    expect(editor.dirty).toBe(false);
    expect(editor.changed()).toEqual([]);
    expect(editor.deleted()).toEqual([]);
  });

  it('reads a replaced object back and leaves the rest to the file', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-3pages'));
    const before = await editor.get(3);
    expect(before.kind).toBe('dict');

    editor.set(3, name('Replaced'));
    expect(await editor.get(3)).toEqual(name('Replaced'));
    expect((await editor.get(4)).kind).toBe('dict'); // untouched, still from the file
    expect(editor.changed().map((o) => o.objectNumber)).toEqual([3]);
  });

  it('a deleted object reads as null, which is what a free entry means (§7.3.10)', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-3pages'));
    editor.delete(5);
    expect(await editor.get(5)).toEqual({ kind: 'null' });
    expect(editor.deleted()).toEqual([{ objectNumber: 5, generationNumber: 1 }]);
  });

  it('deleting increments the generation to record, as §7.5.4 requires', async () => {
    const editor = await PdfDocumentEditor.open(fixture('gen-nonzero'));
    editor.delete(3, 4);
    expect(editor.deleted()).toEqual([{ objectNumber: 3, generationNumber: 5 }]);
  });

  it('setting after deleting replaces rather than leaving both records', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-3pages'));
    editor.delete(5);
    editor.set(5, name('Back'));
    expect(editor.deleted()).toEqual([]);
    expect(await editor.get(5)).toEqual(name('Back'));
  });

  it('refuses object number 0 (§7.3.10)', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-1page'));
    expect(() => editor.set(0, name('X'))).toThrow(/positive/);
  });
});

describe('the overlay is keyed by number and generation together', () => {
  // The corpus holds twelve in-use entries at generations 1 to 6 across two
  // specimens, and no page tree reference at a non-zero generation at all — so
  // a number-only key passes every page-tree test and is still wrong.
  it('a value set at generation 4 does not appear at generation 0', async () => {
    const editor = await PdfDocumentEditor.open(fixture('gen-nonzero'));
    editor.set(3, name('AtFour'), 4);
    expect(await editor.get(3, 4)).toEqual(name('AtFour'));
    expect(await editor.get(3, 0)).toEqual({ kind: 'null' }); // no such object in the file
  });

  it('deleting generation 4 does not silence generation 0', async () => {
    const editor = await PdfDocumentEditor.open(fixture('gen-nonzero'));
    editor.delete(3, 4);
    expect(await editor.get(3, 4)).toEqual({ kind: 'null' });
    expect(editor.deleted()).toEqual([{ objectNumber: 3, generationNumber: 5 }]);
  });
});

describe('allocate clears references, not just definitions', () => {
  it('takes the next free number in an ordinary file', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-1page'));
    const ref = await editor.allocate(name('New'));
    expect(ref).toEqual({ kind: 'ref', objectNumber: 4, generationNumber: 0 });
    expect(await editor.get(4)).toEqual(name('New'));
  });

  it('skips a number that is referenced but never defined', async () => {
    // The shape of veraPDF-corpus 6-2-11-4-1-t01-fail-a.pdf, which refers to
    // object 21 while defining up to 20: giving 21 to something new makes the
    // dangling reference resolve to it. pdf-writer-mcp shipped that rule once
    // and qpdf answered "operation for dictionary attempted on object of type
    // stream".
    const bytes = buildPdf([
      obj(1, '<< /Type /Catalog /Pages 2 0 R /Info 4 0 R >>'), // 4 is never defined
      obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
      obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>'),
    ]).bytes;
    const editor = await PdfDocumentEditor.open(bytes);
    const ref = await editor.allocate(name('New'));
    expect(ref.objectNumber).toBe(5); // not 4
  });

  it('gives out a different number each time', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-1page'));
    const a = await editor.allocate(name('A'));
    const b = await editor.allocate(name('B'));
    expect(a.objectNumber).not.toBe(b.objectNumber);
    expect(await editor.get(b.objectNumber)).toEqual(name('B'));
  });
});

describe('the two exits', () => {
  it('save carries a replacement into the written file', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-3pages'));
    editor.set(3, name('Replaced'));
    const written = await parsePdf(await editor.save());
    expect(await written.getObject(3)).toEqual(name('Replaced'));
    expect((await written.getObject(4)).kind).toBe('dict');
  });

  it('save drops a deleted object', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-3pages'));
    editor.delete(5);
    const written = await parsePdf(await editor.save());
    expect(await written.getObject(5)).toEqual({ kind: 'null' });
  });

  it('appendUpdate leaves the original bytes in place (ADR-0005 step 1)', async () => {
    const original = fixture('flat-3pages');
    const editor = await PdfDocumentEditor.open(original);
    editor.set(3, name('Updated'));
    const { bytes } = editor.appendUpdate();
    expect(bytes.length).toBeGreaterThan(original.length);
    expect(bytes.slice(0, original.length)).toEqual(original);
  });

  it('the appended revision is what a reader sees, the previous one still serves the rest', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-3pages'));
    editor.set(3, name('Updated'));
    const read = await parsePdf(editor.appendUpdate().bytes);
    expect(await read.getObject(3)).toEqual(name('Updated'));
    expect((await read.getObject(4)).kind).toBe('dict'); // from the previous section
  });

  it('refuses to append a revision that changed nothing (§7.5.6)', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-1page'));
    expect(() => editor.appendUpdate()).toThrow(/nothing was changed/);
  });

  it('an update written as a cross-reference stream reads back the same way', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-3pages'));
    editor.set(3, name('Updated'));
    const read = await parsePdf(editor.appendUpdate({ xref: 'stream' }).bytes);
    expect(await read.getObject(3)).toEqual(name('Updated'));
  });
});

describe('reading through the overlay', () => {
  it('resolve follows a reference into the overlay', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-1page'));
    editor.set(3, name('Replaced'));
    const root = await editor.resolve(dictGet(await editor.getCatalog(), 'Pages') as CosObject);
    const kids = await editor.resolve(dictGet(root, 'Kids') as CosObject);
    expect(kids.kind).toBe('array');
    if (kids.kind !== 'array') return;
    expect(await editor.resolve(kids.items[0] as CosObject)).toEqual(name('Replaced'));
  });

  it('resolve passes a direct value through untouched', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-1page'));
    expect(await editor.resolve(name('Direct'))).toEqual(name('Direct'));
  });
});
