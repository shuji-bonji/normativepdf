/**
 * Lexer tests. Where the specification gives examples, the examples are
 * used verbatim as fixtures (ISO 32000-2 §7.2 / §7.3) — the test then
 * cites the clause it exercises.
 */

import { describe, expect, it } from 'vitest';
import { ByteCursor } from '../src/syntax/byte-cursor.js';
import { LexError, nextToken, type Token } from '../src/syntax/lexer.js';

function lexAll(input: string): Token[] {
  const cur = new ByteCursor(new TextEncoder().encode(input));
  const tokens: Token[] = [];
  for (;;) {
    const t = nextToken(cur);
    tokens.push(t);
    if (t.kind === 'eof') {
      return tokens;
    }
  }
}

function lexOne(input: string): Token {
  const t = lexAll(input)[0];
  if (t === undefined) {
    throw new Error('no token');
  }
  return t;
}

function stringBytes(t: Token): number[] {
  if (t.kind !== 'string') {
    throw new Error(`expected string token, got ${t.kind}`);
  }
  return Array.from(t.bytes);
}

describe('numbers (§7.3.3)', () => {
  it('lexes the integer examples of EXAMPLE 1 verbatim', () => {
    // 123 43445 +17 -98 0
    const tokens = lexAll('123 43445 +17 -98 0');
    expect(tokens.slice(0, 5)).toEqual([
      { kind: 'integer', value: 123, offset: 0 },
      { kind: 'integer', value: 43445, offset: 4 },
      { kind: 'integer', value: 17, offset: 10 },
      { kind: 'integer', value: -98, offset: 14 },
      { kind: 'integer', value: 0, offset: 18 },
    ]);
  });

  it('lexes the real examples of EXAMPLE 2 verbatim, keeping integer/real distinct (R-7.3.3-6)', () => {
    // 34.5 -3.62 +123.6 4. -.002 0
    const tokens = lexAll('34.5 -3.62 +123.6 4. -.002 0');
    expect(tokens.map((t) => t.kind).slice(0, 6)).toEqual([
      'real',
      'real',
      'real',
      'real',
      'real',
      'integer', // trailing 0 is an integer object
    ]);
    expect(tokens[3]).toMatchObject({ kind: 'real', value: 4 });
    expect(tokens[4]).toMatchObject({ kind: 'real', value: -0.002 });
  });

  it('rejects a bare sign with no digits', () => {
    expect(() => lexOne('+ ')).toThrow(LexError);
  });
});

describe('literal strings (§7.3.4.2)', () => {
  it('reads balanced nested parentheses without escapes (R-7.3.4.2-2)', () => {
    const t = lexOne('(a(b)c)');
    expect(stringBytes(t)).toEqual(Array.from(new TextEncoder().encode('a(b)c')));
  });

  it('decodes every Table 3 escape', () => {
    const t = lexOne(String.raw`(\n\r\t\b\f\(\)\\)`);
    expect(stringBytes(t)).toEqual([0x0a, 0x0d, 0x09, 0x08, 0x0c, 0x28, 0x29, 0x5c]);
  });

  it('reads \\ddd octal with 1–3 digits and ignores high-order overflow (R-7.3.4.2-9/10)', () => {
    expect(stringBytes(lexOne(String.raw`(\0533)`))).toEqual([0x2b, 0x33]); // \053 then "3"
    expect(stringBytes(lexOne(String.raw`(\53)`))).toEqual([0x2b]); // two-digit form
    // \400 = 256 octal -> high-order overflow ignored -> 0x00
    expect(stringBytes(lexOne(String.raw`(\400)`))).toEqual([0x00]);
  });

  it('ignores the backslash before an unlisted character (R-7.3.4.2-4)', () => {
    expect(stringBytes(lexOne(String.raw`(\q)`))).toEqual([0x71]);
  });

  it('drops backslash + EOL as a line continuation (R-7.3.4.2-6/7)', () => {
    expect(stringBytes(lexOne('(ab\\\ncd)'))).toEqual(Array.from(new TextEncoder().encode('abcd')));
    expect(stringBytes(lexOne('(ab\\\r\ncd)'))).toEqual(
      Array.from(new TextEncoder().encode('abcd')),
    );
  });

  it('normalizes unescaped EOL inside the string to 0Ah (R-7.3.4.2-8)', () => {
    expect(stringBytes(lexOne('(a\r\nb)'))).toEqual([0x61, 0x0a, 0x62]);
    expect(stringBytes(lexOne('(a\rb)'))).toEqual([0x61, 0x0a, 0x62]);
    expect(stringBytes(lexOne('(a\nb)'))).toEqual([0x61, 0x0a, 0x62]);
  });

  it('fails on an unterminated string', () => {
    expect(() => lexOne('(abc')).toThrow(LexError);
  });
});

