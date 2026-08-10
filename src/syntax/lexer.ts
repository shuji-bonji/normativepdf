/**
 * Token-level reader for PDF syntax, per ISO 32000-2 §7.2 (lexical
 * conventions) and the written forms in §7.3 (objects).
 *
 * The lexer produces tokens; it does not know what an object is. Keywords
 * (`true`, `obj`, `stream`, …) come out as generic keyword tokens — which
 * ones are meaningful where is the object/file parser's decision. This
 * keeps the closed lexical rules of §7.2 in one reviewable place.
 *
 * Strictness: this lexer is strict. Deviations that real-world files are
 * known to contain (recovery parsing) are a separate, explicit layer
 * (docs/DESIGN.md §5.1 stage 0 "回復パース") — silently accepting broken
 * syntax here would make the strict path untestable.
 */

import {
  EOF,
  hexValue,
  isDelimiter,
  isDigit,
  isHexDigit,
  isNewline,
  isOctalDigit,
  isRegular,
  isWhitespace,
} from './byte-classes.js';
import type { ByteCursor } from './byte-cursor.js';

/** Lexical error with the byte offset where it was detected. */
export class LexError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} (at byte ${offset})`);
    this.name = 'LexError';
    this.offset = offset;
  }
}

export type Token =
  /** §7.3.3 integer (R-7.3.3-2). */
  | { readonly kind: 'integer'; readonly value: number; readonly offset: number }
  /** §7.3.3 real (R-7.3.3-4). */
  | { readonly kind: 'real'; readonly value: number; readonly offset: number }
  /** §7.3.4 string; bytes after escape/hex decoding, written form preserved. */
  | {
      readonly kind: 'string';
      readonly bytes: Uint8Array;
      readonly form: 'literal' | 'hex';
      readonly offset: number;
    }
  /** §7.3.5 name; value after #xx resolution, UTF-8 decoded (R-7.3.5-13). */
  | { readonly kind: 'name'; readonly value: string; readonly offset: number }
  /** §7.3.6 [ and ]. */
  | { readonly kind: 'array-open'; readonly offset: number }
  | { readonly kind: 'array-close'; readonly offset: number }
  /** §7.3.7 << and >>. */
  | { readonly kind: 'dict-open'; readonly offset: number }
  | { readonly kind: 'dict-close'; readonly offset: number }
  /** §7.2.3 — a run of regular characters that is not a number: true, false,
   *  null, obj, endobj, stream, endstream, R, xref, trailer, startxref, n, f, … */
  | { readonly kind: 'keyword'; readonly value: string; readonly offset: number }
  | { readonly kind: 'eof'; readonly offset: number };

const utf8Decoder = new TextDecoder('utf-8', { fatal: true });
const latin1Decoder = new TextDecoder('latin1');

/**
 * Read the next token. Skips white-space and comments first (§7.2.4:
 * comments are single white-space characters for lexical purposes).
 */
export function nextToken(cur: ByteCursor): Token {
  cur.skipWhitespaceAndComments();
  const offset = cur.pos;
  const b = cur.peek();

  if (b === EOF) {
    return { kind: 'eof', offset };
  }

  // §7.3.6 arrays
  if (b === 0x5b) {
    cur.advance();
    return { kind: 'array-open', offset };
  }
  if (b === 0x5d) {
    cur.advance();
    return { kind: 'array-close', offset };
  }

  // §7.3.7 dictionaries (<<) / §7.3.4.3 hex strings (<)
  if (b === 0x3c) {
    if (cur.peek(1) === 0x3c) {
      cur.advance(2);
      return { kind: 'dict-open', offset };
    }
    return readHexString(cur, offset);
  }
  if (b === 0x3e) {
    if (cur.peek(1) === 0x3e) {
      cur.advance(2);
      return { kind: 'dict-close', offset };
    }
    throw new LexError('lone ">" is not a token (§7.2.3 Table 2)', offset);
  }

  // §7.3.4.2 literal strings
  if (b === 0x28) {
    return readLiteralString(cur, offset);
  }
  if (b === 0x29) {
    throw new LexError('unbalanced ")" outside a string (R-7.3.4.2-2)', offset);
  }

  // §7.3.5 names
  if (b === 0x2f) {
    return readName(cur, offset);
  }

  // §7.3.3 numbers: sign, digit, or period starts a number
  if (b === 0x2b || b === 0x2d || b === 0x2e || isDigit(b)) {
    return readNumber(cur, offset);
  }

  // §7.2.3 — a run of regular characters is a single token (keyword)
  if (isRegular(b)) {
    return readKeyword(cur, offset);
  }

  // { } are delimiters only inside Type 4 functions (§7.2.3); at the
  // object level they cannot begin a token.
  throw new LexError(`unexpected byte 0x${b.toString(16).padStart(2, '0')}`, offset);
}

/**
 * §7.3.3 numeric objects.
 * Integer: `[+-]? digit+` (R-7.3.3-2).
 * Real: digits with a leading, trailing, or embedded PERIOD (R-7.3.3-4);
 * `4.` and `-.002` are the specification's own examples.
 * PostScript radix/exponent forms are not PDF syntax (R-7.3.3-8) and are
 * rejected by virtue of `E`/`#` not continuing a number token — they lex
 * as a following keyword, which the object parser will reject in context.
 */
