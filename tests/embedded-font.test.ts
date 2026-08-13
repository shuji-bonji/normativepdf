/**
 * Embedded font programs and their dictionaries (§9.7.4 / §9.9, Table 124/125).
 *
 * The point of the module under test is that a wrong pairing cannot be built,
 * so most of these cases assert on **which dictionary came out of which bytes**
 * rather than on a re-parse. The font programs here are synthesised sfnt
 * headers: the table directory is what every clause in Table 124 keys on, and
 * building one by hand keeps the case readable.
 *
 * The real programs (NotoSansJP `.otf`, Liberation Sans `.ttf`, and the
 * subsets pdf-writer-mcp produces from them) are exercised by the UC oracle in
 * `pdf-writer-mcp/scripts/uc-oracle/`, which is where an outside reader looks
 * at the result (ADR-0006).
 */

import { describe, expect, it } from 'vitest';
import type { CosObject, CosRef } from '../src/cos/types.js';
import {
  buildType0Font,
  type FontObjectSink,
  FontProgramError,
  fontFileEntry,
  sniffFontProgram,
  subsetTag,
} from '../src/index.js';

/** Minimal sfnt: signature + table directory. Contents are not read. */
function sfnt(signature: string | number, tags: readonly string[]): Uint8Array {
  const bytes = new Uint8Array(12 + tags.length * 16 + 64);
  const view = new DataView(bytes.buffer);
  if (typeof signature === 'number') view.setUint32(0, signature);
  else for (let i = 0; i < 4; i += 1) bytes[i] = signature.charCodeAt(i);
  view.setUint16(4, tags.length);
  tags.forEach((name, i) => {
    const at = 12 + i * 16;
    for (let c = 0; c < 4; c += 1) bytes[at + c] = name.charCodeAt(c);
    view.setUint32(at + 8, bytes.length - 8); // offset, inside the buffer
    view.setUint32(at + 12, 4); // length
  });
  return bytes;
}

const TRUETYPE_TAGS = ['glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp'];
const trueTypeProgram = (extra: readonly string[] = []) =>
  sfnt(0x00010000, [...TRUETYPE_TAGS, ...extra]);
const openTypeCffProgram = () => sfnt('OTTO', ['CFF ', 'cmap', 'head', 'hhea', 'hmtx', 'maxp']);
const bareCff = () => {
  const bytes = new Uint8Array(64);
  bytes.set([1, 0, 4, 2]);
  return bytes;
};

function makeSink(): FontObjectSink & { objects: Map<number, CosObject> } {
  const objects = new Map<number, CosObject>();
  return {
    objects,
    allocate(object: CosObject): CosRef {
      const objectNumber = objects.size + 1;
      objects.set(objectNumber, object);
      return { kind: 'ref', objectNumber, generationNumber: 0 };
    },
  };
}

const entry = (object: CosObject | undefined, key: string): CosObject | undefined =>
  object?.kind === 'dict' ? object.entries.get(key) : undefined;
const nameOf = (object: CosObject | undefined): string | undefined =>
  object?.kind === 'name' ? object.value : undefined;

/** Resolve one level of indirection against the sink. */
const deref = (
  sink: ReturnType<typeof makeSink>,
  object: CosObject | undefined,
): CosObject | undefined =>
  object?.kind === 'ref' ? sink.objects.get(object.objectNumber) : object;

function build(program: Uint8Array, overrides: Record<string, unknown> = {}) {
  const sink = makeSink();
  const result = buildType0Font(sink, {
    program: sniffFontProgram(program),
    postScriptName: 'TestFont',
    descriptor: new Map<string, CosObject>([['Flags', { kind: 'integer', value: 4 }]]),
    ...overrides,
  });
  const type0 = sink.objects.get(result.font.objectNumber);
  const descendants = entry(type0, 'DescendantFonts');
  const cid = deref(sink, descendants?.kind === 'array' ? descendants.items[0] : undefined);
  const descriptor = deref(sink, entry(cid, 'FontDescriptor'));
  return { sink, result, type0, cid, descriptor };
}

