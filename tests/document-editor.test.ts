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
import { checkPageTree, PdfDocumentEditor, parsePdf, rewrite } from '../src/index.js';
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
    const { bytes } = await editor.appendUpdate();
    expect(bytes.length).toBeGreaterThan(original.length);
    expect(bytes.slice(0, original.length)).toEqual(original);
  });

  it('the appended revision is what a reader sees, the previous one still serves the rest', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-3pages'));
    editor.set(3, name('Updated'));
    const read = await parsePdf((await editor.appendUpdate()).bytes);
    expect(await read.getObject(3)).toEqual(name('Updated'));
    expect((await read.getObject(4)).kind).toBe('dict'); // from the previous section
  });

  it('refuses to append a revision that changed nothing (§7.5.6)', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-1page'));
    await expect(editor.appendUpdate()).rejects.toThrow(/nothing was changed/);
  });

  it('an update written as a cross-reference stream reads back the same way', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-3pages'));
    editor.set(3, name('Updated'));
    const read = await parsePdf((await editor.appendUpdate({ xref: 'stream' })).bytes);
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

/**
 * The container reached from empty rather than from bytes.
 *
 * The generation path of a writer has no input file, so `open` cannot serve
 * it. What `create` has to produce is not "some PDF" but the exact state the
 * rest of this file already assumes: a catalog Table 29 accepts, a root page
 * node whose `/Count` already agrees with its `/Kids`, and a `/Size` that
 * `allocate` can use as its floor.
 */
describe('a document created from empty', () => {
  it('holds the two objects §7.7 requires before anything can be attached', async () => {
    const doc = PdfDocumentEditor.create();
    const catalog = await doc.getCatalog();
    expect(dictGet(catalog, 'Type')).toEqual(name('Catalog'));

    const pages = await doc.resolve(dictGet(catalog, 'Pages') as CosObject);
    expect(dictGet(pages, 'Type')).toEqual(name('Pages'));
    expect(dictGet(pages, 'Kids')).toEqual({ kind: 'array', items: [] });
    expect(dictGet(pages, 'Count')).toEqual({ kind: 'integer', value: 0 });
  });

  it('says it was not opened, so callers can tell the two apart', () => {
    expect(PdfDocumentEditor.create().opened).toBe(false);
  });

  it('starts with an empty tree that already satisfies §7.7.3', async () => {
    const doc = PdfDocumentEditor.create();
    const tree = await doc.pageTree();
    expect(tree.reached).toBe(true);
    expect(tree.pages).toEqual([]);
    expect(tree.nodes).toHaveLength(1);
    expect(await checkPageTree(doc, tree)).toEqual([]);
  });

  /**
   * The floor matters here for the same reason it matters on a truncated
   * history: `allocate` must not hand back a number something already holds.
   * On a created document the only holders are the catalog and the root node,
   * and they are in the overlay rather than in `xref`.
   */
  it('allocates above the catalog and the root page node', async () => {
    const doc = PdfDocumentEditor.create();
    expect((await doc.allocate({ kind: 'null' })).objectNumber).toBe(3);
    expect((await doc.allocate({ kind: 'null' })).objectNumber).toBe(4);
  });

  it('saves a file the parser reads back as a zero-page document', async () => {
    const bytes = await PdfDocumentEditor.create().save();
    const back = PdfDocumentEditor.of(await parsePdf(bytes));
    const tree = await back.pageTree();
    expect(tree.reached).toBe(true);
    expect(tree.pages).toEqual([]);
    expect(dictGet(await back.getCatalog(), 'Type')).toEqual(name('Catalog'));
  });

  it('writes the header version it was asked for (§7.5.2)', async () => {
    const header = (bytes: Uint8Array): string => new TextDecoder().decode(bytes.slice(0, 8));
    expect(header(await PdfDocumentEditor.create().save())).toBe('%PDF-1.7');
    expect(header(await PdfDocumentEditor.create({ version: '2.0' }).save())).toBe('%PDF-2.0');
  });

  it('refuses a header version §7.5.2 does not allow', () => {
    expect(() => PdfDocumentEditor.create({ version: '3.0' })).toThrow(RangeError);
    expect(() => PdfDocumentEditor.create({ version: '1.10' })).toThrow(RangeError);
  });

  /**
   * §7.5.6 defines an incremental update as a section appended to the file it
   * updates. There is no such file, so this is refused rather than producing
   * a revision appended to nothing.
   */
  it('refuses an incremental update, having no earlier bytes to append to', async () => {
    const doc = PdfDocumentEditor.create();
    doc.set(3, name('Anything'));
    await expect(doc.appendUpdate()).rejects.toThrow(/§7\.5\.6/);
  });

  /**
   * `/Info` and `/ID` live in the trailer (§7.5.5 Table 15), and a document
   * built from nothing has to write both — `/ID` is Required in PDF 2.0. L2
   * left the trailer alone because "load, change nothing, save" never needs it;
   * the generation path is what forced it.
   */
  it('writes a trailer entry into the saved file', async () => {
    const doc = PdfDocumentEditor.create();
    const infoRef = await doc.allocate({
      kind: 'dict',
      entries: new Map<string, CosObject>([['Producer', name('Test')]]),
    });
    doc.setTrailerEntry('Info', infoRef);

    const back = await parsePdf(await doc.save());
    const info = dictGet(back.trailer, 'Info');
    expect(info?.kind).toBe('ref');
    expect(
      dictGet(await back.getObject((info as { objectNumber: number }).objectNumber), 'Producer'),
    ).toEqual(name('Test'));
  });

  it('refuses the two entries the writer derives (§7.5.5 Table 15)', () => {
    const doc = PdfDocumentEditor.create();
    expect(() => doc.setTrailerEntry('Size', { kind: 'integer', value: 99 })).toThrow(RangeError);
    expect(() => doc.setTrailerEntry('Prev', { kind: 'integer', value: 0 })).toThrow(RangeError);
  });

  /**
   * PDF/A-4 6.1.3-4 forbids the document information dictionary, and a writer
   * that has only `setTrailerEntry` cannot express that: §7.3.7 makes a null
   * value *mean* absent, but the key is still in the bytes, and a checker that
   * asks whether `/Info` is present sees it. So removal is its own operation.
   */
  it('removes a trailer entry, and the key is gone from the saved bytes', async () => {
    const doc = PdfDocumentEditor.create();
    const infoRef = await doc.allocate({
      kind: 'dict',
      entries: new Map<string, CosObject>([['Producer', name('Test')]]),
    });
    doc.setTrailerEntry('Info', infoRef);
    expect(dictGet(doc.trailer(), 'Info')).toBeDefined();

    doc.removeTrailerEntry('Info');
    expect(dictGet(doc.trailer(), 'Info')).toBeUndefined();

    const bytes = await doc.save();
    const back = await parsePdf(bytes);
    expect(dictGet(back.trailer, 'Info')).toBeUndefined();
    // 🔴 the key itself, not just its value, is absent
    expect(new TextDecoder('latin1').decode(bytes)).not.toContain('/Info');
  });

  it('removes an entry that came from the file it opened', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-1page'));
    editor.setTrailerEntry('Info', name('x'));
    editor.removeTrailerEntry('Info');
    expect(dictGet(editor.trailer(), 'Info')).toBeUndefined();
    // setting it again after a removal brings it back — the two are one overlay
    editor.setTrailerEntry('Info', name('y'));
    expect(dictGet(editor.trailer(), 'Info')).toEqual(name('y'));
  });

  it('removing a key that is not there is not an error', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-1page'));
    expect(() => editor.removeTrailerEntry('NotThere')).not.toThrow();
  });

  it('refuses to remove the three entries a file cannot do without', () => {
    const doc = PdfDocumentEditor.create();
    expect(() => doc.removeTrailerEntry('Root')).toThrow(RangeError);
    expect(() => doc.removeTrailerEntry('Size')).toThrow(RangeError);
    expect(() => doc.removeTrailerEntry('Prev')).toThrow(RangeError);
  });

  it('reports a trailer removal as dirty', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-1page'));
    expect(editor.dirty).toBe(false);
    editor.removeTrailerEntry('Info');
    expect(editor.dirty).toBe(true);
  });

  it('reads the catalog through a replaced /Root', async () => {
    const doc = PdfDocumentEditor.create();
    const other = await doc.allocate({
      kind: 'dict',
      entries: new Map<string, CosObject>([
        ['Type', name('Catalog')],
        ['Pages', PdfDocumentEditor.rootPagesRef],
        ['Marker', name('Replaced')],
      ]),
    });
    doc.setTrailerEntry('Root', other);
    expect(dictGet(await doc.getCatalog(), 'Marker')).toEqual(name('Replaced'));
  });

  /**
   * `dirty` answers "was anything touched", and a trailer entry is something
   * touched — saying otherwise would be a small lie in the one place a caller
   * checks before deciding to write.
   *
   * 🔴 But an incremental update is refused all the same, and the two facts do
   * not contradict: §7.5.6 describes the appended section **by the objects it
   * names**, so a trailer edit on its own would append a section naming none.
   * That is a real state — replacing `/Root` or `/Info` with a reference to an
   * object that already exists changes no object — so it gets its own sentence
   * instead of falling through to "nothing was supplied" from two frames down.
   */
  it('reports a trailer-only change as dirty', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-1page'));
    expect(editor.dirty).toBe(false);
    editor.setTrailerEntry('Info', name('x'));
    expect(editor.dirty).toBe(true);
  });

  it('refuses an update that would name no objects, and says why', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-1page'));
    editor.setTrailerEntry('Info', name('x'));
    await expect(editor.appendUpdate()).rejects.toThrow(/only trailer entries were set/);
  });

  it('carries the trailer edit when the update also writes an object', async () => {
    const editor = await PdfDocumentEditor.open(fixture('flat-1page'));
    const info = await editor.allocate({
      kind: 'dict',
      entries: new Map<string, CosObject>([['Producer', name('Appended')]]),
    });
    editor.setTrailerEntry('Info', info);

    const back = await parsePdf((await editor.appendUpdate()).bytes);
    const ref = dictGet(back.trailer, 'Info');
    expect(ref?.kind).toBe('ref');
    expect(
      dictGet(await back.getObject((ref as { objectNumber: number }).objectNumber), 'Producer'),
    ).toEqual(name('Appended'));
  });

  it('carries an added page through save, with /Count recomputed', async () => {
    const doc = PdfDocumentEditor.create();
    const pagesRef = PdfDocumentEditor.rootPagesRef;
    const pageRef = await doc.allocate({
      kind: 'dict',
      entries: new Map<string, CosObject>([
        ['Type', name('Page')],
        ['Parent', pagesRef],
        ['Resources', { kind: 'dict', entries: new Map() }],
        [
          'MediaBox',
          {
            kind: 'array',
            items: [
              { kind: 'integer', value: 0 },
              { kind: 'integer', value: 0 },
              { kind: 'integer', value: 595 },
              { kind: 'integer', value: 842 },
            ],
          },
        ],
      ]),
    });
    // /Count is left at 0 on purpose: R-7.7.3.2-8 makes keeping it right the
    // writer's job, so the container has to fix it rather than the caller.
    doc.set(pagesRef.objectNumber, {
      kind: 'dict',
      entries: new Map<string, CosObject>([
        ['Type', name('Pages')],
        ['Kids', { kind: 'array', items: [pageRef] }],
        ['Count', { kind: 'integer', value: 0 }],
      ]),
    });

    const back = PdfDocumentEditor.of(await parsePdf(await doc.save()));
    const tree = await back.pageTree();
    expect(tree.pages).toHaveLength(1);
    const root = await back.resolve(dictGet(await back.getCatalog(), 'Pages') as CosObject);
    expect(dictGet(root, 'Count')).toEqual({ kind: 'integer', value: 1 });
  });
});
