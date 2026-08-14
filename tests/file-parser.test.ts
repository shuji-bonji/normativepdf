/**
 * File-structure tests (§7.5). The fixture builder lives in
 * `helpers/build-pdf.ts` — it is shared with the page-tree fixtures, which
 * need object numbers that do not follow the order the objects are written in.
 */

import { describe, expect, it } from 'vitest';
import { dictGet } from '../src/cos/types.js';
import { parsePdf, rewrite, TruncatedHistoryError } from '../src/index.js';
import { buildPdf } from './helpers/build-pdf.js';

const enc = (s: string) => new TextEncoder().encode(s);
const pad = (n: number, w: number) => n.toString().padStart(w, '0');

const CATALOG = '1 0 obj << /Type /Catalog >> endobj\n';
const STRING_OBJ = '2 0 obj (Brillig) endobj\n';

describe('minimal file (§7.5.2, §7.5.4, §7.5.5)', () => {
  it('parses header version, resolves the catalog, and fetches objects', async () => {
    const doc = await parsePdf(buildPdf([CATALOG, STRING_OBJ]).bytes);
    expect(doc.version).toBe('1.7');
    const catalog = await doc.getCatalog();
    expect(catalog.kind).toBe('dict');
    if (catalog.kind !== 'dict') return;
    expect(dictGet(catalog, 'Type')).toEqual({ kind: 'name', value: 'Catalog' });

    const s = await doc.getObject(2, 0);
    expect(s.kind).toBe('string');
    if (s.kind !== 'string') return;
    expect(new TextDecoder().decode(s.bytes)).toBe('Brillig');
  });

  it('accepts a 2.0 header', async () => {
    const doc = await parsePdf(buildPdf([CATALOG], { header: '%PDF-2.0\n' }).bytes);
    expect(doc.version).toBe('2.0');
  });

  it('rejects a header that is not %PDF-1.n / %PDF-2.n (§7.5.2, 2020 rule)', async () => {
    await expect(parsePdf(buildPdf([CATALOG], { header: '%PDF-3.0\n' }).bytes)).rejects.toThrow(
      /§7\.5\.2/,
    );
  });
});

describe('offsets are calculated from the PERCENT SIGN (§7.5.2)', () => {
  it('parses a file whose PDF data does not start at byte 0 (corpus: offset start)', async () => {
    const junk = 'JUNK BYTES BEFORE THE HEADER  \n';
    const doc = await parsePdf(buildPdf([CATALOG, STRING_OBJ], { junkBefore: junk }).bytes);
    expect(doc.origin).toBe(enc(junk).length);
    expect((await doc.getObject(2, 0)).kind).toBe('string');
  });
});

describe('xref entry format (§7.5.4: exactly 20 bytes)', () => {
  it.each([
    [' \r', 'SP CR'],
    [' \n', 'SP LF'],
    ['\r\n', 'CR LF'],
  ])('accepts the %s (%s) entry EOL', async (eol) => {
    expect((await parsePdf(buildPdf([CATALOG], { entryEol: eol }).bytes)).version).toBe('1.7');
  });

  it('rejects any other 2-character ending (LF LF)', async () => {
    await expect(parsePdf(buildPdf([CATALOG], { entryEol: '\n\n' }).bytes)).rejects.toThrow(
      /§7\.5\.4/,
    );
  });

  it('rejects a 19-byte entry (single-char EOL)', async () => {
    await expect(parsePdf(buildPdf([CATALOG], { entryEol: '\n' }).bytes)).rejects.toThrow(
      /§7\.5\.4/,
    );
  });

  it('accepts a free-list head whose generation is not 65535 — R-7.5.4-31 is conformance, not function (veraPDF-corpus TWG A029-pdfa2-pass-b/-d)', async () => {
    const b = buildPdf([CATALOG]);
    const deviant = b.text.replace('0000000000 65535 f', '0000000019 00000 f');
    const doc = await parsePdf(enc(deviant));
    expect(doc.xref.get(0)).toEqual({ type: 'free', nextFree: 19, generation: 0 });
    expect((await doc.getCatalog()).kind).toBe('dict');
  });

  it('upgrades the version from a later catalog /Version (§7.7.2 Table 29; incremental-update mechanism of §7.5.2 NOTE 3)', async () => {
    const doc = await parsePdf(
      buildPdf(['1 0 obj << /Type /Catalog /Version /2.0 >> endobj\n']).bytes,
    );
    expect(doc.headerVersion).toBe('1.7');
    expect(doc.version).toBe('2.0');
  });

  it('keeps the header version when it is later than the catalog /Version (Table 29: "the header specifies a later version")', async () => {
    const doc = await parsePdf(
      buildPdf(['1 0 obj << /Type /Catalog /Version /1.4 >> endobj\n'], {
        header: '%PDF-2.0\n',
      }).bytes,
    );
    expect(doc.headerVersion).toBe('2.0');
    expect(doc.version).toBe('2.0');
  });

  it('rejects a catalog /Version that is not a name (Table 29: "shall be a name object, not a number")', async () => {
    await expect(
      parsePdf(buildPdf(['1 0 obj << /Type /Catalog /Version 2.0 >> endobj\n']).bytes),
    ).rejects.toThrow(/Table 29/);
  });

  it('accepts a startxref that points at the EOL just before the xref keyword (measured: veraPDF-corpus 6-6-2-3-2-t01-pass-c)', async () => {
    const b = buildPdf([CATALOG]);
    // Point startxref one byte early, at the EOL preceding `xref`. The
    // builder places `xref` at a known offset; recompute it from the text.
    const at = b.text.indexOf('xref\n');
    const early = b.text.replace(/startxref\n\d+\n/, `startxref\n${at - 1}\n`);
    expect((await parsePdf(enc(early))).version).toBe('1.7');
  });
});

