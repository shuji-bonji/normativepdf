/**
 * The document as something that can be changed and written back.
 *
 * `PdfDocument` reads; it is lazy, cached and immutable. This wraps it with a
 * layer holding only the objects that were touched, and two exits: rewrite the
 * whole file, or append an incremental update.
 *
 * **Why an overlay rather than a materialised object table.** Three reasons,
 * each of which is already an acceptance criterion somewhere:
 *
 *   1. `appendUpdate` asks for "the objects this update writes" (§7.5.6). An
 *      overlay *is* that set. Materialising everything means computing a
 *      difference afterwards, and a difference computed wrongly puts objects
 *      into a revision that never changed.
 *   2. ADR-0005 makes "the original bytes survive byte for byte" the first
 *      thing to measure about an update. An overlay never touches them.
 *   3. Laziness is about reach, not speed. The corpus holds specimens of
 *      several megabytes, and specimens whose `/Info` points at an object that
 *      does not exist. Reading everything up front would fail to open a file
 *      over an object nobody asked for.
 *
 * **What this deliberately does not do.** No `addPage`, no drawing, no layout:
 * DESIGN §5 keeps the authoring layer above the library, and ADR-0007 §1 draws
 * the line here. Page-tree semantics (`/Count`, inheritance, the duplicate and
 * `/Parent` rules of §7.7.3) arrive in the next step; this layer holds the
 * graph and the two exits.
 */

import type { CosObject, CosRef } from '../cos/types.js';
import { dictGet } from '../cos/types.js';
import { type PdfDocument, parsePdf } from '../file/file-parser.js';
import type { WritableObject, WriteFileOptions } from '../serialize/file-writer.js';
import { collectObjects, writeFile } from '../serialize/file-writer.js';
import type {
  AppendUpdateInput,
  AppendUpdateResult,
  DeletedObject,
} from '../serialize/incremental.js';
import { appendUpdateTo } from '../serialize/incremental.js';

/**
 * Overlay key.
 *
 * 🔴 The generation belongs in the key. Measured over veraPDF-corpus
 * (2026-08-14): no page tree anywhere in it holds a reference whose generation
 * is not 0 — 15,834 references, all generation 0 — but the cross-reference
 * tables hold **12 in-use entries at generations 1 to 6, across two
 * specimens**. Keying by object number alone therefore looks correct on every
 * page-tree test and hands back the wrong object on those two files.
 */
type Key = `${number} ${number}`;
const keyOf = (objectNumber: number, generationNumber: number): Key =>
  `${objectNumber} ${generationNumber}`;

export class PdfDocumentEditor {
  /** The file as read. Immutable, and shared with anything else reading it. */
  readonly base: PdfDocument;

  readonly #changed = new Map<Key, WritableObject>();
  readonly #deleted = new Map<Key, DeletedObject>();
  /** Object numbers that are referenced anywhere, filled in on first allocate. */
  #referenced: Set<number> | null = null;
  #nextNumber: number | null = null;

  private constructor(base: PdfDocument) {
    this.base = base;
  }

  static async open(bytes: Uint8Array): Promise<PdfDocumentEditor> {
    return new PdfDocumentEditor(await parsePdf(bytes));
  }

  /** Wrap a document that has already been read. */
  static of(base: PdfDocument): PdfDocumentEditor {
    return new PdfDocumentEditor(base);
  }

  // -------------------------------------------------------------- reading

  /**
   * The object as it stands now: the overlay if it was touched, otherwise the
   * file. A deleted object reads as the null object, which is what §7.3.10
   * says a reference to a free entry means.
   */
  async get(objectNumber: number, generationNumber = 0): Promise<CosObject> {
    const key = keyOf(objectNumber, generationNumber);
    if (this.#deleted.has(key)) {
      return { kind: 'null' };
    }
    const overlaid = this.#changed.get(key);
    if (overlaid !== undefined) {
      return overlaid.object;
    }
    return this.base.getObject(objectNumber, generationNumber);
  }

  /** Follow an indirect reference through the overlay; other objects pass through. */
  async resolve(value: CosObject): Promise<CosObject> {
    if (value.kind !== 'ref') {
      return value;
    }
    return this.get(value.objectNumber, value.generationNumber);
  }

  /** The document catalog (§7.7.2), reached through `/Root` as Table 15 requires. */
  async getCatalog(): Promise<CosObject> {
    const root = dictGet(this.base.trailer, 'Root');
    if (root === undefined) {
      throw new Error('trailer has no /Root, so the catalog cannot be reached (§7.5.5 Table 15)');
    }
    return this.resolve(root);
  }

  // -------------------------------------------------------------- writing

  /** Put an object in place of whatever that number and generation held. */
  set(objectNumber: number, object: CosObject, generationNumber = 0): void {
    if (objectNumber < 1) {
      throw new RangeError(`object number shall be positive (§7.3.10); got ${objectNumber}`);
    }
    const key = keyOf(objectNumber, generationNumber);
    this.#deleted.delete(key);
    this.#changed.set(key, { objectNumber, generationNumber, object });
    this.#referenced?.add(objectNumber);
  }

