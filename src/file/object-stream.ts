/**
 * Object streams — ISO 32000-2 §7.5.7 (Table 16).
 *
 * Clause-fixed behaviours implemented here:
 * - The stream data begins with N pairs "objnum offset" (offsets relative
 *   to First, in increasing order), followed by the objects with no
 *   obj/endobj framing.
 * - Objects are located by offset, not by scanning: "processing of each
 *   object ... starts at the specified byte offset ... and ends prior to
 *   the byte offset of the next object or when the end of stream is
 *   encountered" (2020 clarification — white-space between objects is not
 *   required, so sequential token reading would be wrong).
 * - An object in an object stream shall not consist solely of an object
 *   reference — which is exactly what keeps the object parser's two-token
 *   reference lookahead safe across object boundaries here.
 */

import type { CosObject, CosStream } from '../cos/types.js';
import { dictGet } from '../cos/types.js';
import { decodeStream } from '../filter/decode.js';
import { ByteCursor } from '../syntax/byte-cursor.js';
import { ParseError, parseObject } from '../syntax/object-parser.js';
import { TokenReader } from '../syntax/token-reader.js';

/** An object stream's index, decoded: Table 16 `First`, the (number, offset) pairs, the data. */
export interface ParsedObjectStream {
  /** Byte offset in the decoded data of the first object (Table 16 First). */
  readonly first: number;
  /** N pairs of (object number, offset relative to First), in stored order. */
  readonly pairs: readonly (readonly [number, number])[];
  /** The decoded stream data. */
  readonly data: Uint8Array;
}

/** Decode and index an object stream (Type /ObjStm). */
export async function loadObjectStream(
  stream: CosStream,
  streamObjectNumber: number,
): Promise<ParsedObjectStream> {
  const dict = stream.dict;
  const type = dictGet(dict, 'Type');
  if (type?.kind !== 'name' || type.value !== 'ObjStm') {
    throw new ParseError(
      `object ${streamObjectNumber} is referenced as an object stream but its Type is not /ObjStm (§7.5.7 Table 16)`,
      0,
    );
  }
  const n = requiredNonNegativeInt(dict, 'N', streamObjectNumber);
  const first = requiredNonNegativeInt(dict, 'First', streamObjectNumber);

  const data = await decodeStream(stream);
  const reader = new TokenReader(new ByteCursor(data));

  const pairs: [number, number][] = [];
  let prevOffset = -1;
  for (let i = 0; i < n; i += 1) {
    const num = reader.take();
    const off = reader.take();
    if (num.kind !== 'integer' || off.kind !== 'integer' || num.value < 1 || off.value < 0) {
      throw new ParseError(
        `object stream ${streamObjectNumber}: expected N pairs of integers (object number, offset) in the stream data (§7.5.7)`,
        num.offset,
      );
    }
    if (off.value <= prevOffset) {
      throw new ParseError(
        `object stream ${streamObjectNumber}: byte offsets shall be in increasing order (§7.5.7)`,
        off.offset,
      );
    }
    prevOffset = off.value;
    pairs.push([num.value, off.value]);
  }

  return { first, pairs, data };
}

/**
 * Parse the compressed object at `indexInStream`, verifying the object
 * number recorded in the pair table matches what the cross-reference
 * entry promised (§7.5.4: entries locate *that* object).
 */
export function objectFromStream(
  parsed: ParsedObjectStream,
  indexInStream: number,
  expectedObjectNumber: number,
  streamObjectNumber: number,
): CosObject {
  const pair = parsed.pairs[indexInStream];
  if (pair === undefined) {
    throw new ParseError(
      `index ${indexInStream} is outside the object stream (N = ${parsed.pairs.length}; Table 18 type-2 field 3 shall be 0..N-1)`,
      0,
    );
  }
  const [objectNumber, offset] = pair;
  if (objectNumber !== expectedObjectNumber) {
    throw new ParseError(
      `cross-reference stream points object ${expectedObjectNumber} at index ${indexInStream} of object stream ${streamObjectNumber}, but that slot holds object ${objectNumber}`,
      offset,
    );
  }
  const cur = new ByteCursor(parsed.data);
  cur.seek(parsed.first + offset);
  return parseObject(new TokenReader(cur));
}

function requiredNonNegativeInt(
  dict: Parameters<typeof dictGet>[0],
  key: string,
  streamObjectNumber: number,
): number {
  const value = dictGet(dict, key);
  if (value?.kind !== 'integer' || value.value < 0) {
    throw new ParseError(
      `object stream ${streamObjectNumber}: ${key} shall be a non-negative integer (§7.5.7 Table 16)`,
      0,
    );
  }
  return value.value;
}
