/**
 * Cross-reference stream + object stream tests (§7.5.7, §7.5.8).
 * Fixtures are assembled byte-exactly with a builder; entry data is
 * binary, so string concatenation alone would not do.
 */

import { describe, expect, it } from 'vitest';
import { dictGet } from '../src/cos/types.js';
import { type PdfDocument, parsePdf, readXrefChain, readXrefSectionAt } from '../src/index.js';

const enc = (s: string) => new TextEncoder().encode(s);

class Builder {
  readonly #parts: Uint8Array[] = [];
  #length = 0;

  get length(): number {
    return this.#length;
  }

  /** Append; returns the offset the part starts at. */
  add(part: string | Uint8Array): number {
    const bytes = typeof part === 'string' ? enc(part) : part;
    this.#parts.push(bytes);
    const at = this.#length;
    this.#length += bytes.length;
    return at;
  }

  bytes(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let pos = 0;
    for (const part of this.#parts) {
      out.set(part, pos);
      pos += part.length;
    }
    return out;
  }
}

/** Big-endian fixed-width fields (§7.5.8.3: high-order byte first). */
function entry(widths: readonly number[], fields: readonly number[]): Uint8Array {
  const total = widths.reduce((a, b) => a + b, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (let i = 0; i < widths.length; i += 1) {
    const w = widths[i] ?? 0;
    let v = fields[i] ?? 0;
    for (let b = w - 1; b >= 0; b -= 1) {
      out[pos + b] = v & 0xff;
      v = Math.floor(v / 256);
    }
    pos += w;
  }
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Forward PNG Up filter (tag 2 on every row) for xref-stream data. */
function upFilter(data: Uint8Array, rowBytes: number): Uint8Array {
  const rows = data.length / rowBytes;
  const out = new Uint8Array(rows * (rowBytes + 1));
  for (let r = 0; r < rows; r += 1) {
    out[r * (rowBytes + 1)] = 2;
    for (let i = 0; i < rowBytes; i += 1) {
      const x = data[r * rowBytes + i] ?? 0;
      const up = r === 0 ? 0 : (data[(r - 1) * rowBytes + i] ?? 0);
      out[r * (rowBytes + 1) + 1 + i] = (x - up) & 0xff;
    }
  }
  return out;
}

const W = [1, 2, 2] as const;

/** Uncompressed xref stream, no object streams. Objects: 1 catalog, 2 string. */
async function buildPlain(): Promise<PdfDocument> {
  const b = new Builder();
  b.add('%PDF-2.0\n');
  const off1 = b.add('1 0 obj << /Type /Catalog >> endobj\n');
  const off2 = b.add('2 0 obj (Brillig) endobj\n');

  const rows = [
    entry(W, [0, 0, 65535]), // obj 0: free, head of the free list
    entry(W, [1, off1, 0]), //  obj 1: in use
    entry(W, [1, off2, 0]), //  obj 2: in use
    entry(W, [1, 0, 0]), //      obj 3: the xref stream itself (offset patched below)
  ];
  const dataLen = rows.reduce((a, r) => a + r.length, 0);

  // Two-pass: the xref stream contains its own offset (§7.5.8.3: an entry
  // for it shall exist, usually in itself).
  const head = b.length;
  rows[3] = entry(W, [1, head, 0]);
  const data = new Uint8Array(dataLen);
  let p = 0;
  for (const r of rows) {
    data.set(r, p);
    p += r.length;
  }

  b.add(`3 0 obj << /Type /XRef /Size 4 /W [1 2 2] /Length ${dataLen} /Root 1 0 R >> stream\n`);
  b.add(data);
  b.add('\nendstream endobj\n');
  b.add(`startxref\n${head}\n%%EOF\n`);
  return parsePdf(b.bytes());
}

/**
 * Flate + Predictor-12 xref stream with an object stream. Objects:
 * 1 catalog (plain), 4 ObjStm holding objects 2 (string) and 3 (integer),
 * 5 the xref stream, 6 unknown entry type.
 */
async function buildWithObjStm(extraTrailer = ''): Promise<PdfDocument> {
  const b = new Builder();
  b.add('%PDF-2.0\n');
  const off1 = b.add('1 0 obj << /Type /Catalog >> endobj\n');

  // Object stream: pairs then objects, offsets relative to First (§7.5.7).
  const pairs = '2 0 3 5 ';
  const objects = '(Hi) 7'; // obj 2 at offset 0, obj 3 at offset 5
  const stmData = pairs + objects;
  const off4 = b.add(
    `4 0 obj << /Type /ObjStm /N 2 /First ${pairs.length} /Length ${stmData.length} >> stream\n${stmData}\nendstream endobj\n`,
  );

  const rowBytes = W[0] + W[1] + W[2];
  const makeRows = (off5: number): Uint8Array => {
    const rows = [
      entry(W, [0, 0, 65535]), // 0: free
      entry(W, [1, off1, 0]), //  1: in use
      entry(W, [2, 4, 0]), //     2: compressed, objstm 4, index 0
      entry(W, [2, 4, 1]), //     3: compressed, objstm 4, index 1
      entry(W, [1, off4, 0]), //  4: the object stream
      entry(W, [1, off5, 0]), //  5: the xref stream itself
      entry(W, [9, 0, 0]), //     6: unknown type → null (§7.5.8.3)
    ];
    const data = new Uint8Array(rows.length * rowBytes);
    rows.forEach((r, i) => {
      data.set(r, i * rowBytes);
    });
    return data;
  };

  const off5 = b.length;
  const encoded = await deflate(upFilter(makeRows(off5), rowBytes));
  b.add(
    `5 0 obj << /Type /XRef /Size 7 /W [1 2 2] /Filter /FlateDecode ` +
      `/DecodeParms << /Predictor 12 /Columns ${rowBytes} >> /Length ${encoded.length} /Root 1 0 R${extraTrailer} >> stream\n`,
  );
  b.add(encoded);
  b.add('\nendstream endobj\n');
  b.add(`startxref\n${off5}\n%%EOF\n`);
  return parsePdf(b.bytes());
}

describe('cross-reference streams (§7.5.8)', () => {
  it('reads an uncompressed xref stream; the stream dictionary is the trailer (§7.5.8.1)', async () => {
    const doc = await buildPlain();
    expect(doc.version).toBe('2.0');
    expect(dictGet(doc.trailer, 'Type')).toEqual({ kind: 'name', value: 'XRef' });
    const catalog = await doc.getCatalog();
    expect(catalog.kind).toBe('dict');
    const s = await doc.getObject(2, 0);
    expect(s.kind).toBe('string');
    if (s.kind !== 'string') return;
    expect(new TextDecoder().decode(s.bytes)).toBe('Brillig');
  });

  it('reads a Flate + Predictor-12 xref stream and resolves compressed objects (§7.5.7)', async () => {
    const doc = await buildWithObjStm();
    const s = await doc.getObject(2, 0);
    expect(s.kind).toBe('string');
    if (s.kind !== 'string') return;
    expect(new TextDecoder().decode(s.bytes)).toBe('Hi');
    expect(await doc.getObject(3, 0)).toEqual({ kind: 'integer', value: 7 });
  });

  it('reads a compressed object with a non-zero generation request as null (§7.5.7: implicitly 0)', async () => {
    const doc = await buildWithObjStm();
    expect(await doc.getObject(2, 1)).toEqual({ kind: 'null' });
  });

  it('reads an unknown entry type as null (§7.5.8.3 forward compatibility)', async () => {
    const doc = await buildWithObjStm();
    expect(await doc.getObject(6, 0)).toEqual({ kind: 'null' });
    expect(doc.xref.get(6)).toEqual({ type: 'unknown', rawType: 9 });
  });

  it('accepts /W [1 2 0]: a width-0 generation field defaults to 0, and the table-only 65535 rule for object 0 does not apply to streams (§7.5.8.2 Table 17, §7.5.8.3 Table 18)', async () => {
    // veraPDF-corpus writes /W [1 2 0] in 493 of 2907 specimens; with the
    // generation field absent, the free head decodes as generation 0.
    const W0 = [1, 2, 0] as const;
    const b = new Builder();
    b.add('%PDF-2.0\n');
    const off1 = b.add('1 0 obj << /Type /Catalog >> endobj\n');
    const rows = [
      entry(W0, [0, 0]), //  obj 0: free — generation field not present
      entry(W0, [1, off1]), // obj 1: in use, generation defaults to 0
      entry(W0, [1, 0]), //   obj 2: the xref stream itself (patched below)
    ];
    const head = b.length;
    rows[2] = entry(W0, [1, head]);
    const dataLen = rows.reduce((a, r) => a + r.length, 0);
    const data = new Uint8Array(dataLen);
    let p = 0;
    for (const r of rows) {
      data.set(r, p);
      p += r.length;
    }
    b.add(`2 0 obj << /Type /XRef /Size 3 /W [1 2 0] /Length ${dataLen} /Root 1 0 R >> stream\n`);
    b.add(data);
    b.add('\nendstream endobj\n');
    b.add(`startxref\n${head}\n%%EOF\n`);
    const doc = await parsePdf(b.bytes());
    expect(doc.xref.get(0)).toEqual({ type: 'free', nextFree: 0, generation: 0 });
    expect((await doc.getCatalog()).kind).toBe('dict');
  });

  it('names encryption instead of failing the filter: object streams in an encrypted file are ciphertext (§7.5.5 Table 15 Encrypt, §7.6)', async () => {
    // Observed in veraPDF-corpus ("7.16-t01-fail-a.pdf"): without the gate
    // the ciphertext reaches FlateDecode and the error blames the filter.
    const doc = await buildWithObjStm(' /Encrypt << /Filter /Standard >>');
    await expect(doc.getObject(2, 0)).rejects.toThrow(/encrypted PDF/);
  });

  it('rejects a wrong W shape (Table 17)', async () => {
    const b = new Builder();
    b.add('%PDF-2.0\n');
    b.add('1 0 obj << /Type /Catalog >> endobj\n');
    const head = b.length;
    b.add('3 0 obj << /Type /XRef /Size 4 /W [1 2] /Length 4 /Root 1 0 R >> stream\n');
    b.add(new Uint8Array(4));
    b.add('\nendstream endobj\n');
    b.add(`startxref\n${head}\n%%EOF\n`);
    await expect(parsePdf(b.bytes())).rejects.toThrow(/W shall be an array of three/);
  });
});

/**
 * Hybrid-reference file (§7.5.8.4), the clause's EXAMPLE reduced: a main
 * classic table (objects 0-1; the hidden objects would be free there), an
 * empty update table whose trailer carries Prev + XRefStm, and the
 * cross-reference stream (object 11) that reveals the hidden objects —
 * object 3 lives in object stream 2.
 */
function buildHybrid(): {
  bytes: Uint8Array;
  mainOff: number;
  updateOff: number;
  xrefStmOff: number;
} {
  const pad = (n: number, w: number): string => n.toString().padStart(w, '0');
  const W3 = [1, 2, 2] as const;
  const b = new Builder();
  b.add('%PDF-1.7\n');
  const off1 = b.add('1 0 obj << /Type /Catalog /StructTreeRoot 3 0 R >> endobj\n');
  const pairs = '3 0 ';
  const stmData = `${pairs}<< /Type /StructTreeRoot >>`;
  const off2 = b.add(
    `2 0 obj << /Type /ObjStm /N 1 /First ${pairs.length} /Length ${stmData.length} >> stream\n${stmData}\nendstream endobj\n`,
  );
  const mainOff = b.add(
    `xref\n0 2\n0000000000 65535 f \n${pad(off1, 10)} 00000 n \ntrailer\n<< /Size 12 /Root 1 0 R >>\n`,
  );
  const xrefStmOff = b.length;
  const rows = [
    entry(W3, [1, off2, 0]), //       obj 2: the object stream
    entry(W3, [2, 2, 0]), //          obj 3: hidden, in objstm 2 at index 0
    entry(W3, [1, xrefStmOff, 0]), // obj 11: the cross-reference stream itself
  ];
  const dataLen = rows.reduce((a, r) => a + r.length, 0);
  const data = new Uint8Array(dataLen);
  let p = 0;
  for (const r of rows) {
    data.set(r, p);
    p += r.length;
  }
  b.add(
    `11 0 obj << /Type /XRef /Size 12 /Index [2 1 3 1 11 1] /W [1 2 2] /Length ${dataLen} >> stream\n`,
  );
  b.add(data);
  b.add('\nendstream endobj\n');
  const updateOff = b.add(
    `xref\n0 0\ntrailer\n<< /Size 12 /Root 1 0 R /Prev ${mainOff} /XRefStm ${xrefStmOff} >>\n`,
  );
  b.add(`startxref\n${updateOff}\n%%EOF\n`);
  return { bytes: b.bytes(), mainOff, updateOff, xrefStmOff };
}

describe('hybrid-reference files (§7.5.8.4)', () => {
  it('resolves a hidden object via XRefStm: section → XRefStm → Prev search order', async () => {
    const doc = await parsePdf(buildHybrid().bytes);
    // The XRefStm reveals object 3 as compressed; without it the object is
    // simply absent (the reduced main table never mentions it) and would
    // read as null (R-7.3.10-13).
    expect(doc.xref.get(3)).toEqual({
      type: 'compressed',
      streamObjectNumber: 2,
      indexInStream: 0,
    });
    const structTreeRoot = await doc.getObject(3, 0);
    expect(structTreeRoot.kind).toBe('dict');
    if (structTreeRoot.kind !== 'dict') return;
    expect(dictGet(structTreeRoot, 'Type')).toEqual({ kind: 'name', value: 'StructTreeRoot' });
  });

  it('keeps the revisions apart in readXrefChain: hybrid section carries the folded entries and its stream object number', async () => {
    const { bytes, mainOff, updateOff } = buildHybrid();
    const chain = await readXrefChain(bytes);
    expect(chain.headerVersion).toBe('1.7');
    expect(chain.startxref).toBe(updateOff);
    expect(chain.sections.map((s) => s.kind)).toEqual(['hybrid', 'table']);
    const [update, main] = chain.sections;
    expect(update?.offset).toBe(updateOff);
    expect(update?.selfObjectNumber).toBe(11);
    expect([...(update?.entries.keys() ?? [])].sort((a, b2) => a - b2)).toEqual([2, 3, 11]);
    expect(main?.offset).toBe(mainOff);
    expect(main?.selfObjectNumber).toBeUndefined();
    expect(main?.entries.size).toBe(2);
  });

  it('reads a single addressed section via readXrefSectionAt', async () => {
    const { bytes, mainOff } = buildHybrid();
    const section = await readXrefSectionAt(bytes, mainOff);
    expect(section.kind).toBe('table');
    expect(section.entries.size).toBe(2);
  });
});
