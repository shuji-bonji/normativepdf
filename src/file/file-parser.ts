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
 * - Cross-reference streams (§7.5.8) and object streams (§7.5.7) are
 *   handled; their decoding makes `parsePdf` and `getObject` async
 *   (ADR-0003). Hybrid-reference files (XRefStm, §7.5.8.4) are not read
 *   yet — the classic table wins, which §7.5.8.4 defines as acceptable
 *   for readers that do not support the hybrid mechanism.
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
import { isWhitespace } from '../syntax/byte-classes.js';
import { ByteCursor } from '../syntax/byte-cursor.js';
import { ParseError, parseIndirectObject, parseObject } from '../syntax/object-parser.js';
import { TokenReader } from '../syntax/token-reader.js';
import { loadObjectStream, objectFromStream, type ParsedObjectStream } from './object-stream.js';
import { parseXrefStreamSection } from './xref-stream.js';

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

/** §7.5.8.3 Table 18 type 2 — compressed object; generation is implicitly 0. */
export interface XrefCompressed {
  readonly type: 'compressed';
  /** Object number of the object stream holding this object. */
  readonly streamObjectNumber: number;
  /** Index of this object within the object stream (0..N-1). */
  readonly indexInStream: number;
}

/**
 * §7.5.8.3 — an entry type other than 0/1/2 "shall be interpreted as a
 * reference to the null object" (forward compatibility). Recorded so a
 * newer section's unknown entry correctly shadows an older definition.
 */
export interface XrefUnknown {
  readonly type: 'unknown';
  readonly rawType: number;
}

