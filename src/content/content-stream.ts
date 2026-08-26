/**
 * Content stream builder — ISO 32000-2 §7.8.2 (content streams) and §8.2
 * (graphics objects).
 *
 * A content stream is not a byte soup: the specification constrains *where*
 * each operator may appear. R-8.2-10: "Only those operators that are listed in
 * Figure 9 — Graphics objects for each type of graphics object or in the
 * intervals between graphics objects (called the content stream level in the
 * figure) shall be used in that context." A builder that accepts any operator
 * anywhere pushes that rule onto every caller, and callers forget.
 *
 * So this builder tracks the context and refuses out-of-context operators. The
 * refusals are clauses, not taste:
 *
 * - R-7.8.2-8  Indirect objects and object references shall not be permitted
 *              at all → a `ref` operand throws.
 * - R-7.8.2-6  The operands needed by an operator shall precede it (and
 *   R-7.8.2-12 immediately precede it) → operands and operator are written in
 *              one call, so no other order is expressible.
 * - R-7.8.2-13 Operands shall not be left over when an operator finishes →
 *              same reason; there is no way to push a stray operand.
 * - R-9.4.1-7  Text objects shall not be nested; a second BT shall not appear
 *              before an ET.
 * - R-9.4.2-4  The text-positioning operators shall only appear within text
 *   R-9.4.3-3   objects; likewise the text-showing operators.
 * - R-9.4.1-6  q…Q combined with BT…ET shall be properly (separately) nested.
 * - R-14.6.1-12 BMC…EMC / BDC…EMC / BT…ET shall each be properly (separately)
 *              nested.
 *
 * What this file does NOT do: it does not validate that the resources named by
 * `/Font` or `/XObject` operands exist, and it does not know what the operators
 * mean. Whether the resulting document conforms is pdf-verify-mcp's answer
 * (DESIGN §4.2). It only refuses sequences the specification says shall not be
 * written.
 *
 * Output is uncompressed and deterministic (DESIGN §4.1). Compression is a
 * separate decision — see ADR-0003 §4 and `filter/encode.ts`.
 */

import type { CosObject } from '../cos/types.js';
import { ByteWriter, writeObject } from '../serialize/object-writer.js';

/**
 * Where in Figure 9 we are.
 *
 * `page` is what the figure calls the content stream level. `path` is a path
 * object under construction. `clip` is a path object that has had W or W*
 * applied and is waiting for its painting operator (§8.5.4).
 */
export type ContentContext = 'page' | 'path' | 'clip' | 'text';

/** What a bracket opened, so that the closer can be checked against it. */
type Bracket = 'q' | 'text' | 'mc';

interface OperatorSpec {
  /** Contexts in which the operator may be written (R-8.2-10). */
  readonly where: readonly ContentContext[];
  /** Context to switch to after writing it. Absent = unchanged. */
  readonly enter?: ContentContext;
  readonly opens?: Bracket;
  readonly closes?: Bracket;
}

const PAGE_AND_TEXT: readonly ContentContext[] = ['page', 'text'];

/**
 * Annex A — Operator Summary, restricted to the operators this builder writes.
 *
 * Deliberately absent, each for a stated reason:
 * - `d0` / `d1` (Table 111) are Type 3 glyph descriptions, a different kind of
 *   content stream; writing them here would be out of context by definition.
 * - `BI` / `ID` / `EI` (Table 90) carry an inline image whose data is not COS
 *   syntax (§8.9.7). Accepting them through the operand path would produce
 *   silently wrong bytes, so they are refused by name rather than mis-served.
 */
