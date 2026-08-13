/**
 * Embedded font programs and the dictionaries that describe them —
 * ISO 32000-2 §9.7.4 (CIDFonts), §9.8 (font descriptors), §9.9 (embedded font
 * programs, Table 124 / Table 125).
 *
 * **Why this exists as a type, not as a check.**
 * The defect this module is built against (pdf-writer-mcp W-2) was: a CFF-based
 * OpenType program embedded as `/Subtype /CIDFontType2` + `/FontFile2`. That
 * violates two shalls at once — R-9.9.1-33/-34 (a `FontFile2` program shall
 * conform to the TrueType Reference Manual and shall include "glyf", "head",
 * "hhea", "hmtx", "loca", "maxp"; an OTTO container has neither "glyf" nor
 * "loca") and R-9.7.4.2-3 (when a CIDFont embeds a CFF program, `FontFile3`'s
 * `/Subtype` shall be `CIDFontType0C` or `OpenType`).
 *
 * It survived because the font program and the dictionary were decided in two
 * different places: something subsetted the bytes, and something else picked
 * the dictionary type. Nothing in between made the two agree. The repair that
 * followed (pdf-writer-mcp `font-conformance.ts`) opens the finished document
 * and rewrites the dictionaries — correct, but it means the wrong file is
 * written first and fixed afterwards.
 *
 * So here the descriptor is **derived from the bytes**: `sniffFontProgram`
 * reads the sfnt/CFF header and reports what the program actually is, and
 * `buildType0Font` maps that fact to the only dictionary shape the
 * specification allows for it:
 *
 * | program (measured from bytes) | CIDFont `/Subtype` | descriptor key | stream `/Subtype` |
 * |---|---|---|---|
 * | sfnt with "glyf"     | `/CIDFontType2` | `/FontFile2` | — (`/Length1` required) |
 * | sfnt with "CFF " (OTTO) | `/CIDFontType0` | `/FontFile3` | `/OpenType` |
 * | bare CFF             | `/CIDFontType0` | `/FontFile3` | `/CIDFontType0C` |
 *
 * The caller never names the CIDFont subtype, so it cannot name it wrongly.
 *
 * **What this module does not do.** It does not subset, it does not compute
 * widths, and it does not verify that the glyph for CID 0 exists
 * (R-9.7.4.2-13) — that needs the glyph data, not the table directory. Those
 * remain the caller's, and a document's conformance remains pdf-verify-mcp's
 * answer (DESIGN §4.2).
 */

import type { CosDict, CosObject, CosRef, CosStream } from '../cos/types.js';

export class FontProgramError extends Error {
  override readonly name = 'FontProgramError';
}

/** What the bytes are, as measured — never as claimed. */
export type FontProgramFormat = 'truetype' | 'opentype-cff' | 'bare-cff';

export interface FontProgram {
  readonly format: FontProgramFormat;
  /** sfnt table tags present, in directory order. Empty for a bare CFF. */
  readonly tables: readonly string[];
  /** From "maxp", when there is one. */
  readonly numGlyphs: number | null;
  readonly bytes: Uint8Array;
}

/** Tags a `FontFile2` program shall include (R-9.9.1-34). */
const TRUETYPE_REQUIRED = ['glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp'] as const;

const be32 = (b: Uint8Array, at: number): number =>
  ((b[at] ?? 0) << 24) | ((b[at + 1] ?? 0) << 16) | ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0);
const be16 = (b: Uint8Array, at: number): number => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const tag = (b: Uint8Array, at: number): string =>
  String.fromCharCode(b[at] ?? 0, b[at + 1] ?? 0, b[at + 2] ?? 0, b[at + 3] ?? 0);

/**
 * Decide what a font program is by reading it.
 *
 * The container tells the truth that a file extension does not: a `.otf` is an
 * sfnt whose glyphs may be in a "CFF " table, and that is exactly the case the
 * defect got wrong.
 */
