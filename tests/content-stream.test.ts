/**
 * Content stream builder tests (§7.8.2 / §8.2 / §9.4 / §14.6).
 *
 * ⚠️ Same self-reference caveat as `object-writer.test.ts` (GUARDS T-2): these
 * bytes are produced and checked by this repository. The outside opinions for
 * content streams are qpdf and veraPDF, reached through the UC differential
 * oracle in `pdf-writer-mcp/scripts/uc-oracle/` (ADR-0006) once the generation
 * path is rebuilt on this builder.
 *
 * The refusals matter more than the happy path here. Every `toThrow` below is a
 * sequence the specification says shall not be written; if one of them stops
 * throwing, the builder has silently become a byte sink.
 */

import { describe, expect, it } from 'vitest';
import type { CosObject } from '../src/cos/types.js';
import { ContentStreamBuilder, ContentStreamError } from '../src/index.js';

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');
const int = (value: number): CosObject => ({ kind: 'integer', value });
const real = (value: number): CosObject => ({ kind: 'real', value });
const name = (value: string): CosObject => ({ kind: 'name', value });
const str = (text: string): CosObject => ({
  kind: 'string',
  bytes: new Uint8Array(Array.from(text, (c) => c.charCodeAt(0))),
  form: 'literal',
});
const ref = (objectNumber: number): CosObject => ({
  kind: 'ref',
  objectNumber,
  generationNumber: 0,
});

describe('operand order and shape (§7.8.2)', () => {
  it('writes operands before the operator, postfix (R-7.8.2-6 / R-8.2-2)', () => {
    const cs = new ContentStreamBuilder();
    cs.op('BT')
      .op('Tf', name('F0'), int(12))
      .op('Td', int(72), int(700))
      .op('Tj', str('hi'))
      .op('ET');
    expect(latin1(cs.finish())).toBe('BT\n/F0 12 Tf\n72 700 Td\n(hi) Tj\nET\n');
  });

  it('refuses an indirect reference as an operand (R-7.8.2-8)', () => {
    const cs = new ContentStreamBuilder();
    expect(() => cs.op('Do', ref(7))).toThrow(ContentStreamError);
  });

  it('refuses a reference hidden inside an array operand (R-7.8.2-8)', () => {
    const cs = new ContentStreamBuilder();
    cs.op('BT');
    expect(() => cs.op('TJ', { kind: 'array', items: [str('a'), ref(9)] })).toThrow(/R-7\.8\.2-8/);
  });

  it('refuses a property list whose value is indirect, naming the way out (R-14.6.2-3)', () => {
    const cs = new ContentStreamBuilder();
    const properties: CosObject = { kind: 'dict', entries: new Map([['MCID', ref(3)]]) };
    expect(() => cs.op('BDC', name('P'), properties)).toThrow(/R-14\.6\.2-3/);
  });

  it('refuses a keyword that is not an operator in Annex A (R-7.8.2-14)', () => {
    const cs = new ContentStreamBuilder();
    expect(() => cs.op('Tx')).toThrow(/Annex A/);
  });

  it('writes reals without an exponent, as §7.3.3 requires of any PDF object', () => {
    const cs = new ContentStreamBuilder();
    cs.op('re', real(0.0000001), int(0), int(1), int(1)).op('f');
    expect(latin1(cs.finish())).not.toMatch(/e[+-]/);
  });
});

describe('graphics object contexts (Figure 9 / R-8.2-10)', () => {
  it('refuses a path construction operator that has no path object open', () => {
    const cs = new ContentStreamBuilder();
    expect(() => cs.op('l', int(1), int(1))).toThrow(/R-8\.2-10/);
  });

  it('refuses XObject invocation inside a path object', () => {
    const cs = new ContentStreamBuilder();
    cs.op('m', int(0), int(0));
    expect(() => cs.op('Do', name('X0'))).toThrow(/R-8\.2-10/);
  });

  it('refuses marked content inside a path object (R-14.6.1-8/-9)', () => {
    const cs = new ContentStreamBuilder();
    cs.op('re', int(0), int(0), int(10), int(10));
    expect(() => cs.op('BMC', name('Artifact'))).toThrow(/R-8\.2-10/);
  });

  it('returns to the page level after a painting operator (§8.5.3)', () => {
    const cs = new ContentStreamBuilder();
    cs.op('re', int(0), int(0), int(10), int(10));
    expect(cs.context).toBe('path');
    cs.op('f');
    expect(cs.context).toBe('page');
  });

  it('lets W be followed by a painting operator (§8.5.4)', () => {
    const cs = new ContentStreamBuilder();
    cs.op('re', int(0), int(0), int(10), int(10)).op('W').op('n');
    expect(latin1(cs.finish())).toBe('0 0 10 10 re\nW\nn\n');
  });

  it('refuses a stream that ends inside a path object (§8.5.3)', () => {
    const cs = new ContentStreamBuilder();
    cs.op('m', int(0), int(0));
    expect(() => cs.finish()).toThrow(/painting operator/);
  });
});

