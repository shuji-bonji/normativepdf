/**
 * Incremental update — ISO 32000-2 §7.5.6.
 *
 * > When updating a PDF file incrementally, changes shall be appended to the
 * > end of the file, **leaving its original contents intact**.
 *
 * That sentence is the whole module. The original bytes are copied through
 * untouched and everything new goes after them; there is no code path here
 * that edits what came in. Why it matters is §12.8.1 NOTE 1: a signature's
 * ByteRange covers the original bytes, so preserving them is what lets a
 * signature made before the update still verify after it.
 *
 * What an update section carries (§7.5.6):
 * - "A cross-reference section for an incremental update shall contain entries
 *   only for objects that have been changed, replaced, or deleted." Changed
 *   object numbers are rarely contiguous, so the section is written as several
 *   subsections rather than one range covering every number in the file.
 * - "The added trailer shall contain all the entries except the Prev entry (if
 *   present) from the previous trailer, whether modified or not. In addition,
 *   the added trailer dictionary shall contain a Prev entry giving the
 *   location of the previous cross-reference section."
 * - "Each trailer shall be terminated by its own end-of-file (%%EOF) marker" —
 *   so the original's %%EOF stays where it is and a second one is added.
 *
 * Scope: the appended section is a classic cross-reference table. §7.5.6 does
 * not require an update to use the same mechanism as the section before it,
 * and following a `/Prev` from a table into a cross-reference stream is what
 * the parser already does. Whether other implementations accept that shape is
 * a measurement, not an assumption — see ADR-0005 §3.
 */

import type { CosDict, CosObject } from '../cos/types.js';
import { dictGetRaw } from '../cos/types.js';
import type { PdfDocument } from '../file/file-parser.js';
import { ByteWriter, writeIndirectObject, writeObject } from './object-writer.js';
import type { WritableObject } from './file-writer.js';

/** An object number the update marks as deleted (§7.5.6). */
export interface DeletedObject {
  readonly objectNumber: number;
  /**
   * The generation to record. §7.5.4: when an object is deleted its entry's
   * generation "shall be incremented by 1 to indicate the generation number to
   * be used the next time an object with that object number is created", so
   * the caller supplies the incremented value rather than this module guessing
   * what the previous one was.
   */
  readonly generationNumber: number;
}

export interface AppendUpdateInput {
  /** The file being updated, exactly as it was read. */
  readonly original: Uint8Array;
  /**
   * Byte offset of the cross-reference section this update follows — the value
   * the file's last `startxref` carried, which is what `/Prev` shall hold
   * (§7.5.5 Table 15). Measured from the `%PDF-` header (§7.5.2).
   */
  readonly previousXrefOffset: number;
  /** Trailer dictionary of the previous section; carried over minus `/Prev`. */
  readonly previousTrailer: CosDict;
  /** Objects this update writes. May be new numbers or replacements. */
  readonly objects: readonly WritableObject[];
  /** Objects this update marks as free. */
  readonly deleted?: readonly DeletedObject[];
  /**
   * Byte index of the `%PDF-` header in `original` (§7.5.2: every offset is
   * measured from the PERCENT SIGN). Defaults to 0.
   *
   * 🔴 This is not cosmetic. A file with bytes before its header has origin > 0,
   * and writing absolute offsets into the update's table would point every
   * entry past its object. The round-trip would not notice — it re-reads with
   * the same origin — which is exactly why ADR-0005 puts a signed specimen at
   * the end of the acceptance chain.
   */
  readonly origin?: number;
}

/** §7.5.4 — one 20-byte entry. Shared shape with the full-file writer. */
function xrefEntry(first: number, generation: number, keyword: 'n' | 'f'): string {
  if (first > 9_999_999_999 || generation > 65_535) {
    throw new RangeError(
      `cross-reference entry does not fit its fixed width (§7.5.4): ${first} ${generation}`,
    );
  }
  return `${String(first).padStart(10, '0')} ${String(generation).padStart(5, '0')} ${keyword} \n`;
}