export function sniffFontProgram(bytes: Uint8Array): FontProgram {
  if (bytes.length < 4) {
    throw new FontProgramError('font program is too short to identify (4 bytes minimum)');
  }
  const signature = be32(bytes, 0);
  const asTag = tag(bytes, 0);

  if (asTag === 'ttcf') {
    // R-9.9.1-13's sibling problem: an embedded font file shall consist of
    // exactly one font. A collection carries several, so it cannot be embedded
    // as-is — say so instead of embedding the first one silently.
    throw new FontProgramError(
      'a TrueType/OpenType collection ("ttcf") holds several fonts; an embedded font file shall consist of exactly one (§9.9.1). Extract the face first',
    );
  }

  // Bare CFF: header is major=1, minor=0, hdrSize>=4, offSize in 1..4
  // (Adobe Technical Note #5176 §6). No sfnt directory to read.
  if (
    bytes[0] === 1 &&
    bytes[1] === 0 &&
    (bytes[2] ?? 0) >= 4 &&
    (bytes[3] ?? 0) >= 1 &&
    (bytes[3] ?? 0) <= 4
  ) {
    return { format: 'bare-cff', tables: [], numGlyphs: null, bytes };
  }

  const isSfnt = signature === 0x00010000 || asTag === 'true' || asTag === 'OTTO';
  if (!isSfnt) {
    throw new FontProgramError(
      `unrecognised font program: leading bytes ${asTag.replace(/[^\x20-\x7e]/g, '.')} are neither an sfnt (00010000 / "true" / "OTTO") nor a bare CFF header`,
    );
  }

  const numTables = be16(bytes, 4);
  const tables: string[] = [];
  const offsets = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i += 1) {
    const at = 12 + i * 16;
    if (at + 16 > bytes.length) {
      throw new FontProgramError('sfnt table directory runs past the end of the font program');
    }
    const name = tag(bytes, at);
    tables.push(name);
    offsets.set(name, { offset: be32(bytes, at + 8), length: be32(bytes, at + 12) });
  }

  const maxp = offsets.get('maxp');
  const numGlyphs =
    maxp !== undefined && maxp.offset + 6 <= bytes.length ? be16(bytes, maxp.offset + 4) : null;

  // "CFF " wins over the signature: OTTO is the usual container for it, but the
  // table directory is what decides where the glyphs live.
  if (tables.includes('CFF ')) {
    return { format: 'opentype-cff', tables, numGlyphs, bytes };
  }
  if (tables.includes('glyf')) {
    return { format: 'truetype', tables, numGlyphs, bytes };
  }
  throw new FontProgramError(
    `sfnt font program has neither a "glyf" nor a "CFF " table, so it carries no glyph outlines this module can embed (tables: ${tables.join(', ') || 'none'})`,
  );
}

/**
 * The stream dictionary key and `/Subtype` that Table 124 assigns to a program.
 * Exported because the mapping is the whole point of the module and worth
 * reading on its own.
 */
export function fontFileEntry(program: FontProgram): {
  readonly key: 'FontFile2' | 'FontFile3';
  readonly subtype: 'OpenType' | 'CIDFontType0C' | null;
  readonly cidFontSubtype: 'CIDFontType0' | 'CIDFontType2';
} {
  switch (program.format) {
    case 'truetype':
      return { key: 'FontFile2', subtype: null, cidFontSubtype: 'CIDFontType2' };
    case 'opentype-cff':
      // R-9.7.4.2-3 allows CIDFontType0C or OpenType for a CFF program; the
      // bytes here are a whole sfnt, so OpenType is the one that describes them
      // (R-9.9.1-45: the program shall conform to ISO/IEC 14496-22).
      return { key: 'FontFile3', subtype: 'OpenType', cidFontSubtype: 'CIDFontType0' };
    case 'bare-cff':
      return { key: 'FontFile3', subtype: 'CIDFontType0C', cidFontSubtype: 'CIDFontType0' };
  }
}

/**
 * R-9.9.2-3: the subset tag shall be exactly six uppercase letters, and
 * different subsets of the same font in one file shall have different tags.
 *
 * Derived from the program bytes so that the same subset always gets the same
 * tag (DESIGN §4.1 determinism) and a different subset almost never collides.
 * A random tag would satisfy the clause too, and would make the output
 * unreproducible — which is why it is not an option here.
 */
export function subsetTag(bytes: Uint8Array): string {
  // FNV-1a over the program; six letters is 26^6 ≈ 3.09e8 buckets.
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  let out = '';
  let value = hash;
  for (let i = 0; i < 6; i += 1) {
    out += String.fromCharCode(65 + (value % 26));
    value = Math.floor(value / 26) + i * 7;
  }
  return out;
}

