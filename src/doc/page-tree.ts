/**
 * What §7.7.3 requires of a page tree, as something the library holds rather
 * than something every caller reimplements.
 *
 * The clauses here address the **writer**, not the reader: R-7.7.3.2-8 says
 * "a PDF writer shall ensure that the value of the Count key is consistent
 * with the number of entries in the Kids array and its descendants". Since the
 * writing moved into this library, so did the obligation.
 *
 * **Reading is generous, writing is strict** (ADR-0007 §6). A tree that breaks
 * these rules can be walked — refusing to read one would be a regression in
 * recovery — but writing it back is refused, because a library that silently
 * repairs leaves the caller believing they built something they did not.
 * `/Count` is the exception: it is derived, and R-7.7.3.2-8 names the writer,
 * so it is recomputed rather than checked.
 *
 * **The strictness costs nothing on real files.** Every check below was
 * counted over veraPDF-corpus plus pdf20examples first (2,896 readable files,
 * 12,940 pages, 2026-08-14) and every one of them fires **zero** times:
 * `/Count` mismatch 0, duplicate references 0, non-indirect `/Parent` 0,
 * `/Parent` pointing elsewhere 0, `/Rotate` not a multiple of 90 **0 of 598
 * pages that have one**, empty `/Contents` array **0 of 17 arrays**,
 * `/Resources` or `/MediaBox` supplied nowhere 0. Each detector was inverted
 * to confirm it fires at all.
 *
 * That last point is the reason this file exists rather than a `validate`
 * option: the corpus can show these checks do not break anything, and it can
 * never show they work. The fixtures in `tests/helpers/page-trees.ts` do that.
 */

import type { CosDict, CosObject, CosRef } from '../cos/types.js';
import { dictGet } from '../cos/types.js';

/**
 * The attributes Table 31 marks inheritable. R-7.7.3.3-2: attributes "not
 * explicitly identified in the table as inheritable shall not be inherited",
 * so this list is closed, not a starting point.
 */
export const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const;

/** Inheritable attributes Table 31 also marks Required. */
const REQUIRED_INHERITABLE = ['Resources', 'MediaBox'] as const;

/** Anything that can hand back objects — the read-only document or the editor. */
export interface PageTreeReader {
  resolve(value: CosObject): Promise<CosObject>;
  getCatalog(): Promise<CosObject>;
}

/** One page as the walk found it (§7.7.3), with the ancestor chain that attribute inheritance reads (Table 31). */
export interface PageEntry {
  /** Position in the tree, in the order §7.7.3 gives the pages. */
  readonly index: number;
  /** The reference naming the page, or null when a page is a direct object. */
  readonly ref: CosRef | null;
  readonly dict: CosDict;
  /** Ancestors from the page's parent up to the root, **nearest first**. */
  readonly ancestors: readonly CosDict[];
}

/** A node that is not a leaf, with the count the tree actually holds. */
export interface NodeEntry {
  readonly ref: CosRef | null;
  readonly dict: CosDict;
  /** Descendant pages, counted by walking (R-7.7.3.2-8). */
  readonly count: number;
}

/** What `readPageTree` measured: the pages in §7.7.3 order, the interior nodes, and the walk's anomalies. */
export interface PageTree {
  readonly pages: readonly PageEntry[];
  readonly nodes: readonly NodeEntry[];
  /**
   * References met a second time. R-7.7.3.2-4 and R-7.7.3.3-3 forbid them, so
   * the walk records them here and does not descend again — following would
   * count the same pages twice, or not terminate.
   */
  readonly duplicates: readonly CosRef[];
  /**
   * Whether the tree could be reached at all. A file whose catalog or `/Pages`
   * cannot be read is not judged — nothing here can be said about a tree that
   * was never seen, and saying nothing is not the same as saying it is fine.
   */
  readonly reached: boolean;
}

/** One §7.7.3 requirement the tree does not meet, named by clause. */
export interface PageTreeViolation {
  /** The requirement, so an error can name it rather than describe it. */
  readonly clause: string;
  readonly message: string;
  readonly objectNumber?: number;
}

/** Raised when a tree that breaks §7.7.3 is about to be written. */
export class PageTreeError extends Error {
  readonly violations: readonly PageTreeViolation[];

  constructor(violations: readonly PageTreeViolation[]) {
    super(
      `the page tree breaks ${violations.length} requirement(s) of §7.7.3 and shall not be written:\n` +
        violations.map((v) => `  ${v.clause}: ${v.message}`).join('\n'),
    );
    this.name = 'PageTreeError';
    this.violations = violations;
  }
}

