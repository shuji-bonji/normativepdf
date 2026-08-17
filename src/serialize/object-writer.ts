/**
 * COS object serializer — ISO 32000-2 §7.3, the inverse of the object parser.
 *
 * Scope and stance:
 * - Every escaping decision below is a clause, not a preference. Where the
 *   specification permits two forms (a regular character in a name may be
 *   written as itself *or* as `#xx`, R-7.3.5-6), one is chosen and the choice
 *   is fixed, because deterministic output is a design requirement
 *   (DESIGN §4.1) — same input, same bytes, no time or randomness.
 * - Nothing here validates. A dictionary missing a required key is written as
 *   given; whether the document conforms is pdf-verify-mcp's answer
 *   (DESIGN §4.2).
 * - Streams are written with the bytes they carry, unencoded and unmodified.
 *   Compression is not applied (ADR-0003 §4: `CompressionStream` output is not
 *   byte-stable across engines, so it cannot be used where determinism is
 *   required; the writer starts uncompressed, which `/Filter` being optional
 *   makes legal).
 */

import type { CosDict, CosObject } from '../cos/types.js';
import { isRegular, isWhitespace } from '../syntax/byte-classes.js';

/** Growable byte sink. Kept private so callers cannot leave it half-written. */
export class ByteWriter {
  #chunks: Uint8Array[] = [];
  #length = 0;

  /** Bytes written so far — the value a cross-reference offset is taken from. */
  get length(): number {
    return this.#length;
  }

  bytes(data: Uint8Array): this {
    this.#chunks.push(data);
    this.#length += data.length;
    return this;
  }

  /** ASCII/Latin-1 text. Callers pass only bytes they have already escaped. */
  ascii(text: string): this {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) {
      out[i] = text.charCodeAt(i) & 0xff;
    }
    return this.bytes(out);
  }

  toUint8Array(): Uint8Array {
    const out = new Uint8Array(this.#length);
    let at = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}

const UTF8 = new TextEncoder();

/**
 * §7.3.3 — a real "shall be written as one or more decimal digits with an
 * optional sign and a leading, trailing, or embedded PERIOD" (R-7.3.3-4), and
 * **R-7.3.3-8: "A PDF writer shall not use the PostScript language syntax for
 * numbers … in exponential format (such as 6.02E23)."**
 *
 * JavaScript reaches for the exponent at both ends of the range (`1e-7`,
 * `1e+21`), so the value is expanded into positional notation. The digits come
 * from `String(value)`, which is the shortest decimal that reads back as the
 * same double — so nothing is invented and nothing is rounded away.
 *
 * 🔴 Measured: an earlier version formatted with `toFixed(20)`, which caps at
 * 20 fraction digits and therefore wrote `/YStep -1.175e-38` as `0`. The
 * corpus caught it (TWG A018-pdfa2-pass-b), and the source file held the value
 * in plain positional form with 38 decimals — legal input this writer was
 * silently destroying. Annex C puts the smallest non-zero real at about
 * 1.175 × 10⁻³⁸, so specimens sit exactly on that edge on purpose.
 *
 * A real that happens to be integral still carries a PERIOD: the distinction
 * between integer and real survived parsing (R-7.3.3-6 exists only if it
 * does), so it has to survive writing.
 */
function formatReal(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`a real object shall be a number (§7.3.3); got ${String(value)}`);
  }
  const shortest = String(value);
  const exponent = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(shortest);
  if (exponent === null) {
    return shortest.includes('.') ? shortest : `${shortest}.0`;
  }

  const sign = exponent[1] ?? '';
  const whole = exponent[2] ?? '';
  const fraction = exponent[3] ?? '';
  const digits = whole + fraction;
  // Where the PERIOD lands once the exponent is applied.
  const point = whole.length + Number.parseInt(exponent[4] ?? '0', 10);

  if (point <= 0) {
    return `${sign}0.${'0'.repeat(-point)}${digits}`;
  }
  if (point >= digits.length) {
    return `${sign}${digits}${'0'.repeat(point - digits.length)}.0`;
  }
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * §7.3.5 — name escaping.
 *
 * R-7.3.5-5: a NUMBER SIGN in a name shall be written `#23`.
 * R-7.3.5-7: any character that is not regular shall be written `#xx`.
 * R-7.3.5-8: white space used as part of a name shall always use `#xx`.
 * R-7.3.5-6 leaves regular characters free; they are written as themselves,
 * which keeps the output readable and, more importantly, fixed.
 *
 * The name's characters are encoded as UTF-8 first: R-7.3.5-13 says name
 * bytes "should be interpreted according to UTF-8", and the parser decodes
 * them that way, so writing them back any other way would not round-trip.
 */
function writeName(out: ByteWriter, value: string): void {
  out.ascii('/');
  for (const byte of UTF8.encode(value)) {
    if (byte === 0x23 || isWhitespace(byte) || !isRegular(byte)) {
      // 🔴 Upper case. §7.3.5 says "2-digit hexadecimal code" and does not fix
      // the case, so both are legal to write — but readers exist that only
      // decode upper case: pdf-lib matches `/#([\dABCDEF]{2})/g`, so a name
      // written `/text#2fcsv` reads back as the string "text#2fcsv" there,
      // and `/Subtype` on an embedded file stops being the MIME type.
      // Measured 2026-08-15 against pdf-lib 1.17.1 (PDFName.js:10).
      out.ascii(`#${byte.toString(16).toUpperCase().padStart(2, '0')}`);
    } else {
      out.bytes(new Uint8Array([byte]));
    }
  }
}

