/**
 * TokenReader — pull-based token stream with bounded lookahead over a
 * {@link ByteCursor}.
 *
 * Lookahead exists for exactly one reason: ISO 32000-2 §7.3.10 writes an
 * indirect reference as three tokens (`12 0 R`), so an integer can only be
 * classified after peeking two tokens further.
 *
 * Invariant relied on by the stream reader (§7.3.8): after `take()` returns
 * with an empty lookahead buffer, the cursor sits immediately past the
 * returned token — so raw stream bytes can be read from the cursor without
 * any token-level buffering in between.
 */

import type { ByteCursor } from './byte-cursor.js';
import { nextToken, type Token } from './lexer.js';

/**
 * Pull-based token reader with pushback over a `ByteCursor`. With the
 * lookahead buffer empty the cursor sits immediately past the last token,
 * so stream bytes (§7.3.8) can be read raw from the same cursor without
 * token-level buffering in between.
 */
export class TokenReader {
  readonly #cur: ByteCursor;
  readonly #buffer: Token[] = [];

  constructor(cur: ByteCursor) {
    this.#cur = cur;
  }

  /** The underlying cursor (used by the stream reader for raw byte access). */
  get cursor(): ByteCursor {
    return this.#cur;
  }

  /** Token `ahead` positions from the current one, without consuming. */
  peek(ahead = 0): Token {
    while (this.#buffer.length <= ahead) {
      this.#buffer.push(nextToken(this.#cur));
    }
    const t = this.#buffer[ahead];
    if (t === undefined) {
      // Unreachable: the loop above guarantees the index is populated.
      throw new Error('TokenReader lookahead invariant violated');
    }
    return t;
  }

  /** Consume and return the next token. */
  take(): Token {
    const buffered = this.#buffer.shift();
    return buffered ?? nextToken(this.#cur);
  }
}
