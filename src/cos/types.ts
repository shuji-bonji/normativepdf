/**
 * COS (Carousel Object System) object model.
 *
 * ISO 32000-2:2020 §7.3 "Objects" enumerates the basic object types.
 * This module maps that enumeration 1:1 onto a discriminated union —
 * the closed set of `kind` values mirrors the closed set of types in the
 * specification. Nothing here validates a document; these are the values
 * a parser produces and a serializer consumes.
 *
 * Design decisions (docs/DESIGN.md §5, docs/adr/0002-type-strictness.md):
 * - Integer and real are distinct kinds: R-7.3.3-6 "A real number shall not
 *   be present when an integer is expected" is only expressible if the
 *   distinction survives parsing.
 * - Strings are byte sequences (R-7.3.4.1-1), not JS strings. The written
 *   form (literal / hexadecimal) is preserved for round-trip fidelity.
 * - A dictionary entry whose value is null is preserved as parsed;
 *   the equivalence with an absent entry (R-7.3.7-7, R-7.3.9-3) is applied
 *   at access time via {@link dictGet}, not by dropping data at parse time.
 * - All shapes are readonly: deterministic output (DESIGN §4.1) is easier
 *   to reason about over immutable values.
 */

/** ISO 32000-2 §7.3.2 — keywords `true` / `false`. */
export interface CosBoolean {
  readonly kind: 'boolean';
  readonly value: boolean;
}

/** ISO 32000-2 §7.3.3 — integer object (R-7.3.3-2: digits with optional sign). */
export interface CosInteger {
  readonly kind: 'integer';
  readonly value: number;
}

/** ISO 32000-2 §7.3.3 — real object (R-7.3.3-4: digits with a PERIOD). */
export interface CosReal {
  readonly kind: 'real';
  readonly value: number;
}

/**
 * ISO 32000-2 §7.3.4 — string object: "a series of zero or more bytes"
 * (R-7.3.4.1-1). `form` records which of the two written forms
 * (R-7.3.4.1-3) the string was read from / should be written in.
 */
export interface CosString {
  readonly kind: 'string';
  readonly bytes: Uint8Array;
  readonly form: 'literal' | 'hex';
}

/**
 * ISO 32000-2 §7.3.5 — name object. Atomic (R-7.3.5-12). `value` holds the
 * byte sequence after `#xx` resolution, decoded as UTF-8 (R-7.3.5-13
 * "should be interpreted according to UTF-8") with Latin-1 fallback for
 * sequences that are not valid UTF-8. The leading SOLIDUS is not part of
 * the name (R-7.3.5-4).
 */
export interface CosName {
  readonly kind: 'name';
  readonly value: string;
}

/** ISO 32000-2 §7.3.6 — array object; heterogeneous (R-7.3.6-1), may be empty (R-7.3.6-4). */
export interface CosArray {
  readonly kind: 'array';
  readonly items: readonly CosObject[];
}

/**
 * ISO 32000-2 §7.3.7 — dictionary object. Keys are names (R-7.3.7-1) and
 * direct objects (R-7.3.7-3); entries are unordered (R-7.3.7-10) and keys
 * unique (R-7.3.7-13 — duplicate handling is parser policy, not model
 * capability: a Map cannot represent duplicates).
 */
export interface CosDict {
  readonly kind: 'dict';
  readonly entries: ReadonlyMap<string, CosObject>;
}

/**
 * ISO 32000-2 §7.3.8 — stream object: a dictionary followed by raw bytes
 * (R-7.3.8.1-4). `raw` holds the bytes exactly as they appear between
 * `stream` and `endstream` — encoded, undecoded. Filters (§7.4) are a
 * separate concern applied on demand.
 *
 * All streams shall be indirect objects (R-7.3.8.1-5); that constraint
 * lives in the parser/serializer, not in this shape.
 */
export interface CosStream {
  readonly kind: 'stream';
  readonly dict: CosDict;
  readonly raw: Uint8Array;
}

/** ISO 32000-2 §7.3.9 — the null object (R-7.3.9-1: there is only one). */
export interface CosNull {
  readonly kind: 'null';
}

/**
 * ISO 32000-2 §7.3.10 — indirect reference: object number, generation
 * number, keyword `R` (R-7.3.10-9). The pair uniquely identifies an
 * indirect object (R-7.3.10-6).
 */
export interface CosRef {
  readonly kind: 'ref';
  readonly objectNumber: number;
  readonly generationNumber: number;
}

/**
 * The closed union of ISO 32000-2 §7.3 basic object types, plus the
 * indirect reference (§7.3.10). Exhaustive `switch` over `kind` with a
 * `never` check mirrors the specification's closed enumeration.
 */
export type CosObject =
  | CosBoolean
  | CosInteger
  | CosReal
  | CosString
  | CosName
  | CosArray
  | CosDict
  | CosStream
  | CosNull
  | CosRef;

/** Shared singleton for the null object (R-7.3.9-1). */
export const COS_NULL: CosNull = { kind: 'null' };

/** True boolean singletons — no state, safe to share. */
export const COS_TRUE: CosBoolean = { kind: 'boolean', value: true };
export const COS_FALSE: CosBoolean = { kind: 'boolean', value: false };

/**
 * Dictionary access with the null-equivalence rule applied:
 * "A dictionary entry whose value is null shall be treated the same as
 * if the entry does not exist" (R-7.3.7-7; equivalently R-7.3.9-3).
 *
 * Use {@link dictGetRaw} when the parsed representation itself matters
 * (round-trip, diffing).
 */
export function dictGet(dict: CosDict, key: string): CosObject | undefined {
  const value = dict.entries.get(key);
  if (value === undefined || value.kind === 'null') {
    return undefined;
  }
  return value;
}

/** Dictionary access without the null-equivalence rule — returns what was parsed. */
export function dictGetRaw(dict: CosDict, key: string): CosObject | undefined {
  return dict.entries.get(key);
}
