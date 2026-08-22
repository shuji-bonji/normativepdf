/**
 * FlateDecode body — pure-TS inflate, written against RFC 1950 (zlib
 * container) and RFC 1951 (DEFLATE). The canonical implementation this
 * seat was reserved for (ADR-0003): every behaviour below cites the
 * clause it implements, the same discipline the rest of this library
 * applies to ISO 32000.
 *
 * Strictness follows the RFCs' compliance clauses: a wrong CM, a failed
 * FCHECK, a set FDICT, a reserved block type, a LEN/NLEN mismatch, a
 * distance past the start of the output, a truncated stream, an ADLER32
 * mismatch, and bytes after ADLER32 are all errors, never silence. The
 * interim native implementation agrees on every case but the last, where
 * its answer depends on the RUNTIME (Node 20 ignores trailing bytes,
 * Node >= 21 refuses them — measured); pinning that behaviour down is
 * part of why the pure implementation is the canonical one (ADR-0003).
 *
 * The public shape stays `async` although the body is synchronous —
 * ADR-0003 decision 3: the API does not change when the implementation
 * behind the filter boundary does.
 */

import { FilterError } from './error.js';

/* ------------------------------------------------------------------ *
 * bit reading (RFC 1951 §3.1.1)
 * ------------------------------------------------------------------ */

/**
 * LSB-first bit reader. §3.1.1: "Data elements are packed into bytes in
 * order of increasing bit number within the byte, i.e., starting with
 * the least-significant bit of the byte."
 */
class BitReader {
  private readonly bytes: Uint8Array;
  /** Next byte to load into the bit buffer. */
  pos = 0;
  private bitBuf = 0;
  private bitCount = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  /** Read `n` bits (0-15) as an LSB-first machine integer (§3.1.1). */
  readBits(n: number): number {
    while (this.bitCount < n) {
      const byte = this.bytes[this.pos];
      if (byte === undefined) {
        throw new FilterError(
          `FlateDecode failed: unexpected end of data at byte ${this.pos} (RFC 1951 §3.2.3)`,
        );
      }
      this.bitBuf |= byte << this.bitCount;
      this.bitCount += 8;
      this.pos += 1;
    }
    const value = this.bitBuf & ((1 << n) - 1);
    this.bitBuf >>>= n;
    this.bitCount -= n;
    return value;
  }

  /**
   * Read one Huffman-coded symbol. §3.1.1: "Huffman codes are packed
   * starting with the most-significant bit of the code" — so each bit
   * read extends the code at its least-significant end.
   */
  readSymbol(code: PrefixCode): number {
    let bits = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= MAX_BITS; len += 1) {
      bits = (bits << 1) | this.readBits(1);
      const count = code.count[len] ?? 0;
      if (bits - first < count) {
        return code.symbol[index + (bits - first)] ?? 0;
      }
      index += count;
      first = (first + count) << 1;
    }
    throw new FilterError(
      `FlateDecode failed: bit sequence matches no code at byte ${this.pos} (RFC 1951 §3.2.2)`,
    );
  }

  /** §3.2.4: "Any bits of input up to the next byte boundary are ignored." */
  alignToByte(): void {
    this.bitBuf = 0;
    this.bitCount = 0;
  }

  /** Read a whole byte after alignToByte(). */
  readByte(): number {
    const byte = this.bytes[this.pos];
    if (byte === undefined) {
      throw new FilterError(
        `FlateDecode failed: unexpected end of data at byte ${this.pos} (RFC 1951 §3.2.4)`,
      );
    }
    this.pos += 1;
    return byte;
  }
}

/* ------------------------------------------------------------------ *
 * canonical prefix codes (RFC 1951 §3.2.2)
 * ------------------------------------------------------------------ */

/** §3.2.7: code lengths are 0-15, so codes are at most 15 bits long. */
const MAX_BITS = 15;

/**
 * A canonical prefix code as §3.2.2 defines it: fully determined by the
 * bit length of each symbol's code. `count[len]` is the number of codes
 * of that length; `symbol` lists symbols sorted by (length, symbol),
 * which — with §3.2.2's two rules — is exactly canonical code order.
 */
