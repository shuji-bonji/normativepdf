/**
 * Document-level decryption — §7.6.2 "Application of encryption": which
 * strings and streams of a parsed object are ciphertext, and which the
 * clause excepts.
 *
 * The split with `standard-handler.ts` is deliberate: the handler knows
 * ciphers and keys and nothing about documents; this module knows the
 * document-shaped rules and no cryptography. `file-parser.ts` calls
 * exactly one method — {@link DocumentDecryptor.transform} — on every
 * indirect object it materialises.
 *
 * The §7.6.2 exceptions, and where each is handled:
 * - trailer /ID values — the trailer is not an indirect object, so its
 *   strings never pass through `transform` at all;
 * - strings in the Encrypt dictionary — `transform` skips the object the
 *   trailer's /Encrypt entry references (`encryptObjectNumber`);
 * - strings inside streams (content streams, object streams) — objects
 *   materialised *out of* an object stream are produced by
 *   `objectFromStream`, which never calls `transform`; the container
 *   stream itself was decrypted as a whole;
 * - the hexadecimal /Contents value of a signature dictionary — skipped
 *   when the holding dictionary carries /ByteRange (§12.8.1: a signature
 *   dictionary always does; the key name alone is not distinctive).
 *
 * Streams with their own rules:
 * - cross-reference streams are never encrypted (Table 20 StmF: "All
 *   streams … except for cross-reference streams") — left untouched;
 * - the document-level metadata stream is plaintext when
 *   /EncryptMetadata is false (Table 21) — recognised by /Type /Metadata;
 * - a stream whose Filter chain names /Crypt uses the crypt filter its
 *   DecodeParms /Name selects (§7.4.10 Table 14; missing Name means
 *   Identity), instead of the StmF default.
 */

import type { CosDict, CosObject, CosStream } from '../cos/types.js';
import { dictGet } from '../cos/types.js';
import {
  type CryptMethod,
  EncryptionError,
  type StandardSecurityHandler,
} from './standard-handler.js';

/** The encryption facts a document exposes (read-only observations, no verdicts). */
export interface EncryptionInfo {
  /** Table 20 Filter — always "Standard" here (anything else is refused earlier). */
  readonly filter: string;
  /** Table 20 V. */
  readonly v: number;
  /** Table 21 R. */
  readonly revision: number;
  /** Default crypt method for streams. */
  readonly streamMethod: CryptMethod;
  /** Default crypt method for strings. */
  readonly stringMethod: CryptMethod;
  /** Table 21 EncryptMetadata. */
  readonly encryptMetadata: boolean;
  /** Which password authenticated ('user' covers the empty password). */
  readonly authenticatedAs: 'user' | 'owner';
  /** R 6 only — whether /Perms agreed with /P and /EncryptMetadata (Algorithm 13, "should"). */
  readonly permsConsistent: boolean | undefined;
}

/** Applies §7.6.2 to every materialised indirect object of one document. */
export class DocumentDecryptor {
  readonly info: EncryptionInfo;
  readonly #handler: StandardSecurityHandler;
  /** Object number the trailer /Encrypt references (undefined when the dictionary is direct). */
  readonly #encryptObjectNumber: number | undefined;

  constructor(handler: StandardSecurityHandler, encryptObjectNumber: number | undefined) {
    this.#handler = handler;
    this.#encryptObjectNumber = encryptObjectNumber;
    this.info = {
      filter: 'Standard',
      v: handler.params.v,
      revision: handler.params.revision,
      streamMethod: handler.params.streamMethod,
      stringMethod: handler.params.stringMethod,
      encryptMetadata: handler.params.encryptMetadata,
      authenticatedAs: handler.auth.authenticatedAs,
      permsConsistent: handler.auth.permsConsistent,
    };
  }

  /**
   * Return `object` with every encrypted string and stream replaced by
   * its plaintext. (objectNumber, generationNumber) identify the indirect
   * object being materialised — Algorithm 1 derives the key from them.
   */
  transform(object: CosObject, objectNumber: number, generationNumber: number): CosObject {
    if (objectNumber === this.#encryptObjectNumber) {
      // §7.6.2: "Any strings in an Encrypt dictionary" are not encrypted.
      return object;
    }
    return this.#walk(object, objectNumber, generationNumber);
  }

