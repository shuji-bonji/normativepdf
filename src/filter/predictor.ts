/**
 * Predictor inversion for LZWDecode/FlateDecode output — ISO 32000-2
 * §7.4.4.4 and Tables 8/9/10.
 *
 * Facts fixed by the clause:
 * - Predictor 1: no prediction. Predictor 2: TIFF (component-wise, honours
 *   bit depth). Predictor >= 10: PNG group — "the specific predictor
 *   function used shall be explicitly encoded in the incoming data"
 *   (a per-row tag byte), so on decode every value 10–15 is treated
 *   identically.
 * - A row occupies a whole number of bytes, rounded up. Samples outside
 *   the image are 0. PNG predictors work on bytes; TIFF Predictor 2 works
 *   on colour components.
 */

import { FilterError } from './error.js';

/** Table 8 parameters relevant to prediction, with their defaults. */
export interface PredictorParms {
  /** Table 10 value. Default 1 (no prediction). */
  readonly predictor: number;
  /** Interleaved colour components per sample. Default 1. */
  readonly colors: number;
  /** Bits per colour component (1/2/4/8/16). Default 8. */
  readonly bitsPerComponent: number;
  /** Samples per row. Default 1. */
  readonly columns: number;
}

/** Table 10 defaults: Predictor 1 (none), Colors 1, BitsPerComponent 8, Columns 1. */
export const DEFAULT_PREDICTOR_PARMS: PredictorParms = {
  predictor: 1,
  colors: 1,
  bitsPerComponent: 8,
  columns: 1,
};

/** Invert the predictor on decoded filter output. Returns `data` unchanged for Predictor 1. */
export function applyPredictor(data: Uint8Array, parms: PredictorParms): Uint8Array {
  const { predictor, colors, bitsPerComponent, columns } = parms;
  if (predictor === 1) {
    return data;
  }
  if (predictor === 2) {
    return invertTiff(data, colors, bitsPerComponent, columns);
  }
  if (predictor >= 10 && predictor <= 15) {
    return invertPng(data, colors, bitsPerComponent, columns);
  }
  throw new FilterError(`unknown Predictor value ${predictor} (Table 10)`);
}

/**
 * TIFF Predictor 2 — each colour component predicted from the prior
 * instance of that component. Supported for 8-bit components (the
 * practically occurring case); other depths raise a clear error until
 * a use case arrives.
 */
function invertTiff(
  data: Uint8Array,
  colors: number,
  bitsPerComponent: number,
  columns: number,
): Uint8Array {
  if (bitsPerComponent !== 8) {
    throw new FilterError(
      `TIFF Predictor 2 with BitsPerComponent ${bitsPerComponent} is not supported yet (only 8)`,
    );
  }
  const rowBytes = colors * columns;
  if (rowBytes <= 0 || data.length % rowBytes !== 0) {
    throw new FilterError(
      `TIFF-predicted data length ${data.length} is not a multiple of the row length ${rowBytes}`,
    );
  }
  const out = data.slice();
  for (let row = 0; row < out.length; row += rowBytes) {
    for (let i = colors; i < rowBytes; i += 1) {
      out[row + i] = ((out[row + i] ?? 0) + (out[row + i - colors] ?? 0)) & 0xff;
    }
  }
  return out;
}

/**
 * PNG predictor group (ISO/IEC 15948). Each row: one algorithm tag byte
 * (0 None / 1 Sub / 2 Up / 3 Average / 4 Paeth) followed by the filtered
 * row. `bpp` follows the PNG definition — bytes per complete pixel,
 * rounded up, minimum one.
 */
function invertPng(
  data: Uint8Array,
  colors: number,
  bitsPerComponent: number,
  columns: number,
): Uint8Array {
  const bpp = Math.max(1, Math.ceil((colors * bitsPerComponent) / 8));
  const rowBytes = Math.ceil((colors * bitsPerComponent * columns) / 8);
  const stride = rowBytes + 1; // + tag byte
  if (rowBytes <= 0 || data.length % stride !== 0) {
    throw new FilterError(
      `PNG-predicted data length ${data.length} is not a multiple of the row stride ${stride} (row ${rowBytes} + tag)`,
    );
  }

  const rows = data.length / stride;
  const out = new Uint8Array(rows * rowBytes);
  let prevRow = new Uint8Array(rowBytes); // row above the first row is all zero

  for (let r = 0; r < rows; r += 1) {
    const tag = data[r * stride] ?? 0;
    const src = data.subarray(r * stride + 1, (r + 1) * stride);
    const dst = out.subarray(r * rowBytes, (r + 1) * rowBytes);

    switch (tag) {
      case 0: // None
        dst.set(src);
        break;
      case 1: // Sub
        for (let i = 0; i < rowBytes; i += 1) {
          const left = i >= bpp ? (dst[i - bpp] ?? 0) : 0;
          dst[i] = ((src[i] ?? 0) + left) & 0xff;
        }
        break;
      case 2: // Up
        for (let i = 0; i < rowBytes; i += 1) {
          dst[i] = ((src[i] ?? 0) + (prevRow[i] ?? 0)) & 0xff;
        }
        break;
      case 3: // Average
        for (let i = 0; i < rowBytes; i += 1) {
          const left = i >= bpp ? (dst[i - bpp] ?? 0) : 0;
          const up = prevRow[i] ?? 0;
          dst[i] = ((src[i] ?? 0) + ((left + up) >> 1)) & 0xff;
        }
        break;
      case 4: // Paeth
        for (let i = 0; i < rowBytes; i += 1) {
          const left = i >= bpp ? (dst[i - bpp] ?? 0) : 0;
          const up = prevRow[i] ?? 0;
          const upLeft = i >= bpp ? (prevRow[i - bpp] ?? 0) : 0;
          dst[i] = ((src[i] ?? 0) + paeth(left, up, upLeft)) & 0xff;
        }
        break;
      default:
        throw new FilterError(`invalid PNG predictor row tag ${tag} (Table 9 defines 0-4)`);
    }
    prevRow = dst;
  }
  return out;
}

/** Paeth predictor function per ISO/IEC 15948. */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  if (pb <= pc) {
    return b;
  }
  return c;
}
