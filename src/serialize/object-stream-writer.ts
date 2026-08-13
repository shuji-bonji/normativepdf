/**
 * Object stream construction — ISO 32000-2 §7.5.7.
 *
 * An object stream stores a run of indirect objects inside one stream, so that
 * a compression filter can work across all of them at once. This module builds
 * the container; nothing here compresses, because ADR-0003 §4 rules out
 * `CompressionStream` for a writer that has to be byte-deterministic. NOTE 2 of
 * §7.5.7 anticipates that: "The term 'compressed object' is used regardless of
 * whether the stream is actually encoded with a compression filter."
 *
 * What may not go in one (§7.5.7, verbatim list):
 *   - Stream objects
 *   - Objects with a generation number other than zero
 *   - A document's encryption dictionary
 *   - An object representing the value of the Length entry in an object stream
 *     dictionary
 *   - In linearized files, the catalog, the linearization dictionary and page
 *     objects
 *
 * The fourth cannot arise here: this writer always emits `/Length` as a direct
 * integer, so no object stands for it. The fifth cannot arise either — nothing
 * in this library writes a linearized file. Both are checked rather than
 * assumed away in {@link partitionForObjectStream}, because "cannot arise"
 * ages badly.
 */

import type { CosDict, CosObject } from '../cos/types.js';
import type { WritableObject } from './file-writer.js';
import { ByteWriter, writeObject } from './object-writer.js';

/** An object placed inside an object stream, with the index it landed at. */
export interface CompressedPlacement {
  readonly objectNumber: number;
  /** Position within the stream, 0-based — field 3 of a type 2 entry. */
  readonly indexInStream: number;
}

export interface BuiltObjectStream {
  /** The `/Type /ObjStm` stream, ready to be written as an indirect object. */
  readonly stream: CosObject;
  readonly placements: readonly CompressedPlacement[];
}

/**
 * Split objects into the ones an object stream may hold and the ones it may
 * not, applying the §7.5.7 exclusions.
 *
 * `encryptObjectNumber` names the document's encryption dictionary when the
 * trailer has an `/Encrypt` entry pointing at an indirect object. This library
 * does not encrypt, so the case only arises when rewriting a file that was
 * already encrypted — which the round-trip refuses for other reasons, but the
 * exclusion is applied anyway rather than relying on that.
 */
export function partitionForObjectStream(
  objects: readonly WritableObject[],
  encryptObjectNumber?: number,
): { compressible: WritableObject[]; plain: WritableObject[] } {
  const compressible: WritableObject[] = [];
  const plain: WritableObject[] = [];
  for (const item of objects) {
    if (
      // "Stream objects"
      item.object.kind === 'stream' ||
      // "Objects with a generation number other than zero" (R-7.5.7-15 also
      // requires the generation of any compressed object to be zero)
      item.generationNumber !== 0 ||
      // "A document's encryption dictionary"
      item.objectNumber === encryptObjectNumber ||
      // "An object in an object stream shall not consist solely of an object
      // reference" (R-7.5.7-10) — the EXAMPLE in the clause is a bare `3 0 R`,
      // which a reader cannot tell apart from the integer pair that precedes
      // it in the stream data.
      item.object.kind === 'ref'
    ) {
      plain.push(item);
    } else {
      compressible.push(item);
    }
  }
  return { compressible, plain };
}

/**
 * Build one object stream from objects that {@link partitionForObjectStream}
 * accepted.
 *
 * Layout (§7.5.7): N pairs of integers `objectNumber offset`, white-space
 * separated, offsets relative to `/First` and in increasing order; then the N
 * object values, with no `obj` / `endobj` keywords.
 *
 * Objects are placed in ascending object-number order. NOTE 6 says the order
 * is free ("the objects need not be stored in object-number order"); a fixed
 * one is chosen because deterministic output is a design requirement
 * (DESIGN §4.1).
 */
export function buildObjectStream(objects: readonly WritableObject[]): BuiltObjectStream {
  if (objects.length === 0) {
    throw new RangeError('an object stream shall hold at least one object (§7.5.7 Table 16, N)');
  }
  const sorted = [...objects].sort((a, b) => a.objectNumber - b.objectNumber);

  // The object values first, so their relative offsets are known before the
  // pair list that has to state them.
  const body = new ByteWriter();
  const placements: CompressedPlacement[] = [];
  const pairs: string[] = [];
  for (const [index, item] of sorted.entries()) {
    if (item.object.kind === 'stream' || item.generationNumber !== 0) {
      throw new TypeError(
        `object ${item.objectNumber} may not be stored in an object stream (§7.5.7)`,
      );
    }
    pairs.push(`${item.objectNumber} ${body.length}`);
    placements.push({ objectNumber: item.objectNumber, indexInStream: index });
    writeObject(body, item.object);
    // A separator is not required between objects — NOTE 7 corrected an
    // earlier edition that said it was — but one is written so that the
    // decoded stream stays readable and two adjacent numeric objects cannot
    // run together.
    body.ascii('\n');
  }

  const header = new ByteWriter();
  header.ascii(`${pairs.join(' ')}\n`);
  const first = header.length;

  const data = new ByteWriter();
  data.bytes(header.toUint8Array());
  data.bytes(body.toUint8Array());

  const entries = new Map<string, CosObject>([
    ['Type', { kind: 'name', value: 'ObjStm' }],
    ['N', { kind: 'integer', value: sorted.length }],
    // "The byte offset in the decoded stream of the first compressed object."
    ['First', { kind: 'integer', value: first }],
  ]);
  const dict: CosDict = { kind: 'dict', entries };

  return {
    stream: { kind: 'stream', dict, raw: data.toUint8Array() },
    placements,
  };
}