const refKey = (ref: CosRef): string => `${ref.objectNumber} ${ref.generationNumber}`;
const describe = (ref: CosRef | null): string =>
  ref === null ? 'a direct node' : `object ${ref.objectNumber} ${ref.generationNumber}`;

/**
 * Walk the tree from the catalog's `/Pages`, gathering pages in order and the
 * nodes above them.
 *
 * Everything a violation could be found in is collected here, so the walk
 * happens once. A node reached twice is recorded and **not descended into
 * again**: R-7.7.3.2-4 and R-7.7.3.3-3 forbid that shape, and following it
 * would count the same pages twice or loop forever.
 */
export async function readPageTree(reader: PageTreeReader): Promise<PageTree> {
  const pages: PageEntry[] = [];
  const nodes: NodeEntry[] = [];
  const seen = new Set<string>();
  const duplicates: CosRef[] = [];

  let rootRef: CosObject | undefined;
  try {
    const catalog = await reader.getCatalog();
    rootRef = catalog.kind === 'dict' ? dictGet(catalog, 'Pages') : undefined;
  } catch {
    // A file whose /Root is missing or unreadable has no tree to judge. That
    // is recorded as "not reached", never as "nothing wrong with it".
    rootRef = undefined;
  }
  if (rootRef === undefined) {
    return { pages, nodes, duplicates, reached: false };
  }

  const walk = async (
    value: CosObject,
    ancestors: readonly CosDict[],
    depth: number,
  ): Promise<number> => {
    if (depth > 256) {
      return 0;
    }
    const ref = value.kind === 'ref' ? value : null;
    if (ref !== null) {
      const key = refKey(ref);
      if (seen.has(key)) {
        duplicates.push(ref);
        return 0;
      }
      seen.add(key);
    }
    const dict = await reader.resolve(value);
    if (dict.kind !== 'dict') {
      return 0;
    }
    const kids = await reader.resolve(dictGet(dict, 'Kids') ?? { kind: 'null' });
    if (kids.kind !== 'array') {
      pages.push({ index: pages.length, ref, dict, ancestors });
      return 1;
    }
    const below: readonly CosDict[] = [dict, ...ancestors];
    let count = 0;
    for (const kid of kids.items) {
      count += await walk(kid, below, depth + 1);
    }
    nodes.push({ ref, dict, count });
    return count;
  };

  const reachedRoot = (await reader.resolve(rootRef)).kind === 'dict';
  await walk(rootRef, [], 0);
  return { pages, nodes, duplicates, reached: reachedRoot };
}

/**
 * The value of an inheritable attribute for a page (§7.7.3.4).
 *
 * R-7.7.3.4-5/-6: search the page, then each ancestor following `/Parent`
 * upward, and "when the first Resources dictionary is found the search shall
 * be stopped and that Resources dictionary shall be used in its entirety".
 * R-7.7.3.4-4 adds that values are inherited "as-is, without merging, even for
 * composite data types such as arrays and dictionaries" — so this returns what
 * it found, never a combination.
 *
 * An entry present with an empty value is present: R-7.7.3.3-8 makes an empty
 * `/Resources` dictionary the way to say "this page needs none", which means
 * something different from leaving the entry out.
 */
