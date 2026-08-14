/**
 * Logical structure — ISO 32000-2 §14.7 (structure hierarchy, structure
 * content, the structural parent tree) and §14.6 (marked content).
 *
 * **The thing that breaks, and why a type fixes it.**
 * A tagged page carries the same number in three places:
 *
 *   1. the content stream, as `/MCID n` in a `BDC` property list
 *      (R-14.7.5.2-4: an integer that uniquely identifies the sequence within
 *      its content stream);
 *   2. the structure element's `/K`, as that same integer
 *      (R-14.7.2-24: an integer marked-content identifier is a content item);
 *   3. the structural parent tree, as the **index** into the array of parent
 *      references for that stream (R-14.7.5.4-8: "The array element
 *      corresponding to each sequence shall be found by using the sequence's
 *      marked-content identifier as a zero-based index into the array").
 *
 * Three places, one number, written by three different pieces of code — that is
 * the shape a defect lives in. Nothing in a PDF file records that they were
 * meant to agree, and no validator recomputes them: veraPDF checks that the
 * entries exist and are well-formed, not that `/K 3` names the sequence that
 * actually drew the heading.
 *
 * So here the number has one origin. `TaggedStream.contentItem()` allocates the
 * MCID, writes the `BDC` itself, appends the integer to the element's `/K`, and
 * records the element at that index of the stream's parent array — in one call.
 * The caller never sees an MCID, so the caller cannot mismatch one.
 *
 * **What is enforced, with the clause that requires it:**
 * - R-14.7.5.1.1-6 a structure content item shall not nest another structure
 *   content item (non-structural marked content, such as an artifact, may).
 * - R-14.7.2-21   every structure element's `/P` is the parent — written here,
 *   never by the caller, so it cannot disagree with `/K`.
 * - R-14.7.2-23   `/Pg` is required when `/K` holds integers; it follows from
 *   the stream the content item was written into. An element whose items are on
 *   more than one page gets Table 357 references instead — one `/Pg` cannot
 *   name two pages, and an authoring layer should not have to know that a
 *   paragraph broke across a page changes the shape underneath it.
 * - R-14.7.5.4-9/-10/-11 `/ParentTreeNextKey` shall exceed every key in use,
 *   and keys are handed out in order.
 * - R-14.7.5.4-20 at most one of `/StructParent` / `/StructParents` per object.
 *
 * **What it does not do.** It does not know the standard structure types
 * (§14.8.4) and will write whatever `/S` it is given — role mapping and
 * PDF/UA-1's stronger requirements (ISO 14289-1) are the caller's and
 * pdf-verify-mcp's respectively (DESIGN §4.2).
 */

import { ContentStreamBuilder } from '../content/content-stream.js';
import type { CosDict, CosObject, CosRef } from '../cos/types.js';

export class StructTreeError extends Error {
  override readonly name = 'StructTreeError';
}

const name = (value: string): CosObject => ({ kind: 'name', value });
const int = (value: number): CosObject => ({ kind: 'integer', value });
const dict = (entries: Iterable<readonly [string, CosObject]>): CosDict => ({
  kind: 'dict',
  entries: new Map(entries),
});
const text = (value: string): CosObject => ({
  kind: 'string',
  bytes: new TextEncoder().encode(value),
  form: 'literal',
});

/**
 * Where the built objects go; the caller owns object numbering.
 *
 * Reserving and writing are **separate operations on purpose**: a structure
 * tree is cyclic — `/P` points up (R-14.7.2-21) and `/K` points down
 * (R-14.7.2-24) — so whichever end is written first has to name an object that
 * does not exist yet. Making that a requirement of the type means a sink that
 * cannot do it fails to compile, instead of failing at the one moment a real
 * tree is being written.
 */
export interface StructObjectSink {
  /** Reserve an object number before its contents are known. */
  reserve(): CosRef;
  /** Write the object that was reserved. */
  write(ref: CosRef, object: CosObject): void;
}

export interface StructElementOptions {
  /** Parent element. Absent = a child of the structure tree root. */
  readonly parent?: StructElement;
  /** `/T` (R-14.7.2-32) */
  readonly title?: string;
  /** `/Alt` — the alternate description accessibility depends on (§14.9.3). */
  readonly alt?: string;
  /** `/ActualText` (R-14.7.2-33) */
  readonly actualText?: string;
  /** `/Lang` (§14.9.2) */
  readonly lang?: string;
  /** Further entries of Table 355 the caller wants, e.g. `/A`. */
  readonly extra?: ReadonlyMap<string, CosObject>;
}

/**
 * A node of the structure tree. Opaque on purpose: `/K`, `/P` and `/Pg` are
 * maintained by the builder, so there is nothing here for a caller to set.
 */
