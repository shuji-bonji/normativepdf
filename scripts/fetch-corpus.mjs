#!/usr/bin/env node
/**
 * Fetch the stage-0 conformance corpus (docs/DESIGN.md §5.2).
 *
 * pdf-association/pdf20examples — PDF 2.0 example files.
 *   License: CC BY-SA 4.0 (https://github.com/pdf-association/pdf20examples/blob/master/LICENSE.md)
 * veraPDF/veraPDF-corpus — PDF/A all levels + PDF/UA-1/UA-2 + ISO 32000-1/-2
 *   extra specimens + Isartor test suite (bundled). Default branch: `staging`.
 *   License: CC BY 4.0 (https://github.com/veraPDF/veraPDF-corpus/blob/staging/README.md)
 *
 * The files are downloaded, not vendored; corpus/ is gitignored.
 *
 * Usage: node scripts/fetch-corpus.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const corpusRoot = join(import.meta.dirname, '..', 'corpus');

// --- pdf20examples: 7 individual files over raw.githubusercontent.com ---

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

const dir = join(corpusRoot, 'pdf20examples');
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

// --- veraPDF-corpus: shallow git clone of the `staging` default branch ---

const veraDir = join(corpusRoot, 'veraPDF-corpus');
if (existsSync(veraDir)) {
  console.log(`OK  veraPDF-corpus already present at ${veraDir} (delete to re-fetch)`);
} else {
  const clone = spawnSync(
    'git',
    [
      'clone',
      '--depth',
      '1',
      '--branch',
      'staging',
      'https://github.com/veraPDF/veraPDF-corpus.git',
      veraDir,
    ],
    { stdio: 'inherit' },
  );
  if (clone.status !== 0) {
    failed += 1;
    console.error('NG  veraPDF-corpus: git clone failed');
  } else {
    console.log(`OK  veraPDF-corpus cloned to ${veraDir}`);
  }
}

if (failed > 0) {
  process.exit(1);
}
console.log(`\ncorpus ready under ${corpusRoot}`);
