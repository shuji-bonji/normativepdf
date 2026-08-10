/**
 * Object parser tests. Clause citations follow each behaviour; the
 * specification's own examples (§7.3.10 EXAMPLE 1/3) are used verbatim
 * where they exist.
 */

import { describe, expect, it } from 'vitest';
import { dictGet } from '../src/cos/types.js';
import { ByteCursor } from '../src/syntax/byte-cursor.js';
import {
  type IndirectObject,
  ParseError,
  type ParseObjectOptions,
  parseIndirectObject,
  parseObject,
} from '../src/syntax/object-parser.js';
import { TokenReader } from '../src/syntax/token-reader.js';

function readerOf(input: string): TokenReader {
  return new TokenReader(new ByteCursor(new TextEncoder().encode(input)));
}

function obj(input: string) {
  return parseObject(readerOf(input));
}

function indirect(input: string, options?: ParseObjectOptions): IndirectObject {
  return parseIndirectObject(readerOf(input), options);
}

const text = (s: string) => Array.from(new TextEncoder().encode(s));

describe('basic objects (§7.3.2, §7.3.3, §7.3.9)', () => {
  it('parses the keywords true / false / null', () => {
    expect(obj('true')).toEqual({ kind: 'boolean', value: true });
    expect(obj('false')).toEqual({ kind: 'boolean', value: false });
    expect(obj('null')).toEqual({ kind: 'null' });
  });

  it('keeps integer and real distinct (R-7.3.3-6)', () => {
    expect(obj('42')).toEqual({ kind: 'integer', value: 42 });
    expect(obj('42.0')).toEqual({ kind: 'real', value: 42 });
  });

  it('rejects an unknown keyword in object position', () => {
    expect(() => obj('frobnicate')).toThrow(ParseError);
  });
});

describe('arrays (§7.3.6)', () => {
  it('parses a heterogeneous array (R-7.3.6-1)', () => {
    const a = obj('[0 (a) /B [1 2] <<>>]');
    expect(a.kind).toBe('array');
    if (a.kind !== 'array') return;
    expect(a.items.map((i) => i.kind)).toEqual(['integer', 'string', 'name', 'array', 'dict']);
  });

  it('parses an empty array (R-7.3.6-4)', () => {
    expect(obj('[]')).toEqual({ kind: 'array', items: [] });
  });

  it('fails on an unterminated array', () => {
    expect(() => obj('[1 2')).toThrow(ParseError);
  });
});

describe('dictionaries (§7.3.7)', () => {
  it('parses nested dictionaries and applies null-equivalence at access (R-7.3.7-7)', () => {
    const d = obj('<< /A << /B 1 >> /C null >>');
    expect(d.kind).toBe('dict');
    if (d.kind !== 'dict') return;
    expect(dictGet(d, 'C')).toBeUndefined(); // null-valued entry == absent
    const a = dictGet(d, 'A');
    expect(a?.kind).toBe('dict');
  });

  it('rejects a non-name key (R-7.3.7-1)', () => {
    expect(() => obj('<< 1 2 >>')).toThrow(/R-7\.3\.7-1/);
  });

  it('rejects duplicate keys in the strict layer (R-7.3.7-13)', () => {
    expect(() => obj('<< /A 1 /A 2 >>')).toThrow(/R-7\.3\.7-13/);
  });
});

describe('indirect references (§7.3.10)', () => {
  it('classifies int-int-R with two-token lookahead', () => {
    expect(obj('12 0 R')).toEqual({ kind: 'ref', objectNumber: 12, generationNumber: 0 });
  });

  it('does not misread plain integers before a reference (the classic ambiguity)', () => {
    const a = obj('[1 0 2 0 R]');
    expect(a.kind).toBe('array');
    if (a.kind !== 'array') return;
    expect(a.items).toEqual([
      { kind: 'integer', value: 1 },
      { kind: 'integer', value: 0 },
      { kind: 'ref', objectNumber: 2, generationNumber: 0 },
    ]);
  });

  it('parses consecutive references', () => {
    const a = obj('[1 0 R 2 0 R]');
    expect(a.kind).toBe('array');
    if (a.kind !== 'array') return;
    expect(a.items).toEqual([
      { kind: 'ref', objectNumber: 1, generationNumber: 0 },
      { kind: 'ref', objectNumber: 2, generationNumber: 0 },
    ]);
  });

  it('rejects a reference with object number 0 (object numbers are positive integers)', () => {
    expect(() => obj('0 0 R')).toThrow(/§7\.3\.10/);
  });

  it('rejects a negative generation number (generation numbers are non-negative)', () => {
    expect(() => obj('1 -1 R')).toThrow(/§7\.3\.10/);
  });
});

