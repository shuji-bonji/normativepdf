/**
 * §7.9.2 text strings and §7.9.4 dates.
 *
 * Each `describe` names the requirement it covers, so the clause and the test
 * can be read against each other. Whether these assertions can fail was measured
 * by breaking one rule at a time; the six breaks and what each one turns red are
 * recorded in `docs/ROADMAP.md`.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeTextString,
  encodeTextString,
  formatPdfDate,
  parsePdfDate,
  pdfDocDecode,
  pdfDocEncode,
  stripLanguageEscape,
  TABLE_D3_DEFECTS,
  UNDEFINED_CODES,
} from '../src/index.js';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

/** ESCAPE (U+001B) — elements a) and d) of the language escape sequence. */
const ESC = '\u001b';

/** UTF-16BE bytes for a string, with the byte order mark (R-7.9.2.2.1-3). */
function utf16be(text: string): Uint8Array {
  const out: number[] = [0xfe, 0xff];
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    out.push(unit >> 8, unit & 0xff);
  }
  return Uint8Array.from(out);
}

/** UTF-8 bytes for a string, with the byte order mark (R-7.9.2.2.1-4). */
function utf8(text: string): Uint8Array {
  return Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
}

describe('R-7.9.2.2.1-2 — the three encodings a text string may use', () => {
  it('reads PDFDocEncoding when no byte order mark is present', () => {
    expect(decodeTextString(bytes(0x48, 0x69))).toBe('Hi');
  });

  it('reads UTF-16BE', () => {
    expect(decodeTextString(utf16be('日本語'))).toBe('日本語');
  });

  it('reads UTF-8 (PDF 2.0)', () => {
    expect(decodeTextString(utf8('日本語'))).toBe('日本語');
  });
});

describe('R-7.9.2.2.1-3 — UTF-16BE begins 254, 255', () => {
  it('treats FE FF as the mark, not as text', () => {
    expect(decodeTextString(utf16be('A'))).toBe('A');
  });

  it('does not treat FE alone as a mark', () => {
    // 0xFE is thorn and 0x41 is A in PDFDocEncoding (Table D.3).
    expect(decodeTextString(bytes(0xfe, 0x41))).toBe('þA');
  });

  it('reads a string that is only the mark as empty', () => {
    expect(decodeTextString(bytes(0xfe, 0xff))).toBe('');
  });
});

describe('R-7.9.2.2.1-4 — UTF-8 begins 239, 187, 191', () => {
  it('treats EF BB BF as the mark, not as text', () => {
    expect(decodeTextString(utf8('café'))).toBe('café');
  });

  it('does not treat EF BB as a mark', () => {
    // Without the third byte this is PDFDocEncoding (Table D.3).
    expect(decodeTextString(bytes(0xef, 0xbb))).toBe('ï»');
  });
});

describe('R-7.9.2.2.1-5 — supplementary characters', () => {
  it('reads a surrogate pair from UTF-16BE as one character', () => {
    expect(decodeTextString(utf16be('\u{1F600}'))).toBe('\u{1F600}');
    expect([...decodeTextString(utf16be('\u{1F600}'))]).toHaveLength(1);
  });

  it('reads a four-byte sequence from UTF-8 as one character', () => {
    expect([...decodeTextString(utf8('\u{1F600}'))]).toHaveLength(1);
  });

  it('writes a supplementary character as a surrogate pair', () => {
    const written = encodeTextString('\u{1F600}');
    expect([...written.bytes]).toEqual([0xfe, 0xff, 0xd8, 0x3d, 0xde, 0x00]);
  });
});

describe('R-7.9.2.2.2 — language escape sequences', () => {
  it('removes a 2-byte language code', () => {
    expect(stripLanguageEscape(`${ESC}en${ESC}Hello`)).toBe('Hello');
  });

  it('removes a language code followed by a country code', () => {
    expect(stripLanguageEscape(`${ESC}enUS${ESC}Hello`)).toBe('Hello');
  });

  it('removes a sequence that appears in the middle, not only at the start', () => {
    // "Escape sequences may appear anywhere in a Unicode text string."
    expect(stripLanguageEscape(`Hello ${ESC}ja${ESC}世界`)).toBe('Hello 世界');
  });

  it('removes more than one sequence', () => {
    expect(stripLanguageEscape(`${ESC}en${ESC}a${ESC}jaJP${ESC}b`)).toBe('ab');
  });

  it('leaves an unterminated sequence alone', () => {
    expect(stripLanguageEscape(`${ESC}enHello`)).toBe(`${ESC}enHello`);
  });

  it('leaves ordinary text alone', () => {
    expect(stripLanguageEscape('Hello world ABCD')).toBe('Hello world ABCD');
  });

  it('applies to a UTF-16BE string', () => {
    expect(decodeTextString(utf16be(`${ESC}ja${ESC}世界`))).toBe('世界');
  });

  it('applies to a UTF-8 string', () => {
    expect(decodeTextString(utf8(`${ESC}ja${ESC}世界`))).toBe('世界');
  });

  it('does not apply to a PDFDocEncoded string', () => {
    // PDFDocEncoding has no ESCAPE: byte 0x1B is U+02D9 DOT ABOVE (Table D.3),
    // so the sequence cannot be written in one and nothing may be removed.
    expect(decodeTextString(bytes(0x1b, 0x65, 0x6e, 0x1b, 0x41))).toBe('˙en˙A');
  });
});