export class StructElement {
  /** @internal */ readonly children: (StructElement | { mcid: number; stream: TaggedStream })[] =
    [];
  /** @internal */ ref: CosRef | null = null;

  /** @internal */
  constructor(
    readonly type: string,
    readonly options: StructElementOptions,
    /** @internal */ readonly parent: StructElement | null,
  ) {}
}

/**
 * One content stream, tagged. Wraps a `ContentStreamBuilder` and owns the MCIDs
 * for that stream — R-14.7.5.2-4 scopes uniqueness to the stream, so the
 * counter lives here and not in the document.
 */
export class TaggedStream {
  /** @internal */ readonly parents: StructElement[] = [];
  #open = false;

  /** @internal */
  constructor(
    readonly page: CosRef,
    readonly content: ContentStreamBuilder,
    private readonly tree: StructTreeBuilder,
  ) {}

  /**
   * Bracket a marked-content sequence as the content of `element`
   * (R-14.7.5.2-2). The MCID is allocated, written and recorded here.
   *
   * The tag written is the element's structure type: R-14.7.5.2-3 says it
   * *should* be the same, and there is no reason to offer a way to make them
   * differ.
   */
  contentItem(element: StructElement, draw: (content: ContentStreamBuilder) => void): this {
    if (this.#open) {
      throw new StructTreeError(
        'a marked-content sequence that is a structure content item shall not nest another one (R-14.7.5.1.1-6); close the first, or use artifact() for non-structural marks',
      );
    }
    this.tree.assertKnown(element);
    const mcid = this.parents.length;
    this.parents.push(element);
    element.children.push({ mcid, stream: this });

    this.#open = true;
    try {
      this.content.op('BDC', name(element.type), dict([['MCID', int(mcid)]]));
      draw(this.content);
      this.content.op('EMC');
    } finally {
      this.#open = false;
    }
    return this;
  }

  /**
   * Non-structural marked content (§14.8.2.2 artifacts). Allowed inside a
   * content item — R-14.7.5.1.1-6 forbids nesting *structure* content items,
   * and explicitly permits non-structural marked content.
   */
  artifact(draw: (content: ContentStreamBuilder) => void, subtype?: string): this {
    // Table 352 gives BMC for a sequence with no property list and BDC for one
    // with. An empty dictionary is a property list that says nothing, so
    // writing BDC <<>> would claim a list that carries no property — BMC is
    // what the specification has for exactly this case.
    if (subtype === undefined) {
      this.content.op('BMC', name('Artifact'));
    } else {
      this.content.op('BDC', name('Artifact'), dict([['Subtype', name(subtype)]]));
    }
    draw(this.content);
    this.content.op('EMC');
    return this;
  }

  /** The stream's bytes, once every bracket is closed. */
  finish(): Uint8Array {
    return this.content.finish();
  }
}

export interface BuiltStructTree {
  /** For the catalog's `/StructTreeRoot` (R-14.7.2-2). */
  readonly structTreeRoot: CosRef;
  /**
   * For the catalog's `/MarkInfo` (R-14.7.1-7). `/Marked true` is the whole
   * claim: it says the file uses tagged-PDF conventions, and nothing more —
   * whether it does is veraPDF's answer, not this module's.
   */
  readonly markInfo: CosDict;
  /**
   * `/StructParents` to write on each page object, keyed by the stream it was
   * built for (R-14.7.5.4-12/-17). A page that has one shall not also carry
   * `/StructParent` (R-14.7.5.4-20).
   */
  readonly structParents: ReadonlyMap<TaggedStream, number>;
}

export class StructTreeBuilder {
  readonly #elements = new Set<StructElement>();
  readonly #roots: StructElement[] = [];
  readonly #streams: TaggedStream[] = [];

  /** Create a structure element (Table 355). `/P` is wired by the builder. */
  element(type: string, options: StructElementOptions = {}): StructElement {
    if (type.length === 0) {
      throw new StructTreeError('a structure element shall have a structure type /S (R-14.7.2-20)');
    }
    if (options.parent !== undefined) this.assertKnown(options.parent);
    const element = new StructElement(type, options, options.parent ?? null);
    this.#elements.add(element);
    if (options.parent === undefined) this.#roots.push(element);
    else options.parent.children.push(element);
    return element;
  }

  /** Begin a tagged content stream for `page`. */
  stream(page: CosRef, content: ContentStreamBuilder = new ContentStreamBuilder()): TaggedStream {
    const stream = new TaggedStream(page, content, this);
    this.#streams.push(stream);
    return stream;
  }

  /** @internal */
  assertKnown(element: StructElement): void {
    if (!this.#elements.has(element)) {
      throw new StructTreeError('this structure element was not created by this builder');
    }
  }

