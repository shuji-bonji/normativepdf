/**
 * Document-level encryption — the inverse of `document-decryptor.ts`.
 * §7.6.2 decides which strings and streams become ciphertext and which
 * the clause excepts; the same rules run in reverse here.
 *
 * The §7.6.2 exceptions, applied on the way out:
 * - the Encrypt dictionary object is never encrypted (`encryptPdf` builds
 *   it after transformation and never routes it through here);
 * - trailer /ID values are not objects, so they never reach `transform`;
 * - a signature dictionary's /Contents (recognised by a sibling
 *   /ByteRange) is left as-is;
 * - the document-level metadata stream is left plaintext when
 *   /EncryptMetadata is false;
 * - a cross-reference stream is never encrypted — but `encryptPdf` writes
 *   a classic table, so no such stream is produced here.
 *
 * For revision 6/7 the file key is used directly (no per-object key), so
 * `transform` needs no object number.
 */

import type { CosDict, CosObject, CosStream } from '../cos/types.js';
import { dictGet } from '../cos/types.js';
import { encryptBytes, type RandomBytes, type WriteMethod } from './standard-handler-writer.js';

export class DocumentEncryptor {
  readonly #method: WriteMethod;
  readonly #fileKey: Uint8Array;
  readonly #random: RandomBytes;
  readonly #encryptMetadata: boolean;

  constructor(
    method: WriteMethod,
    fileKey: Uint8Array,
    encryptMetadata: boolean,
    random: RandomBytes,
  ) {
    this.#method = method;
    this.#fileKey = fileKey;
    this.#encryptMetadata = encryptMetadata;
    this.#random = random;
  }

  /** Return `object` with every to-be-encrypted string and stream replaced by ciphertext. */
  transform(object: CosObject): CosObject {
    return this.#walk(object);
  }

  #walk(object: CosObject): CosObject {
    switch (object.kind) {
      case 'string':
        return {
          kind: 'string',
          bytes: encryptBytes(this.#method, this.#fileKey, object.bytes, this.#random),
          form: object.form,
        };
      case 'array':
        return { kind: 'array', items: object.items.map((item) => this.#walk(item)) };
      case 'dict':
        return this.#walkDict(object);
      case 'stream': {
        const dict = this.#walkDict(object.dict);
        const type = dictGet(object.dict, 'Type');
        if (!this.#encryptMetadata && type?.kind === 'name' && type.value === 'Metadata') {
          return { kind: 'stream', dict, raw: object.raw };
        }
        return {
          kind: 'stream',
          dict,
          raw: encryptBytes(this.#method, this.#fileKey, object.raw, this.#random),
        };
      }
      default:
        return object;
    }
  }

  #walkDict(dict: CosDict): CosDict {
    const byteRange = dict.entries.has('ByteRange');
    const entries = new Map<string, CosObject>();
    for (const [key, value] of dict.entries) {
      if (byteRange && key === 'Contents' && value.kind === 'string') {
        // §7.6.2: the /Contents of a signature dictionary is not encrypted
        // — the ByteRange digest is computed over it in the clear.
        entries.set(key, value);
        continue;
      }
      entries.set(key, this.#walk(value));
    }
    return { kind: 'dict', entries };
  }
}

/** True when a stream carries /Type /Metadata (the document metadata stream). */
export function isMetadataStream(stream: CosStream): boolean {
  const type = dictGet(stream.dict, 'Type');
  return type?.kind === 'name' && type.value === 'Metadata';
}