describe('indirect object definitions (§7.3.10)', () => {
  it('parses EXAMPLE 1 verbatim: 12 0 obj (Brillig) endobj', () => {
    const r = indirect('12 0 obj\n(Brillig)\nendobj');
    expect(r.objectNumber).toBe(12);
    expect(r.generationNumber).toBe(0);
    expect(r.object.kind).toBe('string');
    if (r.object.kind !== 'string') return;
    expect(Array.from(r.object.bytes)).toEqual(text('Brillig'));
  });

  it('allows an object consisting solely of a reference (§7.3.10 NOTE, 2020)', () => {
    const r = indirect('1 0 obj 2 0 R endobj');
    expect(r.object).toEqual({ kind: 'ref', objectNumber: 2, generationNumber: 0 });
  });

  it('rejects a missing endobj', () => {
    expect(() => indirect('12 0 obj 5 ')).toThrow(ParseError);
  });

  it('rejects object number 0 in a definition', () => {
    expect(() => indirect('0 0 obj null endobj')).toThrow(/§7\.3\.10/);
  });
});

describe('streams (§7.3.8)', () => {
  it('reads a stream body with LF after the keyword, exactly Length bytes, undecoded', () => {
    const r = indirect('1 0 obj << /Length 5 >> stream\nHello\nendstream endobj');
    expect(r.object.kind).toBe('stream');
    if (r.object.kind !== 'stream') return;
    expect(Array.from(r.object.raw)).toEqual(text('Hello'));
  });

  it('accepts CRLF after the keyword stream (R-7.3.8.1-6)', () => {
    const r = indirect('1 0 obj << /Length 2 >> stream\r\nAB\nendstream endobj');
    expect(r.object.kind).toBe('stream');
  });

  it('rejects CR alone after the keyword stream (R-7.3.8.1-6)', () => {
    expect(() => indirect('1 0 obj << /Length 2 >> stream\rAB\nendstream endobj')).toThrow(
      /R-7\.3\.8\.1-6/,
    );
  });

  it('does not count the optional EOL before endstream as data (R-7.3.8.2-4/5)', () => {
    const r = indirect('1 0 obj << /Length 2 >> stream\nAB\nendstream endobj');
    expect(r.object.kind).toBe('stream');
    if (r.object.kind !== 'stream') return;
    expect(Array.from(r.object.raw)).toEqual(text('AB'));
  });

  it('binary bytes in the body are preserved as-is (stream data is raw)', () => {
    // Length 4 covers bytes: 00 28 29 5C — delimiters/escapes are NOT lexical inside stream data
    const input = new Uint8Array([
      ...text('1 0 obj << /Length 4 >> stream\n'),
      0x00,
      0x28,
      0x29,
      0x5c,
      ...text('\nendstream endobj'),
    ]);
    const r = parseIndirectObject(new TokenReader(new ByteCursor(input)));
    expect(r.object.kind).toBe('stream');
    if (r.object.kind !== 'stream') return;
    expect(Array.from(r.object.raw)).toEqual([0x00, 0x28, 0x29, 0x5c]);
  });

  it('requires a Length entry (R-7.3.8.2-1)', () => {
    expect(() => indirect('1 0 obj << >> stream\nAB\nendstream endobj')).toThrow(/R-7\.3\.8\.2-1/);
  });

  it('resolves an indirect Length via the resolver (§7.3.10 EXAMPLE 3)', () => {
    const r = indirect('7 0 obj << /Length 8 0 R >> stream\nHello\nendstream endobj', {
      resolveStreamLength: (ref) => (ref.objectNumber === 8 ? 5 : undefined),
    });
    expect(r.object.kind).toBe('stream');
    if (r.object.kind !== 'stream') return;
    expect(Array.from(r.object.raw)).toEqual(text('Hello'));
  });

  it('rejects an indirect Length without a resolver instead of guessing', () => {
    expect(() => indirect('7 0 obj << /Length 8 0 R >> stream\nHello\nendstream endobj')).toThrow(
      ParseError,
    );
  });

  it('rejects a Length running past the end of input', () => {
    expect(() => indirect('1 0 obj << /Length 999 >> stream\nAB\nendstream endobj')).toThrow(
      /R-7\.3\.8\.2-1/,
    );
  });

  it('rejects stream after a non-dictionary value (R-7.3.8.1-4)', () => {
    expect(() => indirect('1 0 obj 5 stream\nAB\nendstream endobj')).toThrow(/R-7\.3\.8\.1-4/);
  });

  it('rejects a mismatched endstream keyword', () => {
    expect(() => indirect('1 0 obj << /Length 2 >> stream\nABCD\nendstream endobj')).toThrow(
      ParseError,
    );
  });
});