/**
 * Something the specification says about this program that the module can see
 * but cannot fix, and that no validator will report. Not an error: the bytes
 * are still embedded, and the caller decides what to do.
 */
export interface FontNote {
  readonly clause: string;
  readonly message: string;
}

export interface BuiltType0Font {
  /** The reference to put in `/Resources /Font`. */
  readonly font: CosRef;
  readonly notes: readonly FontNote[];
}

/** Where the built objects go. The caller owns object numbering. */
export interface FontObjectSink {
  /** Store an object and return the reference that names it. */
  allocate(object: CosObject): CosRef;
}

export interface Type0FontSpec {
  /** The embedded program, as measured by `sniffFontProgram`. */
  readonly program: FontProgram;
  /**
   * PostScript name of the font the subset came from, without a tag
   * (R-9.9.2-2 prepends the tag; this module does that so the shape is right).
   */
  readonly postScriptName: string;
  /** Font descriptor entries other than the ones this module owns (§9.8, Table 122). */
  readonly descriptor: ReadonlyMap<string, CosObject>;
  /** `/W` (R-9.7.4.3-3). Omitted when absent — then `/DW` applies. */
  readonly widths?: CosObject;
  /** `/DW`; §9.7.4.3 gives it a default of 1000, so it is optional. */
  readonly defaultWidth?: number;
  /** `/ToUnicode` CMap stream, already built by the caller. */
  readonly toUnicode?: CosRef;
  /** Set false for a full (unsubsetted) embed; then no tag is prepended. */
  readonly subset?: boolean;
}

const name = (value: string): CosObject => ({ kind: 'name', value });
const int = (value: number): CosObject => ({ kind: 'integer', value });
const dict = (entries: Iterable<readonly [string, CosObject]>): CosDict => ({
  kind: 'dict',
  entries: new Map(entries),
});

/**
 * Build the Type 0 font, its descendant CIDFont, the font descriptor and the
 * embedded font stream, and return the reference to put in `/Resources /Font`,
 * together with anything the specification says about the program that this
 * module can see but not repair.
 *
 * Everything that Table 124 ties together is decided here from
 * `spec.program.format`, so no caller can pair a CFF program with `/FontFile2`
 * or a "glyf" program with `/CIDFontType0`.
 */
