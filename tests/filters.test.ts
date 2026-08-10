/**
 * Filter-layer tests (§7.4.4, Tables 8/9/10). Predictor tests build the
 * filtered form with a forward filter written in the test itself, then
 * check that applyPredictor inverts it exactly — the fixtures cannot
 * drift from the assertion.
 */

import { describe, expect, it } from 'vitest';
import type { CosDict, CosObject, CosStream } from '../src/cos/types.js';
import { applyPredictor, decodeStream, FilterError, inflate } from '../src/index.js';

const enc = (s: string) => new TextEncoder().encode(s);

/** Deterministic pseudo-random bytes (no RNG in tests). */
function patternBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = (i * 37 + ((i * i) % 251)) & 0xff;
  }
  return out;
}

/** Forward PNG filter for building fixtures (tag applied to every row). */
function pngForward(data: Uint8Array, rowBytes: number, bpp: number, tag: number): Uint8Array {
  const rows = data.length / rowBytes;
  const out = new Uint8Array(rows * (rowBytes + 1));
  const zero = new Uint8Array(rowBytes);
  for (let r = 0; r < rows; r += 1) {
    const row = data.subarray(r * rowBytes, (r + 1) * rowBytes);
    const prev = r === 0 ? zero : data.subarray((r - 1) * rowBytes, r * rowBytes);
    out[r * (rowBytes + 1)] = tag;
    const dst = out.subarray(r * (rowBytes + 1) + 1, (r + 1) * (rowBytes + 1));
    for (let i = 0; i < rowBytes; i += 1) {
      const x = row[i] ?? 0;
      const left = i >= bpp ? (row[i - bpp] ?? 0) : 0;
      const up = prev[i] ?? 0;
      const upLeft = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
      let predicted: number;
      switch (tag) {
        case 0:
          predicted = 0;
          break;
        case 1:
          predicted = left;
          break;
        case 2:
          predicted = up;
          break;
        case 3:
          predicted = (left + up) >> 1;
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          predicted = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
        default:
          throw new Error('bad tag');
      }
      dst[i] = (x - predicted) & 0xff;
    }
  }
  return out;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  // Test-only forward compression. The library itself never compresses
  // with CompressionStream (ADR-0003: not deterministic across engines).
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function dict(entries: Record<string, CosObject>): CosDict {
  return { kind: 'dict', entries: new Map(Object.entries(entries)) };
}

function name(value: string): CosObject {
  return { kind: 'name', value };
}

function int(value: number): CosObject {
  return { kind: 'integer', value };
}

describe('PNG predictors (§7.4.4.4, Table 9)', () => {
  const parms = { predictor: 12, colors: 1, bitsPerComponent: 8, columns: 5 } as const;
  const data = patternBytes(5 * 6); // 6 rows × 5 columns, 8-bit single component

  it.each([[0], [1], [2], [3], [4]])('inverts row tag %d exactly', (tag) => {
    const filtered = pngForward(data, 5, 1, tag);
    expect(Array.from(applyPredictor(filtered, parms))).toEqual(Array.from(data));
  });

  it('decodes regardless of which Predictor value >= 10 was declared (§7.4.4.4)', () => {
    // "The value of Predictor supplied by the decoding filter need not
    // match the value used when the data were encoded".
    const filtered = pngForward(data, 5, 1, 2); // encoded with Up
    for (const declared of [10, 11, 12, 13, 14, 15]) {
      const out = applyPredictor(filtered, { ...parms, predictor: declared });
      expect(Array.from(out)).toEqual(Array.from(data));
    }
  });

  it('respects bytes-per-pixel for multi-byte samples (Colors 3)', () => {
    const rgb = patternBytes(6 * 4); // 4 rows × (3 colors × 2 columns)
    const filtered = pngForward(rgb, 6, 3, 1); // Sub with bpp 3
    const out = applyPredictor(filtered, {
      predictor: 12,
      colors: 3,
      bitsPerComponent: 8,
      columns: 2,
    });
    expect(Array.from(out)).toEqual(Array.from(rgb));
  });

  it('rejects an invalid row tag (Table 9 defines 0-4)', () => {
    const filtered = pngForward(data, 5, 1, 0);
    filtered[0] = 9;
    expect(() => applyPredictor(filtered, parms)).toThrow(FilterError);
  });

  it('rejects data that is not a whole number of rows', () => {
    expect(() => applyPredictor(patternBytes(7), parms)).toThrow(FilterError);
  });
});

describe('TIFF Predictor 2 (§7.4.4.4)', () => {
  it('inverts component-wise left prediction for 8-bit components', () => {
    const data = patternBytes(3 * 4 * 2); // 2 rows × 4 columns × 3 colors
    const rowBytes = 12;
    const filtered = data.slice();
    for (let row = 0; row < filtered.length; row += rowBytes) {
      for (let i = rowBytes - 1; i >= 3; i -= 1) {
        filtered[row + i] = ((filtered[row + i] ?? 0) - (data[row + i - 3] ?? 0)) & 0xff;
      }
    }
    const out = applyPredictor(filtered, {
      predictor: 2,
      colors: 3,
      bitsPerComponent: 8,
      columns: 4,
    });
    expect(Array.from(out)).toEqual(Array.from(data));
  });

  it('rejects unsupported bit depths explicitly', () => {
    expect(() =>
      applyPredictor(patternBytes(4), {
        predictor: 2,
        colors: 1,
        bitsPerComponent: 4,
        columns: 8,
      }),
    ).toThrow(/not supported yet/);
  });
});

describe('inflate (interim DecompressionStream, ADR-0003)', () => {
  it('round-trips through a zlib deflate stream', async () => {
    const original = patternBytes(4096);
    expect(Array.from(await inflate(await deflate(original)))).toEqual(Array.from(original));
  });

  it('raises FilterError on corrupt data', async () => {
    await expect(inflate(enc('not a zlib stream'))).rejects.toThrow(FilterError);
  });
});

describe('decodeStream (§7.4, Table 5)', () => {
  function stream(dictValue: CosDict, raw: Uint8Array): CosStream {
    return { kind: 'stream', dict: dictValue, raw };
  }

  it('applies FlateDecode + PNG predictor from DecodeParms', async () => {
    const data = patternBytes(5 * 6);
    const filtered = pngForward(data, 5, 1, 2);
    const raw = await deflate(filtered);
    const s = stream(
      dict({
        Length: int(raw.length),
        Filter: name('FlateDecode'),
        DecodeParms: dict({ Predictor: int(12), Columns: int(5) }),
      }),
      raw,
    );
    expect(Array.from(await decodeStream(s))).toEqual(Array.from(data));
  });

  it('handles the array forms of Filter and DecodeParms', async () => {
    const data = enc('array form');
    const raw = await deflate(data);
    const s = stream(
      dict({
        Length: int(raw.length),
        Filter: { kind: 'array', items: [name('FlateDecode')] },
        DecodeParms: { kind: 'array', items: [{ kind: 'null' }] },
      }),
      raw,
    );
    expect(new TextDecoder().decode(await decodeStream(s))).toBe('array form');
  });

  it('returns raw bytes unchanged when there is no Filter', async () => {
    const s = stream(dict({ Length: int(3) }), enc('abc'));
    expect(new TextDecoder().decode(await decodeStream(s))).toBe('abc');
  });

  it('names the unsupported filter instead of passing bytes through', async () => {
    const s = stream(dict({ Filter: name('DCTDecode') }), enc('x'));
    await expect(decodeStream(s)).rejects.toThrow(/DCTDecode.*not supported yet/);
  });
});
