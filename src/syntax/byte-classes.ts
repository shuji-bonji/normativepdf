/**
 * Character classification per ISO 32000-2 §7.2.3 "Character set".
 *
 * "The PDF character set is divided into three classes referred to as
 * regular, delimiter, and white-space characters." The rules apply to all
 * characters in the file except within strings, streams, and comments.
 */

/** EOF sentinel used by ByteCursor. Outside the 0–255 byte range by construction. */
export const EOF = -1;

/** ISO 32000-2 Table 1 — white-space characters: NUL, HT, LF, FF, CR, SP. */
export function isWhitespace(byte: number): boolean {
  return (
    byte === 0x00 ||
    byte === 0x09 ||
    byte === 0x0a ||
    byte === 0x0c ||
    byte === 0x0d ||
    byte === 0x20
  );
}

/**
 * ISO 32000-2 §7.2.3 — CR and LF are the newline characters; EOL markers
 * are CR, LF, or CR immediately followed by LF (treated as one marker).
 */
export function isNewline(byte: number): boolean {
  return byte === 0x0d || byte === 0x0a;
}

/**
 * ISO 32000-2 Table 2 — delimiter characters:
 * ( ) < > [ ] { } / %
 */
export function isDelimiter(byte: number): boolean {
  return (
    byte === 0x28 || // (
    byte === 0x29 || // )
    byte === 0x3c || // <
    byte === 0x3e || // >
    byte === 0x5b || // [
    byte === 0x5d || // ]
    byte === 0x7b || // {
    byte === 0x7d || // }
    byte === 0x2f || // /
    byte === 0x25 //    %
  );
}

/**
 * ISO 32000-2 §7.2.3 — "All characters except the white-space characters
 * and delimiters are referred to as regular characters." Returns false for
 * the EOF sentinel.
 */
export function isRegular(byte: number): boolean {
  return byte >= 0 && byte <= 0xff && !isWhitespace(byte) && !isDelimiter(byte);
}

/** ASCII decimal digit 0–9. */
export function isDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x39;
}

/** ASCII octal digit 0–7 (literal-string \ddd escapes, §7.3.4.2). */
export function isOctalDigit(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x37;
}

/** ASCII hexadecimal digit 0–9 A–F a–f (§7.3.4.3, §7.3.5). */
export function isHexDigit(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x46) ||
    (byte >= 0x61 && byte <= 0x66)
  );
}

/** Numeric value of a hex digit byte. Caller guarantees {@link isHexDigit}. */
export function hexValue(byte: number): number {
  if (byte >= 0x30 && byte <= 0x39) {
    return byte - 0x30;
  }
  if (byte >= 0x41 && byte <= 0x46) {
    return byte - 0x41 + 10;
  }
  return byte - 0x61 + 10;
}
