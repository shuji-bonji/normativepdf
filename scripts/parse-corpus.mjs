#!/usr/bin/env node
/**
 * Stage-0 acceptance runner (docs/DESIGN.md §5.1): parse every corpus
 * file end-to-end — structure walk plus getObject() for every in-use and
 * compressed entry in the merged cross-reference table.
 *
 * A missing corpus is a FAILURE, not a skip (GUARDS T-4: skipped-green is
 * vacuous). Run `node scripts/fetch-corpus.mjs` first.
 *
 * Usage: node scripts/parse-corpus.mjs   (requires `npm run build` first)
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePdf } from '../dist/index.js';

const dir = join(import.meta.dirname, '..', 'corpus', 'pdf20examples');

let entries;
try {
  entries = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.pdf'));
} catch {
  console.error(`NG  corpus not found at ${dir} — run: node scripts/fetch-corpus.mjs`);
  process.exit(1);
}
if (entries.length === 0) {
  console.error('NG  corpus directory is empty');
  process.exit(1);
}

let failed = 0;
for (const file of entries.sort()) {
  const bytes = new Uint8Array(await readFile(join(dir, file)));
  try {
    const doc = await parsePdf(bytes);
    const kinds = new Map();
    let objects = 0;
    for (const [num, entry] of doc.xref) {
      if (entry.type !== 'in-use' && entry.type !== 'compressed') {
        continue;
      }
      const obj = await doc.getObject(num, entry.type === 'in-use' ? entry.generation : 0);
      objects += 1;
      kinds.set(obj.kind, (kinds.get(obj.kind) ?? 0) + 1);
    }
    const catalog = await doc.getCatalog();
    if (catalog.kind !== 'dict') {
      throw new Error(`catalog resolved to ${catalog.kind}`);
    }
    const summary = [...kinds.entries()].map(([k, n]) => `${k}:${n}`).join(' ');
    console.log(`OK  ${file} — v${doc.version}, ${objects} objects (${summary})`);
  } catch (error) {
    failed += 1;
    console.log(`NG  ${file} — ${error instanceof Error ? error.message : error}`);
  }
}

console.log(`\n${entries.length - failed}/${entries.length} parsed`);
process.exit(failed > 0 ? 1 : 0);
