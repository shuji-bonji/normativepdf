/**
 * File-structure serializer — ISO 32000-2 §7.5: header, body, classic
 * cross-reference table, trailer.
 *
 * What this writes, and what it deliberately does not:
 *
 * - **Classic cross-reference table only** (§7.5.4). Cross-reference streams
 *   and object streams are read (see `file/`), not yet written. Everything is
 *   emitted as an uncompressed indirect object, which `/Filter` being optional
 *   makes legal and ADR-0003 §4 makes the starting point.
 * - **Nothing is validated.** A document whose catalog is missing is written
 *   as given; conformance is pdf-verify-mcp's answer (DESIGN §4.2).
 * - **Deterministic** (DESIGN §4.1): no time, no randomness. `/ID` is carried
 *   over from the source trailer when present and never invented — §7.5.5
 *   Table 15 requires it in PDF 2.0, but inventing one would make the output
 *   depend on something other than the input.
 *
 * The acceptance criterion this serves, and its limits, are ADR-0004: a
 * round-trip through this writer and the parser proves self-consistency only,
 * so it is paired with an independent reader (`qpdf --check` / poppler) that
 * does not share this code's assumptions.
 */

import type { CosDict, CosObject } from '../cos/types.js';
import { dictGetRaw } from '../cos/types.js';
import type { PdfDocument } from '../file/file-parser.js';
import { ByteWriter, writeIndirectObject, writeObject } from './object-writer.js';

/** One object to place in the body, with the number it keeps. */
export interface WritableObject {
  readonly objectNumber: number;
  readonly generationNumber: number;
  readonly object: CosObject;
}

export interface WriteFileOptions {
  /**
   * Header version to write (§7.5.2: `%PDF-1.n` / `%PDF-2.n`). Defaults to the
   * document's *header* version, not its effective one: the effective version
   * may have been raised by the catalog's `/Version` (§7.7.2 Table 29), and
   * that entry travels with the catalog, so re-deriving the header from it
   * would silently upgrade the file.
   */
  readonly version?: string;
}

/**
 * Keys that belong to a cross-reference *stream* dictionary (§7.5.8.2
 * Table 17) and mean nothing in a classic trailer (§7.5.5 Table 15).
 *
 * When the source used a cross-reference stream, its stream dictionary served
 * as the trailer. Copying it wholesale into a classic `trailer` would carry
 * `/W`, `/Index` and a `/Length` that describe bytes this file no longer has —
 * a trailer that lies about a stream that is not there. ADR-0004 §4 records
 * this as one of the three intentional differences.
 */
const XREF_STREAM_ONLY_KEYS = new Set([
  'Type',
  'W',
  'Index',
  'Filter',
  'DecodeParms',
  'Length',
  'F',
  'FFilter',
  'FDecodeParms',
  'XRefStm',
]);

/** §7.5.4 — one 20-byte entry: `nnnnnnnnnn ggggg n eol`. */
function xrefEntry(first: number, generation: number, keyword: 'n' | 'f'): string {
  if (first > 9_999_999_999 || generation > 65_535) {
    throw new RangeError(
      `cross-reference entry does not fit its fixed width (§7.5.4): ${first} ${generation}`,
    );
  }
  // The 2-character EOL is SP CR, SP LF, or CR LF. " \n" is used: it keeps the
  // entry exactly 20 bytes on every platform, where CR LF would depend on
  // nothing but still reads as two characters in a text editor.
  return `${String(first).padStart(10, '0')} ${String(generation).padStart(5, '0')} ${keyword} \n`;
}

/**
 * Build the trailer dictionary for a classic cross-reference section.
 *
 * `/Size` is recomputed rather than copied: Table 15 defines it as one greater
 * than the highest object number *in this file*, and the file being written is
 * not the file that was read (see `size` argument). Copying it would be
 * copying a fact about somebody else's file.
 */
function buildTrailer(source: CosDict, size: number): CosDict {
  const entries = new Map<string, CosObject>();
  for (const [key, value] of source.entries) {
    if (XREF_STREAM_ONLY_KEYS.has(key)) {
      continue;
    }
    entries.set(key, value);
  }
  entries.set('Size', { kind: 'integer', value: size });
  // §7.5.5 Table 15 Prev: "present only if the file has more than one
  // cross-reference section". A full rewrite has exactly one, so a Prev
  // inherited from the source would point into a file that no longer exists.
  entries.delete('Prev');
  return { kind: 'dict', entries };
}

/**
 * Serialize a complete PDF file from a set of numbered objects.
 *
 * The objects are written in ascending object-number order — not because the
 * clause requires it (§7.5.4 lets subsections appear in any order) but because
 * a fixed order is what makes the output deterministic.
 */