  /**
   * Write the tree.
   *
   * The parent tree is built from the same ledger the MCIDs came from, so
   * index and identifier cannot drift apart (R-14.7.5.4-8).
   */
  finish(sink: StructObjectSink): BuiltStructTree {
    if (this.#roots.length === 0) {
      throw new StructTreeError(
        'a structure tree root shall have children (R-14.7.2-3); an empty tree claims structure that is not there',
      );
    }

    const alloc = (object: CosObject): CosRef => {
      const ref = sink.reserve();
      sink.write(ref, object);
      return ref;
    };

    // The root is reserved first so that every element's /P can point at it
    // (R-14.7.2-21 requires /P and requires it to be an indirect reference).
    const rootRef = sink.reserve();

    const refs = new Map<StructElement, CosRef>();
    const assign = (element: StructElement): CosRef => {
      const ref = sink.reserve();
      refs.set(element, ref);
      element.ref = ref;
      for (const child of element.children) if (child instanceof StructElement) assign(child);
      return ref;
    };
    for (const root of this.#roots) assign(root);

    const write = (element: StructElement): void => {
      const entries = new Map<string, CosObject>(element.options.extra ?? []);
      entries.set('Type', name('StructElem'));
      entries.set('S', name(element.type));
      entries.set('P', element.parent === null ? rootRef : (refs.get(element.parent) as CosRef));

      // R-14.7.2-23 gives an element **one** /Pg, so a bare integer content item
      // only says which sequence it is — the page comes from /Pg. An element
      // whose items sit on more than one page therefore cannot use bare
      // integers for all of them; Table 357's marked-content reference
      // dictionary carries its own /Pg and is what that case is for.
      //
      // Which shape applies is decided by walking the items first, rather than
      // by the caller: a paragraph that happens to break across a page is an
      // ordinary thing for an authoring layer to produce, and it should not
      // have to know that the shape changes underneath it.
      const contentItems = element.children.filter(
        (child): child is { mcid: number; stream: TaggedStream } =>
          !(child instanceof StructElement),
      );
      const pagesUsed = new Set(contentItems.map((item) => item.stream.page.objectNumber));
      const spansPages = pagesUsed.size > 1;

      const kids: CosObject[] = [];
      for (const child of element.children) {
        if (child instanceof StructElement) {
          kids.push(refs.get(child) as CosRef);
          write(child);
          continue;
        }
        kids.push(
          spansPages
            ? // Table 357. Written as a direct object: the clause requires the
              // dictionary, not an indirect one, and an object number per
              // content item would be spent for nothing.
              dict([
                ['Type', name('MCR')],
                ['Pg', child.stream.page],
                ['MCID', int(child.mcid)],
              ])
            : int(child.mcid),
        );
      }
      if (!spansPages && contentItems.length > 0) {
        entries.set('Pg', (contentItems[0] as { stream: TaggedStream }).stream.page);
      }
      if (kids.length === 1) entries.set('K', kids[0] as CosObject);
      else if (kids.length > 1) entries.set('K', { kind: 'array', items: kids });

      if (element.options.title !== undefined) entries.set('T', text(element.options.title));
      if (element.options.alt !== undefined) entries.set('Alt', text(element.options.alt));
      if (element.options.actualText !== undefined) {
        entries.set('ActualText', text(element.options.actualText));
      }
      if (element.options.lang !== undefined) entries.set('Lang', text(element.options.lang));

      sink.write(refs.get(element) as CosRef, dict(entries));
    };
    for (const root of this.#roots) write(root);

    // --- structural parent tree (§14.7.5.4). One key per content stream that
    // holds at least one content item (R-14.7.5.4-3).
    const structParents = new Map<TaggedStream, number>();
    const nums: CosObject[] = [];
    let nextKey = 0;
    for (const stream of this.#streams) {
      if (stream.parents.length === 0) continue;
      const key = nextKey;
      nextKey += 1;
      structParents.set(stream, key);
      const parentRefs = stream.parents.map((element) => refs.get(element) as CosRef);
      nums.push(int(key), alloc({ kind: 'array', items: parentRefs }));
    }

    const rootEntries = new Map<string, CosObject>([
      ['Type', name('StructTreeRoot')],
      [
        'K',
        this.#roots.length === 1
          ? (refs.get(this.#roots[0] as StructElement) as CosRef)
          : { kind: 'array', items: this.#roots.map((r) => refs.get(r) as CosRef) },
      ],
    ]);
    if (nums.length > 0) {
      rootEntries.set('ParentTree', alloc(dict([['Nums', { kind: 'array', items: nums }]])));
      // R-14.7.5.4-9: greater than any key in use.
      rootEntries.set('ParentTreeNextKey', int(nextKey));
    }
    sink.write(rootRef, dict(rootEntries));

    return {
      structTreeRoot: rootRef,
      markInfo: dict([['Marked', { kind: 'boolean', value: true }]]),
      structParents,
    };
  }
}
