#!/usr/bin/env node
/**
 * Fetch the stage-0 conformance corpus (docs/DESIGN.md §5.2).
 *
 * pdf-association/pdf20examples — PDF 2.0 example files.
 * License: CC BY-SA 4.0 (https://github.com/pdf-association/pdf20examples/blob/master/LICENSE.md)
 * The files are downloaded, not vendored; corpus/ is gitignored.
 *
 * Usage: node scripts/fetch-corpus.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = 'https://raw.githubusercontent.com/pdf-association/pdf20examples/master/';
const FILES = [
  'Simple PDF 2.0 file.pdf',
  'PDF 2.0 image with BPC.pdf',
  'PDF 2.0 UTF-8 string and annotation.pdf',
  'PDF 2.0 via incremental save.pdf',
  'PDF 2.0 with offset start.pdf',
  'PDF 2.0 with page level output intent.pdf',
  'pdf20-utf8-test.pdf',
];

const dir = join(import.meta.dirname, '..', 'corpus', 'pdf20examples');
await mkdir(dir, { recursive: true });

let failed = 0;
for (const file of FILES) {
  const url = BASE + encodeURIComponent(file);
  try {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    await writeFile(join(dir, file), bytes);
    console.log(`OK  ${file} (${bytes.length} bytes)`);
  } catch (error) {
    failed += 1;
    console.error(`NG  ${file}: ${error instanceof Error ? error.message : error}`);
  }
}

if (failed > 0) {
  process.exit(1);
}
console.log(`\n${FILES.length} files in ${dir}`);
