/**
 * Logical structure (§14.7) — the three places one number has to appear.
 *
 * The assertions that matter here are the cross-checks: the MCID written into
 * the content stream, the integer in the element's `/K`, and the index into the
 * parent-tree array all have to be the same number (R-14.7.5.2-4 /
 * R-14.7.2-24 / R-14.7.5.4-8). A test that only looked at one of the three
 * would pass on a file no reader could follow.
 *
 * ⚠️ GUARDS T-2 again: these objects are built and inspected by this
 * repository. The outside opinion for tagged output is veraPDF `pdfua-1`,
 * reached through the UC oracle (ADR-0006).
 */

import { describe, expect, it } from 'vitest';
import type { CosObject, CosRef } from '../src/cos/types.js';
import { StructTreeBuilder, StructTreeError } from '../src/index.js';

const latin1 = (bytes: Uint8Array) => Array.from(bytes, (b) => String.fromCharCode(b)).join('');
const int = (value: number): CosObject => ({ kind: 'integer', value });
const name = (value: string): CosObject => ({ kind: 'name', value });
const str = (text: string): CosObject => ({
  kind: 'string',
  bytes: new Uint8Array(Array.from(text, (c) => c.charCodeAt(0))),
  form: 'literal',
});
const page = (n: number): CosRef => ({ kind: 'ref', objectNumber: 900 + n, generationNumber: 0 });

function makeSink() {
  const objects = new Map<number, CosObject>();
  let next = 0;
  return {
    objects,
    reserve(): CosRef {
      next += 1;
      return { kind: 'ref', objectNumber: next, generationNumber: 0 };
    },
    write(ref: CosRef, object: CosObject): void {
      objects.set(ref.objectNumber, object);
    },
  };
}

const get = (object: CosObject | undefined, key: string): CosObject | undefined =>
  object?.kind === 'dict' ? object.entries.get(key) : undefined;
const items = (object: CosObject | undefined): readonly CosObject[] =>
  object?.kind === 'array' ? object.items : [];
const refOf = (object: CosObject | undefined): number =>
  object?.kind === 'ref' ? object.objectNumber : -1;

describe('one number, three places', () => {
  it('writes the same MCID into the stream, /K and the parent tree index', () => {
    const tree = new StructTreeBuilder();
    const doc = tree.element('Document');
    const h1 = tree.element('H1', { parent: doc });
    const p = tree.element('P', { parent: doc });

    const stream = tree.stream(page(1));
    stream.contentItem(h1, (c) => c.op('BT').op('Tj', str('Title')).op('ET'));
    stream.contentItem(p, (c) => c.op('BT').op('Tj', str('Body')).op('ET'));
    const bytes = latin1(stream.finish());

    expect(bytes).toContain('/H1 <</MCID 0>> BDC');
    expect(bytes).toContain('/P <</MCID 1>> BDC');

    const sink = makeSink();
    const built = tree.finish(sink);
    const root = sink.objects.get(built.structTreeRoot.objectNumber);
    const documentDict = sink.objects.get(refOf(get(root, 'K')));
    const kids = items(get(documentDict, 'K'));

    // /K holds the integers…
    const h1Dict = sink.objects.get(refOf(kids[0]));
    const pDict = sink.objects.get(refOf(kids[1]));
    expect(get(h1Dict, 'K')).toEqual(int(0));
    expect(get(pDict, 'K')).toEqual(int(1));

    // …and the parent tree array is indexed by the very same numbers.
    const parentTree = sink.objects.get(refOf(get(root, 'ParentTree')));
    const nums = items(get(parentTree, 'Nums'));
    expect(nums[0]).toEqual(int(0)); // the stream's StructParents key
    const parents = items(sink.objects.get(refOf(nums[1])));
    expect(refOf(parents[0])).toBe(refOf(kids[0]));
    expect(refOf(parents[1])).toBe(refOf(kids[1]));
  });

  it('gives the page the /StructParents key the tree was built with (R-14.7.5.4-17)', () => {
    const tree = new StructTreeBuilder();
    const p1 = tree.element('P');
    const p2 = tree.element('P');
    tree.stream(page(1)).contentItem(p1, () => {});
    tree.stream(page(2)).contentItem(p2, () => {});
    const built = tree.finish(makeSink());
    expect([...built.structParents.values()]).toEqual([0, 1]);
  });

  it('keeps /ParentTreeNextKey above every key in use (R-14.7.5.4-9)', () => {
    const tree = new StructTreeBuilder();
    tree.stream(page(1)).contentItem(tree.element('P'), () => {});
    tree.stream(page(2)).contentItem(tree.element('P'), () => {});
    const sink = makeSink();
    const built = tree.finish(sink);
    const root = sink.objects.get(built.structTreeRoot.objectNumber);
    expect(get(root, 'ParentTreeNextKey')).toEqual(int(2));
  });
});