describe('text objects (§9.4)', () => {
  it('refuses nested text objects, citing the clause that says so (R-9.4.1-7)', () => {
    const cs = new ContentStreamBuilder();
    cs.op('BT');
    expect(() => cs.op('BT')).toThrow(/R-9\.4\.1-7/);
  });

  it('refuses text positioning outside a text object (R-9.4.2-4)', () => {
    const cs = new ContentStreamBuilder();
    expect(() => cs.op('Td', int(1), int(1))).toThrow(/R-8\.2-10/);
  });

  it('refuses text showing outside a text object (R-9.4.3-3)', () => {
    const cs = new ContentStreamBuilder();
    expect(() => cs.op('Tj', str('x'))).toThrow(/R-8\.2-10/);
  });

  it('allows the text state operators outside a text object (R-8.2-15)', () => {
    const cs = new ContentStreamBuilder();
    cs.op('Tf', name('F0'), int(12));
    expect(latin1(cs.finish())).toBe('/F0 12 Tf\n');
  });
});

describe('proper nesting (R-9.4.1-6 / R-14.6.1-12)', () => {
  it('accepts q and BT nested separately', () => {
    const cs = new ContentStreamBuilder();
    cs.op('q').op('BT').op('ET').op('Q');
    expect(cs.openBrackets).toEqual([]);
  });

  it('refuses Q that would close across a BT (each pair shall be separately nested)', () => {
    const cs = new ContentStreamBuilder();
    cs.op('q').op('BT');
    // Q is legal inside a text object (R-8.2-15 / Figure 9); what is wrong here
    // is the crossing, so the error is the nesting one, not the context one.
    expect(() => cs.op('Q')).toThrow(/properly nested/);
  });

  it('refuses EMC when the innermost bracket is a text object', () => {
    const cs = new ContentStreamBuilder();
    cs.op('BDC', name('P'), { kind: 'dict', entries: new Map([['MCID', int(0)]]) }).op('BT');
    expect(() => cs.op('EMC')).toThrow(/properly nested/);
  });

  it('refuses ET when the innermost bracket is a marked-content sequence', () => {
    const cs = new ContentStreamBuilder();
    cs.op('BT').op('BMC', name('Artifact'));
    expect(() => cs.op('ET')).toThrow(/properly nested/);
  });

  it('refuses a stream that ends with a bracket open', () => {
    const cs = new ContentStreamBuilder();
    cs.op('BMC', name('Artifact'));
    expect(() => cs.finish()).toThrow(/unclosed bracket/);
  });

  it('writes the tagged-text shape the PDF/UA path needs', () => {
    const cs = new ContentStreamBuilder();
    cs.op('BDC', name('P'), { kind: 'dict', entries: new Map([['MCID', int(0)]]) })
      .op('BT')
      .op('Tf', name('F0'), int(12))
      .op('Td', int(72), int(720))
      .op('Tj', str('Hello'))
      .op('ET')
      .op('EMC');
    expect(latin1(cs.finish())).toBe(
      '/P <</MCID 0>> BDC\nBT\n/F0 12 Tf\n72 720 Td\n(Hello) Tj\nET\nEMC\n',
    );
  });
});

describe('operators this builder refuses by name', () => {
  it('refuses inline images and says what to write instead (§8.9.7)', () => {
    const cs = new ContentStreamBuilder();
    expect(() => cs.op('BI')).toThrow(/image XObject/);
  });

  it('refuses Type 3 glyph operators (Table 111)', () => {
    const cs = new ContentStreamBuilder();
    expect(() => cs.op('d0', int(0), int(0))).toThrow(/glyph description/);
  });
});
