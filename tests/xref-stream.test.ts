/**
 * Cross-reference stream + object stream tests (§7.5.7, §7.5.8).
 * Fixtures are assembled byte-exactly with a builder; entry data is
 * binary, so string concatenation alone would not do.
 */

import { describe, expect, it } from 'vitest';
import { dictGet } from '../src/cos/types.js';
import { type PdfDocument, parsePdf } from '../src/index.js';

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
async function buildWithObjStm(): Promise<PdfDocument> {
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
      `/DecodeParms << /Predictor 12 /Columns ${rowBytes} >> /Length ${encoded.length} /Root 1 0 R >> stream\n`,
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