describe('resolution rules (§7.3.10, §7.5.4, Table 15)', () => {
  it('reads an undefined object as null (R-7.3.10-13)', async () => {
    const doc = await parsePdf(buildPdf([CATALOG]).bytes);
    expect(await doc.getObject(99, 0)).toEqual({ kind: 'null' });
  });

  it('reads a generation mismatch as null (R-7.3.10-6: the pair identifies the object)', async () => {
    const doc = await parsePdf(buildPdf([CATALOG, STRING_OBJ]).bytes);
    expect(await doc.getObject(2, 1)).toEqual({ kind: 'null' });
  });

  it('errors when the xref offset points at a different object definition (§7.5.4)', async () => {
    const b = buildPdf([CATALOG, STRING_OBJ]);
    // Point object 2 at object 1's definition.
    const off1 = b.objectOffsets[0];
    const off2 = b.objectOffsets[1];
    if (off1 === undefined || off2 === undefined) throw new Error('fixture');
    const broken = b.text.replace(`${pad(off2, 10)} 00000 n`, `${pad(off1, 10)} 00000 n`);
    const doc = await parsePdf(enc(broken));
    await expect(doc.getObject(2, 0)).rejects.toThrow(/§7\.5\.4/);
  });

  it('ignores entries with object numbers greater than Size — literally (Table 15)', async () => {
    // Table 15: "Any object ... whose number is greater than this value
    // shall be ignored". With Size = 1: entry 2 (> Size) is ignored;
    // entry 1 (== Size) is the boundary — the clause says "greater
    // than", so it is kept. Whether Size itself is correct (it shall be
    // 1 greater than the highest object number) is a conformance matter
    // for pdf-verify, not a reading rule for this parser.
    const b = buildPdf([CATALOG, STRING_OBJ], {
      trailerSource: () => 'trailer\n<< /Size 1 /Root 1 0 R >>\n',
    });
    const doc = await parsePdf(b.bytes);
    expect(await doc.getObject(2, 0)).toEqual({ kind: 'null' }); // 2 > 1 → missing
    expect((await doc.getObject(1, 0)).kind).toBe('dict'); // 1 == Size → not "greater than"
  });
});

describe('incremental update chain (§7.5.4, §7.5.6, Table 15 Prev)', () => {
  function withUpdate(): { bytes: Uint8Array } {
    const base = buildPdf([CATALOG, STRING_OBJ]);
    const updatedObj = '2 0 obj (Updated) endobj\n';
    const updObjOffset = base.text.length; // relative == absolute (no junk)
    const updXrefOffset = updObjOffset + updatedObj.length;
    const upd =
      `${updatedObj}xref\n2 1\n${pad(updObjOffset, 10)} ${pad(0, 5)} n \n` +
      `trailer\n<< /Size 3 /Root 1 0 R /Prev ${base.xrefOffset} >>\n` +
      `startxref\n${updXrefOffset}\n%%EOF\n`;
    return { bytes: enc(base.text + upd) };
  }

  it('the newest section wins for updated objects; older sections still serve the rest', async () => {
    const doc = await parsePdf(withUpdate().bytes);
    const s = await doc.getObject(2, 0);
    expect(s.kind).toBe('string');
    if (s.kind !== 'string') return;
    expect(new TextDecoder().decode(s.bytes)).toBe('Updated'); // newest wins
    expect((await doc.getObject(1, 0)).kind).toBe('dict'); // from the previous section
  });
});

describe('streams resolved through the document (§7.3.10 EXAMPLE 3 end-to-end)', () => {
  it('resolves an indirect /Length through the cross-reference table', async () => {
    const body = 'Hello';
    const streamObj = `2 0 obj << /Length 3 0 R >> stream\n${body}\nendstream endobj\n`;
    const lengthObj = `3 0 obj ${body.length} endobj\n`;
    const doc = await parsePdf(buildPdf([CATALOG, streamObj, lengthObj]).bytes);
    const s = await doc.getObject(2, 0);
    expect(s.kind).toBe('stream');
    if (s.kind !== 'stream') return;
    expect(new TextDecoder().decode(s.raw)).toBe(body);
  });
});

