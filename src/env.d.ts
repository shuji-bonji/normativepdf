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