/**
 * Group sorted object numbers into the contiguous runs §7.5.4 calls
 * subsections: "Each cross-reference subsection shall contain entries for a
 * contiguous range of object numbers."
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

/**
 * Build the trailer for an update section (§7.5.6).
 *
 * Everything from the previous trailer is carried over — "whether modified or
 * not" — with two exceptions the clause names: the old `/Prev` is dropped and
 * a new one is written. `/Size` is recomputed because Table 15 defines it over
 * "the combination of the original section and all update sections", so an
 * update that adds a higher object number has to raise it.
 */
function buildTrailer(previous: CosDict, previousXrefOffset: number, size: number): CosDict {
  const entries = new Map<string, CosObject>(previous.entries);
  entries.set('Size', { kind: 'integer', value: size });
  entries.set('Prev', { kind: 'integer', value: previousXrefOffset });
  // A hybrid-reference file's XRefStm (§7.5.8.4 Table 19) describes a stream
  // belonging to the *previous* section. Carrying it into this trailer would
  // claim the update has a cross-reference stream it did not write.
  entries.delete('XRefStm');
  return { kind: 'dict', entries };
}

export interface AppendUpdateResult {
  /** The complete updated file: the original bytes, then the update. */
  readonly bytes: Uint8Array;
  /** Offset of the update's `xref` keyword, for whatever appends next. */
  readonly xrefOffset: number;
}

/**
 * Append an incremental update, leaving the original bytes untouched.
 *
 * The result always starts with `input.original` byte for byte; that is the
 * first thing ADR-0005 asks to be measured, and it is asserted here as well so
 * a mistake cannot leave the module quietly.
 */
