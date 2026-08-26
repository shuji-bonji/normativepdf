/**
 * Incremental update (§7.5.6): change a document by appending to it, never
 * rewriting what is already there. The original bytes stay byte-identical
 * at the front of the file — which is what keeps an existing digital
 * signature's byte range intact.
 *
 * Here: give the page an annotation. Two objects change — the annotation
 * is new (object 6), and the page (object 3) must point at it — so the
 * appended section carries exactly those two, plus a new cross-reference
 * section whose /Prev points back at the original one.
 */

import { type CosObject, type WritableObject, appendUpdateTo, parsePdf } from 'normativepdf';
import { bytes as original } from './01-build-a-minimal-pdf.mts';

const name = (value: string): CosObject => ({ kind: 'name', value });
const int = (value: number): CosObject => ({ kind: 'integer', value });
const ref = (objectNumber: number): CosObject => ({ kind: 'ref', objectNumber, generationNumber: 0 });

const doc = await parsePdf(original);

// The changed page: same dictionary as before, plus /Annots.
const page = await doc.getObject(3);
if (page.kind !== 'dict') throw new Error('page shall be a dictionary');
const updatedPage: WritableObject = {
  objectNumber: 3,
  generationNumber: 0,
  object: { kind: 'dict', entries: new Map(page.entries).set('Annots', { kind: 'array', items: [ref(6)] }) },
};

const annotation: WritableObject = {
  objectNumber: 6,
  generationNumber: 0,
  object: {
    kind: 'dict',
    entries: new Map<string, CosObject>([
      ['Type', name('Annot')],
      ['Subtype', name('Text')],
      [
        'Rect',
        { kind: 'array', items: [int(72), int(680), int(100), int(700)] },
      ],
      [
        'Contents',
        { kind: 'string', bytes: new TextEncoder().encode('added incrementally'), form: 'literal' },
      ],
    ]),
  },
};

const { bytes: updated } = appendUpdateTo(doc, [updatedPage, annotation]);

// The original file is still there, untouched, at the front.
if (new TextDecoder('latin1').decode(updated.slice(0, original.length)) !==
    new TextDecoder('latin1').decode(original)) {
  throw new Error('an incremental update shall not rewrite the original bytes');
}

// Reading the updated file resolves object 3 to the NEW page — the merged
// cross-reference table prefers the newest section (§7.5.4).
const reread = await parsePdf(updated);
const rereadPage = await reread.getObject(3);
const hasAnnots = rereadPage.kind === 'dict' && rereadPage.entries.has('Annots');

export { updated, hasAnnots };
