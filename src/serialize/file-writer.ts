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
import { EncryptionError } from '../encrypt/standard-handler.js';
import { type PdfDocument, TruncatedHistoryError } from '../file/file-parser.js';
import type { CompressedPlacement } from './object-stream-writer.js';
import { buildObjectStream, partitionForObjectStream } from './object-stream-writer.js';
import { ByteWriter, writeIndirectObject, writeObject } from './object-writer.js';
import type { XrefStreamEntry } from './xref-stream-writer.js';
import { buildXrefStream } from './xref-stream-writer.js';

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
  /**
   * Which cross-reference mechanism to write.
   *
   * `'table'` (default) is the classic table of §7.5.4, readable by every
   * version of PDF. `'stream'` is the cross-reference stream of §7.5.8, which
   * requires a PDF 1.5 reader and is what object streams need in order to be
   * addressable at all (§7.5.7 NOTE 3).
   */
  readonly xref?: 'table' | 'stream';
  /**
   * Store eligible objects in an object stream (§7.5.7). Requires
   * `xref: 'stream'` — a classic table has no way to point at an object inside
   * a stream, since its entry format predates them.
   */
  readonly objectStreams?: boolean;
  /**
   * Internal: set only by {@link encryptPdf} (`serialize/encrypt-writer.ts`),
   * which has already encrypted every string and stream and built the
   * encryption dictionary. It lifts the refusal below — the trailer legitimately
   * declares /Encrypt and the bytes under it really are ciphertext. Callers must
   * not set this by hand; the refusal exists so a plaintext body is never
   * emitted under an /Encrypt entry (ADR-0008 decision 3).
   */
  readonly encryptedByEncryptPdf?: boolean;
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
 * The largest object number any reference in the document points at, whether
 * or not an object with that number exists (§7.3.10).
 */