export function appendUpdate(input: AppendUpdateInput): AppendUpdateResult {
  const { original, previousXrefOffset, previousTrailer, objects, deleted = [] } = input;
  const origin = input.origin ?? 0;

  if (objects.length === 0 && deleted.length === 0) {
    throw new RangeError(
      'an incremental update shall contain entries for the objects it changed (§7.5.6); nothing was supplied',
    );
  }

  const changed = new Map<number, { generation: number; offset: number | null }>();
  for (const { objectNumber } of [...objects, ...deleted]) {
    if (objectNumber < 1) {
      // NOTE 3 of §7.5.4: "cross reference subsections of incremental updates
      // can never have an object number of zero".
      throw new RangeError(
        `an incremental update shall not write object number ${objectNumber} (§7.5.4 NOTE 3)`,
      );
    }
  }

  const out = new ByteWriter();
  out.bytes(original);
  // §7.5.5 requires %%EOF on a line of its own; if the original did not end
  // with an EOL the appended object would continue that line.
  const lastByte = original.at(-1);
  if (lastByte !== 0x0a && lastByte !== 0x0d) {
    out.ascii('\n');
  }

  for (const { objectNumber, generationNumber, object } of objects) {
    if (changed.has(objectNumber)) {
      throw new RangeError(
        `object ${objectNumber} was supplied twice in one update — an object number identifies one object (R-7.3.10-6)`,
      );
    }
    // Offsets are measured from the header, not from byte 0 (§7.5.2).
    changed.set(objectNumber, { generation: generationNumber, offset: out.length - origin });
    writeIndirectObject(out, objectNumber, generationNumber, object);
  }
  for (const { objectNumber, generationNumber } of deleted) {
    if (changed.has(objectNumber)) {
      throw new RangeError(
        `object ${objectNumber} is both written and deleted in one update (§7.5.6)`,
      );
    }
    changed.set(objectNumber, { generation: generationNumber, offset: null });
  }

  const xrefOffset = out.length - origin;
  out.ascii('xref\n');
  const numbers = [...changed.keys()].sort((a, b) => a - b);
  for (const { start, count } of subsections(numbers)) {
    out.ascii(`${start} ${count}\n`);
    for (let number = start; number < start + count; number += 1) {
      const entry = changed.get(number);
      if (entry === undefined) {
        throw new Error(`subsection covers object ${number} but it was not collected`);
      }
      out.ascii(
        entry.offset === null
          ? // §7.5.4: a free entry's first field is the next free object; 0
            // links back to the head of the list.
            xrefEntry(0, entry.generation, 'f')
          : xrefEntry(entry.offset, entry.generation, 'n'),
      );
    }
  }

  // Table 15: Size is "1 greater than the highest object number defined in the
  // PDF file" across the original and every update section.
  const previousSize = dictGetRaw(previousTrailer, 'Size');
  const previousHighest =
    previousSize?.kind === 'integer' ? previousSize.value : (numbers.at(-1) ?? 0) + 1;
  const size = Math.max(previousHighest, (numbers.at(-1) ?? 0) + 1);

  out.ascii('trailer\n');
  writeObject(out, buildTrailer(previousTrailer, previousXrefOffset, size));
  out.ascii(`\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const bytes = out.toUint8Array();
  assertOriginalIntact(original, bytes);
  return { bytes, xrefOffset };
}

/**
 * §7.5.6 — "leaving its original contents intact".
 *
 * Checked here rather than only in tests: this is the property the whole
 * module exists to provide, and a caller has no way to tell it was violated
 * short of comparing the bytes itself.
 */
function assertOriginalIntact(original: Uint8Array, produced: Uint8Array): void {
  if (produced.length < original.length) {
    throw new Error(
      `an incremental update shall append (§7.5.6); the result is ${produced.length} bytes, shorter than the ${original.length} it started from`,
    );
  }
  for (let i = 0; i < original.length; i += 1) {
    if (original[i] !== produced[i]) {
      throw new Error(
        `an incremental update shall leave the original contents intact (§7.5.6); byte ${i} changed from ${original[i]} to ${produced[i]}`,
      );
    }
  }
}

/**
 * Append an update to a parsed document, taking the previous section's offset
 * and trailer from it.
 *
 * The document must have been produced from `original`; the offsets recorded
 * in it are meaningless against any other bytes.
 */
export function appendUpdateTo(
  doc: PdfDocument,
  objects: readonly WritableObject[],
  deleted?: readonly DeletedObject[],
): AppendUpdateResult {
  const startxref = findLastStartxref(doc.bytes);
  if (startxref === null) {
    throw new Error('no startxref found, so the previous cross-reference section cannot be named (§7.5.5)');
  }
  return appendUpdate({
    original: doc.bytes,
    previousXrefOffset: startxref,
    previousTrailer: doc.trailer,
    objects,
    ...(deleted === undefined ? {} : { deleted }),
    origin: doc.origin,
  });
}

/** `startxref` as bytes; the module stays free of Node-only globals. */
const STARTXREF = [0x73, 0x74, 0x61, 0x72, 0x74, 0x78, 0x72, 0x65, 0x66];

/** The value the file's last `startxref` carries (§7.5.5). */
function findLastStartxref(bytes: Uint8Array): number | null {
  let at = -1;
  outer: for (let i = bytes.length - STARTXREF.length; i >= 0; i -= 1) {
    for (let j = 0; j < STARTXREF.length; j += 1) {
      if (bytes[i + j] !== STARTXREF[j]) {
        continue outer;
      }
    }
    at = i;
    break;
  }
  if (at < 0) {
    return null;
  }

  let i = at + STARTXREF.length;
  for (; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte !== 0x20 && byte !== 0x0a && byte !== 0x0d) {
      break;
    }
  }
  let value = 0;
  let seen = false;
  for (; i < bytes.length; i += 1) {
    const byte = bytes[i];
    if (byte === undefined || byte < 0x30 || byte > 0x39) {
      break;
    }
    seen = true;
    value = value * 10 + (byte - 0x30);
  }
  return seen ? value : null;
}
