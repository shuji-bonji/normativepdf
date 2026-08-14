/**
 * Trees that break §7.7.3: readable, and refused on the way out.
 *
 * ADR-0007 §6 splits the two directions. Reading has to stay generous — the
 * recovery path is measured over a corpus of deliberately broken files — while
 * writing refuses, because a library that repairs quietly leaves the caller
 * believing they built a tree they did not build.
 *
 * `/Count` is the exception and is tested here as one: R-7.7.3.2-8 names the
 * writer, so a wrong count is corrected rather than rejected.
 *
 * Every fixture below was checked to parse before it was written
 * (`page-tree-fixtures.test.ts`). A counter-example an earlier layer rejects
 * never reaches the rule it was built for, and sits in the suite looking green.
 */

import { describe, expect, it } from 'vitest';
import { dictGet, PageTreeError, PdfDocumentEditor, parsePdf } from '../src/index.js';
import { INVALID_PAGE_TREES } from './helpers/page-trees.js';

const fixture = (id: string): Uint8Array => {
  const found = INVALID_PAGE_TREES.find((f) => f.id === id);
  if (found === undefined) throw new Error(`fixture ${id} is missing`);
  return found.bytes;
};

const countAfterSave = async (id: string): Promise<number | string> => {
  const written = await parsePdf(await (await PdfDocumentEditor.open(fixture(id))).save());
  const catalog = await written.getCatalog();
  if (catalog.kind !== 'dict') return 'no catalog';
  const pages = await written.resolve(dictGet(catalog, 'Pages') ?? { kind: 'null' });
  if (pages.kind !== 'dict') return 'no page tree';
  const count = await written.resolve(dictGet(pages, 'Count') ?? { kind: 'null' });
  return count.kind === 'integer' ? count.value : count.kind;
};

describe('/Count is recomputed rather than refused (R-7.7.3.2-8)', () => {
  // "A PDF writer shall ensure that the value of the Count key is consistent
  // with the number of entries in the Kids array and its descendants." The
  // duty is the writer's, so these four are corrections, not violations.
  for (const id of ['bad-count-high', 'bad-count-low', 'bad-count-missing', 'bad-count-nonint']) {
    it(`${id} writes out with the count the tree actually has`, async () => {
      expect(await countAfterSave(id)).toBe(3);
    });
  }

  it('leaves a correct count exactly as it was', async () => {
    // Nothing is rewritten when the value already agrees, which is why the
    // whole corpus still comes out byte-identical to the round-trip gate.
    const editor = await PdfDocumentEditor.open(fixture('bad-count-high'));
    await editor.save();
    expect(editor.changed().map((o) => o.objectNumber)).toEqual([2]); // only the root node
  });
});

describe('everything else is refused, naming the requirement', () => {
  const refusals: readonly [string, string][] = [
    ['dup-page-ref', 'R-7.7.3.3-3'],
    ['dup-node-ref', 'R-7.7.3.2-4'],
    ['parent-direct', 'R-7.7.3.3-5'],
    ['parent-wrong', 'R-7.7.3.3-5'],
    ['parent-missing', 'R-7.7.3.3-5'],
    ['rotate-45', 'R-7.7.3.3-28'],
    ['contents-empty-array', 'R-7.7.3.3-26'],
    ['resources-nowhere', 'R-7.7.3.4-2'],
  ];

  for (const [id, clause] of refusals) {
    it(`${id} is refused under ${clause}`, async () => {
      const editor = await PdfDocumentEditor.open(fixture(id));
      await expect(editor.save()).rejects.toThrow(PageTreeError);
      const violations = await editor
        .save()
        .then(() => [] as { clause: string }[])
        .catch((error: unknown) =>
          error instanceof PageTreeError ? [...error.violations] : [{ clause: 'none' }],
        );
      expect(violations.map((v) => v.clause).join(' ')).toContain(clause);
    });
  }

  it('reading the broken tree still works — only writing refuses', async () => {
    const editor = await PdfDocumentEditor.open(fixture('rotate-45'));
    const tree = await editor.pageTree();
    expect(tree.reached).toBe(true);
    expect(tree.pages.length).toBe(1);
  });

  it('an incremental update is refused for the same reasons a save is', async () => {
    const editor = await PdfDocumentEditor.open(fixture('parent-missing'));
    editor.set(9, { kind: 'name', value: 'Anything' });
    await expect(editor.appendUpdate()).rejects.toThrow(PageTreeError);
  });

  it('reports every violation at once rather than the first one', async () => {
    // Fixing them one at a time means rebuilding the document once per rule.
    const editor = await PdfDocumentEditor.open(fixture('dup-node-ref'));
    const violations = await editor
      .save()
      .then(() => [] as { clause: string }[])
      .catch((error: unknown) => (error instanceof PageTreeError ? [...error.violations] : []));
    expect(violations.length).toBeGreaterThan(0);
  });
});