export function writeFile(
  objects: readonly WritableObject[],
  trailerSource: CosDict,
  options: WriteFileOptions = {},
): Uint8Array {
  const version = options.version ?? '2.0';
  if (!/^[12]\.[0-9]$/.test(version)) {
    throw new RangeError(
      `file header shall be %PDF-1.n or %PDF-2.n with n a single digit (§7.5.2); got ${version}`,
    );
  }

  const out = new ByteWriter();
  out.ascii(`%PDF-${version}\n`);
  // §7.5.2: a file containing binary data should have a second line with a
  // comment holding at least four bytes greater than 127, so that transfer
  // tools treat the file as binary. Fixed bytes, so the output stays
  // deterministic.
  out.bytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const sorted = [...objects].sort((a, b) => a.objectNumber - b.objectNumber);
  const offsets = new Map<number, { offset: number; generation: number }>();

  for (const { objectNumber, generationNumber, object } of sorted) {
    if (objectNumber < 1) {
      throw new RangeError(
        `object number 0 is reserved for the head of the free list (§7.5.4); got ${objectNumber}`,
      );
    }
    if (offsets.has(objectNumber)) {
      throw new RangeError(
        `object ${objectNumber} was supplied twice — an object number identifies one object (R-7.3.10-6)`,
      );
    }
    offsets.set(objectNumber, { offset: out.length, generation: generationNumber });
    writeIndirectObject(out, objectNumber, generationNumber, object);
  }

  const highest = sorted.at(-1)?.objectNumber ?? 0;
  const size = highest + 1;

  // §7.5.5: startxref carries the offset "to the beginning of the xref
  // keyword in the last cross-reference section".
  const xrefOffset = out.length;
  out.ascii('xref\n');
  // One subsection covering 0..highest. §7.5.4 requires the table to hold an
  // entry for every object number in that range "even if one or more of the
  // object numbers in this range do not actually occur", so gaps — including
  // the numbers vacated by cross-reference and object streams — are written as
  // free entries rather than skipped.
  out.ascii(`0 ${size}\n`);
  // R-7.5.4: the first entry shall be free with generation 65535, and the tail
  // of the free list links back to object 0. With no other free objects in the
  // list, object 0 links to itself.
  out.ascii(xrefEntry(0, 65_535, 'f'));
  for (let number = 1; number <= highest; number += 1) {
    const placed = offsets.get(number);
    if (placed === undefined) {
      // A free entry whose "next free object" field is 0 terminates the list.
      out.ascii(xrefEntry(0, 65_535, 'f'));
    } else {
      out.ascii(xrefEntry(placed.offset, placed.generation, 'n'));
    }
  }

  // §7.5.5 — the keyword `trailer` followed by the dictionary. It is a direct
  // object, so the ordinary object writer handles it.
  out.ascii('trailer\n');
  writeObject(out, buildTrailer(trailerSource, size));
  out.ascii(`\nstartxref\n${xrefOffset}\n%%EOF\n`);

  return out.toUint8Array();
}

/**
 * Collect every object a parsed document holds, ready for {@link writeFile}.
 *
 * Cross-reference streams (`/Type /XRef`) and object streams (`/Type /ObjStm`)
 * are dropped: they are the bookkeeping this writer replaces, and re-emitting
 * them would leave a file describing two cross-reference mechanisms at once.
 * The objects *inside* an object stream are not dropped — they are read
 * through the merged table like any other object and written out
 * uncompressed, so the graph survives (ADR-0004 §4).
 */
export async function collectObjects(doc: PdfDocument): Promise<WritableObject[]> {
  const collected: WritableObject[] = [];
  for (const [objectNumber, entry] of doc.xref) {
    if (objectNumber === 0 || entry.type === 'free' || entry.type === 'unknown') {
      continue;
    }
    const generationNumber = entry.type === 'in-use' ? entry.generation : 0;
    const object = await doc.getObject(objectNumber, generationNumber);
    if (object.kind === 'null') {
      // An entry that resolves to null carries nothing to write; §7.5.4 lets
      // the number come back as a free entry.
      continue;
    }
    if (object.kind === 'stream') {
      const type = dictGetRaw(object.dict, 'Type');
      if (type?.kind === 'name' && (type.value === 'XRef' || type.value === 'ObjStm')) {
        continue;
      }
    }
    collected.push({ objectNumber, generationNumber, object });
  }
  return collected.sort((a, b) => a.objectNumber - b.objectNumber);
}

/** Read a document and write it back out as a single-revision PDF. */
export async function rewrite(doc: PdfDocument): Promise<Uint8Array> {
  const objects = await collectObjects(doc);
  return writeFile(objects, doc.trailer, { version: doc.headerVersion });
}
