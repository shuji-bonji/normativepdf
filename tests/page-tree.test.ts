/**
 * Page-tree semantics (§7.7.3): walking, inheritance, and the `/Count` the
 * writer owes.
 *
 * Each fixture used here carries a difference — a plausible wrong
 * implementation answers differently from the specification — and
 * `page-tree-fixtures.test.ts` proves separately that the difference is really
 * in the bytes. Without that, a test like "the nearest ancestor wins" agrees
 * with an implementation that always takes the root.
 */

import { describe, expect, it } from 'vitest';
import type { CosObject } from '../src/cos/types.js';
import { dictGet, INHERITABLE, PdfDocumentEditor, parsePdf, rewrite } from '../src/index.js';
import { PAGE_TREES } from './helpers/page-trees.js';

const fixture = (id: string): Uint8Array => {
  const found = PAGE_TREES.find((f) => f.id === id);
  if (found === undefined) throw new Error(`fixture ${id} is missing`);
  return found.bytes;
};

const open = (id: string) => PdfDocumentEditor.open(fixture(id));
const numbers = (value: CosObject | undefined): number[] =>
  value?.kind === 'array'
    ? value.items.map((i) => (i.kind === 'integer' || i.kind === 'real' ? i.value : Number.NaN))
    : [];
const keys = (value: CosObject | undefined): string[] =>
  value?.kind === 'dict' ? [...value.entries.keys()].sort() : [];

describe('walking the tree (§7.7.3.2)', () => {
  for (const f of PAGE_TREES) {
    it(`${f.id} yields ${f.axes.pages} page(s)`, async () => {
      const tree = await (await PdfDocumentEditor.open(f.bytes)).pageTree();
      expect(tree.reached).toBe(true);
      expect(tree.pages.length).toBe(f.axes.pages);
    });
  }

  it('reaches deeper than the corpus does and records every ancestor', async () => {
    // The corpus tops out at depth 3 with eleven intermediate nodes in total,
    // so nothing in it would notice a walk that stopped early.
    const tree = await (await open('nested-deep')).pageTree();
    expect(tree.nodes.length).toBe(4);
    expect(tree.pages[0]?.ancestors.length).toBe(4);
  });

  it('gives pages in tree order across a mixed Kids array (R-7.7.3.2-7)', async () => {
    const tree = await (await open('nested-unbalanced')).pageTree();
    expect(tree.pages.map((p) => p.ref?.objectNumber)).toEqual([3, 4, 5]);
  });
});

describe('inheritance (§7.7.3.4)', () => {
  it('takes the nearest ancestor and stops there (R-7.7.3.4-5/-6)', async () => {
    const editor = await open('inherit-shadowed');
    expect(numbers(await editor.pageAttribute(0, 'MediaBox'))).toEqual([0, 0, 595, 842]);
  });

  it('takes the value whole, never a merge of two ancestors (R-7.7.3.4-4)', async () => {
    const editor = await open('inherit-not-merged');
    expect(keys(await editor.pageAttribute(0, 'Resources'))).toEqual(['Font']);
  });

  it('an empty dictionary on the page is an answer, not a gap (R-7.7.3.3-8)', async () => {
    const editor = await open('resources-empty-dict');
    expect(keys(await editor.pageAttribute(0, 'Resources'))).toEqual([]);
  });

  it('carries all four inheritable attributes down', async () => {
    const editor = await open('inherit-all-four');
    for (const key of INHERITABLE) {
      expect(await editor.pageAttribute(0, key)).toBeDefined();
    }
  });

  it('does not carry an attribute the table does not mark inheritable (R-7.7.3.3-2)', async () => {
    // Written first as "walk the ancestors for whatever key you are given",
    // which is the obvious implementation and hands the page a /Tabs that
    // belongs to the node above it. This fixture is why that did not ship.
    const editor = await open('inherit-all-four');
    expect(await editor.pageAttribute(0, 'Tabs')).toBeUndefined();
  });

  it('refuses a page index the document does not have', async () => {
    const editor = await open('flat-3pages');
    await expect(editor.pageAttribute(9, 'MediaBox')).rejects.toThrow(/3 page/);
  });
});

describe('/Count is derived, not trusted (R-7.7.3.2-8)', () => {
  it('counts descendants rather than the length of Kids', async () => {
    const tree = await (await open('nested-unbalanced')).pageTree();
    const root = tree.nodes.find((n) => n.ref?.objectNumber === 2);
    expect(root?.count).toBe(3); // Kids.length is 2
  });

  it('counts through a balanced tree as well', async () => {
    const tree = await (await open('nested-balanced')).pageTree();
    expect(tree.nodes.find((n) => n.ref?.objectNumber === 2)?.count).toBe(4);
  });
});

describe('settling the tree does not disturb a file that was already right', () => {
  // Measured over veraPDF-corpus plus pdf20examples as well: `open → save` is
  // byte-identical to `rewrite` for all 2,890 readable files, with the checks
  // and the recomputation in place (2026-08-14).
  for (const f of PAGE_TREES) {
    it(f.id, async () => {
      const viaGate = await rewrite(await parsePdf(f.bytes));
      const viaEditor = await (await PdfDocumentEditor.open(f.bytes)).save();
      expect(viaEditor).toEqual(viaGate);
    });
  }

  it('a tree with no reachable /Pages is neither corrected nor blamed', async () => {
    // ADR-0007 §6: nothing can be said about a tree that was never seen.
    const bytes = new TextEncoder().encode(
      '%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n' +
        'xref\n0 2\n0000000000 65535 f \n0000000009 00000 n \n' +
        'trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n44\n%%EOF\n',
    );
    const editor = await PdfDocumentEditor.open(bytes);
    expect((await editor.pageTree()).reached).toBe(false);
    await expect(editor.save()).resolves.toBeInstanceOf(Uint8Array);
  });
});

describe('the catalog is reached the way Table 15 says', () => {
  it('resolves /Root through the overlay', async () => {
    const editor = await open('flat-1page');
    const catalog = await editor.getCatalog();
    expect(catalog.kind).toBe('dict');
    if (catalog.kind !== 'dict') return;
    expect(dictGet(catalog, 'Pages')).toBeDefined();
  });
});