describe('R-7.9.2.3-1 — PDFDocEncoded strings are one byte per character', () => {
  it('maps the bytes that differ from Latin-1', () => {
    // 0x18 BREVE, 0x80 BULLET, 0x8A MINUS SIGN, 0xA0 EURO SIGN (Table D.3).
    expect(pdfDocDecode(bytes(0x18, 0x80, 0x8a, 0xa0))).toBe('\u02d8\u2022\u2212\u20ac');
  });

  it('maps ASCII to itself', () => {
    expect(pdfDocDecode(bytes(0x41, 0x7e))).toBe('A~');
  });

  it('maps the high Latin-1 range to itself', () => {
    expect(pdfDocDecode(bytes(0xc0, 0xff))).toBe('\u00c0\u00ff');
  });

  it('decodes one character per byte', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect([...pdfDocDecode(all)]).toHaveLength(256);
  });

  it('refuses to write a code point the encoding does not define', () => {
    // 0x00 is marked `U` in Table D.3, so U+0000 has no byte to be written as.
    expect(pdfDocEncode('\u0000')).toBeNull();
    expect(pdfDocEncode('\u65e5')).toBeNull();
  });

  it('names the undefined code points and the defects of Table D.3', () => {
    expect(UNDEFINED_CODES.size).toBe(24);
    expect(UNDEFINED_CODES.has(0x16)).toBe(true);
    expect(TABLE_D3_DEFECTS).toHaveLength(3);
  });
});

describe('NOTE 3 / NOTE 4 of 7.9.2.2.1 — a PDFDocEncoded string cannot begin with a mark', () => {
  it('writes thorn ydieresis as UTF-16BE rather than as PDFDocEncoding', () => {
    // Written as PDFDocEncoding this would be FE FF and read back as an empty
    // UTF-16BE string.
    const written = encodeTextString('þÿ');
    expect(written.form).toBe('hex');
    expect(decodeTextString(written.bytes)).toBe('þÿ');
  });

  it('writes the characters whose bytes are EF BB BF as UTF-16BE', () => {
    // NOTE 4 names them "dieresis, guillemotright, questiondown", but the first
    // of those is U+00A8 (byte 0xA8 in Table D.3), not byte 0xEF. The bytes the
    // note is about are EF BB BF, which Table D.3 maps to U+00EF, U+00BB, U+00BF.
    // The glyph names in that note come from another encoding; the table is what
    // a decoder reads.
    const written = encodeTextString('\u00ef\u00bb\u00bf');
    expect(written.form).toBe('hex');
    expect(decodeTextString(written.bytes)).toBe('\u00ef\u00bb\u00bf');
  });
});

describe('round trip', () => {
  it('returns a string inside PDFDocEncoding unchanged', () => {
    const text = 'Hello — “world” € ÿ';
    const written = encodeTextString(text);
    expect(written.form).toBe('literal');
    expect(decodeTextString(written.bytes)).toBe(text);
  });

  it('returns a string outside PDFDocEncoding unchanged', () => {
    const text = '日本語のタイトル';
    const written = encodeTextString(text);
    expect(written.form).toBe('hex');
    expect(decodeTextString(written.bytes)).toBe(text);
  });

  it('returns a supplementary character unchanged', () => {
    const text = 'a\u{1F600}b';
    expect(decodeTextString(encodeTextString(text).bytes)).toBe(text);
  });

  it('drops a language escape sequence on the way back', () => {
    // Not identity, and correctly so: the sequence marks the language of the
    // text that follows, and decoding removes it (7.9.2.2.2).
    const text = `${ESC}ja${ESC}世界`;
    expect(decodeTextString(encodeTextString(text).bytes)).toBe('世界');
  });

  it('returns every byte PDFDocEncoding defines', () => {
    for (let byte = 0; byte < 256; byte += 1) {
      if (UNDEFINED_CODES.has(byte)) continue;
      const decoded = pdfDocDecode(bytes(byte));
      expect(pdfDocEncode(decoded)?.[0], `0x${byte.toString(16)}`).toBe(byte);
    }
  });
});

