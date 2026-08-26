/**
 * Write-side filter seam — the mirror of `filter/decode.ts`.
 *
 * ADR-0003 §2 put decoding behind a registry so that the provisional native
 * implementation and the eventual own one occupy the same seat. Encoding needs
 * the same seam for a different reason: **there is currently nothing to put in
 * it, and that has to be visible.**
 *
 * ADR-0003 §4 decided the writer starts uncompressed. `/Filter` is optional
 * (§7.3.8.2, Table 5), so an unfiltered stream is legal, and it is the only
 * form that is byte-stable across engines — `CompressionStream` is not
 * (DESIGN §4.1). Measured cost of that choice (2026-08-13, over the 32 files
 * the UC oracle produces): **×1.28 overall, ×1.68 on the worst specimen**.
 * Breakdown by stream kind, compressed → decoded:
 *
 *   fontfile  254 KB → 340 KB  (×1.3)   — the bulk, and already compact
 *   objstm     29 KB →  77 KB  (×2.6)
 *   content    12 KB →  54 KB  (×4.5)
 *
 * So the size argument for compressing is real but small, and it does not
 * justify reaching for a non-deterministic encoder. When it does become worth
 * paying for, the answer is a fixed-parameter deflate of our own (ADR-0003 §4),
 * registered here — not `CompressionStream`.
 *
 * `encodeStream` therefore has exactly one encoder today. Asking for any other
 * filter is refused by name, so that "we do not compress" stays a statement in
 * the code rather than an omission nobody can see.
 */

import { FilterError } from './error.js';

/** What a caller may ask for. `null` = write the bytes as they are. */
export type EncodeFilter = null | string;

/** `encodeStream`'s result: the bytes plus the `/Filter` value to record. */
export interface EncodedStream {
  readonly bytes: Uint8Array;
  /**
   * The value for the stream dictionary's `/Filter` — `null` when the entry
   * shall be omitted (§7.3.8.2: `/Filter` is optional).
   */
  readonly filter: string | null;
}

/**
 * Encode stream bytes for writing.
 *
 * Deliberately not doing the obvious convenience: there is no "compress if it
 * helps" mode. A writer that sometimes compresses produces different bytes for
 * the same input depending on the data, which is exactly the determinism
 * DESIGN §4.1 asks for.
 */
export function encodeStream(data: Uint8Array, filter: EncodeFilter = null): EncodedStream {
  if (filter === null) {
    return { bytes: data, filter: null };
  }
  if (filter === 'FlateDecode') {
    throw new FilterError(
      'FlateDecode is not implemented on the write side. ADR-0003 §4: compressed output shall come from a fixed-parameter deflate of our own, never CompressionStream, whose bytes are not stable across engines. Write the stream uncompressed (/Filter is optional, §7.3.8.2) until that exists.',
    );
  }
  throw new FilterError(`${filter} is not implemented on the write side`);
}
