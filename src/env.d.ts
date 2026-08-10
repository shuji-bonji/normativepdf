/**
 * Runtime environment assumptions, declared minimally instead of pulling
 * in lib.dom or @types/node — the library is runtime-agnostic and depends
 * only on WHATWG Encoding globals, present in Node.js >= 20 and browsers.
 *
 * This file is compilation-input only; it is not part of the emitted API.
 */

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean });
  decode(input?: Uint8Array): string;
}

declare class TextEncoder {
  encode(input?: string): Uint8Array;
}

/**
 * WHATWG Compression Streams (Node.js >= 18, all evergreen browsers).
 * Used by the INTERIM FlateDecode implementation only (ADR-0003: the
 * canonical implementation will be a pure-TS inflate). Declared minimally —
 * just the surface `src/filter/inflate.ts` touches.
 */
interface MinimalReadableStream {
  pipeThrough(transform: DecompressionStream): MinimalReadableStream;
}

declare class DecompressionStream {
  constructor(format: 'deflate' | 'deflate-raw' | 'gzip');
  readonly readable: MinimalReadableStream;
  readonly writable: unknown;
}

declare class Blob {
  constructor(blobParts: readonly Uint8Array[]);
  stream(): MinimalReadableStream;
}

declare class Response {
  constructor(body: MinimalReadableStream);
  arrayBuffer(): Promise<ArrayBuffer>;
}