describe('what the builder refuses', () => {
  it('refuses a structure content item nested in another (R-14.7.5.1.1-6)', () => {
    const tree = new StructTreeBuilder();
    const outer = tree.element('P');
    const inner = tree.element('Span', { parent: outer });
    const stream = tree.stream(page(1));
    expect(() =>
      stream.contentItem(outer, () => {
        stream.contentItem(inner, () => {});
      }),
    ).toThrow(/R-14\.7\.5\.1\.1-6/);
  });

  it('refuses an empty structure tree (R-14.7.2-3)', () => {
    expect(() => new StructTreeBuilder().finish(makeSink())).toThrow(StructTreeError);
  });

  it('refuses content items of one element on two pages (R-14.7.2-23)', () => {
    const tree = new StructTreeBuilder();
    const p = tree.element('P');
    tree.stream(page(1)).contentItem(p, () => {});
    tree.stream(page(2)).contentItem(p, () => {});
    expect(() => tree.finish(makeSink())).toThrow(/R-14\.7\.2-23/);
  });

  it('refuses an element that belongs to another builder', () => {
    const a = new StructTreeBuilder();
    const b = new StructTreeBuilder();
    expect(() => a.stream(page(1)).contentItem(b.element('P'), () => {})).toThrow(StructTreeError);
  });

  it('refuses an element with no structure type (R-14.7.2-20)', () => {
    expect(() => new StructTreeBuilder().element('')).toThrow(StructTreeError);
  });
});

describe('artifacts and other non-structural marks', () => {
  it('does not consume an MCID (R-14.7.5.1.1-6 permits them inside content)', () => {
    const tree = new StructTreeBuilder();
    const p = tree.element('P');
    const stream = tree.stream(page(1));
    stream.artifact((c) => c.op('re', int(0), int(0), int(10), int(10)).op('f'), 'Pagination');
    stream.contentItem(p, (c) => c.op('BT').op('Tj', str('Body')).op('ET'));
    const bytes = latin1(stream.finish());
    expect(bytes).toContain('/Artifact <</Subtype /Pagination>> BDC');
    expect(bytes).toContain('/P <</MCID 0>> BDC');
    expect(bytes.match(/MCID/g)?.length).toBe(1);
  });
});

describe('the dictionaries themselves', () => {
  it('wires /P upward and /Pg to the page the content is on', () => {
    const tree = new StructTreeBuilder();
    const doc = tree.element('Document');
    const p = tree.element('P', { parent: doc });
    tree.stream(page(3)).contentItem(p, () => {});
    const sink = makeSink();
    const built = tree.finish(sink);
    const root = sink.objects.get(built.structTreeRoot.objectNumber);
    const documentRef = refOf(get(root, 'K'));
    const pDict = sink.objects.get(refOf(get(sink.objects.get(documentRef), 'K')));
    expect(refOf(get(pDict, 'P'))).toBe(documentRef);
    expect(refOf(get(pDict, 'Pg'))).toBe(903);
    expect(get(pDict, 'Type')).toEqual(name('StructElem'));
    expect(get(pDict, 'S')).toEqual(name('P'));
  });

  it('carries the accessibility entries the caller supplies (§14.9)', () => {
    const tree = new StructTreeBuilder();
    const figure = tree.element('Figure', { alt: 'a cat', actualText: 'cat', lang: 'en' });
    tree.stream(page(1)).contentItem(figure, () => {});
    const sink = makeSink();
    const built = tree.finish(sink);
    const root = sink.objects.get(built.structTreeRoot.objectNumber);
    const figureDict = sink.objects.get(refOf(get(root, 'K')));
    expect(get(figureDict, 'Alt')).toEqual(str('a cat'));
    expect(get(figureDict, 'ActualText')).toEqual(str('cat'));
    expect(get(figureDict, 'Lang')).toEqual(str('en'));
  });

  it('claims /Marked true and nothing more (R-14.7.1-7)', () => {
    const tree = new StructTreeBuilder();
    tree.stream(page(1)).contentItem(tree.element('P'), () => {});
    const built = tree.finish(makeSink());
    expect([...built.markInfo.entries.keys()]).toEqual(['Marked']);
  });

  it('omits the parent tree when nothing was tagged', () => {
    // An element with no content items is legal — a Document wrapper, say.
    const tree = new StructTreeBuilder();
    tree.element('Document');
    const sink = makeSink();
    const built = tree.finish(sink);
    const root = sink.objects.get(built.structTreeRoot.objectNumber);
    expect(get(root, 'ParentTree')).toBeUndefined();
    expect(get(root, 'ParentTreeNextKey')).toBeUndefined();
  });
});
