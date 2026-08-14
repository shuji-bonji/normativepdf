/**
 * The fixtures for the document model, measured before the model exists.
 *
 * A fixture is an instrument, and an instrument is not trusted until it has
 * been shown to move. Two things are checked here, neither of which needs the
 * model:
 *
 *   1. **The invalid fixtures parse.** A counter-example that an earlier layer
 *      rejects never reaches the rule it was built for. It would sit in the
 *      suite looking green while measuring nothing.
 *   2. **The difference-carrying fixtures actually carry it.** Each one names
 *      what a plausible wrong implementation answers; that answer is computed
 *      here from the fixture's own bytes and asserted to differ from the one
 *      §7.7.3 requires. If a fixture is ever flattened, this fails rather than
 *      quietly agreeing with both implementations.
 */

import { describe, expect, it } from 'vitest';
import { type CosObject, dictGet } from '../src/cos/types.js';
import { type PdfDocument, parsePdf } from '../src/index.js';
import { axisCoverage, INVALID_PAGE_TREES, PAGE_TREES } from './helpers/page-trees.js';

const byId = <T extends { id: string }>(list: readonly T[], id: string): T => {
  const found = list.find((f) => f.id === id);
  if (found === undefined) throw new Error(`fixture ${id} is missing`);
  return found;
};

/** The root page tree node, reached the way §7.7.2 Table 29 says to. */
async function root(doc: PdfDocument): Promise<CosObject> {
  const catalog = await doc.getCatalog();
  const pages = dictGet(catalog, 'Pages');
  if (pages === undefined) throw new Error('catalog has no /Pages');
  return doc.resolve(pages);
}

const kidsOf = async (doc: PdfDocument, node: CosObject): Promise<readonly CosObject[]> => {
  const kids = await doc.resolve(dictGet(node, 'Kids') ?? { kind: 'null' });
  return kids.kind === 'array' ? kids.items : [];
};

/** Descendant pages, counted by walking — what R-7.7.3.2-8 calls consistent. */
async function descendantPages(doc: PdfDocument, ref: CosObject, depth = 0): Promise<number> {
  if (depth > 32) throw new Error('page tree too deep — fixture loops?');
  const nodeObj = await doc.resolve(ref);
  if (nodeObj.kind !== 'dict') return 0;
  const kids = await kidsOf(doc, nodeObj);
  if (kids.length === 0) return 1;
  let total = 0;
  for (const kid of kids) total += await descendantPages(doc, kid, depth + 1);
  return total;
}

/** The first page in the tree, with the ancestors above it, nearest first. */
async function firstPageWithAncestors(
  doc: PdfDocument,
): Promise<{ page: CosObject; ancestors: readonly CosObject[] }> {
  const ancestors: CosObject[] = [];
  let current = await root(doc);
  for (let depth = 0; depth < 32; depth += 1) {
    const kids = await kidsOf(doc, current);
    if (kids.length === 0) return { page: current, ancestors: [...ancestors].reverse() };
    ancestors.push(current);
    const next = await doc.resolve(kids[0] as CosObject);
    if (next.kind !== 'dict') break;
    current = next;
  }
  throw new Error('no page found');
}

/** §7.7.3.4: walk up from the page and stop at the first node that has the key. */
const inherited = (
  page: CosObject,
  ancestors: readonly CosObject[],
  key: string,
): CosObject | undefined => {
  const own = dictGet(page, key);
  if (own !== undefined) return own;
  for (const ancestor of ancestors) {
    const value = dictGet(ancestor, key);
    if (value !== undefined) return value;
  }
  return undefined;
};

const numbers = (value: CosObject | undefined): number[] =>
  value?.kind === 'array'
    ? value.items.map((i) => (i.kind === 'integer' || i.kind === 'real' ? i.value : Number.NaN))
    : [];

const dictKeys = (value: CosObject | undefined): string[] =>
  value?.kind === 'dict' ? [...value.entries.keys()].sort() : [];

describe('page-tree fixtures parse and hold the shape they claim (§7.7.3)', () => {
  for (const fixture of PAGE_TREES) {
    it(`${fixture.id} — ${fixture.why}`, async () => {
      const doc = await parsePdf(fixture.bytes);
      const node = await root(doc);
      expect(node.kind).toBe('dict');
      // `pages` is declared on every fixture on purpose. Falling back to the
      // measured value would make this assertion agree with whatever it found.
      expect(fixture.axes.pages).toBeTypeOf('number');
      expect(await descendantPages(doc, node)).toBe(fixture.axes.pages);
    });
  }
});

describe('invalid fixtures reach the writing rule they were built for', () => {
  // A fixture the parser rejects measures nothing. Corpus-wide these defects
  // occur zero times, so these twelve are the only ones that will ever run.
  for (const fixture of INVALID_PAGE_TREES) {
    it(`${fixture.id} parses, so ${fixture.violates} can be measured on save`, async () => {
      const doc = await parsePdf(fixture.bytes);
      const node = await root(doc);
      expect(node.kind).toBe('dict');
      const kids = await kidsOf(doc, node);
      expect(kids.length).toBeGreaterThan(0);
    });
  }
});

