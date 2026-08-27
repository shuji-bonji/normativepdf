/**
 * PDFDocEncoding — ISO 32000-2 Annex D.3, Table D.3.
 *
 * The table below is transcribed from the clause, not from another library.
 * Only the *Unicode* column is normative for a decoder; the Character column of
 * Table D.3 is a rendering of that code point and disagrees with it in one row
 * (see `TABLE_D3_DEFECTS`).
 *
 * Notes column of Table D.3:
 * - `U`  — undefined code point in PDFDocEncoding
 * - `SR` — Unicode code point that may require special representation in XML
 *
 * A conforming PDFDocEncoded string (R-7.9.2.3-1) uses one byte per character,
 * so a byte marked `U` cannot appear in one. Such bytes are still decoded to the
 * code point Table D.3 lists for them: a decoder that dropped them would destroy
 * data a caller may need to see. `UNDEFINED_CODES` is exported so a caller that
 * wants to reject them can.
 */

/** U+FFFD REPLACEMENT CHARACTER — used where Table D.3 lists no Unicode value. */
const REPLACEMENT = 0xfffd;

/**
 * Rows of Table D.3 whose code point differs from ISO/IEC 8859-1 (Latin-1).
 * Byte → Unicode code point. Every other byte in 0x00–0xFF maps to itself.
 */
const DEVIATIONS: ReadonlyMap<number, number> = new Map([
  // 0x16 — Table D.3 prints U+0017 with the name "(SYNCRONOUS IDLE)". SYNCHRONOUS
  // IDLE is U+0016, so the two columns of that row disagree and 0x16 and 0x17 are
  // given the same code point. The row is marked `U`, so no conforming string
  // reaches it. The Unicode column is followed here because it is the column a
  // decoder reads. See TABLE_D3_DEFECTS.
  [0x16, 0x0017],

  // 0x18–0x1F — spacing accents, where Latin-1 has C1 control codes.
  [0x18, 0x02d8], // BREVE
  [0x19, 0x02c7], // CARON
  [0x1a, 0x02c6], // MODIFIER LETTER CIRCUMFLEX ACCENT
  [0x1b, 0x02d9], // DOT ABOVE
  [0x1c, 0x02dd], // DOUBLE ACUTE ACCENT
  [0x1d, 0x02db], // OGONEK
  [0x1e, 0x02da], // RING ABOVE
  [0x1f, 0x02dc], // SMALL TILDE

  [0x7f, REPLACEMENT], // Undefined (no Unicode value in Table D.3)

  // 0x80–0x9E — typographic characters, where Latin-1 has C1 control codes.
  [0x80, 0x2022], // BULLET
  [0x81, 0x2020], // DAGGER
  [0x82, 0x2021], // DOUBLE DAGGER
  [0x83, 0x2026], // HORIZONTAL ELLIPSIS
  [0x84, 0x2014], // EM DASH
  [0x85, 0x2013], // EN DASH
  [0x86, 0x0192], // LATIN SMALL LETTER F WITH HOOK
  [0x87, 0x2044], // FRACTION SLASH
  [0x88, 0x2039], // SINGLE LEFT-POINTING ANGLE QUOTATION MARK
  [0x89, 0x203a], // SINGLE RIGHT-POINTING ANGLE QUOTATION MARK
  [0x8a, 0x2212], // MINUS SIGN
  [0x8b, 0x2030], // PER MILLE SIGN
  [0x8c, 0x201e], // DOUBLE LOW-9 QUOTATION MARK
  [0x8d, 0x201c], // LEFT DOUBLE QUOTATION MARK
  [0x8e, 0x201d], // RIGHT DOUBLE QUOTATION MARK
  [0x8f, 0x2018], // LEFT SINGLE QUOTATION MARK
  [0x90, 0x2019], // RIGHT SINGLE QUOTATION MARK
  [0x91, 0x201a], // SINGLE LOW-9 QUOTATION MARK
  [0x92, 0x2122], // TRADE MARK SIGN
  [0x93, 0xfb01], // LATIN SMALL LIGATURE FI
  [0x94, 0xfb02], // LATIN SMALL LIGATURE FL
  [0x95, 0x0141], // LATIN CAPITAL LETTER L WITH STROKE
  [0x96, 0x0152], // LATIN CAPITAL LIGATURE OE
  [0x97, 0x0160], // LATIN CAPITAL LETTER S WITH CARON
  [0x98, 0x0178], // LATIN CAPITAL LETTER Y WITH DIAERESIS
  [0x99, 0x017d], // LATIN CAPITAL LETTER Z WITH CARON
  [0x9a, 0x0131], // LATIN SMALL LETTER DOTLESS I
  [0x9b, 0x0142], // LATIN SMALL LETTER L WITH STROKE
  [0x9c, 0x0153], // LATIN SMALL LIGATURE OE
  [0x9d, 0x0161], // LATIN SMALL LETTER S WITH CARON
  [0x9e, 0x017e], // LATIN SMALL LETTER Z WITH CARON

  [0x9f, REPLACEMENT], // Undefined (no Unicode value in Table D.3)
  [0xa0, 0x20ac], // EURO SIGN, where Latin-1 has NO-BREAK SPACE
  [0xad, REPLACEMENT], // Undefined (no Unicode value in Table D.3)
]);