export function inheritedAttribute(page: PageEntry, key: string): CosObject | undefined {
  const own = dictGet(page.dict, key);
  if (own !== undefined) {
    return own;
  }
  // 🔴 R-7.7.3.3-2: "Attributes that are not explicitly identified in the
  // table as inheritable shall not be inherited." Walking ancestors for any
  // key at all is the obvious implementation and it is wrong — it hands a page
  // a `/Tabs` or an `/Annots` that belongs to a node above it. Written that
  // way first here; the `inherit-all-four` fixture, which puts a `/Tabs` on
  // the ancestor precisely so it can be wrongly taken, is what caught it.
  if (!(INHERITABLE as readonly string[]).includes(key)) {
    return undefined;
  }
  for (const ancestor of page.ancestors) {
    const value = dictGet(ancestor, key);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/** Whether a `/Rotate` value is one §7.7.3.3 allows: an integer multiple of 90. */
const rotationIsValid = (value: CosObject): boolean =>
  value.kind === 'integer' && value.value % 90 === 0;

/**
 * Everything about this tree that §7.7.3 forbids. An empty result means
 * nothing here could be shown to be wrong — the checks this file implements
 * are the ones it implements, and a tree passing them is not thereby correct.
 */
export async function checkPageTree(
  reader: PageTreeReader,
  tree?: PageTree,
): Promise<readonly PageTreeViolation[]> {
  const walked = tree ?? (await readPageTree(reader));
  if (!walked.reached) {
    return [];
  }
  const violations: PageTreeViolation[] = [];
  const add = (clause: string, message: string, objectNumber?: number): void => {
    violations.push({ clause, message, ...(objectNumber === undefined ? {} : { objectNumber }) });
  };

  for (const ref of walked.duplicates) {
    add(
      'R-7.7.3.2-4 / R-7.7.3.3-3',
      `${describe(ref)} is referenced more than once; a page tree shall not contain multiple indirect references to the same node or page`,
      ref.objectNumber,
    );
  }

  // /Parent: Required below the root, and an indirect reference (R-7.7.3.3-5).
  const parentOf = new Map<string, CosRef>();
  for (const node of walked.nodes) {
    if (node.ref === null) continue;
    const kids = await reader.resolve(dictGet(node.dict, 'Kids') ?? { kind: 'null' });
    if (kids.kind !== 'array') continue;
    for (const kid of kids.items) {
      if (kid.kind === 'ref') parentOf.set(refKey(kid), node.ref);
    }
  }
  const checkParent = (ref: CosRef | null, dict: CosDict, what: string): void => {
    if (ref === null) return;
    const expected = parentOf.get(refKey(ref));
    if (expected === undefined) return; // the root has no parent to check
    const parent = dictGet(dict, 'Parent');
    if (parent === undefined) {
      add('R-7.7.3.3-5', `${what} ${describe(ref)} has no /Parent`, ref.objectNumber);
      return;
    }
    if (parent.kind !== 'ref') {
      add(
        'R-7.7.3.3-5',
        `${what} ${describe(ref)} has a direct /Parent; it shall be an indirect reference`,
        ref.objectNumber,
      );
      return;
    }
    if (parent.objectNumber !== expected.objectNumber) {
      add(
        'R-7.7.3.3-5',
        `${what} ${describe(ref)} names object ${parent.objectNumber} as its /Parent, but it hangs below object ${expected.objectNumber}`,
        ref.objectNumber,
      );
    }
  };
  for (const node of walked.nodes) checkParent(node.ref, node.dict, 'page tree node');
  for (const page of walked.pages) checkParent(page.ref, page.dict, 'page');

  for (const page of walked.pages) {
    // Required inheritable attributes: R-7.7.3.4-2 says a required attribute
    // omitted from the page "shall be supplied in an ancestor node".
    for (const key of REQUIRED_INHERITABLE) {
      if (inheritedAttribute(page, key) === undefined) {
        add(
          'R-7.7.3.4-2',
          `page ${page.index} has no /${key} and no ancestor supplies one`,
          page.ref?.objectNumber,
        );
      }
    }

    const rotate = inheritedAttribute(page, 'Rotate');
    if (rotate !== undefined) {
      const resolved = await reader.resolve(rotate);
      if (!rotationIsValid(resolved)) {
        add(
          'R-7.7.3.3-28',
          `page ${page.index} has a /Rotate that is not a multiple of 90`,
          page.ref?.objectNumber,
        );
      }
    }

    const contents = dictGet(page.dict, 'Contents');
    if (contents !== undefined) {
      const resolved = await reader.resolve(contents);
      if (resolved.kind === 'array' && resolved.items.length === 0) {
        add(
          'R-7.7.3.3-26',
          `page ${page.index} has an empty /Contents array; PDF writers shall not create one`,
          page.ref?.objectNumber,
        );
      }
    }
  }

  return violations;
}

/**
 * The nodes whose `/Count` does not match the pages below them, with the value
 * that does.
 *
 * This is a correction rather than a violation. R-7.7.3.2-8 puts the duty on
 * the writer, and asking a caller to count descendants themselves is asking
 * them to reimplement the walk that just happened — the shape in which the
 * mistake is easy is `Kids.length`, which is right for a flat tree and wrong
 * for every other one.
 */
export async function countCorrections(
  reader: PageTreeReader,
  tree?: PageTree,
): Promise<ReadonlyMap<number, { readonly dict: CosDict; readonly count: number }>> {
  const walked = tree ?? (await readPageTree(reader));
  const corrections = new Map<number, { dict: CosDict; count: number }>();
  for (const node of walked.nodes) {
    if (node.ref === null) continue;
    const declared = await reader.resolve(dictGet(node.dict, 'Count') ?? { kind: 'null' });
    if (declared.kind === 'integer' && declared.value === node.count) continue;
    corrections.set(node.ref.objectNumber, { dict: node.dict, count: node.count });
  }
  return corrections;
}

/** The same dictionary with `/Count` set. Key order is preserved when it was already there. */
export function withCount(dict: CosDict, count: number): CosDict {
  const entries = new Map(dict.entries);
  entries.set('Count', { kind: 'integer', value: count });
  return { kind: 'dict', entries };
}
