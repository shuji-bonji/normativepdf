/**
 * Fixture builder — assembles a classic-cross-reference PDF (§7.5) from
 * hand-written object sources, computing every byte offset.
 *
 * **Why fixtures are hand-written rather than produced by `writeFile`.**
 * The library reads what it writes. A fixture built with `writeFile` and read
 * back with `parsePdf` cannot fail when both sides share a mistake
 * (GUARDS T-2). Hand-written sources are independent of both.
 *
 * **Why offsets are computed rather than written by hand.** They would rot the
 * moment a fixture changes, and a rotten offset produces a fixture that tests
 * the recovery path instead of the thing under test.
 *
 * 🔴 **The cross-reference is indexed by object number, not by array
 * position.** An earlier version of this builder wrote the i-th entry for the
 * i-th array element, which silently required callers to pass objects in
 * ascending, contiguous order. Listing a page tree in reading order (root,
 * then the intermediate node, then its pages) was enough to break it: qpdf
 * answered `object 4 0, offset 234: expected 4 0 obj / file is damaged`, and
 * this library's own parser answered `cross-reference table points object 4 0
 * at a definition of 3 0 (§7.5.4)`. Requiring callers to sort by number would
 * fight the wish to write a tree in the order that reads well, so the builder
 * sorts instead. Gaps become separate subsections (§7.5.4 allows any number of
 * them) rather than invented free entries.
 */

const enc = (s: string) => new TextEncoder().encode(s);
const pad = (n: number, w: number) => n.toString().padStart(w, '0');

/** An indirect object placed in the body, with the number it keeps. */
export interface ObjectEntry {
  readonly number: number;
  /** §7.3.10. Defaults to 0. */
  readonly generation?: number;
  /** The complete `n g obj … endobj` text, including its trailing EOL. */
  readonly source: string;
}

/**
 * A plain string is shorthand for "the i-th object, numbered i+1, generation
 * 0" — the shape most fixtures want and the one this builder started with.
 */
export type ObjectSource = string | ObjectEntry;

export interface BuildOptions {
  readonly junkBefore?: string;
  readonly header?: string;
  /** Two-character entry EOL (§7.5.4): `' \r'` | `' \n'` | `'\r\n'`. */
  readonly entryEol?: string;
  /** Receives `/Size` (highest object number + 1, Table 15). */
  readonly trailerSource?: (size: number) => string;
  readonly startxrefOverride?: number;
  readonly tailSource?: (startxref: number) => string;
}

export interface BuiltPdf {
  readonly bytes: Uint8Array;
  readonly text: string;
  /** Offset of the `xref` keyword, relative to the `%PDF-` origin (§7.5.2). */
  readonly xrefOffset: number;
  /** Offsets in the order the objects were passed. */
  readonly objectOffsets: readonly number[];
  /** Offset of a specific object, for fixtures that do not pass them in order. */
  offsetOf(objectNumber: number): number;
  /** `/Size` as written in the trailer. */
  readonly size: number;
}

const normalise = (source: ObjectSource, index: number): Required<ObjectEntry> =>
  typeof source === 'string'
    ? { number: index + 1, generation: 0, source }
    : { number: source.number, generation: source.generation ?? 0, source: source.source };

/** Contiguous runs of object numbers, each of which becomes one subsection. */
function subsections(numbers: readonly number[]): { start: number; count: number }[] {
  const runs: { start: number; count: number }[] = [];
  for (const n of numbers) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last.start + last.count === n) {
      last.count += 1;
    } else {
      runs.push({ start: n, count: 1 });
    }
  }
  return runs;
}

/**
 * Assemble a PDF with a classic cross-reference table. Every offset is
 * measured from the `%PDF-` header, which is where §7.5.2 puts the origin —
 * so `junkBefore` shifts the file without shifting the table.
 */
export function buildPdf(sources: readonly ObjectSource[], opts: BuildOptions = {}): BuiltPdf {
  const junk = opts.junkBefore ?? '';
  const header = opts.header ?? '%PDF-1.7\n';
  const eol = opts.entryEol ?? ' \n';

  const objects = sources.map(normalise);
  const seen = new Set<number>();
  for (const o of objects) {
    if (o.number < 1) {
      throw new RangeError(`object number shall be positive (§7.3.10); got ${o.number}`);
    }
    if (seen.has(o.number)) {
      throw new RangeError(
        `object ${o.number} given twice — a cross-reference table holds one entry per number`,
      );
    }
    seen.add(o.number);
  }

  // Body: written in the order the caller gave, so a fixture can read well.
  let rel = header.length;
  const objectOffsets: number[] = [];
  const offsetByNumber = new Map<number, number>();
  let body = '';
  for (const o of objects) {
    objectOffsets.push(rel);
    offsetByNumber.set(o.number, rel);
    body += o.source;
    rel += o.source.length;
  }

  // Table: indexed by number, so body order and table order are independent.
  const xrefOffset = rel;
  const sorted = [...objects].sort((a, b) => a.number - b.number);
  const size = (sorted[sorted.length - 1]?.number ?? 0) + 1;

  // Object 0 heads the free list (§7.5.4): generation 65535, next free 0.
  let xref = 'xref\n';
  const runs = subsections([0, ...sorted.map((o) => o.number)]);
  for (const run of runs) {
    xref += `${run.start} ${run.count}\n`;
    for (let n = run.start; n < run.start + run.count; n += 1) {
      if (n === 0) {
        xref += `0000000000 65535 f${eol}`;
        continue;
      }
      const o = sorted.find((c) => c.number === n) as Required<ObjectEntry>;
      xref += `${pad(offsetByNumber.get(n) as number, 10)} ${pad(o.generation, 5)} n${eol}`;
    }
  }

  const trailer = opts.trailerSource?.(size) ?? `trailer\n<< /Size ${size} /Root 1 0 R >>\n`;
  const startxref = opts.startxrefOverride ?? xrefOffset;
  const tail = opts.tailSource?.(startxref) ?? `startxref\n${startxref}\n%%EOF\n`;

  const text = junk + header + body + xref + trailer + tail;
  return {
    bytes: enc(text),
    text,
    xrefOffset,
    objectOffsets,
    size,
    offsetOf(objectNumber: number): number {
      const offset = offsetByNumber.get(objectNumber);
      if (offset === undefined) {
        throw new RangeError(`object ${objectNumber} is not in this fixture`);
      }
      return offset;
    },
  };
}

/** `n g obj … endobj` with its trailing EOL, for fixtures that number explicitly. */
export const obj = (number: number, source: string, generation = 0): ObjectEntry => ({
  number,
  generation,
  source: `${number} ${generation} obj ${source} endobj\n`,
});
