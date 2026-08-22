/**
 * FlateDecode via the runtime's WHATWG `DecompressionStream('deflate')` —
 * the interim implementation that occupied this seat until the pure-TS
 * inflate landed (ADR-0003).
 *
 * It now serves as the DIFFERENTIAL ORACLE (ADR-0003 decision 5, GUARDS
 * G-6): tests and the corpus surveys run it against the pure-TS inflate
 * and require byte-identical output. It is not on the runtime path and is
 * not exported from the package index.
 */

import { FilterError } from './error.js';

export async function inflateNative(bytes: Uint8Array): Promise<Uint8Array> {
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