const OPERATORS: Readonly<Record<string, OperatorSpec>> = {
  // Table 56 — Graphics state operators (§8.4.4)
  q: { where: PAGE_AND_TEXT, opens: 'q' },
  Q: { where: PAGE_AND_TEXT, closes: 'q' },
  cm: { where: PAGE_AND_TEXT },
  w: { where: PAGE_AND_TEXT },
  J: { where: PAGE_AND_TEXT },
  j: { where: PAGE_AND_TEXT },
  M: { where: PAGE_AND_TEXT },
  d: { where: PAGE_AND_TEXT },
  ri: { where: PAGE_AND_TEXT },
  i: { where: PAGE_AND_TEXT },
  gs: { where: PAGE_AND_TEXT },

  // Table 58 — Path construction operators (§8.5.2)
  m: { where: ['page', 'path'], enter: 'path' },
  l: { where: ['path'] },
  c: { where: ['path'] },
  v: { where: ['path'] },
  y: { where: ['path'] },
  h: { where: ['path'] },
  re: { where: ['page', 'path'], enter: 'path' },

  // Table 59 — Path-painting operators (§8.5.3). They end the path object.
  S: { where: ['path', 'clip'], enter: 'page' },
  s: { where: ['path', 'clip'], enter: 'page' },
  f: { where: ['path', 'clip'], enter: 'page' },
  F: { where: ['path', 'clip'], enter: 'page' },
  'f*': { where: ['path', 'clip'], enter: 'page' },
  B: { where: ['path', 'clip'], enter: 'page' },
  'B*': { where: ['path', 'clip'], enter: 'page' },
  b: { where: ['path', 'clip'], enter: 'page' },
  'b*': { where: ['path', 'clip'], enter: 'page' },
  n: { where: ['path', 'clip'], enter: 'page' },

  // Table 60 — Clipping path operators (§8.5.4)
  W: { where: ['path'], enter: 'clip' },
  'W*': { where: ['path'], enter: 'clip' },

  // Table 73 — Colour operators (§8.6.8)
  CS: { where: PAGE_AND_TEXT },
  cs: { where: PAGE_AND_TEXT },
  SC: { where: PAGE_AND_TEXT },
  sc: { where: PAGE_AND_TEXT },
  SCN: { where: PAGE_AND_TEXT },
  scn: { where: PAGE_AND_TEXT },
  G: { where: PAGE_AND_TEXT },
  g: { where: PAGE_AND_TEXT },
  RG: { where: PAGE_AND_TEXT },
  rg: { where: PAGE_AND_TEXT },
  K: { where: PAGE_AND_TEXT },
  k: { where: PAGE_AND_TEXT },

  // Table 76 — Shading operator (§8.7.4.2) / Table 86 — XObject operator (§8.8)
  sh: { where: ['page'] },
  Do: { where: ['page'] },

  // Table 105 — Text object operators (§9.4)
  BT: { where: ['page'], enter: 'text', opens: 'text' },
  ET: { where: ['text'], enter: 'page', closes: 'text' },

  // Table 103 — Text state operators (§9.3). Permitted inside or outside a
  // text object (R-8.2-15).
  Tc: { where: PAGE_AND_TEXT },
  Tw: { where: PAGE_AND_TEXT },
  Tz: { where: PAGE_AND_TEXT },
  TL: { where: PAGE_AND_TEXT },
  Tf: { where: PAGE_AND_TEXT },
  Tr: { where: PAGE_AND_TEXT },
  Ts: { where: PAGE_AND_TEXT },

  // Table 106 — Text-positioning operators (§9.4.2). R-9.4.2-4: text objects only.
  Td: { where: ['text'] },
  TD: { where: ['text'] },
  Tm: { where: ['text'] },
  'T*': { where: ['text'] },

  // Table 107 — Text-showing operators (§9.4.3). R-9.4.3-3: text objects only.
  Tj: { where: ['text'] },
  TJ: { where: ['text'] },
  "'": { where: ['text'] },
  '"': { where: ['text'] },

  // Table 352 — Marked-content operators (§14.6.1).
  // R-14.6.1-8/-9: only between graphics objects, never inside one — hence
  // `page` and `text`, but not `path` or `clip`.
  MP: { where: PAGE_AND_TEXT },
  DP: { where: PAGE_AND_TEXT },
  BMC: { where: PAGE_AND_TEXT, opens: 'mc' },
  BDC: { where: PAGE_AND_TEXT, opens: 'mc' },
  EMC: { where: PAGE_AND_TEXT, closes: 'mc' },

  // Table 33 — Compatibility operators (§7.8.2)
  BX: { where: PAGE_AND_TEXT },
  EX: { where: PAGE_AND_TEXT },
};

/** Operators the specification defines but this builder refuses, with why. */
const REFUSED: Readonly<Record<string, string>> = {
  BI: 'inline image data is not COS syntax (§8.9.7); write an image XObject and Do it',
  ID: 'inline image data is not COS syntax (§8.9.7); write an image XObject and Do it',
  EI: 'inline image data is not COS syntax (§8.9.7); write an image XObject and Do it',
  d0: 'Type 3 glyph operator (Table 111); it belongs in a glyph description, not here',
  d1: 'Type 3 glyph operator (Table 111); it belongs in a glyph description, not here',
};

/** Raised when an operator sequence is one the clauses do not admit (§8.2, Annex A). */
export class ContentStreamError extends Error {
  override readonly name = 'ContentStreamError';
}

/**
 * Writes a content stream operator by operator, refusing what the clauses
 * refuse: operators Annex A does not define, operators outside their
 * allowed context (Figure 9), unbalanced BT/ET, q/Q and marked-content
 * pairs. Operand *values* are the caller's responsibility; the sequence
 * is this builder's.
 */
export class ContentStreamBuilder {
  readonly #out = new ByteWriter();
  #context: ContentContext = 'page';
  #brackets: Bracket[] = [];

  /** Where the next operator would be written (Figure 9). */
  get context(): ContentContext {
    return this.#context;
  }

