/**
 * Cross-reference streams — ISO 32000-2 §7.5.8.
 *
 * The stream dictionary doubles as the trailer dictionary (§7.5.8.1); the
 * stream data holds fixed-width binary entries described by W, organised
 * into subsections described by Index (§7.5.8.2/7.5.8.3, Tables 17/18).
 *
 * Clause-fixed behaviours implemented here:
 * - W element 0 means "field absent, use the default"; a zero first
 *   element defaults the type to 1; the second element shall not be 0.
 * - Index defaults to [0 Size]; pairs shall be ascending and disjoint.
 * - Fields are big-endian.
 * - Entry types other than 0/1/2 "shall be interpreted as a reference to
 *   the null object" — recorded as `unknown`, never an error (forward
 *   compatibility is a shall, not a courtesy).
 */

import type { CosDict } from '../cos/types.js';
import { dictGet } from '../cos/types.js';
import { decodeStream } from '../filter/decode.js';
import { ByteCursor } from '../syntax/byte-cursor.js';
import { ParseError, parseIndirectObject } from '../syntax/object-parser.js';
import { TokenReader } from '../syntax/token-reader.js';
import type { XrefEntry, XrefSection } from './file-parser.js';

/**
 * Parse the cross-reference stream located at `origin + offset`.
 * `addressedAt` is the offset the startxref/Prev/XRefStm carried — it is
 * recorded on the section as its identity (it may differ from `offset`
 * when the caller has skipped leading white-space).
 */
export async function parseXrefStreamSection(
  bytes: Uint8Array,
  origin: number,
  offset: number,
  addressedAt: number,
): Promise<XrefSection> {
  const cur = new ByteCursor(bytes);
  cur.seek(origin + offset);
  // No Length resolver here: before this section is read there is no
  // cross-reference information to resolve with. A cross-reference stream
  // whose own Length is indirect is therefore unreadable by construction
  // and surfaces as the object parser's clear error.
  const parsed = parseIndirectObject(new TokenReader(cur));
  if (parsed.object.kind !== 'stream') {
    throw new ParseError(
      'startxref points at an object that is not a stream (§7.5.8.1)',
      origin + offset,
    );
  }
  const stream = parsed.object;
  const dict = stream.dict;

  const type = dictGet(dict, 'Type');
  if (type?.kind !== 'name' || type.value !== 'XRef') {
    throw new ParseError(
      'cross-reference stream dictionary shall have Type /XRef (§7.5.8.2 Table 17)',
      origin + offset,
    );
  }

  const size = requiredInt(dict, 'Size', origin + offset);
  const w = readW(dict, origin + offset);
  const index = readIndex(dict, size, origin + offset);

  const data = await decodeStream(stream);
  const entryLength = w[0] + w[1] + w[2];
  const expected = index.reduce((sum, [, count]) => sum + count * entryLength, 0);
  if (data.length !== expected) {
    throw new ParseError(
      `cross-reference stream data is ${data.length} bytes, expected ${expected} (Index × W, §7.5.8.3)`,
      origin + offset,
    );
  }

  const entries = new Map<number, XrefEntry>();
  let pos = 0;
  for (const [first, count] of index) {
    for (let i = 0; i < count; i += 1) {
      const objectNumber = first + i;
      const f1 = readField(data, pos, w[0]);
      const f2 = readField(data, pos + w[0], w[1]);
      const f3 = readField(data, pos + w[0] + w[1], w[2]);
      pos += entryLength;

      if (entries.has(objectNumber)) {
        throw new ParseError(
          `object number ${objectNumber} shall have no more than one entry in a section (§7.5.8.2 Index)`,
          origin + offset,
        );
      }
      entries.set(objectNumber, makeEntry(f1 ?? 1, f2 ?? 0, f3 ?? 0));
      // f1 default: "If the first element is zero, the type field shall not
      // be present, and shall default to Type 1" (Table 17 W).
      // f2 has no default (W[1] shall not be 0); f3 defaults to 0 (Table 18).
    }
  }

  return {
    offset: addressedAt,
    kind: 'stream',
    entries,
    trailer: dict,
    // §7.5.8.3: an entry for the stream itself exists (usually in itself) —
    // its own object number identifies it to per-revision consumers.
    selfObjectNumber: parsed.objectNumber,
  };
}

