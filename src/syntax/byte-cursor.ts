/**
 * ByteCursor — the single place where index access into the input buffer
 * happens (docs/adr/0002-type-strictness.md: bounds checking is quarantined
 * here so `noUncheckedIndexedAccess` friction does not spread through the
 * lexer and parsers).
 *
 * Out-of-range reads return the {@link EOF} sentinel (-1), which no byte
 * classifier accepts. This is an implementation choice, not a claim about
 * PDF syntax.
 */

import { EOF, isNewline, isWhitespace } from './byte-classes.js';

/**
 * Position-tracked cursor over the file's raw bytes — the layer the lexer
 * (`nextToken`) and the raw stream reader share, so token reading and byte
 * reading stay in step (§7.2).
 */
export class ByteCursor {
  readonly #bytes: Uint8Array;
  #pos: number;

  constructor(bytes: Uint8Array, pos = 0) {
    this.#bytes = bytes;
    this.#pos = pos;
  }

  /** Current byte offset from the start of the buffer. */
  get pos(): number {
    return this.#pos;
  }

  /** Total length of the underlying buffer. */
  get length(): number {
    return this.#bytes.length;
  }

  get atEnd(): boolean {
    return this.#pos >= this.#bytes.length;
  }

  /** Byte at current position + offset, or {@link EOF}. Does not advance. */
  peek(offset = 0): number {
    const b = this.#bytes[this.#pos + offset];
    return b === undefined ? EOF : b;
  }

  /** Byte at current position; advances by one. Returns {@link EOF} at end. */
  next(): number {
    const b = this.peek();
    if (b !== EOF) {
      this.#pos += 1;
    }
    return b;
  }

  /** Advance by n bytes (clamped to the buffer end). */
  advance(n = 1): void {
    this.#pos = Math.min(this.#pos + n, this.#bytes.length);
  }

  /** True and advances if the current byte equals `byte`; false otherwise. */
  tryConsume(byte: number): boolean {
    if (this.peek() === byte) {
      this.#pos += 1;
      return true;
    }
    return false;
  }

  /**
   * Consume one EOL marker per ISO 32000-2 §7.2.3: CR, LF, or CRLF
   * ("The combination of a CARRIAGE RETURN followed immediately by a
   * LINE FEED shall be treated as one EOL marker"). Returns true if a
   * marker was consumed.
   */
  tryConsumeEol(): boolean {
    const b = this.peek();
    if (b === 0x0d) {
      this.#pos += 1;
      if (this.peek() === 0x0a) {
        this.#pos += 1;
      }
      return true;
    }
    if (b === 0x0a) {
      this.#pos += 1;
      return true;
    }
    return false;
  }

  /**
   * Skip white-space (Table 1) and comments (§7.2.4: a comment runs from
   * `%` to before the EOL marker and "shall be treated as a single
   * white-space character"). The `%PDF-n.m` / `%%EOF` comments of §7.5 are
   * significant to the *file-structure* parser, which reads them before
   * handing offsets to token-level code — at token level every comment is
   * white-space.
   */
  skipWhitespaceAndComments(): void {
    for (;;) {
      const b = this.peek();
      if (isWhitespace(b)) {
        this.#pos += 1;
        continue;
      }
      if (b === 0x25 /* % */) {
        this.#pos += 1;
        while (!this.atEnd && !isNewline(this.peek())) {
          this.#pos += 1;
        }
        continue;
      }
      return;
    }
  }

  /** Copy of `n` bytes starting at `start` (clamped). Never throws. */
  slice(start: number, end: number): Uint8Array {
    return this.#bytes.slice(start, end);
  }

  /** True if the bytes at the current position equal `expected` (no advance). */
  matches(expected: readonly number[]): boolean {
    for (let i = 0; i < expected.length; i += 1) {
      if (this.peek(i) !== expected[i]) {
        return false;
      }
    }
    return true;
  }

  /** Reposition the cursor (used by xref-driven random access and recovery). */
  seek(pos: number): void {
    this.#pos = Math.max(0, Math.min(pos, this.#bytes.length));
  }
}