  /** Open brackets, outermost first: q / BT / BMC or BDC. */
  get openBrackets(): readonly ('q' | 'text' | 'mc')[] {
    return [...this.#brackets];
  }

  /**
   * Write one operator with its operands, in that order (R-8.2-2 postfix,
   * R-7.8.2-12 operands immediately precede).
   */
  op(operator: string, ...operands: readonly CosObject[]): this {
    const refusal = REFUSED[operator];
    if (refusal !== undefined) {
      throw new ContentStreamError(`${operator} is not written by this builder: ${refusal}`);
    }
    const spec = OPERATORS[operator];
    if (spec === undefined) {
      // R-7.8.2-14: an unrecognised operator is an error for the reader. We do
      // not invent one for the writer either — BX/EX exist for that (R-7.8.2-15)
      // and the caller has to ask for them explicitly.
      throw new ContentStreamError(
        `${operator} is not an operator in Annex A; a keyword written by mistake would be an error for every reader (R-7.8.2-14)`,
      );
    }
    if (!spec.where.includes(this.#context)) {
      // The generic rule is R-8.2-10, but where the specification states the
      // case outright, say that instead — an error that names the nearest
      // clause is the difference between "fix this" and "look it up".
      if (operator === 'BT' && this.#context === 'text') {
        throw new ContentStreamError(
          'text objects shall not be nested; a second BT shall not appear before an ET (R-9.4.1-7)',
        );
      }
      throw new ContentStreamError(
        `${operator} shall not appear at the ${this.#context} level (R-8.2-10; Annex A places it in ${spec.where.join(' / ')})`,
      );
    }
    if (spec.closes !== undefined) {
      const top = this.#brackets[this.#brackets.length - 1];
      if (top !== spec.closes) {
        // R-9.4.1-6 / R-14.6.1-12: "properly (separately) nested" — the closer
        // has to match the innermost opener, not merely exist somewhere below.
        throw new ContentStreamError(
          `${operator} closes ${spec.closes}, but the innermost open bracket is ${top ?? 'none'} (R-9.4.1-6 / R-14.6.1-12: each pair shall be properly nested)`,
        );
      }
      this.#brackets.pop();
    }

    for (const operand of operands) {
      if (operand.kind === 'ref') {
        throw new ContentStreamError(
          `${operator}: indirect object references shall not be permitted in a content stream at all (R-7.8.2-8)`,
        );
      }
      if (operand.kind === 'stream') {
        throw new ContentStreamError(
          `${operator}: a stream is an indirect object and cannot be an operand (R-7.8.2-8)`,
        );
      }
      assertDirect(operand, operator);
      writeObject(this.#out, operand);
      this.#out.ascii(' ');
    }
    this.#out.ascii(operator);
    // LINE FEED after every operator: legal white space (§7.2.3) and fixed, so
    // the same input yields the same bytes (DESIGN §4.1).
    this.#out.ascii('\n');

    if (spec.opens !== undefined) this.#brackets.push(spec.opens);
    if (spec.enter !== undefined) this.#context = spec.enter;
    return this;
  }

  /**
   * The bytes, once everything that was opened has been closed.
   *
   * An unbalanced stream is not a lesser evil to be fixed by the reader:
   * R-9.4.1-6 and R-14.6.1-12 require proper nesting, and a path object with no
   * painting operator leaves the reader mid-graphics-object (§8.5.3). Both are
   * refused here rather than shipped.
   */
  finish(): Uint8Array {
    if (this.#brackets.length > 0) {
      throw new ContentStreamError(
        `content stream ends with ${this.#brackets.length} unclosed bracket(s): ${this.#brackets.join(', ')} (R-9.4.1-6 / R-14.6.1-12)`,
      );
    }
    if (this.#context !== 'page') {
      throw new ContentStreamError(
        `content stream ends inside a ${this.#context} object; a path object shall end with a painting operator (§8.5.3, Table 59)`,
      );
    }
    return this.#out.toUint8Array();
  }
}

/**
 * Operands are direct objects all the way down (R-7.8.2-8). An array or a
 * dictionary operand — `TJ`'s array, `BDC`'s inline property list (R-14.6.2-2)
 * — may not smuggle a reference inside it.
 */
function assertDirect(operand: CosObject, operator: string): void {
  if (operand.kind === 'array') {
    for (const item of operand.items) {
      if (item.kind === 'ref' || item.kind === 'stream') {
        throw new ContentStreamError(
          `${operator}: an array operand shall not contain an indirect reference (R-7.8.2-8)`,
        );
      }
      assertDirect(item, operator);
    }
    return;
  }
  if (operand.kind === 'dict') {
    for (const [key, value] of operand.entries) {
      if (value.kind === 'ref' || value.kind === 'stream') {
        // R-14.6.2-3 says exactly what to do instead: name it in the
        // /Properties subdictionary of the resource dictionary.
        throw new ContentStreamError(
          `${operator}: /${key} is an indirect reference; a property list with indirect values shall be a named resource in /Properties instead (R-14.6.2-3)`,
        );
      }
      assertDirect(value, operator);
    }
  }
}