describe('hexadecimal strings (§7.3.4.3)', () => {
  it('decodes hex pairs and ignores white-space (R-7.3.4.3-3)', () => {
    expect(stringBytes(lexOne('<48 65\n6C6C 6F>'))).toEqual(
      Array.from(new TextEncoder().encode('Hello')),
    );
  });

  it('assumes a trailing 0 for an odd digit count (R-7.3.4.3-4)', () => {
    // The clause's own convention: <901FA> means 90 1F A0
    expect(stringBytes(lexOne('<901FA>'))).toEqual([0x90, 0x1f, 0xa0]);
  });

  it('rejects non-hex bytes', () => {
    expect(() => lexOne('<48ZZ>')).toThrow(LexError);
  });
});

describe('names (§7.3.5)', () => {
  it('treats the SOLIDUS as prefix, not part of the name (R-7.3.5-4)', () => {
    expect(lexOne('/Type')).toMatchObject({ kind: 'name', value: 'Type' });
  });

  it('resolves #xx hexadecimal codes (R-7.3.5-5/6/7)', () => {
    expect(lexOne('/A#23B')).toMatchObject({ kind: 'name', value: 'A#B' }); // #23 = '#'
    expect(lexOne('/Name#20With#20Space')).toMatchObject({
      kind: 'name',
      value: 'Name With Space',
    });
  });

  it('is case-sensitive (§7.2.3)', () => {
    const a = lexOne('/A');
    const b = lexOne('/a');
    expect(a).toMatchObject({ value: 'A' });
    expect(b).toMatchObject({ value: 'a' });
  });

  it('an empty name is valid syntax (the clause sets no minimum length)', () => {
    expect(lexOne('/ ')).toMatchObject({ kind: 'name', value: '' });
  });

  it('interprets the byte sequence as UTF-8 (R-7.3.5-13)', () => {
    // 日 = E6 97 A5 in UTF-8, written with #xx escapes
    expect(lexOne('/#E6#97#A5')).toMatchObject({ kind: 'name', value: '日' });
  });
});

describe('delimiters and structure tokens (§7.2.3, §7.3.6, §7.3.7)', () => {
  it('distinguishes << >> from < >', () => {
    const tokens = lexAll('<</K[<AB>]>>');
    expect(tokens.map((t) => t.kind)).toEqual([
      'dict-open',
      'name',
      'array-open',
      'string',
      'array-close',
      'dict-close',
      'eof',
    ]);
  });

  it('rejects a lone ">"', () => {
    expect(() => lexOne('> ')).toThrow(LexError);
  });

  it('rejects an unbalanced ")" outside a string (R-7.3.4.2-2)', () => {
    expect(() => lexOne(') ')).toThrow(LexError);
  });
});

describe('comments (§7.2.4)', () => {
  it('treats a comment as a single white-space: the clause example lexes as tokens abc, 123', () => {
    const tokens = lexAll('abc%comment (/%) blah blah blah\n123');
    expect(tokens).toEqual([
      { kind: 'keyword', value: 'abc', offset: 0 },
      { kind: 'integer', value: 123, offset: expect.any(Number) },
      { kind: 'eof', offset: expect.any(Number) },
    ]);
  });
});

describe('keywords (§7.2.3)', () => {
  it('lexes object framing keywords as generic keywords', () => {
    const tokens = lexAll('12 0 obj null endobj');
    expect(tokens).toEqual([
      { kind: 'integer', value: 12, offset: 0 },
      { kind: 'integer', value: 0, offset: 3 },
      { kind: 'keyword', value: 'obj', offset: 5 },
      { kind: 'keyword', value: 'null', offset: 9 },
      { kind: 'keyword', value: 'endobj', offset: 14 },
      { kind: 'eof', offset: expect.any(Number) },
    ]);
  });

  it('white-space variants separate tokens identically (§7.2.3: consecutive white-space is one separator)', () => {
    for (const ws of [' ', '\t', '\n', '\r', '\r\n', '\f', '\0', '  \n ']) {
      const tokens = lexAll(`1${ws}2`);
      expect(tokens.map((t) => t.kind)).toEqual(['integer', 'integer', 'eof']);
    }
  });
});