interface PrefixCode {
  readonly count: Int32Array;
  readonly symbol: Int32Array;
}

/**
 * Build a decoding table from code lengths (§3.2.2 steps 1-3). Lengths
 * of zero mean the symbol "must not be assigned a value".
 *
 * An over-subscribed set of lengths (more codes than the tree has room
 * for) is always an error. An incomplete set is accepted only when the
 * code has exactly one symbol — §3.2.7: "If only one distance code is
 * used, it is encoded using one bit, not zero bits; in this case there
 * is a single code length of one, with one unused code."
 */
function buildPrefixCode(lengths: Uint8Array, what: string): PrefixCode {
  const count = new Int32Array(MAX_BITS + 1);
  let symbols = 0;
  for (let i = 0; i < lengths.length; i += 1) {
    const len = lengths[i] ?? 0;
    count[len] = (count[len] ?? 0) + 1;
    if (len !== 0) {
      symbols += 1;
    }
  }

  let left = 1;
  for (let len = 1; len <= MAX_BITS; len += 1) {
    left = (left << 1) - (count[len] ?? 0);
    if (left < 0) {
      throw new FilterError(
        `FlateDecode failed: over-subscribed ${what} code lengths (RFC 1951 §3.2.2)`,
      );
    }
  }
  if (left > 0 && symbols > 1) {
    throw new FilterError(
      `FlateDecode failed: incomplete ${what} code lengths (RFC 1951 §3.2.2; §3.2.7 permits an incomplete code only for a single symbol)`,
    );
  }

  // §3.2.2 step 2/3 flattened: symbols of equal length take consecutive
  // values in symbol order, shorter lengths precede longer ones.
  const offsets = new Int32Array(MAX_BITS + 2);
  for (let len = 1; len <= MAX_BITS; len += 1) {
    offsets[len + 1] = (offsets[len] ?? 0) + (count[len] ?? 0);
  }
  const symbol = new Int32Array(symbols);
  for (let i = 0; i < lengths.length; i += 1) {
    const len = lengths[i] ?? 0;
    if (len !== 0) {
      const at = offsets[len] ?? 0;
      symbol[at] = i;
      offsets[len] = at + 1;
    }
  }
  return { count, symbol };
}

/* ------------------------------------------------------------------ *
 * fixed codes (RFC 1951 §3.2.6)
 * ------------------------------------------------------------------ */

/**
 * §3.2.6: literal/length code lengths are 8 (0-143), 9 (144-255),
 * 7 (256-279), 8 (280-287); "values 286-287 will never actually occur
 * in the compressed data, but participate in the code construction."
 */
function fixedLiteralLengths(): Uint8Array {
  const lengths = new Uint8Array(288);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  return lengths;
}

/** §3.2.6: "Distance codes 0-31 are represented by (fixed-length) 5-bit codes". */
function fixedDistanceLengths(): Uint8Array {
  return new Uint8Array(32).fill(5);
}

let fixedLitCode: PrefixCode | null = null;
let fixedDistCode: PrefixCode | null = null;

/* ------------------------------------------------------------------ *
 * length / distance tables (RFC 1951 §3.2.5)
 * ------------------------------------------------------------------ */

/** §3.2.5: base lengths for codes 257-285. */
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
/** §3.2.5: extra bits for codes 257-285. */
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
/** §3.2.5: base distances for codes 0-29. */
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
/** §3.2.5: extra bits for distance codes 0-29. */
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

/** §3.2.7: the code length alphabet arrives in this fixed order. */
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/* ------------------------------------------------------------------ *
 * output buffer
 * ------------------------------------------------------------------ */

class OutputBuffer {
  private data: Uint8Array;
  length = 0;

  constructor(initial: number) {
    this.data = new Uint8Array(initial < 1024 ? 1024 : initial);
  }

  private grow(needed: number): void {
    let capacity = this.data.length;
    while (capacity < needed) {
      capacity *= 2;
    }
    const next = new Uint8Array(capacity);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }

  push(byte: number): void {
    if (this.length === this.data.length) {
      this.grow(this.length + 1);
    }
    this.data[this.length] = byte;
    this.length += 1;
  }

  pushBytes(bytes: Uint8Array): void {
    if (this.length + bytes.length > this.data.length) {
      this.grow(this.length + bytes.length);
    }
    this.data.set(bytes, this.length);
    this.length += bytes.length;
  }

  /**
   * §3.2.3 LZ77 copy. "The referenced string may overlap the current
   * position", so the copy is byte-by-byte, never a block move.
   */
  copyBack(distance: number, length: number): void {
    if (this.length + length > this.data.length) {
      this.grow(this.length + length);
    }
    const data = this.data;
    let from = this.length - distance;
    let to = this.length;
    for (let i = 0; i < length; i += 1) {
      data[to] = data[from] ?? 0;
      to += 1;
      from += 1;
    }
    this.length = to;
  }

  finish(): Uint8Array {
    return this.data.slice(0, this.length);
  }
}

/* ------------------------------------------------------------------ *
 * Adler-32 (RFC 1950 §2.2 ADLER32)
 * ------------------------------------------------------------------ */

/**
 * §2.2: "s1 is the sum of all bytes, s2 is the sum of all s1 values.
 * Both sums are done modulo 65521. s1 is initialized to 1, s2 to zero."
 * The modulo is deferred across runs of 5552 bytes — the longest run
 * before s2 can overflow 2^32 with all-0xff input.
 */
function adler32(bytes: Uint8Array, length: number): number {
  let s1 = 1;
  let s2 = 0;
  let i = 0;
  while (i < length) {
    const end = i + 5552 > length ? length : i + 5552;
    for (; i < end; i += 1) {
      s1 += bytes[i] ?? 0;
      s2 += s1;
    }
    s1 %= 65521;
    s2 %= 65521;
  }
  return ((s2 << 16) | s1) >>> 0;
}

/* ------------------------------------------------------------------ *
 * differential oracle hook (GUARDS G-6)
 * ------------------------------------------------------------------ */

type InflateOracle = (input: Uint8Array, output: Uint8Array) => Promise<void>;

let oracle: InflateOracle | null = null;

/**
 * Register a differential oracle called with every successful decode
 * (input, output). The corpus surveys use this to run the interim
 * native implementation alongside and require byte-identical output
 * (ADR-0003 decision 5). Not exported from the package index — this is
 * measurement plumbing, not API.
 */
export function setInflateOracle(next: InflateOracle | null): void {
  oracle = next;
}

/* ------------------------------------------------------------------ *
 * inflate
 * ------------------------------------------------------------------ */

/** Decompress an RFC 1950 zlib stream whose method is DEFLATE (RFC 1951). */
export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const out = inflateSync(bytes);
  if (oracle !== null) {
    await oracle(bytes, out);
  }
  return out;
}

