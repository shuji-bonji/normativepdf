/**
 * Stream decoding — applies the Filter chain of a stream (Table 5:
 * "Multiple filters shall be specified in the order in which they are to
 * be applied", R-7.3.8.2-8) and the predictor parameters (Table 8).
 *
 * Coverage is explicit: FlateDecode only for now. Any other filter raises
 * FilterError naming the filter — "not supported yet" must never silently
 * pass bytes through as if decoded.
 */

import type { CosDict, CosObject, CosStream } from '../cos/types.js';
import { dictGet } from '../cos/types.js';
import { FilterError } from './error.js';
import { inflate } from './inflate.js';
import { applyPredictor, DEFAULT_PREDICTOR_PARMS, type PredictorParms } from './predictor.js';

/** Options for `decodeStream`. */
export interface DecodeOptions {
  /**
   * Resolve indirect values in Filter / DecodeParms. Cross-reference
   * streams require these entries to be direct (§7.5.8.2), so they never
   * need this; general streams may.
   */
  readonly resolve?: (value: CosObject) => CosObject;
}

/** Decode the raw bytes of `stream` through its Filter chain. */
export async function decodeStream(
  stream: CosStream,
  options?: DecodeOptions,
): Promise<Uint8Array> {
  const resolve = options?.resolve ?? ((v: CosObject): CosObject => v);
  const filters = filterNames(stream.dict, resolve);
  const parms = decodeParms(stream.dict, resolve);

  let data = stream.raw;
  for (let i = 0; i < filters.length; i += 1) {
    const name = filters[i];
    if (name === undefined) {
      continue;
    }
    if (name === 'Crypt') {
      // §7.4.10: the Crypt filter marks where decryption sits in the
      // chain, and decryption is not a byte-transform this layer can
      // perform — it happened (or was skipped, for /Identity) when the
      // object was materialised from its document (§7.6.6,
      // encrypt/document-decryptor.ts). By the time bytes reach this
      // function they are already what the next filter expects, so
      // /Identity (the Table 14 default) passes through. A NAMED crypt
      // filter means "this stream's ciphertext needs the document's CF
      // entry"; when the stream came through a document decryptor that
      // has already happened and the pass-through is correct — and when
      // it did not, no key exists at this layer, so refusing would also
      // refuse every legitimately decrypted stream. The decryptor is the
      // layer that refuses unknown names (encrypt/document-decryptor.ts).
      continue;
    }
    if (name !== 'FlateDecode') {
      throw new FilterError(`filter /${name} is not supported yet (§7.4)`);
    }
    data = await inflate(data);
    data = applyPredictor(data, predictorParms(parms[i], resolve));
  }
  return data;
}

/** Table 5 Filter: a name, or an array of names, in application order. */
function filterNames(dict: CosDict, resolve: (v: CosObject) => CosObject): string[] {
  const value = dictGet(dict, 'Filter');
  if (value === undefined) {
    return [];
  }
  const direct = resolve(value);
  if (direct.kind === 'name') {
    return [direct.value];
  }
  if (direct.kind === 'array') {
    return direct.items.map((item) => {
      const el = resolve(item);
      if (el.kind !== 'name') {
        throw new FilterError(`Filter array elements shall be names (Table 5), got ${el.kind}`);
      }
      return el.value;
    });
  }
  throw new FilterError(
    `Filter shall be a name or an array of names (Table 5), got ${direct.kind}`,
  );
}

/** Table 5 DecodeParms: a dictionary, or an array parallel to Filter (null = defaults). */
function decodeParms(dict: CosDict, resolve: (v: CosObject) => CosObject): (CosDict | undefined)[] {
  const value = dictGet(dict, 'DecodeParms');
  if (value === undefined) {
    return [];
  }
  const direct = resolve(value);
  if (direct.kind === 'dict') {
    return [direct];
  }
  if (direct.kind === 'array') {
    return direct.items.map((item) => {
      const el = resolve(item);
      if (el.kind === 'dict') {
        return el;
      }
      if (el.kind === 'null') {
        return undefined;
      }
      throw new FilterError(
        `DecodeParms array elements shall be dictionaries or null (Table 5), got ${el.kind}`,
      );
    });
  }
  throw new FilterError(
    `DecodeParms shall be a dictionary or an array (Table 5), got ${direct.kind}`,
  );
}

/** Read Table 8 predictor parameters with their clause defaults. */
function predictorParms(
  parms: CosDict | undefined,
  resolve: (v: CosObject) => CosObject,
): PredictorParms {
  if (parms === undefined) {
    return DEFAULT_PREDICTOR_PARMS;
  }
  return {
    predictor: intEntry(parms, 'Predictor', 1, resolve),
    colors: intEntry(parms, 'Colors', 1, resolve),
    bitsPerComponent: intEntry(parms, 'BitsPerComponent', 8, resolve),
    columns: intEntry(parms, 'Columns', 1, resolve),
  };
}

function intEntry(
  dict: CosDict,
  key: string,
  fallback: number,
  resolve: (v: CosObject) => CosObject,
): number {
  const value = dictGet(dict, key);
  if (value === undefined) {
    return fallback;
  }
  const direct = resolve(value);
  if (direct.kind !== 'integer') {
    throw new FilterError(`${key} shall be an integer (Table 8), got ${direct.kind}`);
  }
  return direct.value;
}
