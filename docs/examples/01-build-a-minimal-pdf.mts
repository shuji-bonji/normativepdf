/**
 * Build the smallest one-page PDF the clauses admit — by hand, at the COS
 * level. This is deliberately verbose: normativepdf's core is the object
 * model (§7.3), the file structure (§7.5), and nothing above them. The
 * ten-line version of this example is what `@normativepdf/document` exists
 * to provide.
 *
 * Every example in this directory is executed by the test suite
 * (tests/examples.test.ts). If the code below stops working, CI fails —
 * the documentation cannot drift from the implementation.
 */

import {
  ContentStreamBuilder,
  type CosDict,
  type CosObject,
  type WritableObject,
  writeFile,
} from 'normativepdf';

// -- Small constructors, so the object graph below stays readable. --------

const name = (value: string): CosObject => ({ kind: 'name', value });
const int = (value: number): CosObject => ({ kind: 'integer', value });
const ref = (objectNumber: number): CosObject => ({ kind: 'ref', objectNumber, generationNumber: 0 });
const array = (...items: CosObject[]): CosObject => ({ kind: 'array', items });
const dict = (entries: Record<string, CosObject>): CosDict => ({
  kind: 'dict',
  entries: new Map(Object.entries(entries)),
});
const literal = (text: string): CosObject => ({
  kind: 'string',
  bytes: new TextEncoder().encode(text),
  form: 'literal',
});

// -- The page's content stream (§8.2), via the operator-checked builder. --
// The builder refuses operators that Annex A does not define, operators
// outside their allowed context, and unbalanced BT/ET or q/Q pairs.

const content = new ContentStreamBuilder()
  .op('BT')
  .op('Tf', name('F0'), int(24))
  .op('Td', int(72), int(720))
  .op('Tj', literal('Hello from normativepdf'))
  .op('ET')
  .finish();

// -- The document's object graph: catalog → page tree → one page. ---------

const objects: WritableObject[] = [
  {
    objectNumber: 1,
    generationNumber: 0,
    object: dict({ Type: name('Catalog'), Pages: ref(2) }),
  },
  {
    objectNumber: 2,
    generationNumber: 0,
    object: dict({ Type: name('Pages'), Kids: array(ref(3)), Count: int(1) }),
  },
  {
    objectNumber: 3,
    generationNumber: 0,
    object: dict({
      Type: name('Page'),
      Parent: ref(2),
      MediaBox: array(int(0), int(0), int(612), int(792)),
      Contents: ref(4),
      Resources: dict({ Font: dict({ F0: ref(5) }) }),
    }),
  },
  {
    objectNumber: 4,
    generationNumber: 0,
    object: { kind: 'stream', dict: dict({ Length: int(content.length) }), raw: content },
  },
  {
    // A standard-14 font without an embedded program: admissible in 1.7,
    // which is why the header below says 1.7. Embedding (and PDF 2.0) is
    // the `buildType0Font` example's territory.
    objectNumber: 5,
    generationNumber: 0,
    object: dict({ Type: name('Font'), Subtype: name('Type1'), BaseFont: name('Helvetica') }),
  },
];

const trailer = dict({ Root: ref(1) });

// -- Serialize: header, bodies, cross-reference table, trailer (§7.5). ----

export const bytes: Uint8Array = writeFile(objects, trailer, { version: '1.7' });

// Re-exported so the later examples can build on this document.
export { objects, trailer };
