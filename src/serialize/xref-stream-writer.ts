/**
 * Cross-reference stream construction — ISO 32000-2 §7.5.8.
 *
 * A cross-reference stream replaces the classic table, and its stream
 * dictionary doubles as the trailer: for a file that uses them throughout,
 * "the keywords xref and trailer shall no longer be used" (R-7.5.8.1-3), and
 * `startxref` carries "the byte offset of the cross-reference stream rather
 * than the xref keyword" (R-7.5.8.1-2).
 *
 * The stream is written unencoded. §7.5.8.4 says both streams of a hybrid file
 * "should be Flate-encoded", and NOTE 9 of §7.5.7 says Flate "would typically
 * be used" — a *should*, not a *shall*, and ADR-0003 §4 declines it because
 * `CompressionStream` output is not byte-stable across engines while
 * deterministic output is a design requirement (DESIGN §4.1). When the pure-TS
 * deflate arrives (ADR-0003's trigger list), this is where it plugs in.
 */

import type { CosDict, CosObject } from '../cos/types.js';
import { ByteWriter } from './object-writer.js';

/** One row of the cross-reference stream (§7.5.8.3 Table 18). */
export type XrefStreamEntry =
  | { readonly type: 'free'; readonly nextFree: number; readonly generation: number }
  | { readonly type: 'in-use'; readonly offset: number; readonly generation: number }
  | {
      readonly type: 'compressed';
      readonly streamObjectNumber: number;
      readonly indexInStream: number;
    };

/**
 * Keys this builder computes for itself, which therefore shall not be carried
 * over from a source document's trailer.
 *
 * 🔴 The encoding keys are the ones that bite. When the source was itself a
 * cross-reference stream, its dictionary — which doubles as the trailer — says
 * `/Filter /FlateDecode`. Copying that onto a stream this writer emits
 * *unencoded* produces a dictionary that lies about its own bytes, and the
 * next reader gets "FlateDecode failed" on data that was never deflated.
 * Measured: 487 of 2,879 corpus specimens, every one of them a file that had
 * used cross-reference streams. The classic-table path had already excluded
 * these keys; this path was written with a shorter list.
 */
const COMPUTED_KEYS = new Set([
  // Table 17 — computed from the entries being written
  'Type',
  'Size',
  'Index',
  'W',
  // Table 5 — describe the bytes this builder produces
  'Length',
  'Filter',
  'DecodeParms',
  // Table 5 — an external-file stream is a different object entirely
  'F',
  'FFilter',
  'FDecodeParms',
]);

/** Bytes needed to hold `value` big-endian; at least 1 so a field exists. */
function widthFor(value: number): number {
  let width = 1;
  let limit = 256;
  while (value >= limit && width < 8) {
    width += 1;
    limit *= 256;
  }
  return width;
}

function putField(out: number[], value: number, width: number): void {
  for (let shift = width - 1; shift >= 0; shift -= 1) {
    out.push(Math.floor(value / 256 ** shift) % 256);
  }
}

/**
 * Group sorted object numbers into the subsections `/Index` describes.
 * Table 17: "The first integer shall be the first object number in the
 * subsection; the second integer shall be the number of entries … The array
 * shall be sorted in ascending order by object number."
 */
function subsections(numbers: readonly number[]): { start: number; count: number }[] {
  const runs: { start: number; count: number }[] = [];
  for (const number of numbers) {
    const last = runs.at(-1);
    if (last !== undefined && number === last.start + last.count) {
      last.count += 1;
    } else {
      runs.push({ start: number, count: 1 });
    }
  }
  return runs;
}

export interface BuiltXrefStream {
  /** The `/Type /XRef` stream, ready to be written as an indirect object. */
  readonly stream: CosObject;
}

/**
 * Build a cross-reference stream over `entries`, keyed by object number.
 *
 * `extraTrailerEntries` carries what a classic trailer would have said —
 * `/Root`, `/Info`, `/ID`, `/Prev`. Table 17 restricts only its own entries to
 * direct objects; "other cross-reference stream entries … may be indirect; in
 * fact, some (such as Root) shall be indirect" (R-7.5.8.2-8/-9), so those are
 * passed through untouched.
 */
export function buildXrefStream(
  entries: ReadonlyMap<number, XrefStreamEntry>,
  size: number,
  extraTrailerEntries: CosDict,
): BuiltXrefStream {
  const numbers = [...entries.keys()].sort((a, b) => a - b);

  // Field widths are derived from the data rather than fixed, which keeps the
  // stream small and — because the derivation is a pure function of the
  // entries — deterministic.
  let maxField2 = 0;
  let maxField3 = 0;
  for (const number of numbers) {
    const entry = entries.get(number);
    if (entry === undefined) {
      continue;
    }
    if (entry.type === 'free') {
      maxField2 = Math.max(maxField2, entry.nextFree);
      maxField3 = Math.max(maxField3, entry.generation);
    } else if (entry.type === 'in-use') {
      maxField2 = Math.max(maxField2, entry.offset);
      maxField3 = Math.max(maxField3, entry.generation);
    } else {
      maxField2 = Math.max(maxField2, entry.streamObjectNumber);
      maxField3 = Math.max(maxField3, entry.indexInStream);
    }
  }

  // W[0] is 1 rather than 0: a zero first element makes the type field absent
  // and default to 1 (R-7.5.8.2-21/-22), which cannot express the free and
  // compressed entries this stream carries.
  // W[1] "shall not" be zero (R-7.5.8.2-20) — `widthFor` never returns 0.
  const w: [number, number, number] = [1, widthFor(maxField2), widthFor(maxField3)];

  const data: number[] = [];
  for (const number of numbers) {
    const entry = entries.get(number);
    if (entry === undefined) {
      continue;
    }
    if (entry.type === 'free') {
      putField(data, 0, w[0]);
      putField(data, entry.nextFree, w[1]);
      putField(data, entry.generation, w[2]);
    } else if (entry.type === 'in-use') {
      putField(data, 1, w[0]);
      putField(data, entry.offset, w[1]);
      putField(data, entry.generation, w[2]);
    } else {
      putField(data, 2, w[0]);
      putField(data, entry.streamObjectNumber, w[1]);
      putField(data, entry.indexInStream, w[2]);
    }
  }

  const index: CosObject[] = [];
  for (const { start, count } of subsections(numbers)) {
    index.push({ kind: 'integer', value: start }, { kind: 'integer', value: count });
  }

  const dictEntries = new Map<string, CosObject>();
  // Table 17 entries first, then the trailer's — the order is what a reader of
  // the file sees, and putting the identifying keys up front makes a hexdump
  // legible. Determinism is unaffected either way.
  dictEntries.set('Type', { kind: 'name', value: 'XRef' });
  dictEntries.set('Size', { kind: 'integer', value: size });
  dictEntries.set('Index', { kind: 'array', items: index });
  dictEntries.set('W', {
    kind: 'array',
    items: w.map((value) => ({ kind: 'integer', value }) as CosObject),
  });
  for (const [key, value] of extraTrailerEntries.entries) {
    if (COMPUTED_KEYS.has(key)) {
      continue;
    }
    dictEntries.set(key, value);
  }

  const bytes = new ByteWriter();
  bytes.bytes(new Uint8Array(data));

  return {
    stream: {
      kind: 'stream',
      dict: { kind: 'dict', entries: dictEntries },
      raw: bytes.toUint8Array(),
    },
  };
}
