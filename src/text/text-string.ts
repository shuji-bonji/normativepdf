/**
 * Text strings — ISO 32000-2 §7.9.2.2.
 *
 * A text string is one of three encodings (R-7.9.2.2.1-2), told apart by what the
 * bytes begin with:
 *
 * - `FE FF` — UTF-16BE (R-7.9.2.2.1-3)
 * - `EF BB BF` — UTF-8, PDF 2.0 (R-7.9.2.2.1-4)
 * - anything else — PDFDocEncoding (§7.9.2.3, Annex D.3)
 *
 * Which of the three a producer used is not recorded anywhere else, so the
 * leading bytes are the whole of the decision. NOTE 3 and NOTE 4 of §7.9.2.2.1
 * say this is why a PDFDocEncoded string cannot begin with those byte sequences;
 * `encodeTextString` honours that when choosing an encoding.
 */

import type { CosString } from '../cos/types.js';
import { pdfDocDecode, pdfDocEncode } from './pdfdoc-encoding.js';

/** U+FFFD REPLACEMENT CHARACTER. */
const REPLACEMENT_CHARACTER = '�';

/** R-7.9.2.2.1-3 — the two bytes that mark UTF-16BE. */
const UTF16BE_BOM: readonly [number, number] = [0xfe, 0xff];

/** R-7.9.2.2.1-4 — the three bytes that mark UTF-8. */
const UTF8_BOM: readonly [number, number, number] = [0xef, 0xbb, 0xbf];

/**
 * §7.9.2.2.2 — a language escape sequence, in order:
 *
 *   a) ESCAPE (U+001B)
 *   b) a 2-byte BCP 47 language code
 *   c) (optional) a 2-byte ISO 3166 country code
 *   d) ESCAPE (U+001B)
 *
 * The clause says such a sequence "may appear anywhere in a Unicode text string",
 * so this matches globally rather than only at the start.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: ESCAPE (U+001B) is what the clause names as elements a) and d) of the sequence
const LANGUAGE_ESCAPE = /\u001b[A-Za-z]{2}(?:[A-Za-z]{2})?\u001b/g;

/**
 * Remove language escape sequences (§7.9.2.2.2) from decoded text.
 *
 * Operates on the decoded string rather than on bytes because the clause defines
 * the sequence in Unicode values: in UTF-16BE the ESCAPE is the byte pair `00 1B`
 * and in UTF-8 it is the single byte `1B`, but in both it is one U+001B once
 * decoded. One rule then covers both encodings.
 *
 * Not applied to PDFDocEncoded strings: PDFDocEncoding has no ESCAPE at all —
 * byte 0x1B is U+02D9 DOT ABOVE (Table D.3) — so the sequence cannot be written
 * in one, and stripping there would delete text the producer meant to keep.
 */
export function stripLanguageEscape(text: string): string {
  return text.replace(LANGUAGE_ESCAPE, '');
}

/** Decode big-endian UTF-16 code units. Surrogate pairs survive (R-7.9.2.2.1-5). */
function decodeUtf16Be(bytes: Uint8Array): string {
  const units: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    units.push(((bytes[i] ?? 0) << 8) | (bytes[i + 1] ?? 0));
  }
  let out = '';
  // Chunked so a long string does not exhaust the argument stack.
  for (let i = 0; i < units.length; i += 4096) {
    out += String.fromCharCode(...units.slice(i, i + 4096));
  }
  // An odd trailing byte is half a code unit. The clause does not describe it;
  // reporting it as U+FFFD keeps the damage visible instead of dropping it.
  return bytes.length % 2 === 1 ? out + REPLACEMENT_CHARACTER : out;
}

/** Decode UTF-8. Invalid sequences become U+FFFD rather than throwing. */
function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

/**
 * Decode a text string (§7.9.2.2) from the bytes of a string object.
 *
 * The caller decides *whether* a given string object is a text string — that is
 * fixed by the dictionary key it appears under, not by the bytes (R-7.9.2.1-1).
 * This function only decodes one that is.
 */
export function decodeTextString(bytes: Uint8Array): string {
  if (startsWith(bytes, UTF16BE_BOM)) {
    return stripLanguageEscape(decodeUtf16Be(bytes.subarray(2)));
  }
  if (startsWith(bytes, UTF8_BOM)) {
    return stripLanguageEscape(decodeUtf8(bytes.subarray(3)));
  }
  return pdfDocDecode(bytes);
}

/** Encode a string as UTF-16BE with the byte order mark (R-7.9.2.2.1-3). */
function encodeUtf16Be(text: string): Uint8Array {
  const bytes: number[] = [...UTF16BE_BOM];
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i);
    bytes.push(unit >> 8, unit & 0xff);
  }
  return Uint8Array.from(bytes);
}

/**
 * Encode a string as a text string (§7.9.2.2).
 *
 * PDFDocEncoding is used when every character has a code point in Table D.3, and
 * UTF-16BE with a byte order mark otherwise. The caller does not choose: letting
 * it choose leaves a path where a string is written in an encoding that cannot
 * hold it and the text is silently replaced.
 *
 * Two cases fall back to UTF-16BE even though PDFDocEncoding could hold them:
 * a string whose PDFDocEncoded bytes would begin `FE FF` or `EF BB BF` would be
 * read back as UTF-16BE or UTF-8 (NOTE 3 and NOTE 4 of §7.9.2.2.1).
 *
 * The lexical form (§7.3.4) is not the same decision as the encoding: both a
 * literal and a hexadecimal string can carry either. UTF-16BE is written as
 * hexadecimal because its bytes are mostly outside the printable range, and a
 * literal would render them as octal escapes.
 */
export function encodeTextString(text: string): CosString {
  const pdfDocBytes = pdfDocEncode(text);
  if (
    pdfDocBytes !== null &&
    !startsWith(pdfDocBytes, UTF16BE_BOM) &&
    !startsWith(pdfDocBytes, UTF8_BOM)
  ) {
    return { kind: 'string', bytes: pdfDocBytes, form: 'literal' };
  }
  return { kind: 'string', bytes: encodeUtf16Be(text), form: 'hex' };
}
