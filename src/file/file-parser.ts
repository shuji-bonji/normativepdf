/**
 * File-structure parser — ISO 32000-2 §7.5: header, classic
 * cross-reference table, trailer, startxref, and the Prev chain.
 *
 * Scope and stance:
 * - Strict layer (like the object parser): what §7.5 does not permit is an
 *   error. Recovery parsing of broken files is a separate stage-0 layer.
 * - Functional requirements are enforced (header present, table format,
 *   Size/Root available) because nothing works without them. Conformance
 *   checking beyond that is pdf-verify-mcp's job (DESIGN §4.2), not this
 *   parser's.
 * - Cross-reference *streams* (§7.5.8, PDF 1.5+) are not handled yet; a
 *   file whose startxref points at an indirect object raises a clear
 *   "not supported" error rather than a confusing syntax error.
 *
 * Clause anchors used throughout:
 * - §7.5.2: the file begins with %PDF– and "byte offsets shall be
 *   calculated from the PERCENT SIGN" — arbitrary bytes may precede the
 *   header, so every offset below is relative to `origin`.
 * - §7.5.4: each cross-reference entry is exactly 20 bytes; the 2-byte
 *   EOL is one of SP CR, SP LF, CR LF. Comments are not permitted between
 *   xref and trailer — hence this module reads raw bytes, not tokens.
 * - §7.5.5: trailer dictionary; Size and Root are required (Table 15);
 *   the file ends startxref / offset / %%EOF.
 * - §7.3.10: a reference to an undefined object reads as null
 *   (R-7.3.10-13/14) — applied here, in the resolver, not in the object
 *   parser.
 */

import type { CosDict, CosObject, CosRef } from '../cos/types.js';
import { COS_NULL, dictGet } from '../cos/types.js';
import { ByteCursor } from '../syntax/byte-cursor.js';
import { ParseError, parseIndirectObject, parseObject } from '../syntax/object-parser.js';
import { TokenReader } from '../syntax/token-reader.js';

/** §7.5.4 — in-use entry: `nnnnnnnnnn ggggg n`. */
export interface XrefInUse {
  readonly type: 'in-use';
  /** Byte offset from the beginning of the PDF file (i.e. from `origin`). */
  readonly offset: number;
  readonly generation: number;
}

/** §7.5.4 — free entry: `nnnnnnnnnn ggggg f` (first field = next free object number). */
export interface XrefFree {
  readonly type: 'free';
  readonly nextFree: number;
  readonly generation: number;
}

export type XrefEntry = XrefInUse | XrefFree;

/** One cross-reference section (one `xref` keyword and its subsections + trailer). */
export interface XrefSection {
  readonly entries: ReadonlyMap<number, XrefEntry>;
  readonly trailer: CosDict;
}

const HEADER = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-
const STARTXREF = [0x73, 0x74, 0x61, 0x72, 0x74, 0x78, 0x72, 0x65, 0x66]; // startxref
const EOF_MARKER = [0x25, 0x25, 0x45, 0x4f, 0x46]; // %%EOF

/**
 * A parsed PDF file: merged cross-reference information plus an object
 * resolver. Construction validates structure; it does not validate
 * conformance.
 */
export class PdfDocument {
  readonly bytes: Uint8Array;
  /** Byte index of the PERCENT SIGN of %PDF- — the offset origin (§7.5.2). */
  readonly origin: number;
  /** Header version, e.g. "1.7" or "2.0" (§7.5.2). */
  readonly version: string;
  /** Trailer dictionary of the most recent cross-reference section (§7.5.5). */
  readonly trailer: CosDict;
  /** Merged cross-reference table — newest section wins per object number (§7.5.4/§7.5.6). */
  readonly xref: ReadonlyMap<number, XrefEntry>;

  readonly #cache = new Map<string, CosObject>();
  readonly #inFlight = new Set<string>();

  constructor(
    bytes: Uint8Array,
    origin: number,
    version: string,
    trailer: CosDict,
    xref: ReadonlyMap<number, XrefEntry>,
  ) {
    this.bytes = bytes;
    this.origin = origin;
    this.version = version;
    this.trailer = trailer;
    this.xref = xref;
  }