/** §7.3.4.3 — hexadecimal string: hex digits between angle brackets. */
function writeHexString(out: ByteWriter, value: Uint8Array): void {
  out.ascii('<');
  for (const byte of value) {
    out.ascii(byte.toString(16).padStart(2, '0'));
  }
  out.ascii('>');
}

/**
 * §7.3.4.2 — literal string.
 *
 * Only what the clause requires to be escaped is escaped (R-7.3.4.2-15:
 * REVERSE SOLIDUS is the escape for unbalanced parentheses and for itself).
 * Rather than track nesting to decide which parentheses are balanced, both
 * are always escaped — always legal, and it removes a state machine from a
 * path where a mistake produces a file that parses as something else.
 *
 * Bytes outside printable ASCII are written as `\ddd` (Table 3). The clause
 * permits raw bytes here, but a literal string carrying a raw CR would be read
 * back as LF (R-7.3.4.2-8) — the escape is what makes the value survive.
 * R-7.3.4.2-11 requires three octal digits when the next character is a digit;
 * three are always used, which satisfies it unconditionally.
 */
function writeLiteralString(out: ByteWriter, value: Uint8Array): void {
  out.ascii('(');
  for (const byte of value) {
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) {
      out.ascii(`\\${String.fromCharCode(byte)}`);
    } else if (byte < 0x20 || byte > 0x7e) {
      out.ascii(`\\${byte.toString(8).padStart(3, '0')}`);
    } else {
      out.bytes(new Uint8Array([byte]));
    }
  }
  out.ascii(')');
}

/**
 * Write a direct object (§7.3). Streams are rejected: R-7.3.8.1-5 requires
 * every stream to be an indirect object, so a stream can only appear through
 * {@link writeIndirectObject}.
 */
export function writeObject(out: ByteWriter, object: CosObject): void {
  switch (object.kind) {
    case 'null':
      out.ascii('null');
      return;
    case 'boolean':
      out.ascii(object.value ? 'true' : 'false');
      return;
    case 'integer':
      if (!Number.isInteger(object.value)) {
        throw new RangeError(
          `an integer object shall be written as digits without a PERIOD (§7.3.3); got ${object.value}`,
        );
      }
      out.ascii(String(object.value));
      return;
    case 'real':
      out.ascii(formatReal(object.value));
      return;
    case 'name':
      writeName(out, object.value);
      return;
    case 'string':
      if (object.form === 'hex') {
        writeHexString(out, object.bytes);
      } else {
        writeLiteralString(out, object.bytes);
      }
      return;
    case 'ref':
      // R-7.3.10-9 — object number, generation number, keyword R.
      out.ascii(`${object.objectNumber} ${object.generationNumber} R`);
      return;
    case 'array': {
      out.ascii('[');
      object.items.forEach((item, index) => {
        if (index > 0) {
          out.ascii(' ');
        }
        writeObject(out, item);
      });
      out.ascii(']');
      return;
    }
    case 'dict':
      writeDict(out, object);
      return;
    case 'stream':
      throw new TypeError(
        'all streams shall be indirect objects (R-7.3.8.1-5) — use writeIndirectObject',
      );
    default: {
      const never: never = object;
      throw new TypeError(`unhandled COS kind: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * §7.3.7 — dictionary. Entries are unordered by the clause (R-7.3.7-10), so
 * insertion order is preserved rather than sorted: it is the order the parser
 * saw, which keeps a diff against the source file readable. Determinism is
 * unaffected — the same parse yields the same order.
 *
 * A `null` value is written, not dropped. R-7.3.7-7 makes a null entry
 * equivalent to an absent one *when reading*; that is not a licence for a
 * writer to discard what it was given (see `dictGet` / `dictGetRaw`).
 */
function writeDict(out: ByteWriter, dict: CosDict): void {
  out.ascii('<<');
  for (const [key, value] of dict.entries) {
    writeName(out, key);
    // A delimiter or white space would separate the key from its value on its
    // own, but names and numbers are self-delimiting only against non-regular
    // bytes — `/Key/Value` is legal, `/Key 12` needs the space. One space
    // always is simpler than deciding per value type, and stays deterministic.
    out.ascii(' ');
    writeObject(out, value);
  }
  out.ascii('>>');
}

/**
 * §7.3.10 — one indirect object: `N G obj … endobj`.
 *
 * For a stream (§7.3.8.1) the dictionary is followed by the keyword `stream`,
 * an end-of-line marker, the bytes, and `endstream`. R-7.3.8.1-6 permits only
 * CR LF or LF after `stream`, never CR alone — LF is used.
 *
 * `/Length` is written as a direct integer equal to the byte count actually
 * emitted (R-7.3.8.2-1), replacing whatever the source dictionary carried.
 * The source value can be an indirect reference, and it can be wrong: the
 * parser falls back to locating `endstream` when it is, so preserving the
 * original number would write a file that disagrees with itself. This is one
 * of the three intentional differences recorded in ADR-0004 §4.
 */
export function writeIndirectObject(
  out: ByteWriter,
  objectNumber: number,
  generationNumber: number,
  object: CosObject,
): void {
  out.ascii(`${objectNumber} ${generationNumber} obj\n`);
  if (object.kind === 'stream') {
    const entries = new Map(object.dict.entries);
    entries.set('Length', { kind: 'integer', value: object.raw.length });
    writeDict(out, { kind: 'dict', entries });
    out.ascii('\nstream\n');
    out.bytes(object.raw);
    // R-7.3.8.2-4 permits one extra EOL before `endstream`; it is written so
    // that `endstream` starts a line even when the data does not end with one.
    out.ascii('\nendstream');
  } else {
    writeObject(out, object);
  }
  out.ascii('\nendobj\n');
}