/** Byte → Unicode code point, for all 256 bytes (Table D.3). */
const TO_UNICODE: readonly number[] = Array.from({ length: 256 }, (_, byte) => {
  const deviation = DEVIATIONS.get(byte);
  return deviation === undefined ? byte : deviation;
});

/**
 * Bytes whose Notes column in Table D.3 is `U`, plus the three rows that list no
 * Unicode value at all (0x7F, 0x9F, 0xAD). A conforming PDFDocEncoded string
 * contains none of them (R-7.9.2.3-1).
 */
export const UNDEFINED_CODES: ReadonlySet<number> = new Set([
  ...Array.from({ length: 9 }, (_, i) => i), // 0x00–0x08
  0x0b,
  0x0c,
  ...Array.from({ length: 10 }, (_, i) => 0x0e + i), // 0x0E–0x17
  0x7f,
  0x9f,
  0xad,
]);

/**
 * Rows where Table D.3 contradicts itself. Recorded so the transcription can be
 * audited against the clause without re-reading it, and so a later edition that
 * fixes the row is noticed rather than silently diverging.
 *
 * All of them fall on rows marked `U`, so no conforming string reaches them.
 */
export const TABLE_D3_DEFECTS: readonly string[] = [
  '0x16: Unicode column says U+0017 while the name says "(SYNCRONOUS IDLE)" (U+0016); 0x16 and 0x17 are given the same code point',
  '0x04: named "(END OF TEXT)", which is 0x03; 0x04 is END OF TRANSMISSION',
  '0x38: named "DIGIT EIGJT"',
];

/** Unicode code point → byte, over the code points PDFDocEncoding defines. */
const FROM_UNICODE: ReadonlyMap<number, number> = new Map(
  TO_UNICODE.flatMap((codePoint, byte) =>
    UNDEFINED_CODES.has(byte) ? [] : [[codePoint, byte] as const],
  ),
);

/**
 * Decode a PDFDocEncoded string (§7.9.2.3): one byte per character, via Table D.3.
 *
 * Bytes marked `U` are decoded to the code point the table lists rather than
 * dropped; use `UNDEFINED_CODES` to detect them.
 */
export function pdfDocDecode(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += String.fromCodePoint(TO_UNICODE[byte] ?? REPLACEMENT);
  }
  return out;
}

/**
 * Encode a string as PDFDocEncoded bytes, or `null` when any character is outside
 * the code points PDFDocEncoding defines. `null` is the caller's signal to use
 * UTF-16BE or UTF-8 instead (R-7.9.2.2.1-2).
 *
 * Code points that Table D.3 lists only on a row marked `U` are treated as
 * outside the encoding: writing them would produce a string that R-7.9.2.3-1
 * does not allow.
 */
export function pdfDocEncode(text: string): Uint8Array | null {
  const bytes: number[] = [];
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) return null;
    const byte = FROM_UNICODE.get(codePoint);
    if (byte === undefined) return null;
    bytes.push(byte);
  }
  return Uint8Array.from(bytes);
}