function readNumber(cur: ByteCursor, offset: number): Token {
  let text = '';
  let sawDigit = false;
  let sawPeriod = false;

  const sign = cur.peek();
  if (sign === 0x2b || sign === 0x2d) {
    text += String.fromCharCode(sign);
    cur.advance();
  }

  for (;;) {
    const b = cur.peek();
    if (isDigit(b)) {
      sawDigit = true;
      text += String.fromCharCode(b);
      cur.advance();
      continue;
    }
    if (b === 0x2e && !sawPeriod) {
      sawPeriod = true;
      text += '.';
      cur.advance();
      continue;
    }
    break;
  }

  if (!sawDigit) {
    throw new LexError('number without digits (§7.3.3)', offset);
  }

  if (sawPeriod) {
    return { kind: 'real', value: Number.parseFloat(text), offset };
  }
  return { kind: 'integer', value: Number.parseInt(text, 10), offset };
}

/**
 * §7.3.5 name objects. The SOLIDUS is a prefix, not part of the name
 * (R-7.3.5-4). `#xx` resolves to the byte with that hexadecimal code
 * (R-7.3.5-5..7). The resulting byte sequence is interpreted as UTF-8
 * (R-7.3.5-13, "should") with Latin-1 fallback — a reading decision, since
 * the clause addresses interpretation, not lexing.
 *
 * A `#` not followed by two hex digits is not writable under R-7.3.5-5..7;
 * for reading we take the byte literally rather than failing, because the
 * clause constrains writers. This is the single deliberate leniency here.
 */
function readName(cur: ByteCursor, offset: number): Token {
  cur.advance(); // consume '/'
  const bytes: number[] = [];

  for (;;) {
    const b = cur.peek();
    if (!isRegular(b)) {
      break;
    }
    cur.advance();
    if (b === 0x23 /* # */) {
      const h1 = cur.peek();
      const h2 = cur.peek(1);
      if (isHexDigit(h1) && isHexDigit(h2)) {
        cur.advance(2);
        bytes.push(hexValue(h1) * 16 + hexValue(h2));
        continue;
      }
      bytes.push(0x23); // reader leniency, see doc comment
      continue;
    }
    bytes.push(b);
  }

  const raw = Uint8Array.from(bytes);
  let value: string;
  try {
    value = utf8Decoder.decode(raw);
  } catch {
    value = latin1Decoder.decode(raw);
  }
  return { kind: 'name', value, offset };
}

/**
 * §7.3.4.2 literal strings.
 * - Balanced parentheses need no escape (R-7.3.4.2-2/3).
 * - Escape sequences per Table 3: \n \r \t \b \f \( \) \\ and \ddd octal
 *   (1–3 digits, high-order overflow ignored — R-7.3.4.2-9/10).
 * - Backslash before EOL: line continuation, both dropped (R-7.3.4.2-6/7).
 * - Backslash before anything else: backslash ignored (R-7.3.4.2-4).
 * - Unescaped EOL in the string data: becomes a single 0Ah regardless of
 *   CR / LF / CRLF (R-7.3.4.2-8).
 */
