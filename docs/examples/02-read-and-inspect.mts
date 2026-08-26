/**
 * Read a PDF back: parse the file structure, walk to the catalog, follow
 * references to the page, and decode its content stream.
 *
 * `parsePdf` reads the cross-reference chain (table or stream, §7.5.4 /
 * §7.5.8), merges incremental-update sections newest-first, and hands back
 * a `PdfDocument` whose `getObject` resolves any in-use or compressed
 * entry — decrypting on the way when the file is encrypted.
 */

import { type CosObject, decodeStream, dictGet, parsePdf } from 'normativepdf';
import { bytes } from './01-build-a-minimal-pdf.mts';

const doc = await parsePdf(bytes);

// The catalog is wherever the trailer's /Root points (§7.7.2).
const catalog = await doc.getCatalog();
if (catalog.kind !== 'dict') throw new Error('catalog shall be a dictionary');

// Follow /Pages → /Kids[0] → the page dictionary.
const deref = async (value: CosObject | undefined): Promise<CosObject | undefined> =>
  value?.kind === 'ref' ? doc.getObject(value.objectNumber, value.generationNumber) : value;

const pages = await deref(dictGet(catalog, 'Pages'));
if (pages?.kind !== 'dict') throw new Error('page tree root shall be a dictionary');
const kids = dictGet(pages, 'Kids');
if (kids?.kind !== 'array') throw new Error('/Kids shall be an array');
const page = await deref(kids.items[0]);
if (page?.kind !== 'dict') throw new Error('page shall be a dictionary');

// The content stream: a stream object, run through its /Filter chain.
// (This document wrote it unfiltered; decodeStream is a no-op then, and
// inflates when a /FlateDecode filter is present.)
const contents = await deref(dictGet(page, 'Contents'));
if (contents?.kind !== 'stream') throw new Error('/Contents shall be a stream here');
const operators = new TextDecoder('latin1').decode(await decodeStream(contents));

export { doc, page, operators };