describe('R-7.9.4 — dates', () => {
  it('reads the example from the clause', () => {
    const date = parsePdfDate("D:199812231952-08'00");
    expect(date).not.toBeNull();
    expect(date?.year).toBe(1998);
    expect(date?.month).toBe(12);
    expect(date?.day).toBe(23);
    expect(date?.hour).toBe(19);
    expect(date?.minute).toBe(52);
    expect(date?.utRelationship).toBe('-');
    expect(date?.offsetHours).toBe(8);
    expect(date?.epochMs).toBe(Date.UTC(1998, 11, 24, 3, 52, 0));
  });

  it('R-7.9.4-12 — requires the prefix and the year', () => {
    expect(parsePdfDate('19981223')).toBeNull();
    expect(parsePdfDate('D:')).toBeNull();
    expect(parsePdfDate('D:1998')).not.toBeNull();
  });

  it('R-7.9.4-12 — refuses a field whose predecessors are absent', () => {
    expect(parsePdfDate('D:199823')).toBeNull();
  });

  it('R-7.9.4-16 — defaults MM and DD to 01 and the rest to zero', () => {
    const date = parsePdfDate('D:1998');
    expect(date?.month).toBe(1);
    expect(date?.day).toBe(1);
    expect(date?.hour).toBe(0);
    expect(date?.minute).toBe(0);
    expect(date?.second).toBe(0);
  });

  it('R-7.9.4-4/-5/-6/-7/-8 — bounds each field', () => {
    expect(parsePdfDate('D:19981323')).toBeNull();
    expect(parsePdfDate('D:19981200')).toBeNull();
    expect(parsePdfDate('D:1998122324')).toBeNull();
    expect(parsePdfDate('D:199812231960')).toBeNull();
    expect(parsePdfDate('D:19981223195260')).toBeNull();
  });
});

describe('R-7.9.4 — the UT relationship', () => {
  it('R-7.9.4-14 — the APOSTROPHE needs the hour offset before it', () => {
    expect(parsePdfDate("D:1998+'00")).toBeNull();
  });

  it('R-7.9.4-15 — the minute offset needs the APOSTROPHE before it', () => {
    expect(parsePdfDate('D:1998+0800')).toBeNull();
    expect(parsePdfDate("D:1998+08'00")).not.toBeNull();
  });

  it('R-7.9.4-17 — no UT information is GMT', () => {
    const date = parsePdfDate('D:19981223195200');
    expect(date?.utRelationship).toBeNull();
    expect(date?.epochMs).toBe(Date.UTC(1998, 11, 23, 19, 52, 0));
  });

  it('R-7.9.4-9 — Z is local time equal to UT', () => {
    expect(parsePdfDate('D:19981223195200Z')?.epochMs).toBe(Date.UTC(1998, 11, 23, 19, 52, 0));
    // NOTE 3 — Z may carry offsets, which are zero.
    expect(parsePdfDate("D:19981223195200Z00'00")?.epochMs).toBe(Date.UTC(1998, 11, 23, 19, 52, 0));
    // A non-zero offset contradicts the Z it follows.
    expect(parsePdfDate("D:19981223195200Z05'00")).toBeNull();
  });

  it('NOTE 2 — accepts the terminating APOSTROPHE of PDF 1.7 and earlier', () => {
    expect(parsePdfDate("D:199812231952-08'00'")?.epochMs).toBe(Date.UTC(1998, 11, 24, 3, 52, 0));
  });
});

describe('R-7.9.4 — writing a date', () => {
  it('writes the ISO 32000-2 form, without a terminating APOSTROPHE', () => {
    expect(formatPdfDate(new Date(Date.UTC(2026, 7, 27, 12, 34, 56)))).toBe(
      "D:20260827123456+00'00",
    );
  });

  it('reads back what it writes', () => {
    const when = new Date(Date.UTC(2026, 7, 27, 12, 34, 56));
    expect(parsePdfDate(formatPdfDate(when))?.epochMs).toBe(when.getTime());
  });

  it('refuses a year that does not fit four digits', () => {
    expect(() => formatPdfDate(new Date(Date.UTC(12026, 0, 1)))).toThrow(RangeError);
  });
});