function readLiteralString(cur: ByteCursor, offset: number): Token {
  cur.advance(); // consume '('
  const bytes: number[] = [];
  let depth = 1;

  for (;;) {
    const b = cur.next();
    if (b === EOF) {
      throw new LexError('unterminated literal string (§7.3.4.2)', offset);
    }

    if (b === 0x5c /* \ */) {
      const e = cur.peek();
      switch (e) {
        case 0x6e: // n
          bytes.push(0x0a);
          cur.advance();
          break;
        case 0x72: // r
          bytes.push(0x0d);
          cur.advance();
          break;
        case 0x74: // t
          bytes.push(0x09);
          cur.advance();
          break;
        case 0x62: // b
          bytes.push(0x08);
          cur.advance();
          break;
        case 0x66: // f
          bytes.push(0x0c);
          cur.advance();
          break;
        case 0x28: // (
          bytes.push(0x28);
          cur.advance();
          break;
        case 0x29: // )
          bytes.push(0x29);
          cur.advance();
          break;
        case 0x5c: // \
          bytes.push(0x5c);
          cur.advance();
          break;
        default: {
          if (isOctalDigit(e)) {
            // \ddd — up to three octal digits, high-order overflow ignored
            let code = 0;
            for (let i = 0; i < 3 && isOctalDigit(cur.peek()); i += 1) {
              code = code * 8 + (cur.next() - 0x30);
            }
            bytes.push(code & 0xff);
            break;
          }
          if (isNewline(e)) {
            cur.tryConsumeEol(); // line continuation: drop backslash + EOL
            break;
          }
          // R-7.3.4.2-4: the REVERSE SOLIDUS shall be ignored
          break;
        }
      }
      continue;
    }

    if (isNewline(b)) {
      // R-7.3.4.2-8: any EOL form in string data reads as 0Ah
      if (b === 0x0d) {
        cur.tryConsume(0x0a);
      }
      bytes.push(0x0a);
      continue;
    }

    if (b === 0x28) {
      depth += 1;
      bytes.push(b);
      continue;
    }
    if (b === 0x29) {
      depth -= 1;
      if (depth === 0) {
        return { kind: 'string', bytes: Uint8Array.from(bytes), form: 'literal', offset };
      }
      bytes.push(b);
      continue;
    }

    bytes.push(b);
  }
}

/**
 * §7.3.4.3 hexadecimal strings. White-space is ignored (R-7.3.4.3-3);
 * an odd number of digits implies a final 0 (R-7.3.4.3-4). Any other byte
 * before `>` is a lexical error.
 */
function readHexString(cur: ByteCursor, offset: number): Token {
  cur.advance(); // consume '<'
  const bytes: number[] = [];
  let pending = -1;

  for (;;) {
    const b = cur.next();
    if (b === EOF) {
      throw new LexError('unterminated hexadecimal string (§7.3.4.3)', offset);
    }
    if (b === 0x3e /* > */) {
      if (pending >= 0) {
        bytes.push(pending * 16); // odd digit count: final digit assumed 0
      }
      return { kind: 'string', bytes: Uint8Array.from(bytes), form: 'hex', offset };
    }
    if (isWhitespace(b)) {
      continue;
    }
    if (!isHexDigit(b)) {
      throw new LexError(
        `invalid byte 0x${b.toString(16).padStart(2, '0')} in hexadecimal string (§7.3.4.3)`,
        offset,
      );
    }
    if (pending < 0) {
      pending = hexValue(b);
    } else {
      bytes.push(pending * 16 + hexValue(b));
      pending = -1;
    }
  }
}

/**
 * §7.2.3 — "A sequence of consecutive regular characters comprises a
 * single token." Case-sensitive. Which keywords exist (true, false, null,
 * obj, endobj, R, stream, endstream, xref, trailer, startxref, n, f) is
 * the parser's vocabulary, not the lexer's.
 */
function readKeyword(cur: ByteCursor, offset: number): Token {
  const bytes: number[] = [];
  for (;;) {
    const b = cur.peek();
    if (!isRegular(b)) {
      break;
    }
    bytes.push(b);
    cur.advance();
  }
  return { kind: 'keyword', value: latin1Decoder.decode(Uint8Array.from(bytes)), offset };
}

/** Convenience: does this byte end any token? (white-space or delimiter or EOF) */
export function isTokenBoundary(byte: number): boolean {
  return byte === EOF || isWhitespace(byte) || isDelimiter(byte);
}