  /**
   * Fetch the indirect object `objectNumber generationNumber`.
   * Undefined, free, or generation-mismatched objects read as the null
   * object (R-7.3.10-13/14, R-7.3.10-6).
   */
  getObject(objectNumber: number, generationNumber = 0): CosObject {
    const key = `${objectNumber} ${generationNumber}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const entry = this.xref.get(objectNumber);
    if (entry === undefined || entry.type === 'free' || entry.generation !== generationNumber) {
      return COS_NULL;
    }

    if (this.#inFlight.has(key)) {
      throw new ParseError(
        `cyclic indirect-object dependency at object ${objectNumber} ${generationNumber}`,
        this.origin + entry.offset,
      );
    }
    this.#inFlight.add(key);
    try {
      const cur = new ByteCursor(this.bytes);
      cur.seek(this.origin + entry.offset);
      const reader = new TokenReader(cur);
      const parsed = parseIndirectObject(reader, {
        resolveStreamLength: (ref: CosRef): number | undefined => {
          const resolved = this.getObject(ref.objectNumber, ref.generationNumber);
          return resolved.kind === 'integer' ? resolved.value : undefined;
        },
      });
      if (parsed.objectNumber !== objectNumber || parsed.generationNumber !== generationNumber) {
        throw new ParseError(
          `cross-reference table points object ${objectNumber} ${generationNumber} at a definition of ` +
            `${parsed.objectNumber} ${parsed.generationNumber} (§7.5.4: entries specify the byte offset of that object)`,
          this.origin + entry.offset,
        );
      }
      this.#cache.set(key, parsed.object);
      return parsed.object;
    } finally {
      this.#inFlight.delete(key);
    }
  }

  /** If `value` is a reference, resolve it (undefined → null per R-7.3.10-13); otherwise identity. */
  resolve(value: CosObject): CosObject {
    return value.kind === 'ref'
      ? this.getObject(value.objectNumber, value.generationNumber)
      : value;
  }

  /** The document catalog — trailer Root resolved (Table 15: required, indirect). */
  get catalog(): CosObject {
    const root = dictGet(this.trailer, 'Root');
    if (root === undefined) {
      throw new ParseError('trailer shall have a Root entry (§7.5.5 Table 15)', this.origin);
    }
    return this.resolve(root);
  }
}

/** Parse a complete PDF file (classic cross-reference tables). */
export function parsePdf(bytes: Uint8Array): PdfDocument {
  const origin = indexOfSeq(bytes, HEADER, 0);
  if (origin < 0) {
    throw new ParseError('no %PDF- header found (§7.5.2)', 0);
  }
  const version = readHeaderVersion(bytes, origin);
  const startxref = readStartxref(bytes);

  // Walk the Prev chain, newest section first (§7.5.4, §7.5.6).
  const sections: XrefSection[] = [];
  const visited = new Set<number>();
  let offset: number | undefined = startxref;
  while (offset !== undefined) {
    if (visited.has(offset)) {
      throw new ParseError(`cyclic Prev chain revisits offset ${offset} (§7.5.5 Table 15)`, offset);
    }
    visited.add(offset);
    const section = parseXrefSection(bytes, origin, offset);
    sections.push(section);
    const prev = dictGet(section.trailer, 'Prev');
    if (prev === undefined) {
      offset = undefined;
    } else if (prev.kind === 'integer' && prev.value >= 0) {
      offset = prev.value;
    } else {
      throw new ParseError('trailer Prev shall be a direct integer (§7.5.5 Table 15)', offset);
    }
  }

  const newest = sections[0];
  if (newest === undefined) {
    throw new ParseError('no cross-reference section found (§7.5.4)', startxref);
  }

  const sizeValue = dictGet(newest.trailer, 'Size');
  if (sizeValue === undefined || sizeValue.kind !== 'integer' || sizeValue.value < 1) {
    throw new ParseError(
      'trailer shall have an integer Size entry (§7.5.5 Table 15; shall not be an indirect reference)',
      startxref,
    );
  }
  const size = sizeValue.value;

  // Merge: the newest entry for each object number wins; entries with a
  // number greater than Size are "ignored and defined to be missing by a
  // PDF reader" (Table 15, Size).
  const merged = new Map<number, XrefEntry>();
  for (const section of sections) {
    for (const [num, entry] of section.entries) {
      if (num > size) {
        continue;
      }
      if (!merged.has(num)) {
        merged.set(num, entry);
      }
    }
  }

  // §7.5.4: "The first entry in the table (object number 0) shall always be
  // free and shall have a generation number of 65,535".
  const zero = merged.get(0);
  if (zero === undefined || zero.type !== 'free' || zero.generation !== 65535) {
    throw new ParseError(
      'cross-reference entry for object 0 shall be free with generation 65535 (§7.5.4)',
      startxref,
    );
  }

  return new PdfDocument(bytes, origin, version, newest.trailer, merged);
}

/**
 * §7.5.2 — "%PDF–1.n" or "%PDF–2.n" (n a single digit) followed by a
 * single EOL marker.
 */
function readHeaderVersion(bytes: Uint8Array, origin: number): string {
  const cur = new ByteCursor(bytes, origin + HEADER.length);
  const major = cur.next();
  const dot = cur.next();
  const minor = cur.next();
  if ((major !== 0x31 && major !== 0x32) || dot !== 0x2e || minor < 0x30 || minor > 0x39) {
    throw new ParseError(
      'file header shall be %PDF-1.n or %PDF-2.n with n a single digit (§7.5.2)',
      origin,
    );
  }
  if (!cur.tryConsumeEol()) {
    throw new ParseError('file header shall be followed by a single EOL marker (§7.5.2)', cur.pos);
  }
  return `${String.fromCharCode(major)}.${String.fromCharCode(minor)}`;
}

/**
 * §7.5.5 — from the end of the file: %%EOF on the last line, preceded by
 * the byte offset and the keyword startxref, one per line.
 */
function readStartxref(bytes: Uint8Array): number {
  const sxPos = lastIndexOfSeq(bytes, STARTXREF);
  if (sxPos < 0) {
    throw new ParseError('no startxref keyword found (§7.5.5)', bytes.length);
  }
  const cur = new ByteCursor(bytes, sxPos + STARTXREF.length);
  if (!cur.tryConsumeEol()) {
    throw new ParseError('startxref shall be on its own line (§7.5.5)', cur.pos);
  }
  const offset = readIntegerLine(cur, 'startxref offset');
  if (!cur.matches(EOF_MARKER)) {
    throw new ParseError('the last line of the file shall contain %%EOF (§7.5.5)', cur.pos);
  }
  cur.advance(EOF_MARKER.length);
  cur.tryConsumeEol();
  if (!cur.atEnd) {
    throw new ParseError('the last line of the file shall contain only %%EOF (§7.5.5)', cur.pos);
  }
  return offset;
}

/**
 * §7.5.4 — one cross-reference section: the keyword xref, one or more
 * subsections of fixed 20-byte entries, then the trailer dictionary.
 * Raw-byte reading is deliberate: comments are not permitted here, and
 * the entry format is fixed, so the token layer must not be involved.
 */
function parseXrefSection(bytes: Uint8Array, origin: number, offset: number): XrefSection {
  const cur = new ByteCursor(bytes, origin + offset);

  if (cur.matches([0x78, 0x72, 0x65, 0x66])) {
    cur.advance(4);
  } else {
    // A digit here means startxref points at "N G obj" — a cross-reference
    // stream (§7.5.8), which this slice does not read yet.
    const b = cur.peek();
    if (b >= 0x30 && b <= 0x39) {
      throw new ParseError(
        'startxref points at an indirect object: cross-reference streams (§7.5.8) are not supported yet',
        cur.pos,
      );
    }
    throw new ParseError(
      'cross-reference section shall begin with the keyword xref (§7.5.4)',
      cur.pos,
    );
  }
  if (!cur.tryConsumeEol()) {
    throw new ParseError('keyword xref shall be on a line of its own (§7.5.4)', cur.pos);
  }

  const entries = new Map<number, XrefEntry>();
  for (;;) {
    const b = cur.peek();
    if (b >= 0x30 && b <= 0x39) {
      readSubsection(cur, entries);
      continue;
    }
    break;
  }

  if (!cur.matches([0x74, 0x72, 0x61, 0x69, 0x6c, 0x65, 0x72])) {
    throw new ParseError(
      'cross-reference section shall be followed by the keyword trailer (§7.5.5); comments are not permitted between xref and trailer (§7.5.4)',
      cur.pos,
    );
  }
  cur.advance(7);

  const reader = new TokenReader(cur);
  const trailer = parseObject(reader);
  if (trailer.kind !== 'dict') {
    throw new ParseError('keyword trailer shall be followed by a dictionary (§7.5.5)', cur.pos);
  }

  return { entries, trailer };
}

/**
 * §7.5.4 — subsection: "two integers separated by a SPACE and terminated
 * by an end-of-line marker", then exactly `count` 20-byte entries.
 */
function readSubsection(cur: ByteCursor, entries: Map<number, XrefEntry>): void {
  const first = readDigits(cur, 'subsection first object number');
  if (cur.next() !== 0x20) {
    throw new ParseError(
      'subsection header integers shall be separated by a single SPACE (§7.5.4)',
      cur.pos - 1,
    );
  }
  const count = readDigits(cur, 'subsection entry count');
  if (!cur.tryConsumeEol()) {
    throw new ParseError(
      'subsection header shall be terminated by an EOL marker (§7.5.4)',
      cur.pos,
    );
  }

  for (let i = 0; i < count; i += 1) {
    const objectNumber = first + i;
    const entry = readEntry(cur);
    if (entries.has(objectNumber)) {
      throw new ParseError(
        `object number ${objectNumber} shall not have an entry in more than one subsection within a single section (§7.5.4)`,
        cur.pos - 20,
      );
    }
    entries.set(objectNumber, entry);
  }
}

/**
 * §7.5.4 — one entry, exactly 20 bytes:
 * 10 digits, SP, 5 digits, SP, keyword n or f, then a 2-character EOL
 * that is one of SP CR, SP LF, CR LF.
 */
function readEntry(cur: ByteCursor): XrefEntry {
  const start = cur.pos;
  const firstField = readFixedDigits(cur, 10);
  if (cur.next() !== 0x20) {
    throw new ParseError('xref entry fields shall be separated by a single SPACE (§7.5.4)', start);
  }
  const generation = readFixedDigits(cur, 5);
  if (cur.next() !== 0x20) {
    throw new ParseError('xref entry fields shall be separated by a single SPACE (§7.5.4)', start);
  }
  const keyword = cur.next();
  if (keyword !== 0x6e && keyword !== 0x66) {
    throw new ParseError('xref entry keyword shall be n or f (§7.5.4)', start);
  }
  const e1 = cur.next();
  const e2 = cur.next();
  const eolOk =
    (e1 === 0x20 && e2 === 0x0d) || (e1 === 0x20 && e2 === 0x0a) || (e1 === 0x0d && e2 === 0x0a);
  if (!eolOk) {
    throw new ParseError(
      'xref entry shall end with a 2-character EOL: SP CR, SP LF, or CR LF (§7.5.4; entries are exactly 20 bytes)',
      start,
    );
  }

  if (keyword === 0x6e) {
    return { type: 'in-use', offset: firstField, generation };
  }
  return { type: 'free', nextFree: firstField, generation };
}

function readFixedDigits(cur: ByteCursor, width: number): number {
  let value = 0;
  for (let i = 0; i < width; i += 1) {
    const b = cur.next();
    if (b < 0x30 || b > 0x39) {
      throw new ParseError(
        `expected a ${width}-digit zero-padded number in xref entry (§7.5.4)`,
        cur.pos - 1,
      );
    }
    value = value * 10 + (b - 0x30);
  }
  return value;
}

function readDigits(cur: ByteCursor, what: string): number {
  let value = 0;
  let seen = false;
  for (;;) {
    const b = cur.peek();
    if (b < 0x30 || b > 0x39) {
      break;
    }
    seen = true;
    value = value * 10 + (b - 0x30);
    cur.advance();
  }
  if (!seen) {
    throw new ParseError(`expected digits for ${what} (§7.5.4)`, cur.pos);
  }
  return value;
}

/** Integer on a line of its own (startxref offset, §7.5.5). */
function readIntegerLine(cur: ByteCursor, what: string): number {
  const value = readDigits(cur, what);
  if (!cur.tryConsumeEol()) {
    throw new ParseError(`${what} shall be on a line of its own (§7.5.5)`, cur.pos);
  }
  return value;
}

function indexOfSeq(bytes: Uint8Array, seq: readonly number[], from: number): number {
  outer: for (let i = from; i <= bytes.length - seq.length; i += 1) {
    for (let j = 0; j < seq.length; j += 1) {
      if (bytes[i + j] !== seq[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

function lastIndexOfSeq(bytes: Uint8Array, seq: readonly number[]): number {
  outer: for (let i = bytes.length - seq.length; i >= 0; i -= 1) {
    for (let j = 0; j < seq.length; j += 1) {
      if (bytes[i + j] !== seq[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}
