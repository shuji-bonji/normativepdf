/**
 * Object parser — assembles tokens into the COS objects of ISO 32000-2
 * §7.3, including indirect references (§7.3.10) and stream objects
 * (§7.3.8).
 *
 * Strict layer: syntax the specification does not permit is an error here.
 * Tolerating real-world deviations is the recovery layer's job
 * (docs/DESIGN.md §5.1 stage 0), not a silent default.
 *
 * Resolution is out of scope: an indirect reference is returned as a
 * {@link CosRef} value. The rule that a reference to an undefined object
 * reads as null (R-7.3.10-13/14) belongs to the resolver that owns the
 * cross-reference information, not to this parser.
 */

import type { CosDict, CosObject, CosRef } from '../cos/types.js';
import { COS_FALSE, COS_NULL, COS_TRUE, dictGet } from '../cos/types.js';
import type { Token } from './lexer.js';
import type { TokenReader } from './token-reader.js';

/** Structural error with the byte offset where it was detected. */
export class ParseError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} (at byte ${offset})`);
    this.name = 'ParseError';
    this.offset = offset;
  }
}

/** Options for `parseObject` / `parseIndirectObject`. */
export interface ParseObjectOptions {
  /**
   * Resolve an indirect /Length to its integer value (§7.3.10 EXAMPLE 3:
   * a stream's Length may be an indirect reference, e.g. written by
   * single-pass generators). Without a resolver, such a stream is a
   * ParseError — guessing the extent would violate R-7.3.8.2-1.
   */
  readonly resolveStreamLength?: (ref: CosRef) => number | undefined;
}

/** An indirect object definition: `<objNum> <genNum> obj … endobj` (§7.3.10). */
export interface IndirectObject {
  readonly objectNumber: number;
  readonly generationNumber: number;
  readonly object: CosObject;
}

/**
 * Parse one object in direct-object position. Handles all §7.3 basic
 * types and classifies `<int> <int> R` as an indirect reference
 * (two-token lookahead).
 */
export function parseObject(reader: TokenReader): CosObject {
  const t = reader.take();
  return parseFromToken(reader, t);
}

function parseFromToken(reader: TokenReader, t: Token): CosObject {
  switch (t.kind) {
    case 'integer':
      return maybeReference(reader, t.value, t.offset);
    case 'real':
      return { kind: 'real', value: t.value };
    case 'string':
      return { kind: 'string', bytes: t.bytes, form: t.form };
    case 'name':
      return { kind: 'name', value: t.value };
    case 'array-open':
      return parseArrayBody(reader, t.offset);
    case 'dict-open':
      return parseDictBody(reader, t.offset);
    case 'keyword':
      switch (t.value) {
        case 'true': // §7.3.2
          return COS_TRUE;
        case 'false':
          return COS_FALSE;
        case 'null': // §7.3.9
          return COS_NULL;
        default:
          throw new ParseError(`unexpected keyword "${t.value}" in object position`, t.offset);
      }
    case 'array-close':
      throw new ParseError('unexpected "]" (no matching "[")', t.offset);
    case 'dict-close':
      throw new ParseError('unexpected ">>" (no matching "<<")', t.offset);
    case 'eof':
      throw new ParseError('unexpected end of input in object position', t.offset);
    default: {
      const unreachable: never = t;
      return unreachable;
    }
  }
}

/**
 * §7.3.10 — an indirect reference is `objNum genNum R`: a positive integer
 * object number, a non-negative integer generation number, the keyword R.
 * If the three-token pattern is present but the numbers violate those
 * constraints, that is a syntax error, not two integers followed by a
 * keyword — silently re-reading it as data would hide the corruption.
 */
function maybeReference(reader: TokenReader, first: number, offset: number): CosObject {
  const second = reader.peek(0);
  const third = reader.peek(1);
  if (second.kind !== 'integer' || third.kind !== 'keyword' || third.value !== 'R') {
    return { kind: 'integer', value: first };
  }

  if (first < 1 || !Number.isInteger(first)) {
    throw new ParseError(
      `indirect reference with non-positive object number ${first} (§7.3.10)`,
      offset,
    );
  }
  if (second.value < 0) {
    throw new ParseError(
      `indirect reference with negative generation number ${second.value} (§7.3.10)`,
      offset,
    );
  }

  reader.take(); // generation number
  reader.take(); // keyword R
  return { kind: 'ref', objectNumber: first, generationNumber: second.value };
}

/** §7.3.6 — heterogeneous, possibly empty array, closed by `]`. */
function parseArrayBody(reader: TokenReader, openOffset: number): CosObject {
  const items: CosObject[] = [];
  for (;;) {
    const next = reader.peek(0);
    if (next.kind === 'array-close') {
      reader.take();
      return { kind: 'array', items };
    }
    if (next.kind === 'eof') {
      throw new ParseError('unterminated array (§7.3.6)', openOffset);
    }
    items.push(parseObject(reader));
  }
}

/**
 * §7.3.7 — keys shall be names (R-7.3.7-1); multiple entries shall not
 * have the same key (R-7.3.7-13). The duplicate-key rule addresses the
 * file, so a duplicate is a strict-layer error; recovery policy
 * (e.g. last-wins) belongs to the recovery layer.
 */
function parseDictBody(reader: TokenReader, openOffset: number): CosDict {
  const entries = new Map<string, CosObject>();
  for (;;) {
    const next = reader.take();
    if (next.kind === 'dict-close') {
      return { kind: 'dict', entries };
    }
    if (next.kind === 'eof') {
      throw new ParseError('unterminated dictionary (§7.3.7)', openOffset);
    }
    if (next.kind !== 'name') {
      throw new ParseError(
        `dictionary key shall be a name (R-7.3.7-1), got ${next.kind}`,
        next.offset,
      );
    }
    if (entries.has(next.value)) {
      throw new ParseError(`duplicate dictionary key /${next.value} (R-7.3.7-13)`, next.offset);
    }
    entries.set(next.value, parseObject(reader));
  }
}

/**
 * Parse an indirect object definition:
 * `objNum genNum obj <object> endobj` (§7.3.10), or with a stream body
 * `… << dict >> stream … endstream endobj` (§7.3.8).
 */
export function parseIndirectObject(
  reader: TokenReader,
  options?: ParseObjectOptions,
): IndirectObject {
  const numTok = reader.take();
  if (numTok.kind !== 'integer' || numTok.value < 1) {
    throw new ParseError(
      'indirect object shall begin with a positive integer object number (§7.3.10)',
      numTok.offset,
    );
  }
  const genTok = reader.take();
  if (genTok.kind !== 'integer' || genTok.value < 0) {
    throw new ParseError(
      'object number shall be followed by a non-negative generation number (§7.3.10)',
      genTok.offset,
    );
  }
  const objTok = reader.take();
  if (objTok.kind !== 'keyword' || objTok.value !== 'obj') {
    throw new ParseError('expected keyword "obj" (§7.3.10)', objTok.offset);
  }

  const value = parseObject(reader);

  const next = reader.peek(0);
  if (next.kind === 'keyword' && next.value === 'stream') {
    if (value.kind !== 'dict') {
      throw new ParseError(
        'keyword "stream" shall follow a stream dictionary (R-7.3.8.1-4)',
        next.offset,
      );
    }
    reader.take(); // keyword stream; buffer now empty -> cursor sits right after it
    const stream = readStreamBody(reader, value, options);
    expectKeyword(reader, 'endobj');
    return { objectNumber: numTok.value, generationNumber: genTok.value, object: stream };
  }

  expectKeyword(reader, 'endobj');
  return { objectNumber: numTok.value, generationNumber: genTok.value, object: value };
}

/**
 * §7.3.8 stream body.
 * - The keyword `stream` shall be followed by CRLF or LF, not CR alone
 *   (R-7.3.8.1-6).
 * - Length is required (R-7.3.8.2-1) and counts the encoded bytes; an
 *   indirect Length needs the caller's resolver (§7.3.10 EXAMPLE 3).
 * - An extra EOL before `endstream` is permitted and not part of the data
 *   (R-7.3.8.1-7/8, R-7.3.8.2-4/5).
 * - `raw` is stored exactly as read — undecoded (filters are §7.4).
 */
function readStreamBody(
  reader: TokenReader,
  dict: CosDict,
  options?: ParseObjectOptions,
): CosObject {
  const cur = reader.cursor;

  const eolStart = cur.pos;
  const b = cur.peek();
  if (b === 0x0d) {
    cur.advance();
    if (!cur.tryConsume(0x0a)) {
      throw new ParseError(
        'keyword "stream" shall be followed by CRLF or LF, not CR alone (R-7.3.8.1-6)',
        eolStart,
      );
    }
  } else if (b === 0x0a) {
    cur.advance();
  } else {
    throw new ParseError(
      'keyword "stream" shall be followed by an end-of-line marker (R-7.3.8.1-6)',
      eolStart,
    );
  }

  const length = streamLength(dict, eolStart, options);
  const start = cur.pos;
  if (start + length > cur.length) {
    throw new ParseError(`stream Length ${length} runs past the end of input (R-7.3.8.2-1)`, start);
  }
  const raw = cur.slice(start, start + length);
  cur.seek(start + length);

  cur.tryConsumeEol(); // optional EOL before endstream, not counted in Length
  expectKeyword(reader, 'endstream');

  return { kind: 'stream', dict, raw };
}

function streamLength(dict: CosDict, offset: number, options?: ParseObjectOptions): number {
  const lengthValue = dictGet(dict, 'Length');
  if (lengthValue === undefined) {
    throw new ParseError('stream dictionary shall have a Length entry (R-7.3.8.2-1)', offset);
  }
  if (lengthValue.kind === 'integer') {
    if (lengthValue.value < 0) {
      throw new ParseError(`negative stream Length ${lengthValue.value} (R-7.3.8.2-1)`, offset);
    }
    return lengthValue.value;
  }
  if (lengthValue.kind === 'ref') {
    const resolved = options?.resolveStreamLength?.(lengthValue);
    if (resolved === undefined) {
      throw new ParseError(
        'stream Length is an indirect reference and no resolver was provided (§7.3.10 EXAMPLE 3)',
        offset,
      );
    }
    if (!Number.isInteger(resolved) || resolved < 0) {
      throw new ParseError(
        `resolved stream Length ${resolved} is not a non-negative integer`,
        offset,
      );
    }
    return resolved;
  }
  throw new ParseError(
    `stream Length shall be an integer, got ${lengthValue.kind} (R-7.3.8.2-1)`,
    offset,
  );
}

function expectKeyword(reader: TokenReader, keyword: string): void {
  const t = reader.take();
  if (t.kind !== 'keyword' || t.value !== keyword) {
    throw new ParseError(
      `expected keyword "${keyword}", got ${t.kind === 'keyword' ? `"${t.value}"` : t.kind}`,
      t.offset,
    );
  }
}
