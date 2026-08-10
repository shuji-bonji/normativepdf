/**
 * FlateDecode body — RFC 1950 zlib stream, decompressed via the runtime's
 * WHATWG `DecompressionStream('deflate')`.
 *
 * ⚠️ INTERIM IMPLEMENTATION (ADR-0003). The canonical implementation is a
 * pure-TS inflate written against RFC 1950/1951; this wrapper temporarily
 * occupies the same seat behind the filter boundary and must not leak
 * outside `src/filter/`. When the pure-TS inflate lands, this file becomes
 * the differential oracle in tests (GUARDS G-6) and leaves the runtime.
 */

import { FilterError } from './error.js';

export async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  try {
    const buffer = await new Response(stream).arrayBuffer();
    return new Uint8Array(buffer);
  } catch (cause) {
    throw new FilterError(
      `FlateDecode failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}