  /**
   * Store a new object and return the reference that names it.
   *
   * **The number has to clear references as well as definitions.** Taking
   * "highest defined number + 1" is the obvious rule and it is wrong: a file
   * may refer to an object it never defines, and giving that number to
   * something new makes the dangling reference resolve to it. Measured over
   * veraPDF-corpus (2026-08-14) this happens in **one specimen out of 2,890** —
   * `6-2-11-4-1-t01-fail-a.pdf`, which refers to object 21 while the highest
   * the file defines is 20. One specimen, and the failure is silent, so the
   * scan is worth its cost: pdf-writer-mcp shipped the cheap rule and qpdf
   * answered `operation for dictionary attempted on object of type stream`.
   *
   * The scan happens here rather than in `open`, so a session that only reads
   * or only replaces existing objects never pays for it.
   */
  async allocate(object: CosObject): Promise<CosRef> {
    if (this.#referenced === null) {
      this.#referenced = await this.#scanReferences();
    }
    let number = this.#nextNumber ?? 1;
    while (this.#referenced.has(number) || this.base.xref.has(number)) {
      number += 1;
    }
    this.#nextNumber = number + 1;
    this.set(number, object, 0);
    return { kind: 'ref', objectNumber: number, generationNumber: 0 };
  }

  /**
   * Mark an object free (§7.5.6). §7.5.4 requires the recorded generation to
   * be "incremented by 1 to indicate the generation number to be used the next
   * time an object with that object number is created", so the caller names
   * the generation being retired and this adds the one.
   */
  delete(objectNumber: number, generationNumber = 0): void {
    const key = keyOf(objectNumber, generationNumber);
    this.#changed.delete(key);
    this.#deleted.set(key, { objectNumber, generationNumber: generationNumber + 1 });
  }

  /** Everything the overlay holds, in object-number order. */
  changed(): readonly WritableObject[] {
    return [...this.#changed.values()].sort((a, b) => a.objectNumber - b.objectNumber);
  }

  /** Everything marked free, in object-number order. */
  deleted(): readonly DeletedObject[] {
    return [...this.#deleted.values()].sort((a, b) => a.objectNumber - b.objectNumber);
  }

  /** Whether anything has been touched. */
  get dirty(): boolean {
    return this.#changed.size > 0 || this.#deleted.size > 0;
  }

  // -------------------------------------------------------------- exits

  /**
   * Write the whole file again as a single revision.
   *
   * The header version defaults to the file's *header* version rather than its
   * effective one, for the reason `writeFile` gives: a catalog `/Version` that
   * raised the effective version travels with the catalog, so deriving the
   * header from it would upgrade the file without being asked.
   */
  async save(options: WriteFileOptions = {}): Promise<Uint8Array> {
    const objects = new Map<number, WritableObject>();
    for (const object of await collectObjects(this.base)) {
      objects.set(object.objectNumber, object);
    }
    for (const { objectNumber } of this.#deleted.values()) {
      objects.delete(objectNumber);
    }
    for (const object of this.#changed.values()) {
      objects.set(object.objectNumber, object);
    }
    const ordered = [...objects.values()].sort((a, b) => a.objectNumber - b.objectNumber);
    return writeFile(ordered, this.base.trailer, {
      version: this.base.headerVersion,
      ...options,
    });
  }

  /**
   * Append what changed as an incremental update (§7.5.6), leaving the
   * original bytes in place.
   *
   * Refuses an empty update rather than writing a revision that says nothing:
   * §7.5.6 describes a section that names the objects the update changed, and
   * a section naming none of them is a revision claiming a change that did not
   * happen.
   */
  appendUpdate(options: Pick<AppendUpdateInput, 'xref'> = {}): AppendUpdateResult {
    if (!this.dirty) {
      throw new RangeError(
        'nothing was changed, so there is no incremental update to append (§7.5.6)',
      );
    }
    return appendUpdateTo(this.base, this.changed(), this.deleted(), options);
  }

  // -------------------------------------------------------------- internals

  /**
   * Every object number referenced anywhere in the file. This is the one
   * operation that reads the whole body, which is why it is not done on open.
   */
  async #scanReferences(): Promise<Set<number>> {
    const found = new Set<number>();
    const visit = (value: CosObject): void => {
      switch (value.kind) {
        case 'ref':
          found.add(value.objectNumber);
          return;
        case 'array':
          for (const item of value.items) visit(item);
          return;
        case 'dict':
          for (const item of value.entries.values()) visit(item);
          return;
        case 'stream':
          for (const item of value.dict.entries.values()) visit(item);
          return;
        default:
      }
    };

    visit(this.base.trailer);
    for (const [objectNumber, entry] of this.base.xref) {
      if (objectNumber === 0 || entry.type === 'free' || entry.type === 'unknown') {
        continue;
      }
      const generation = entry.type === 'in-use' ? entry.generation : 0;
      visit(await this.base.getObject(objectNumber, generation));
    }
    for (const object of this.#changed.values()) {
      visit(object.object);
      found.add(object.objectNumber);
    }
    return found;
  }
}
