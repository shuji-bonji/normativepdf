/**
 * Files whose `/Prev` chain cannot be walked to the end (§7.5.6).
 *
 * The parser used to refuse these outright, which refused files that are
 * perfectly appendable; swallowing the break instead would report a document
 * with no history at all. Both answers are wrong in the same place, so the
 * reason travels with the result and the two exits diverge: appending leaves
 * every earlier revision byte for byte, rewriting would emit only the objects
 * that were found.
 *
 * Measured on `docs/specimens/dss-pades-5sigs-doctimestamp.pdf` (six
 * signatures, `/Prev 0`, 2026-08-14): opening now succeeds, appending keeps
 * every signature at the verdict it already had — Signature1 was INVALID in
 * the input too, for a revoked certificate — and the only change is that the
 * document timestamp stops covering the whole file, which is what appending a
 * revision means.
 */

import { describe, expect, it } from 'vitest';
import {
  PdfDocumentEditor,
  parsePdf,
  readXrefChain,
  rewrite,
  TruncatedHistoryError,
} from '../src/index.js';
import { buildPdf, obj } from './helpers/build-pdf.js';

const enc = (s: string) => new TextEncoder().encode(s);
const CATALOG = obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
const NODE = obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
const PAGE = obj(3, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> >>');

/**
 * A file whose newest section reads and whose `/Prev` points at `prev`.
 * `/Prev 0` is the shape the five-signature specimen has; §7.5.2 puts the
 * header at the origin, so nothing addresses a section there.
 */
function withPrev(prev: number): Uint8Array {
  const base = buildPdf([CATALOG, NODE, PAGE]);
  const updated =
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << >> >> endobj\n';
  const objOffset = base.text.length;
  const xrefOffset = objOffset + updated.length;
  const update =
    `${updated}xref\n3 1\n${String(objOffset).padStart(10, '0')} 00000 n \n` +
    `trailer\n<< /Size 4 /Root 1 0 R /Prev ${prev} >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;
  return enc(base.text + update);
}

describe('the walk reports why it stopped, in three kinds (§7.5.6)', () => {
  it('a trailer with no /Prev is complete', async () => {
    const chain = await readXrefChain(buildPdf([CATALOG, NODE, PAGE]).bytes);
    expect(chain.stop).toEqual({ kind: 'complete' });
    expect(chain.sections.length).toBe(1);
  });

  it('a chain that was walked to the end is complete even with several sections', async () => {
    const base = buildPdf([CATALOG, NODE, PAGE]);
    const chain = await readXrefChain(withPrev(base.xrefOffset));
    expect(chain.stop).toEqual({ kind: 'complete' });
    expect(chain.sections.length).toBe(2);
  });

  it('/Prev 0 stops the walk and says so, rather than passing for the end', async () => {
    const chain = await readXrefChain(withPrev(0));
    expect(chain.stop.kind).toBe('prev-zero');
    expect(chain.sections.length).toBe(1); // the newest section was read
  });

  it('/Prev pointing at something that is not a section stops the walk', async () => {
    const chain = await readXrefChain(withPrev(12));
    expect(chain.stop.kind).toBe('unreadable');
    expect(chain.sections.length).toBe(1);
  });

  it('the newest section failing is still an error — there would be no document', async () => {
    const broken = enc('%PDF-1.7\n1 0 obj << >> endobj\nstartxref\n9\n%%EOF\n');
    await expect(parsePdf(broken)).rejects.toThrow();
  });
});

describe('a truncated history reaches the document, and the exits diverge', () => {
  it('opens, and carries the reason on the document', async () => {
    const editor = await PdfDocumentEditor.open(withPrev(0));
    expect(editor.base.chainStop.kind).toBe('prev-zero');
  });

  it('refuses a whole-file rewrite, because the unread revisions would be dropped', async () => {
    const editor = await PdfDocumentEditor.open(withPrev(0));
    await expect(editor.save()).rejects.toThrow(TruncatedHistoryError);
  });

  it('refuses the round-trip helper for the same reason', async () => {
    await expect(rewrite(await parsePdf(withPrev(0)))).rejects.toThrow(TruncatedHistoryError);
  });

  it('allows an incremental update, which leaves the earlier revisions alone', async () => {
    const original = withPrev(0);
    const editor = await PdfDocumentEditor.open(original);
    editor.set(3, { kind: 'name', value: 'Replaced' });
    const { bytes } = await editor.appendUpdate();
    expect(bytes.slice(0, original.length)).toEqual(original);
  });
});

describe('allocate trusts /Size, not what was read (§7.5.5 Table 15)', () => {
  // Table 15 defines /Size over the whole file — every revision, including
  // the ones this parser could not reach. On the five-signature specimen the
  // newest section names eight objects while /Size is 154: taking the highest
  // that was *read* hands out object 3, which an unread revision defines, and
  // the update then replaces it without saying so.
  it('starts above /Size when the history is truncated', async () => {
    const bytes = withPrev(0); // /Size 4, but the newest section names only 3
    const editor = await PdfDocumentEditor.open(bytes);
    const ref = await editor.allocate({ kind: 'null' });
    expect(ref.objectNumber).toBeGreaterThanOrEqual(4);
  });

  it('still takes the next number on a file whose history is complete', async () => {
    const editor = await PdfDocumentEditor.open(buildPdf([CATALOG, NODE, PAGE]).bytes);
    expect((await editor.allocate({ kind: 'null' })).objectNumber).toBe(4);
  });
});