function inflateSync(bytes: Uint8Array): Uint8Array {
  // ---- zlib header (RFC 1950 §2.2; checks required by §2.3) ----
  const cmf = bytes[0];
  const flg = bytes[1];
  if (cmf === undefined || flg === undefined) {
    throw new FilterError(
      `FlateDecode failed: ${bytes.length} byte(s) is too short for a zlib header (RFC 1950 §2.2)`,
    );
  }
  const cm = cmf & 0x0f;
  if (cm !== 8) {
    // §2.3: "must give an error indication if CM is not ... 8".
    throw new FilterError(`FlateDecode failed: compression method ${cm}, not 8 (RFC 1950 §2.3)`);
  }
  const cinfo = cmf >>> 4;
  if (cinfo > 7) {
    // §2.2: "Values of CINFO above 7 are not allowed in this version".
    throw new FilterError(`FlateDecode failed: CINFO ${cinfo} exceeds 7 (RFC 1950 §2.2)`);
  }
  if ((cmf * 256 + flg) % 31 !== 0) {
    // §2.2: CMF*256 + FLG "is a multiple of 31"; §2.3 requires the check.
    throw new FilterError('FlateDecode failed: FCHECK does not verify (RFC 1950 §2.2)');
  }
  if ((flg & 0x20) !== 0) {
    // §2.3: when the containing format (PDF FlateDecode, §7.4.4) defines
    // no preset dictionaries, "a compliant decompressor must reject any
    // stream in which the FDICT flag is set".
    throw new FilterError('FlateDecode failed: FDICT is set (RFC 1950 §2.3)');
  }

  // ---- DEFLATE blocks (RFC 1951 §3.2.3) ----
  const reader = new BitReader(bytes.subarray(2));
  const out = new OutputBuffer(bytes.length * 3);

  let final = 0;
  do {
    final = reader.readBits(1);
    const type = reader.readBits(2);
    if (type === 0) {
      inflateStored(reader, out);
    } else if (type === 1) {
      fixedLitCode ??= buildPrefixCode(fixedLiteralLengths(), 'fixed literal/length');
      fixedDistCode ??= buildPrefixCode(fixedDistanceLengths(), 'fixed distance');
      inflateCompressed(reader, out, fixedLitCode, fixedDistCode);
    } else if (type === 2) {
      const [lit, dist] = readDynamicCodes(reader);
      inflateCompressed(reader, out, lit, dist);
    } else {
      // §3.2.3: "11 - reserved (error)".
      throw new FilterError('FlateDecode failed: reserved block type 11 (RFC 1951 §3.2.3)');
    }
  } while (final === 0);

  // ---- Adler-32 trailer (RFC 1950 §2.2; check required by §2.3) ----
  reader.alignToByte();
  let stored = 0;
  for (let i = 0; i < 4; i += 1) {
    // §2.2: "stored as s2*65536 + s1 in most-significant-byte first ... order".
    stored = (stored << 8) | reader.readByte();
  }
  const computed = adler32(out.finish(), out.length);
  if (stored >>> 0 !== computed) {
    throw new FilterError(
      `FlateDecode failed: ADLER32 mismatch — stored ${(stored >>> 0).toString(16)}, computed ${computed.toString(16)} (RFC 1950 §2.3)`,
    );
  }
  if (reader.pos !== bytes.length - 2) {
    // §2.2: "Any data which may appear after ADLER32 are not part of the
    // zlib stream". Refusing them is a choice §2.2 leaves open — and the
    // interim native implementation decided it BY RUNTIME: Node 20's
    // DecompressionStream ignores trailing bytes, Node >= 21 refuses them
    // (measured). A deterministic decoder picks one behaviour; this one
    // refuses, because bytes it never read are bytes it cannot vouch for.
    throw new FilterError(
      `FlateDecode failed: ${bytes.length - 2 - reader.pos} byte(s) after ADLER32 (RFC 1950 §2.2)`,
    );
  }
  return out.finish();
}

/** §3.2.4 non-compressed block. */
function inflateStored(reader: BitReader, out: OutputBuffer): void {
  reader.alignToByte();
  const len = reader.readByte() | (reader.readByte() << 8);
  const nlen = reader.readByte() | (reader.readByte() << 8);
  if (len !== (~nlen & 0xffff)) {
    // §3.2.4: "NLEN is the one's complement of LEN".
    throw new FilterError(
      `FlateDecode failed: stored-block NLEN is not the complement of LEN (RFC 1951 §3.2.4)`,
    );
  }
  for (let i = 0; i < len; i += 1) {
    out.push(reader.readByte());
  }
}