describe('the fixtures carry a difference (a right and a wrong answer differ)', () => {
  it('nested-unbalanced: Kids.length is 2 where the descendant count is 3 (R-7.7.3.2-8)', async () => {
    const doc = await parsePdf(byId(PAGE_TREES, 'nested-unbalanced').bytes);
    const node = await root(doc);
    const kids = await kidsOf(doc, node);
    const walked = await descendantPages(doc, node);
    expect(kids.length).toBe(2); // what returning Kids.length would answer
    expect(walked).toBe(3); // what the clause requires
    expect(kids.length).not.toBe(walked); // the fixture is not flat
  });

  it('nested-balanced: Kids.length is 2 where the descendant count is 4', async () => {
    const doc = await parsePdf(byId(PAGE_TREES, 'nested-balanced').bytes);
    const node = await root(doc);
    expect((await kidsOf(doc, node)).length).toBe(2);
    expect(await descendantPages(doc, node)).toBe(4);
  });

  it('inherit-shadowed: the nearer ancestor wins, and the root holds a different value (R-7.7.3.4-6)', async () => {
    const doc = await parsePdf(byId(PAGE_TREES, 'inherit-shadowed').bytes);
    const { page, ancestors } = await firstPageWithAncestors(doc);
    expect(ancestors.length).toBe(2);
    expect(numbers(inherited(page, ancestors, 'MediaBox'))).toEqual([0, 0, 595, 842]);
    // Searching from the root instead would answer this — a different value,
    // which is the only reason this fixture can tell the two apart.
    expect(numbers(dictGet(ancestors[ancestors.length - 1] as CosObject, 'MediaBox'))).toEqual([
      0, 0, 612, 792,
    ]);
  });

  it('inherit-not-merged: the ancestors hold disjoint keys, so merging is visible (R-7.7.3.4-4)', async () => {
    const doc = await parsePdf(byId(PAGE_TREES, 'inherit-not-merged').bytes);
    const { page, ancestors } = await firstPageWithAncestors(doc);
    expect(dictKeys(inherited(page, ancestors, 'Resources'))).toEqual(['Font']);
    const merged = ancestors.flatMap((a) => dictKeys(dictGet(a, 'Resources'))).sort();
    expect(merged).toEqual(['Font', 'ProcSet']); // what merging would answer
  });

  it('resources-empty-dict: an empty dictionary is not an absent entry (R-7.7.3.3-8)', async () => {
    const doc = await parsePdf(byId(PAGE_TREES, 'resources-empty-dict').bytes);
    const { page, ancestors } = await firstPageWithAncestors(doc);
    expect(dictKeys(inherited(page, ancestors, 'Resources'))).toEqual([]);
    // Treating empty as absent would reach the ancestor's dictionary instead.
    expect(dictKeys(dictGet(ancestors[0] as CosObject, 'Resources'))).toEqual(['ProcSet']);
  });

  it('inherit-all-four: the four inheritable attributes descend and /Tabs does not (R-7.7.3.3-2)', async () => {
    const doc = await parsePdf(byId(PAGE_TREES, 'inherit-all-four').bytes);
    const { page, ancestors } = await firstPageWithAncestors(doc);
    for (const key of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) {
      expect(inherited(page, ancestors, key)).toBeDefined();
    }
    expect(dictGet(page, 'Tabs')).toBeUndefined();
    expect(dictGet(ancestors[0] as CosObject, 'Tabs')).toBeDefined(); // it is there to be wrongly taken
  });

  it('gen-nonzero: the page answers at generation 4 and is absent at generation 0 (§7.3.10)', async () => {
    const doc = await parsePdf(byId(PAGE_TREES, 'gen-nonzero').bytes);
    expect((await doc.getObject(3, 4)).kind).toBe('dict');
    expect((await doc.getObject(3, 0)).kind).toBe('null'); // an overlay keyed by number alone
  });
});

describe('coverage of the fixture set', () => {
  it('every axis has more than one shape, or it is not being measured', () => {
    const coverage = axisCoverage([...PAGE_TREES, ...INVALID_PAGE_TREES]);
    const single = Object.entries(coverage)
      .filter(([, v]) => v.distinct < 2)
      .map(([k]) => k);
    // `mixedKids` is the one boolean here: its absence is the other shape.
    // Everything else is labelled on both sides — an axis whose second shape
    // exists but was never written down looks measured and is not
    // (uc-oracle's `revisions` axis spent a day in exactly that state).
    expect(single).toEqual(['mixedKids']);
  });

  it('every fixture that claims to carry a difference has a test above', () => {
    const claiming = PAGE_TREES.filter((f) => f.carries !== undefined).map((f) => f.id);
    expect(claiming).toEqual([
      'nested-balanced',
      'nested-unbalanced',
      'gen-nonzero',
      'inherit-shadowed',
      'inherit-not-merged',
      'inherit-all-four',
      'resources-empty-dict',
    ]);
  });
});
