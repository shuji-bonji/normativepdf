/**
 * COS serializer tests (§7.3) — what the writer puts on the wire.
 *
 * ⚠️ Every assertion here is self-referential by construction: the bytes are
 * produced by this repository and checked by this repository. GUARDS T-2 says
 * that cannot detect a layer where the reader and the writer are wrong in the
 * same direction. So most cases assert on the **bytes**, not on a re-parse —
 * a literal expectation is the closest thing to an outside opinion a unit test
 * can hold. The actual outside opinion is `scripts/roundtrip-corpus.mjs
 * --qpdf` (ADR-0004 §2), which these tests do not replace.
 */

import { describe, expect, it } from 'vitest';
import type { CosObject } from '../src/cos/types.js';
import { ByteWriter, writeIndirectObject, writeObject } from '../src/index.js';

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');

function write(object: CosObject): string {
  const out = new ByteWriter();
  writeObject(out, object);
  return latin1(out.toUint8Array());
}

function writeIndirect(object: CosObject, number = 1, generation = 0): string {
  const out = new ByteWriter();
  writeIndirectObject(out, number, generation, object);
  return latin1(out.toUint8Array());
}

const real = (value: number): CosObject => ({ kind: 'real', value });
const name = (value: string): CosObject => ({ kind: 'name', value });
const str = (text: string, form: 'literal' | 'hex' = 'literal'): CosObject => ({
  kind: 'string',
  bytes: new Uint8Array(Array.from(text, (c) => c.charCodeAt(0))),
  form,
});

describe('numeric objects (§7.3.3)', () => {
  it('writes an integer as digits with no PERIOD (R-7.3.3-2)', () => {
    expect(write({ kind: 'integer', value: 0 })).toBe('0');
    expect(write({ kind: 'integer', value: -42 })).toBe('-42');
  });

  it('keeps the PERIOD on a real whose value is integral (R-7.3.3-4 / R-7.3.3-6)', () => {
    // The integer/real distinction survived parsing precisely because
    // R-7.3.3-6 ("a real shall not be present when an integer is expected")
    // is only expressible if it does. Writing 1.0 as `1` would erase it.
    expect(write(real(1))).toBe('1.0');
    expect(write(real(-100))).toBe('-100.0');
  });

  it('never writes exponential notation (R-7.3.3-8)', () => {
    // R-7.3.3-8: "A PDF writer shall not use the PostScript language syntax
    // for numbers … in exponential format (such as 6.02E23)." JavaScript
    // reaches for the exponent at both ends of the range.
    for (const value of [1e21, 1e-7, 3.403e38, -1.175e-38, 5e-324]) {
      expect(write(real(value))).not.toMatch(/[eE]/);
    }
  });

  it('🔴 keeps the smallest reals Annex C admits (the corpus caught this)', () => {
    // An earlier version formatted with toFixed(20), which caps at 20 fraction
    // digits, so /YStep -1.175e-38 was written as `0`. The value came from
    // TWG A018-pdfa2-pass-b, where the source file holds it in plain
    // positional form with 38 decimals — legal input, silently destroyed.
    //
    // T-3: revert formatReal to `value.toFixed(20)` and this fails.
    expect(Number.parseFloat(write(real(-1.175e-38)))).toBe(-1.175e-38);
    expect(Number.parseFloat(write(real(1.173e-38)))).toBe(1.173e-38);
  });

  it('round-trips every real through parseFloat with a PERIOD present', () => {
    const values = [
      0,
      1,
      -1,
      0.5,
      -0.5,
      1.5,
      100,
      1e21,
      1e-7,
      -1.175e-38,
      3.403e38,
      1 / 3,
      0.1,
      123456789.123,
      -0.000001,
    ];
    for (const value of values) {
      const written = write(real(value));
      expect(written, `${value} shall carry a PERIOD (R-7.3.3-4)`).toContain('.');
      expect(Number.parseFloat(written), `${value} shall survive`).toBe(value);
    }
  });

  it('refuses a non-integral value in an integer object', () => {
    expect(() => write({ kind: 'integer', value: 1.5 })).toThrow(/§7.3.3/);
  });
});

describe('name objects (§7.3.5)', () => {
  it('introduces a name with SOLIDUS and leaves regular characters alone (R-7.3.5-3/-6)', () => {
    expect(write(name('Type'))).toBe('/Type');
    expect(write(name('A;Name_With-Various***Characters?'))).toBe(
      '/A;Name_With-Various***Characters?',
    );
  });

  it('writes NUMBER SIGN as #23 (R-7.3.5-5)', () => {
    // Without this the name reads back as something else entirely, since `#`
    // introduces a hex escape when read.
    expect(write(name('Lime#Green'))).toBe('/Lime#23Green');
  });

  it('writes white space and delimiters as #xx (R-7.3.5-7 / R-7.3.5-8)', () => {
    expect(write(name('Paired()Parentheses'))).toBe('/Paired#28#29Parentheses');
    // 🔴 16 進の桁は**大文字**で書く。§7.3.5 は桁の大小を決めていないが、
    // 小文字だけを読めない読み手がある（pdf-lib は `/#([\dABCDEF]{2})/g` で
    // 照合するので、`/text#2fcsv` を "text#2fcsv" という名前として読む）
    expect(write(name('With Space'))).toBe('/With#20Space');
    expect(write(name('Slash/Inside'))).toBe('/Slash#2FInside');
    expect(write(name('Hash#Inside'))).toBe('/Hash#23Inside');
    expect(write(name('text/csv'))).toBe('/text#2Fcsv');
  });

  it('encodes name characters as UTF-8 (R-7.3.5-13)', () => {
    // The parser decodes name bytes as UTF-8, so the writer has to encode them
    // that way; Latin-1 or UTF-16 would not survive a round-trip.
    //
    // Asserted on the bytes rather than a string literal: these are regular
    // characters, so R-7.3.5-6 lets them be written as themselves, and the
    // Latin-1 rendering of the result ("/ã\x81\x82") says nothing useful to
    // a reader about which encoding was used.
    const out = new ByteWriter();
    writeObject(out, name('あ'));
    expect(Array.from(out.toUint8Array())).toEqual([0x2f, 0xe3, 0x81, 0x82]);
  });
});