function makeEntry(type: number, second: number, third: number): XrefEntry {
  switch (type) {
    case 0: // free (Table 18)
      return { type: 'free', nextFree: second, generation: third };
    case 1: // in use, uncompressed
      return { type: 'in-use', offset: second, generation: third };
    case 2: // compressed: (object stream number, index within it); generation implicitly 0
      return { type: 'compressed', streamObjectNumber: second, indexInStream: third };
    default:
      // "Any other value shall be interpreted as a reference to the null
      // object" (§7.5.8.3) — represent, don't reject.
      return { type: 'unknown', rawType: type };
  }
}

/** Table 17 W: exactly three non-negative integers; the second shall not be 0. */
function readW(dict: CosDict, at: number): [number, number, number] {
  const value = dictGet(dict, 'W');
  if (value?.kind !== 'array' || value.items.length !== 3) {
    throw new ParseError(
      'W shall be an array of three integers (§7.5.8.2 Table 17; PDF 1.5-2.0 entries have three fields)',
      at,
    );
  }
  const widths = value.items.map((item) => {
    if (item.kind !== 'integer' || item.value < 0) {
      throw new ParseError('W elements shall be non-negative direct integers (Table 17)', at);
    }
    return item.value;
  });
  const [w0, w1, w2] = widths;
  if (w0 === undefined || w1 === undefined || w2 === undefined) {
    throw new ParseError('W shall have three elements (Table 17)', at);
  }
  if (w1 === 0) {
    throw new ParseError(
      'a value of zero shall not be used for the second element of W (Table 17)',
      at,
    );
  }
  return [w0, w1, w2];
}

/** Table 17 Index: pairs [first count], ascending and disjoint. Default [0 Size]. */
function readIndex(dict: CosDict, size: number, at: number): [number, number][] {
  const value = dictGet(dict, 'Index');
  if (value === undefined) {
    return [[0, size]];
  }
  if (value.kind !== 'array' || value.items.length % 2 !== 0) {
    throw new ParseError('Index shall be an array of integer pairs (Table 17)', at);
  }
  const pairs: [number, number][] = [];
  let minNext = 0;
  for (let i = 0; i < value.items.length; i += 2) {
    const first = value.items[i];
    const count = value.items[i + 1];
    if (
      first?.kind !== 'integer' ||
      count?.kind !== 'integer' ||
      first.value < 0 ||
      count.value < 0
    ) {
      throw new ParseError('Index pairs shall be non-negative direct integers (Table 17)', at);
    }
    if (first.value < minNext) {
      throw new ParseError(
        'Index shall be sorted ascending and subsections shall not overlap (Table 17)',
        at,
      );
    }
    minNext = first.value + count.value;
    pairs.push([first.value, count.value]);
  }
  return pairs;
}

function requiredInt(dict: CosDict, key: string, at: number): number {
  const value = dictGet(dict, key);
  if (value?.kind !== 'integer' || value.value < 1) {
    throw new ParseError(`${key} shall be a positive direct integer (§7.5.8.2 Table 17)`, at);
  }
  return value.value;
}

/** Big-endian fixed-width field; width 0 = absent (§7.5.8.3: high-order byte first). */
function readField(data: Uint8Array, pos: number, width: number): number | undefined {
  if (width === 0) {
    return undefined;
  }
  let value = 0;
  for (let i = 0; i < width; i += 1) {
    value = value * 256 + (data[pos + i] ?? 0);
  }
  return value;
}