describe('tail structure (§7.5.5)', () => {
  it('rejects a missing %%EOF', async () => {
    const b = buildPdf([CATALOG], { tailSource: (sx) => `startxref\n${sx}\n` });
    await expect(parsePdf(b.bytes)).rejects.toThrow(/%%EOF/);
  });

  it('rejects a missing startxref', async () => {
    const b = buildPdf([CATALOG], { tailSource: () => '%%EOF\n' });
    await expect(parsePdf(b.bytes)).rejects.toThrow(/startxref/);
  });

  it('🔴 accepts bytes after %%EOF — a conformance rule, not a functional one (§7.5.5)', async () => {
    // "The last line of the file shall contain only the end-of-file marker,
    // %%EOF" — so trailing bytes violate the clause. This parser does not
    // enforce it, on the same grounds as R-7.5.4-31: nothing about locating
    // `startxref` depends on what follows %%EOF, so the file still functions.
    // Whether it *conforms* is pdf-verify-mcp's verdict (DESIGN §4.2).
    //
    // Two specimens forced this: veraPDF-corpus "6-1-3-t03-fail-a.pdf" and its
    // Isartor twin, which end `%%EOF\nSomeData` and which qpdf reads without
    // complaint. The demand was confirmed by the second consumer —
    // pdf-writer-mcp's incremental fixtures put a marker comment after %%EOF,
    // and enforcing the rule broke 13 of its tests.
    //
    // T-3: restore the `if (!cur.atEnd) throw` in readStartxref and this fails.
    const b = buildPdf([CATALOG]);
    const withTrailing = new Uint8Array([...b.bytes, ...enc('SomeData')]);
    const doc = await parsePdf(withTrailing);
    expect((await doc.getCatalog()).kind).toBe('dict');
  });

  it('accepts white-space between the last entry and trailer (§7.2.3; the PDF Association incremental-save example has a blank line there)', async () => {
    const b = buildPdf([CATALOG, STRING_OBJ]);
    const spaced = b.text.replace('trailer\n', '\r\n\ntrailer\n');
    const doc = await parsePdf(enc(spaced));
    expect((await doc.getObject(2, 0)).kind).toBe('string');
  });

  it('rejects a comment between xref and trailer (§7.5.4, 2020 clarification)', async () => {
    const b = buildPdf([CATALOG]);
    const broken = b.text.replace('trailer\n', '%comment\ntrailer\n');
    await expect(parsePdf(enc(broken))).rejects.toThrow(/comments are not permitted/);
  });

  it('rejects a missing Size (Table 15)', async () => {
    const b = buildPdf([CATALOG], {
      trailerSource: () => 'trailer\n<< /Root 1 0 R >>\n',
    });
    await expect(parsePdf(b.bytes)).rejects.toThrow(/Size/);
  });

  it('rejects a startxref pointing at an object that is not a cross-reference stream (§7.5.8)', async () => {
    // startxref pointing at the catalog object: it parses as an indirect
    // object, but it is a dictionary, not a stream — the §7.5.8.1 check
    // fires before the Type /XRef check ever runs.
    const b = buildPdf([CATALOG], { startxrefOverride: enc('%PDF-1.7\n').length });
    await expect(parsePdf(b.bytes)).rejects.toThrow(/§7\.5\.8\.1/);
  });

  it('reports a cyclic Prev chain rather than looping forever', async () => {
    // Build manually: xref section whose trailer Prev points at itself.
    const header = '%PDF-1.7\n';
    const cat = CATALOG;
    const xrefOff = header.length + cat.length;
    const text =
      header +
      cat +
      `xref\n0 2\n0000000000 65535 f \n${pad(header.length, 10)} 00000 n \n` +
      `trailer\n<< /Size 2 /Root 1 0 R /Prev ${xrefOff} >>\n` +
      `startxref\n${xrefOff}\n%%EOF\n`;

    // 🔴 This used to reject. The guarantee the name was about — the walk
    // terminates — is unchanged; what changed is that terminating is now
    // reported instead of refused, for the same reason `/Prev 0` is
    // (`truncated-history.test.ts`): the newest section is perfectly readable,
    // and a file that can still be appended to should not be refused outright.
    // Nothing is lost silently, because the exits that would drop the unread
    // revisions refuse instead — asserted below.
    const doc = await parsePdf(enc(text));
    expect(doc.chainStop).toEqual({ kind: 'cyclic', offset: xrefOff });
    await expect(rewrite(doc)).rejects.toThrow(TruncatedHistoryError);
  });
});