  #walk(object: CosObject, num: number, gen: number): CosObject {
    switch (object.kind) {
      case 'string':
        return {
          kind: 'string',
          bytes: this.#handler.decrypt(this.info.stringMethod, object.bytes, num, gen),
          form: object.form,
        };
      case 'array': {
        return { kind: 'array', items: object.items.map((item) => this.#walk(item, num, gen)) };
      }
      case 'dict':
        return this.#walkDict(object, num, gen);
      case 'stream': {
        const type = dictGet(object.dict, 'Type');
        if (type?.kind === 'name' && type.value === 'XRef') {
          // A cross-reference stream is untouched WHOLE, dictionary
          // included: its data is never encrypted (Table 20 StmF: "except
          // for cross-reference streams" — it must be readable before any
          // key exists), and its dictionary doubles as the trailer
          // (§7.5.8.2), so its strings are trailer strings — the /ID
          // values §7.6.2 excepts. Measured: both cross-reference-stream
          // specimens carry /ID inside the stream dictionary, and
          // "decrypting" those 16-byte values was the first live failure
          // of this module.
          return object;
        }
        const dict = this.#walkDict(object.dict, num, gen);
        return { kind: 'stream', dict, raw: this.#decryptStreamData(object, num, gen) };
      }
      default:
        return object;
    }
  }

  #walkDict(dict: CosDict, num: number, gen: number): CosDict {
    const byteRange = dict.entries.has('ByteRange');
    const entries = new Map<string, CosObject>();
    for (const [key, value] of dict.entries) {
      if (byteRange && key === 'Contents' && value.kind === 'string') {
        // §7.6.2: the /Contents hexadecimal string of a signature
        // dictionary is written unencrypted (its bytes are what the
        // ByteRange digest covers). /ByteRange is the distinctive mark —
        // §12.8.1 requires it of every signature dictionary, and no other
        // common dictionary pairs the two keys.
        entries.set(key, value);
        continue;
      }
      entries.set(key, this.#walk(value, num, gen));
    }
    return { kind: 'dict', entries };
  }

  #decryptStreamData(stream: CosStream, num: number, gen: number): Uint8Array {
    const type = dictGet(stream.dict, 'Type');
    if (!this.info.encryptMetadata && type?.kind === 'name' && type.value === 'Metadata') {
      // Table 21 EncryptMetadata false: the document-level metadata
      // stream is plaintext.
      return stream.raw;
    }
    const method = this.#cryptFilterMethod(stream.dict) ?? this.info.streamMethod;
    return this.#handler.decrypt(method, stream.raw, num, gen);
  }

  /**
   * §7.4.10 Table 14 — when the Filter chain names /Crypt, the
   * DecodeParms /Name entry selects the crypt filter for this stream
   * (missing means Identity). Returns undefined when there is no /Crypt
   * filter, so the StmF default applies.
   */
  #cryptFilterMethod(dict: CosDict): CryptMethod | undefined {
    const filter = dictGet(dict, 'Filter');
    const names =
      filter === undefined
        ? []
        : filter.kind === 'name'
          ? [filter]
          : filter.kind === 'array'
            ? filter.items
            : [];
    const index = names.findIndex((f) => f.kind === 'name' && f.value === 'Crypt');
    if (index < 0) {
      return undefined;
    }
    const parmsEntry = dictGet(dict, 'DecodeParms');
    const parms =
      parmsEntry === undefined
        ? undefined
        : parmsEntry.kind === 'dict'
          ? parmsEntry
          : parmsEntry.kind === 'array'
            ? parmsEntry.items[index]
            : undefined;
    const name = parms !== undefined && parms.kind === 'dict' ? dictGet(parms, 'Name') : undefined;
    if (name === undefined) {
      return 'Identity'; // Table 14 Name: "Default value: Identity"
    }
    if (name.kind !== 'name') {
      throw new EncryptionError(
        `Crypt filter Name shall be a name (§7.4.10 Table 14), got ${name.kind}`,
      );
    }
    if (name.value === 'Identity') {
      return 'Identity'; // Table 26: input passed through without processing
    }
    const method = this.#handler.params.cryptFilters.get(name.value);
    if (method === undefined) {
      throw new EncryptionError(
        `Crypt filter /${name.value} is not defined in the encryption dictionary's CF (§7.6.6: every crypt filter used in the document shall have an entry)`,
      );
    }
    return method;
  }
}