export function buildType0Font(sink: FontObjectSink, spec: Type0FontSpec): BuiltType0Font {
  const { program } = spec;
  const mapping = fontFileEntry(program);
  const notes: FontNote[] = [];

  if (program.format === 'truetype') {
    const missing = TRUETYPE_REQUIRED.filter((t) => !program.tables.includes(t));
    if (missing.length > 0) {
      throw new FontProgramError(
        `a /FontFile2 program shall include "glyf", "head", "hhea", "hmtx", "loca" and "maxp" (R-9.9.1-34); missing: ${missing.join(', ')}`,
      );
    }
    if (program.tables.includes('cmap')) {
      // R-9.9.1-21: with a CIDFont dictionary the "cmap" table is not needed
      // and shall not be present — the CMap in the Type 0 font does that job.
      //
      // Reported, not refused. Two measured reasons (2026-08-14):
      //   1. It cannot be fixed here. Removing a table means rebuilding the
      //      sfnt directory and every offset in it; that is the subsetter's
      //      job, and this module does not subset.
      //   2. Refusing would reject what real subsetters produce.
      //      pdf-writer-mcp's TrueType output (harfbuzz via `subset-font`)
      //      carries "cmap", and veraPDF judges that document COMPLIANT
      //      (pdfa-3b 146/146) — validators do not look inside font programs,
      //      which is the same blind spot that let W-2 live.
      // So the caller is told, in the same breath as being handed the bytes.
      notes.push({
        clause: 'R-9.9.1-21',
        message:
          'the TrueType program carries a "cmap" table; with a CIDFont dictionary it is not needed and shall not be present. Strip it when subsetting — no validator will report this',
      });
    }
  }

  const baseName =
    spec.subset === false
      ? spec.postScriptName
      : `${subsetTag(program.bytes)}+${spec.postScriptName}`;
  assertBaseFontName(baseName, spec.subset !== false);

  // --- the embedded font stream (Table 125)
  const streamEntries: [string, CosObject][] = [];
  if (mapping.subtype !== null) {
    // R-9.9.1-47: the name shall be Type1C, CIDFontType0C or OpenType.
    streamEntries.push(['Subtype', name(mapping.subtype)]);
  }
  if (program.format === 'truetype') {
    // Table 125: Length1 is required for a TrueType program — the length of the
    // decoded program. pdf-lib omitted it; that was W-4.
    streamEntries.push(['Length1', int(program.bytes.length)]);
  }
  // R-9.9.1-12: Length1/2/3 are not needed for CFF and shall not be present.
  const fontFile: CosStream = {
    kind: 'stream',
    dict: dict(streamEntries),
    raw: program.bytes,
  };
  const fontFileRef = sink.allocate(fontFile);

  // --- font descriptor (§9.8). The caller supplies the metrics; the key that
  // names the program is ours, and it is the one the defect got wrong.
  for (const forbidden of ['FontFile', 'FontFile2', 'FontFile3']) {
    if (spec.descriptor.has(forbidden)) {
      throw new FontProgramError(
        `/${forbidden} is decided by the font program, not by the caller (Table 124); drop it from the descriptor`,
      );
    }
  }
  const descriptorEntries = new Map<string, CosObject>(spec.descriptor);
  descriptorEntries.set('Type', name('FontDescriptor'));
  descriptorEntries.set('FontName', name(baseName));
  descriptorEntries.set(mapping.key, fontFileRef);
  const descriptorRef = sink.allocate(dict(descriptorEntries));

  // --- descendant CIDFont (Table 115)
  const cidEntries = new Map<string, CosObject>([
    ['Type', name('Font')],
    ['Subtype', name(mapping.cidFontSubtype)],
    ['BaseFont', name(baseName)],
    [
      'CIDSystemInfo',
      dict([
        ['Registry', { kind: 'string', bytes: latin1('Adobe'), form: 'literal' }],
        ['Ordering', { kind: 'string', bytes: latin1('Identity'), form: 'literal' }],
        ['Supplement', int(0)],
      ]),
    ],
    ['FontDescriptor', descriptorRef],
  ]);
  if (spec.defaultWidth !== undefined) cidEntries.set('DW', int(spec.defaultWidth));
  if (spec.widths !== undefined) cidEntries.set('W', spec.widths);
  if (mapping.cidFontSubtype === 'CIDFontType2') {
    // R-9.7.4.2-7: an embedded Type 2 CIDFont shall carry CIDToGIDMap. With
    // Identity-H and CID = GID the identity name is the whole mapping
    // (R-9.7.4.1-13). A Type 0 CIDFont has no such entry, and this branch is
    // the only place it can be written.
    cidEntries.set('CIDToGIDMap', name('Identity'));
  }
  const cidFontRef = sink.allocate(dict(cidEntries));

  // --- Type 0 font (Table 112)
  const type0 = new Map<string, CosObject>([
    ['Type', name('Font')],
    ['Subtype', name('Type0')],
    ['BaseFont', name(baseName)],
    ['Encoding', name('Identity-H')],
    ['DescendantFonts', { kind: 'array', items: [cidFontRef] }],
  ]);
  if (spec.toUnicode !== undefined) type0.set('ToUnicode', spec.toUnicode);
  return { font: sink.allocate(dict(type0)), notes };
}

function latin1(text: string): Uint8Array {
  return new Uint8Array(Array.from(text, (c) => c.charCodeAt(0) & 0xff));
}

/**
 * R-9.9.2-2 / R-9.9.2-3 — the subset name shape. Checked rather than assumed,
 * because the previous implementation produced `NotoSansJP-Regular-7572`,
 * which looks like a subset name and satisfies none of the clause.
 */
function assertBaseFontName(baseName: string, subsetted: boolean): void {
  if (!subsetted) return;
  if (!/^[A-Z]{6}\+/.test(baseName)) {
    throw new FontProgramError(
      `a subset font name shall be exactly six uppercase letters, a PLUS SIGN, then the PostScript name (R-9.9.2-2/-3); got ${baseName}`,
    );
  }
}