describe('string objects (§7.3.4)', () => {
  it('keeps the written form the source used', () => {
    // CosString carries `form` for exactly this reason.
    expect(write(str('Hi', 'literal'))).toBe('(Hi)');
    expect(write(str('Hi', 'hex'))).toBe('<4869>');
  });

  it('escapes parentheses and REVERSE SOLIDUS (R-7.3.4.2-15)', () => {
    expect(write(str('a(b)c\\d'))).toBe('(a\\(b\\)c\\\\d)');
  });

  it('🔴 escapes CR, which a raw byte would not survive (R-7.3.4.2-8)', () => {
    // "An end-of-line marker appearing within a literal string without a
    // preceding REVERSE SOLIDUS shall be treated as a byte value of (0Ah)".
    // Writing the CR raw therefore turns it into LF on the way back.
    //
    // T-3: drop the `byte < 0x20` branch in writeLiteralString and this fails.
    expect(write(str('a\rb'))).toBe('(a\\015b)');
  });

  it('uses three octal digits so a following digit cannot be absorbed (R-7.3.4.2-11)', () => {
    // "Three octal digits shall be used, with leading zeros as needed, if the
    // next character of the string is also a digit." The rule governs an
    // escape that is being written, not printable digits, which stay raw.
    // `\19` would read as octal 19; `\0019` is the byte 0x01 then '9'.
    expect(write(str('\u00019'))).toBe('(\\0019)');
    expect(write(str('9'))).toBe('(9)');
  });
});

describe('composite objects (§7.3.6, §7.3.7, §7.3.10)', () => {
  it('writes an indirect reference as N G R (R-7.3.10-9)', () => {
    expect(write({ kind: 'ref', objectNumber: 12, generationNumber: 3 })).toBe('12 3 R');
  });

  it('writes an empty array (R-7.3.6-4)', () => {
    expect(write({ kind: 'array', items: [] })).toBe('[]');
  });

  it('🔴 preserves a dictionary entry whose value is null', () => {
    // R-7.3.7-7 makes a null entry equivalent to an absent one *when reading*.
    // That is a rule for readers; a writer that drops the entry has discarded
    // what it was handed, and the difference is visible to anything that
    // compares the two files.
    //
    // T-3: skip null values in writeDict and this fails.
    const dict: CosObject = {
      kind: 'dict',
      entries: new Map<string, CosObject>([['Absent', { kind: 'null' }]]),
    };
    expect(write(dict)).toBe('<</Absent null>>');
  });

  it('separates a key from a numeric value (a name is self-delimiting, a number is not)', () => {
    const dict: CosObject = {
      kind: 'dict',
      entries: new Map<string, CosObject>([['Size', { kind: 'integer', value: 12 }]]),
    };
    expect(write(dict)).toBe('<</Size 12>>');
  });
});

describe('stream objects (§7.3.8)', () => {
  const stream = (raw: string, extra: [string, CosObject][] = []): CosObject => ({
    kind: 'stream',
    dict: { kind: 'dict', entries: new Map<string, CosObject>(extra) },
    raw: new Uint8Array(Array.from(raw, (c) => c.charCodeAt(0))),
  });

  it('refuses to write a stream as a direct object (R-7.3.8.1-5)', () => {
    expect(() => write(stream('x'))).toThrow(/R-7.3.8.1-5/);
  });

  it('🔴 follows the keyword `stream` with LF, never CR alone (R-7.3.8.1-6)', () => {
    // "shall be followed by an end-of-line marker consisting of either a
    // CARRIAGE RETURN and a LINE FEED or just a LINE FEED, and not by a
    // CARRIAGE RETURN alone."
    //
    // T-3: change '\nstream\n' to '\nstream\r' and this fails.
    const written = writeIndirect(stream('DATA'));
    expect(written).toContain('stream\nDATA');
    expect(written).not.toMatch(/stream\r(?!\n)/);
  });

  it('writes /Length as a direct integer equal to the bytes emitted (R-7.3.8.2-1)', () => {
    // ADR-0004 §4.1: the source /Length may be an indirect reference, and it
    // may be wrong — the parser falls back to locating `endstream` when it is.
    // Preserving it would write a file that disagrees with itself.
    const written = writeIndirect(
      stream('12345', [['Length', { kind: 'ref', objectNumber: 9, generationNumber: 0 }]]),
    );
    expect(written).toContain('/Length 5');
    expect(written).not.toContain('9 0 R');
  });

  it('wraps the data between the keywords with endobj after it (R-7.3.8.1-4)', () => {
    expect(writeIndirect(stream('AB'), 4, 0)).toBe(
      '4 0 obj\n<</Length 2>>\nstream\nAB\nendstream\nendobj\n',
    );
  });
});

describe('deterministic output (DESIGN §4.1)', () => {
  it('produces identical bytes for the same input', () => {
    const object: CosObject = {
      kind: 'dict',
      entries: new Map<string, CosObject>([
        ['Name', name('Value')],
        ['Real', real(1 / 3)],
        ['Text', str('hello', 'literal')],
        ['Items', { kind: 'array', items: [{ kind: 'integer', value: 1 }, { kind: 'null' }] }],
      ]),
    };
    expect(write(object)).toBe(write(object));
  });
});