describe('what the bytes are (§9.9.1)', () => {
  it('reads a "glyf" sfnt as TrueType', () => {
    expect(sniffFontProgram(trueTypeProgram()).format).toBe('truetype');
  });

  it('reads an OTTO container with a "CFF " table as CFF, not TrueType', () => {
    // This is the W-2 case: the container looks like a font file either way,
    // and only the table directory says where the glyphs are.
    expect(sniffFontProgram(openTypeCffProgram()).format).toBe('opentype-cff');
  });

  it('reads a bare CFF header (Adobe TN #5176)', () => {
    expect(sniffFontProgram(bareCff()).format).toBe('bare-cff');
  });

  it('refuses a font collection rather than embedding one face of it', () => {
    expect(() => sniffFontProgram(sfnt('ttcf', []))).toThrow(/collection/);
  });

  it('refuses an sfnt with neither "glyf" nor "CFF "', () => {
    expect(() => sniffFontProgram(sfnt(0x00010000, ['head', 'maxp']))).toThrow(/no glyph outlines/);
  });

  it('refuses bytes that are not a font program at all', () => {
    expect(() => sniffFontProgram(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toThrow(
      FontProgramError,
    );
  });
});

describe('Table 124 — the pairing the caller cannot get wrong', () => {
  it('puts a TrueType program in /FontFile2 under /CIDFontType2', () => {
    const { cid, descriptor } = build(trueTypeProgram());
    expect(nameOf(entry(cid, 'Subtype'))).toBe('CIDFontType2');
    expect(entry(descriptor, 'FontFile2')).toBeDefined();
    expect(entry(descriptor, 'FontFile3')).toBeUndefined();
  });

  it('puts a CFF-based OpenType program in /FontFile3 /OpenType under /CIDFontType0 (R-9.7.4.2-3)', () => {
    const { sink, cid, descriptor } = build(openTypeCffProgram());
    expect(nameOf(entry(cid, 'Subtype'))).toBe('CIDFontType0');
    const stream = deref(sink, entry(descriptor, 'FontFile3'));
    expect(stream?.kind).toBe('stream');
    expect(nameOf(stream?.kind === 'stream' ? stream.dict.entries.get('Subtype') : undefined)).toBe(
      'OpenType',
    );
    expect(entry(descriptor, 'FontFile2')).toBeUndefined();
  });

  it('names a bare CFF program /CIDFontType0C (R-9.9.1-47)', () => {
    const { sink, descriptor } = build(bareCff());
    const stream = deref(sink, entry(descriptor, 'FontFile3'));
    expect(nameOf(stream?.kind === 'stream' ? stream.dict.entries.get('Subtype') : undefined)).toBe(
      'CIDFontType0C',
    );
  });

  it('exposes the mapping on its own', () => {
    expect(fontFileEntry(sniffFontProgram(openTypeCffProgram()))).toEqual({
      key: 'FontFile3',
      subtype: 'OpenType',
      cidFontSubtype: 'CIDFontType0',
    });
  });

  it('refuses a descriptor that tries to name the font file itself', () => {
    expect(() =>
      build(trueTypeProgram(), {
        descriptor: new Map<string, CosObject>([
          ['FontFile2', { kind: 'ref', objectNumber: 9, generationNumber: 0 }],
        ]),
      }),
    ).toThrow(/decided by the font program/);
  });

  it('refuses a TrueType program that is missing a required table (R-9.9.1-34)', () => {
    const broken = sfnt(0x00010000, ['glyf', 'head', 'hhea', 'maxp']);
    expect(() => build(broken)).toThrow(/R-9\.9\.1-34/);
  });
});

describe('entries that follow from the format', () => {
  it('writes /Length1 for a TrueType program and not for CFF (Table 125 / R-9.9.1-12)', () => {
    const tt = build(trueTypeProgram());
    const ttStream = deref(tt.sink, entry(tt.descriptor, 'FontFile2'));
    expect(
      ttStream?.kind === 'stream' ? ttStream.dict.entries.get('Length1') : undefined,
    ).toBeDefined();

    const cff = build(openTypeCffProgram());
    const cffStream = deref(cff.sink, entry(cff.descriptor, 'FontFile3'));
    expect(
      cffStream?.kind === 'stream' ? cffStream.dict.entries.get('Length1') : undefined,
    ).toBeUndefined();
  });

  it('writes /CIDToGIDMap only for CIDFontType2 (R-9.7.4.2-7)', () => {
    expect(nameOf(entry(build(trueTypeProgram()).cid, 'CIDToGIDMap'))).toBe('Identity');
    expect(entry(build(openTypeCffProgram()).cid, 'CIDToGIDMap')).toBeUndefined();
  });

  it('reports the "cmap" a CIDFont program shall not carry, without refusing it (R-9.9.1-21)', () => {
    const { result } = build(trueTypeProgram(['cmap']));
    expect(result.notes.map((n) => n.clause)).toContain('R-9.9.1-21');
    // Reported, not fatal: removing a table means rebuilding the sfnt, which is
    // the subsetter's job, and every real subsetter ships one.
    expect(result.font).toBeDefined();
  });

  it('says nothing when the program is clean', () => {
    expect(build(trueTypeProgram()).result.notes).toEqual([]);
  });
});

describe('subset naming (§9.9.2)', () => {
  it('prepends six uppercase letters and a PLUS SIGN (R-9.9.2-2/-3)', () => {
    const { type0, cid, descriptor } = build(trueTypeProgram());
    const base = nameOf(entry(type0, 'BaseFont'));
    expect(base).toMatch(/^[A-Z]{6}\+TestFont$/);
    // The same name shall appear on the CIDFont and in the descriptor.
    expect(nameOf(entry(cid, 'BaseFont'))).toBe(base);
    expect(nameOf(entry(descriptor, 'FontName'))).toBe(base);
  });

  it('is deterministic for the same bytes and different for different bytes', () => {
    expect(subsetTag(trueTypeProgram())).toBe(subsetTag(trueTypeProgram()));
    expect(subsetTag(trueTypeProgram())).not.toBe(subsetTag(trueTypeProgram(['cmap'])));
    expect(subsetTag(trueTypeProgram())).toMatch(/^[A-Z]{6}$/);
  });

  it('omits the tag when the whole font is embedded', () => {
    const { type0 } = build(trueTypeProgram(), { subset: false });
    expect(nameOf(entry(type0, 'BaseFont'))).toBe('TestFont');
  });
});

describe('the Type 0 wrapper (Table 112)', () => {
  it('wires Identity-H and a single descendant', () => {
    const { type0 } = build(trueTypeProgram());
    expect(nameOf(entry(type0, 'Subtype'))).toBe('Type0');
    expect(nameOf(entry(type0, 'Encoding'))).toBe('Identity-H');
    const descendants = entry(type0, 'DescendantFonts');
    expect(descendants?.kind === 'array' ? descendants.items.length : 0).toBe(1);
  });

  it('carries /ToUnicode when the caller supplies one', () => {
    const toUnicode: CosRef = { kind: 'ref', objectNumber: 42, generationNumber: 0 };
    const { type0 } = build(trueTypeProgram(), { toUnicode });
    expect(entry(type0, 'ToUnicode')).toEqual(toUnicode);
  });
});