export type XrefEntry = XrefInUse | XrefFree | XrefCompressed | XrefUnknown;

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
  readonly #objStmCache = new Map<number, Promise<ParsedObjectStream>>();

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
   * Undefined, free, unknown-typed (§7.5.8.3), or generation-mismatched
   * objects read as the null object (R-7.3.10-13/14, R-7.3.10-6).
   * Async because compressed objects live in filtered object streams.
   */
  async getObject(objectNumber: number, generationNumber = 0): Promise<CosObject> {
    const key = `${objectNumber} ${generationNumber}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const entry = this.xref.get(objectNumber);
    if (entry === undefined || entry.type === 'free' || entry.type === 'unknown') {
      return COS_NULL;
    }

    if (entry.type === 'in-use') {
      if (entry.generation !== generationNumber) {
        return COS_NULL;
      }
      return this.#parseInUse(key, objectNumber, generationNumber, entry);
    }

    // compressed: the generation number shall be implicitly 0 (§7.5.7)
    if (generationNumber !== 0) {
      return COS_NULL;
    }
    const objStm = await this.#objectStream(entry.streamObjectNumber);
    const object = objectFromStream(
      objStm,
      entry.indexInStream,
      objectNumber,
      entry.streamObjectNumber,
    );
    this.#cache.set(key, object);
    return object;
  }

  /** Parse an uncompressed in-use object at its recorded offset (synchronous). */
  #parseInUse(
    key: string,
    objectNumber: number,
    generationNumber: number,
    entry: XrefInUse,
  ): CosObject {
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
        resolveStreamLength: (ref: CosRef): number | undefined => this.#resolveLengthSync(ref),
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

  /**
   * Synchronous /Length resolution for stream parsing. A Length object
   * stored *inside an object stream* would need async decoding mid-parse;
   * §7.5.7 forbids that placement only for object streams' own Length, so
   * it is conceivable for ordinary streams — rejected explicitly until a
   * real file demands it.
   */
  #resolveLengthSync(ref: CosRef): number | undefined {
    const cached = this.#cache.get(`${ref.objectNumber} ${ref.generationNumber}`);
    if (cached !== undefined) {
      return cached.kind === 'integer' ? cached.value : undefined;
    }
    const entry = this.xref.get(ref.objectNumber);
    if (entry === undefined || entry.type === 'free' || entry.type === 'unknown') {
      return undefined;
    }
    if (entry.type === 'compressed') {
      throw new ParseError(
        `stream Length ${ref.objectNumber} ${ref.generationNumber} R is stored inside an object stream — not supported yet`,
        this.origin,
      );
    }
    if (entry.generation !== ref.generationNumber) {
      return undefined;
    }
    const resolved = this.#parseInUse(
      `${ref.objectNumber} ${ref.generationNumber}`,
      ref.objectNumber,
      ref.generationNumber,
      entry,
    );
    return resolved.kind === 'integer' ? resolved.value : undefined;
  }

  /** Load and index an object stream once; concurrent requests share the promise. */
  #objectStream(streamObjectNumber: number): Promise<ParsedObjectStream> {
    const existing = this.#objStmCache.get(streamObjectNumber);
    if (existing !== undefined) {
      return existing;
    }
    const loading = (async (): Promise<ParsedObjectStream> => {
      // §7.5.5 Table 15: Encrypt is "required if document is encrypted"
      // (§7.6). Object streams in an encrypted file are encrypted as whole
      // streams; inflating the ciphertext would fail with a misleading
      // filter error (observed: veraPDF-corpus "7.16-t01-fail-a.pdf",
      // "6-1-3-t02-fail-a.pdf" reported "FlateDecode failed"). Decryption
      // is not implemented — name the real reason instead.
      if (dictGet(this.trailer, 'Encrypt') !== undefined) {
        throw new ParseError(
          'encrypted PDF: stream decryption is not supported yet (§7.6; trailer Encrypt entry, §7.5.5 Table 15)',
          this.origin,
        );
      }
      const entry = this.xref.get(streamObjectNumber);
      if (entry === undefined || entry.type !== 'in-use') {
        throw new ParseError(
          `object stream ${streamObjectNumber} shall be an ordinary in-use object (§7.5.7: stream objects shall not be stored in an object stream)`,
          this.origin,
        );
      }
      if (entry.generation !== 0) {
        throw new ParseError(
          `the generation number of an object stream shall be zero (§7.5.7), got ${entry.generation}`,
          this.origin,
        );
      }
      const obj = this.#parseInUse(`${streamObjectNumber} 0`, streamObjectNumber, 0, entry);
      if (obj.kind !== 'stream') {
        throw new ParseError(
          `object ${streamObjectNumber} is referenced as an object stream but is a ${obj.kind}`,
          this.origin,
        );
      }
      return loadObjectStream(obj, streamObjectNumber);
    })();
    this.#objStmCache.set(streamObjectNumber, loading);
    return loading;
  }

  /** If `value` is a reference, resolve it (undefined → null per R-7.3.10-13); otherwise identity. */
  async resolve(value: CosObject): Promise<CosObject> {
    return value.kind === 'ref'
      ? this.getObject(value.objectNumber, value.generationNumber)
      : value;
  }

  /** The document catalog — trailer Root resolved (Table 15: required, indirect). */
  async getCatalog(): Promise<CosObject> {
    const root = dictGet(this.trailer, 'Root');
    if (root === undefined) {
      throw new ParseError('trailer shall have a Root entry (§7.5.5 Table 15)', this.origin);
    }
    return this.resolve(root);
  }
}

/** Parse a complete PDF file (classic cross-reference tables and cross-reference streams). */
export async function parsePdf(bytes: Uint8Array): Promise<PdfDocument> {
  const origin = indexOfSeq(bytes, HEADER, 0);
  if (origin < 0) {
    throw new ParseError('no %PDF- header found (§7.5.2)', 0);
  }
  const version = readHeaderVersion(bytes, origin);
  const startxref = readStartxref(bytes);

  // Walk the Prev chain, newest section first (§7.5.4, §7.5.6). Prev works
  // identically for tables (Table 15) and streams (Table 17). Hybrid files'
  // XRefStm (Table 19) is deliberately not followed yet.
  const sections: XrefSection[] = [];
  const visited = new Set<number>();
  let offset: number | undefined = startxref;
  while (offset !== undefined) {
    if (visited.has(offset)) {
      throw new ParseError(`cyclic Prev chain revisits offset ${offset} (§7.5.5 Table 15)`, offset);
    }
    visited.add(offset);
    const section = await parseSection(bytes, origin, offset);
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

/** Dispatch one cross-reference section: classic table (§7.5.4) or stream (§7.5.8). */
async function parseSection(
  bytes: Uint8Array,
  origin: number,
  offset: number,
): Promise<XrefSection> {
  const cur = new ByteCursor(bytes, origin + offset);
  // Measured recovery (ROADMAP: 嘘の startxref, first live case): §7.5.5
  // requires the offset of the section itself, but veraPDF-corpus
  // "6-6-2-3-2-t01-pass-c.pdf" — a PDF/A *pass* specimen — points startxref
  // at the EOL immediately before the xref keyword. Leading white-space is
  // functionally unambiguous (§7.2.3: white-space separates syntactic
  // constructs), so it is skipped before dispatching; anything else at the
  // offset is still an error.
  while (isWhitespace(cur.peek())) {
    cur.advance();
  }
  if (cur.matches(XREF_KEYWORD)) {
    return parseXrefSection(bytes, origin, cur.pos - origin);
  }
  const b = cur.peek();
  if (b >= 0x30 && b <= 0x39) {
    // "N G obj" — the startxref offset shall point at the cross-reference
    // stream object itself (§7.5.8.1).
    return parseXrefStreamSection(bytes, origin, cur.pos - origin);
  }
  throw new ParseError(
    'cross-reference section shall begin with the keyword xref (§7.5.4) or be a cross-reference stream object (§7.5.8.1)',
    cur.pos,
  );
}

const XREF_KEYWORD = [0x78, 0x72, 0x65, 0x66]; // xref

/**
 * §7.5.4 — one cross-reference section: the keyword xref, one or more
 * subsections of fixed 20-byte entries, then the trailer dictionary.
 * Raw-byte reading is deliberate: comments are not permitted here, and
 * the entry format is fixed, so the token layer must not be involved.
 */
function parseXrefSection(bytes: Uint8Array, origin: number, offset: number): XrefSection {
  const cur = new ByteCursor(bytes, origin + offset);

  if (cur.matches(XREF_KEYWORD)) {
    cur.advance(4);
  } else {
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
    // White-space is a separator here per the general rule of §7.2.3;
    // what §7.5.4 prohibits between xref and trailer is *comments* — so
    // Table 1 white-space is skipped, '%' is not. (The PDF Association's
    // own incremental-save example puts a blank line before `trailer`.)
    while (isWhitespace(cur.peek())) {
      cur.advance();
    }
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

  // R-7.5.4-31 ("the first entry in the table shall be free with generation
  // 65,535") is deliberately NOT enforced here. It is a conformance rule,
  // not a functional one: a free entry's generation plays no part in object
  // resolution (free → null either way), and this parser enforces only what
  // is needed for the file to function (module header; DESIGN §4.2 puts
  // conformance checking on pdf-verify-mcp). Measured demand: veraPDF-corpus
  // "TWG test suite A029-pdfa2-pass-b/-d.pdf" are PDF/A *pass* specimens
  // whose free-list head reads `0000000019 00000 f`. For cross-reference
  // streams no such rule exists at all — a width-0 third field defaults the
  // generation to 0 (§7.5.8.2 Table 17 W; §7.5.8.3 Table 18 "Default
  // value: 0"), which veraPDF-corpus writes as /W [1 2 0] in 493 of 2907
  // specimens.
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