/** §3.2.3 decoding loop for both fixed and dynamic blocks. */
function inflateCompressed(
  reader: BitReader,
  out: OutputBuffer,
  lit: PrefixCode,
  dist: PrefixCode,
): void {
  for (;;) {
    const symbol = reader.readSymbol(lit);
    if (symbol < 256) {
      // §3.2.3: "if value < 256: copy value (literal byte) to output".
      out.push(symbol);
      continue;
    }
    if (symbol === 256) {
      // §3.2.3: "if value = end of block (256): break from loop".
      return;
    }
    if (symbol > 285) {
      // §3.2.6: "Literal/length values 286-287 will never actually occur
      // in the compressed data, but participate in the code construction."
      throw new FilterError(
        `FlateDecode failed: literal/length symbol ${symbol} (RFC 1951 §3.2.6)`,
      );
    }
    const lengthIndex = symbol - 257;
    const length =
      (LENGTH_BASE[lengthIndex] ?? 0) + reader.readBits(LENGTH_EXTRA[lengthIndex] ?? 0);

    const distSymbol = reader.readSymbol(dist);
    if (distSymbol > 29) {
      // §3.2.6: "distance codes 30-31 will never actually occur".
      throw new FilterError(`FlateDecode failed: distance symbol ${distSymbol} (RFC 1951 §3.2.6)`);
    }
    const distance = (DIST_BASE[distSymbol] ?? 0) + reader.readBits(DIST_EXTRA[distSymbol] ?? 0);
    if (distance > out.length) {
      // §3.2.3: "a distance cannot refer past the beginning of the output stream".
      throw new FilterError(
        `FlateDecode failed: distance ${distance} reaches past the start of the output (RFC 1951 §3.2.3)`,
      );
    }
    out.copyBack(distance, length);
  }
}

/** §3.2.7 dynamic code descriptor. */
function readDynamicCodes(reader: BitReader): [PrefixCode, PrefixCode] {
  const hlit = reader.readBits(5) + 257;
  const hdist = reader.readBits(5) + 1;
  const hclen = reader.readBits(4) + 4;
  if (hlit > 286) {
    // §3.2.7: "# of Literal/Length codes - 257 (257 - 286)".
    throw new FilterError(
      `FlateDecode failed: ${hlit} literal/length codes exceeds 286 (RFC 1951 §3.2.7)`,
    );
  }

  // §3.2.7: (HCLEN + 4) x 3-bit lengths for the code length alphabet,
  // "in the order: 16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13,
  // 2, 14, 1, 15".
  const codeLengthLengths = new Uint8Array(19);
  for (let i = 0; i < hclen; i += 1) {
    codeLengthLengths[CODE_LENGTH_ORDER[i] ?? 0] = reader.readBits(3);
  }
  const codeLengthCode = buildPrefixCode(codeLengthLengths, 'code length');

  // §3.2.7: "all code lengths form a single sequence of HLIT + HDIST +
  // 258 values" — the repeat codes may cross from the literal/length
  // lengths into the distance lengths.
  const lengths = new Uint8Array(hlit + hdist);
  let at = 0;
  while (at < lengths.length) {
    const symbol = reader.readSymbol(codeLengthCode);
    if (symbol <= 15) {
      // §3.2.7: "0 - 15: Represent code lengths of 0 - 15".
      lengths[at] = symbol;
      at += 1;
      continue;
    }
    let repeat: number;
    let value = 0;
    if (symbol === 16) {
      // §3.2.7: "16: Copy the previous code length 3 - 6 times."
      if (at === 0) {
        throw new FilterError(
          'FlateDecode failed: repeat code 16 with no previous length (RFC 1951 §3.2.7)',
        );
      }
      value = lengths[at - 1] ?? 0;
      repeat = 3 + reader.readBits(2);
    } else if (symbol === 17) {
      // §3.2.7: "17: Repeat a code length of 0 for 3 - 10 times."
      repeat = 3 + reader.readBits(3);
    } else {
      // §3.2.7: "18: Repeat a code length of 0 for 11 - 138 times."
      repeat = 11 + reader.readBits(7);
    }
    if (at + repeat > lengths.length) {
      throw new FilterError(
        'FlateDecode failed: code length repeat runs past HLIT + HDIST lengths (RFC 1951 §3.2.7)',
      );
    }
    lengths.fill(value, at, at + repeat);
    at += repeat;
  }

  if ((lengths[256] ?? 0) === 0) {
    // §3.2.3 requires every block to end with symbol 256; a code that
    // cannot express it can never terminate.
    throw new FilterError(
      'FlateDecode failed: the literal/length code has no end-of-block code (RFC 1951 §3.2.3)',
    );
  }
  const lit = buildPrefixCode(lengths.subarray(0, hlit), 'literal/length');
  const dist = buildPrefixCode(lengths.subarray(hlit), 'distance');
  return [lit, dist];
}