function highestReferencedNumber(objects: readonly WritableObject[], trailer: CosDict): number {
  let highest = 0;
  const visit = (value: CosObject): void => {
    switch (value.kind) {
      case 'ref':
        highest = Math.max(highest, value.objectNumber);
        return;
      case 'array':
        for (const item of value.items) {
          visit(item);
        }
        return;
      case 'dict':
        for (const entry of value.entries.values()) {
          visit(entry);
        }
        return;
      case 'stream':
        visit(value.dict);
        return;
      default:
        return;
    }
  };
  visit(trailer);
  for (const { object } of objects) {
    visit(object);
  }
  return highest;
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

  // §7.6.2: "Encryption applies to all strings and streams in the
  // document's PDF file". This writer emits the objects it is given as
  // plaintext; a trailer carrying /Encrypt would therefore describe a
  // document whose contents do not match its own declaration — either
  // decrypted objects under an Encrypt entry (a parsed encrypted file,
  // whose strings and streams were decrypted at materialisation) or
  // ciphertext this writer never touched. Both are files that lie.
  // Writing encrypted output is the write side of ADR-0008 and is not
  // implemented; refusing is the only honest exit (decision 3).
  if (
    dictGetRaw(trailerSource, 'Encrypt') !== undefined &&
    options.encryptedByEncryptPdf !== true
  ) {
    throw new EncryptionError(
      'writing an encrypted document is not supported through writeFile (§7.6.2; ADR-0008): the trailer ' +
        'carries /Encrypt but this writer would emit plaintext strings and streams under it. Use encryptPdf ' +
        'to produce an encrypted document; drop the entry only if a deliberately decrypted copy is intended',
    );
  }

  const out = new ByteWriter();
  out.ascii(`%PDF-${version}\n`);
  // §7.5.2: a file containing binary data should have a second line with a
  // comment holding at least four bytes greater than 127, so that transfer
  // tools treat the file as binary. Fixed bytes, so the output stays
  // deterministic.
  out.bytes(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

  const useStream = options.xref === 'stream';
  const useObjectStreams = options.objectStreams === true;
  if (useObjectStreams && !useStream) {
    throw new RangeError(
      'object streams require a cross-reference stream to address them (§7.5.7 NOTE 3); pass xref: "stream"',
    );
  }

  const sorted = [...objects].sort((a, b) => a.objectNumber - b.objectNumber);
  for (const { objectNumber } of sorted) {
    if (objectNumber < 1) {
      throw new RangeError(
        `object number 0 is reserved for the head of the free list (§7.5.4); got ${objectNumber}`,
      );
    }
  }
  const seen = new Set<number>();
  for (const { objectNumber } of sorted) {
    if (seen.has(objectNumber)) {
      throw new RangeError(
        `object ${objectNumber} was supplied twice — an object number identifies one object (R-7.3.10-6)`,
      );
    }
    seen.add(objectNumber);
  }

  // Object numbers for the containers this writer adds. §7.5.7 requires new
  // object streams to be "assigned new object numbers, not old ones taken from
  // the free list" (R-7.5.7-17), so they go above everything supplied.
  //
  // 🔴 Above everything *referenced*, not merely everything defined. A file can
  // hold a reference to an object number that does not exist — which reads as
  // null (R-7.3.10-13) and is perfectly quiet. Creating an object at that
  // number turns the dangling reference into a live one pointing at this
  // writer's bookkeeping. Measured on veraPDF-corpus
  // "6-2-11-4-1-t01-fail-a.pdf": `/Info 21 0 R` with nothing at 21, so the new
  // cross-reference stream landed there and qpdf reported "operation for
  // dictionary attempted on object of type stream".
  let nextNumber =
    Math.max(sorted.at(-1)?.objectNumber ?? 0, highestReferencedNumber(objects, trailerSource)) + 1;
  const objectStreamNumber = useObjectStreams ? nextNumber++ : null;
  const xrefStreamNumber = useStream ? nextNumber++ : null;

  let toPlace = sorted;
  let compressed: readonly CompressedPlacement[] = [];
  if (useObjectStreams && objectStreamNumber !== null) {
    const encrypt = dictGetRaw(trailerSource, 'Encrypt');
    const { compressible, plain } = partitionForObjectStream(
      sorted,
      encrypt?.kind === 'ref' ? encrypt.objectNumber : undefined,
    );
    if (compressible.length > 0) {
      const built = buildObjectStream(compressible);
      compressed = built.placements;
      toPlace = [
        ...plain,
        { objectNumber: objectStreamNumber, generationNumber: 0, object: built.stream },
      ].sort((a, b) => a.objectNumber - b.objectNumber);
    }
  }

  const offsets = new Map<number, { offset: number; generation: number }>();
  for (const { objectNumber, generationNumber, object } of toPlace) {
    offsets.set(objectNumber, { offset: out.length, generation: generationNumber });
    writeIndirectObject(out, objectNumber, generationNumber, object);
  }

  const highest = Math.max(
    sorted.at(-1)?.objectNumber ?? 0,
    objectStreamNumber ?? 0,
    xrefStreamNumber ?? 0,
  );
  const size = highest + 1;

  if (useStream && xrefStreamNumber !== null) {
    return writeWithXrefStream({
      out,
      offsets,
      compressed,
      objectStreamNumber,
      xrefStreamNumber,
      highest,
      size,
      trailerSource,
    });
  }

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
 * Finish a file whose cross-reference information is a stream (§7.5.8).
 *
 * Two differences from the classic tail, both required rather than chosen:
 * `startxref` carries "the byte offset of the cross-reference stream rather
 * than the xref keyword" (R-7.5.8.1-2), and the `xref` and `trailer` keywords
 * "shall no longer be used" (R-7.5.8.1-3) because the stream dictionary is the
 * trailer.
 */
function writeWithXrefStream(input: {
  out: ByteWriter;
  offsets: ReadonlyMap<number, { offset: number; generation: number }>;
  compressed: readonly CompressedPlacement[];
  objectStreamNumber: number | null;
  xrefStreamNumber: number;
  highest: number;
  size: number;
  trailerSource: CosDict;
}): Uint8Array {
  const { out, offsets, compressed, objectStreamNumber, xrefStreamNumber, highest, size } = input;

  const entries = new Map<number, XrefStreamEntry>();
  // §7.5.4's requirement that object 0 head the free list with generation
  // 65535 is expressed here as a type 0 entry; Table 18 gives the same two
  // fields (next free object, generation).
  entries.set(0, { type: 'free', nextFree: 0, generation: 65_535 });
  for (const [objectNumber, placed] of offsets) {
    entries.set(objectNumber, {
      type: 'in-use',
      offset: placed.offset,
      generation: placed.generation,
    });
  }
  for (const { objectNumber, indexInStream } of compressed) {
    if (objectStreamNumber === null) {
      throw new Error('compressed objects were placed without an object stream to hold them');
    }
    entries.set(objectNumber, {
      type: 'compressed',
      streamObjectNumber: objectStreamNumber,
      indexInStream,
    });
  }
  // Numbers nothing occupies are still described, so the section covers a
  // contiguous range and `/Index` stays a single subsection for a fresh write.
  for (let number = 1; number <= highest; number += 1) {
    if (!entries.has(number)) {
      entries.set(number, { type: 'free', nextFree: 0, generation: 65_535 });
    }
  }

  // The stream is an indirect object and needs an entry for itself, "usually
  // itself" (R-7.5.8.3-5) — so its offset is taken before it is written.
  const xrefOffset = out.length;
  entries.set(xrefStreamNumber, { type: 'in-use', offset: xrefOffset, generation: 0 });

  const trailerEntries = new Map<string, CosObject>(input.trailerSource.entries);
  trailerEntries.delete('Prev');
  trailerEntries.delete('XRefStm');
  const { stream } = buildXrefStream(entries, size, {
    kind: 'dict',
    entries: trailerEntries,
  });
  writeIndirectObject(out, xrefStreamNumber, 0, stream);
  out.ascii(`startxref\n${xrefOffset}\n%%EOF\n`);

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

/**
 * Read a document and write it back out as a single-revision PDF.
 *
 * Refuses a document whose `/Prev` chain could not be walked to the end: the
 * objects defined in the revisions that were not read are absent from `xref`,
 * so a rewrite would emit a smaller file with references pointing at nothing.
 * An incremental update is the operation such a file can still take.
 */
export async function rewrite(doc: PdfDocument): Promise<Uint8Array> {
  if (doc.chainStop.kind !== 'complete') {
    throw new TruncatedHistoryError(doc.chainStop);
  }
  const objects = await collectObjects(doc);
  return writeFile(objects, doc.trailer, { version: doc.headerVersion });
}
