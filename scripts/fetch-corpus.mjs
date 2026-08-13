#!/usr/bin/env node
/**
 * Fetch the stage-0 conformance corpus (docs/DESIGN.md §5.2).
 *
 * pdf-association/pdf20examples — PDF 2.0 example files.
 *   License: CC BY-SA 4.0 (https://github.com/pdf-association/pdf20examples/blob/master/LICENSE.md)
 * veraPDF/veraPDF-corpus — PDF/A all levels + PDF/UA-1/UA-2 + ISO 32000-1/-2
 *   extra specimens + Isartor test suite (bundled).
 *   License: CC BY 4.0 (https://github.com/veraPDF/veraPDF-corpus/blob/staging/README.md)
 *
 * The files are downloaded, not vendored; corpus/ is gitignored.
 *
 * **veraPDF-corpus is pinned by commit** (corpus.lock.json), not tracked on the
 * `staging` branch. A moving corpus and a parser regression both show up as the
 * pass rate going down, and nothing in the output distinguishes them — so the
 * rate quoted in ROADMAP.md would stop being a claim about this code. The fetch
 * writes the commit it materialised into corpus/.veraPDF-corpus.sha; the survey
 * refuses to run as a gate when that file is missing or does not match the lock.
 *
 * Usage: node scripts/fetch-corpus.mjs
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const corpusRoot = join(import.meta.dirname, '..', 'corpus');
const lock = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'corpus.lock.json'), 'utf8'));

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

// --- veraPDF-corpus: the pinned commit, as a tarball ---
//
// A tarball of one commit rather than `git clone --branch staging`: the clone
// tracks a moving branch, so re-running it on two days can materialise two
// different corpora under the same path with nothing on disk saying which. The
// codeload tarball is addressed by SHA, carries no history (136 MB vs a clone),
// and lets the fetch be a no-op when the recorded SHA already matches.

const { commit, repo, specimens } = lock.veraPDFCorpus;
const veraDir = join(corpusRoot, 'veraPDF-corpus');
const shaFile = join(corpusRoot, '.veraPDF-corpus.sha');
const present = existsSync(shaFile) ? readFileSync(shaFile, 'utf8').trim() : null;

if (present === commit) {
  console.log(`OK  veraPDF-corpus already at ${commit.slice(0, 12)} (pinned)`);
} else {
  if (present !== null) {
    console.log(`--  corpus is at ${present.slice(0, 12)}, lock wants ${commit.slice(0, 12)} — re-fetching`);
  }
  await rm(veraDir, { recursive: true, force: true });
  await rm(shaFile, { force: true });

  const url = `${repo.replace('github.com', 'codeload.github.com')}/tar.gz/${commit}`;
  // Extracting with --strip-components=1 drops the "<repo>-<sha>/" wrapper the
  // tarball carries, so the layout matches what a clone would have produced and
  // every path already recorded in the docs stays valid.
  const fetched = spawnSync('bash', ['-o', 'pipefail', '-c',
    `mkdir -p "${veraDir}" && curl -sSfL "${url}" | tar xz -C "${veraDir}" --strip-components=1`,
  ], { stdio: 'inherit' });

  if (fetched.status !== 0) {
    failed += 1;
    console.error(`NG  veraPDF-corpus: fetch of ${commit} failed`);
  } else {
    await writeFile(shaFile, `${commit}\n`);
    console.log(`OK  veraPDF-corpus ${commit.slice(0, 12)} extracted to ${veraDir}`);
  }
}

// The specimen count is the cheapest check that the fetch produced the corpus
// the lock describes — a truncated download extracts without error.
if (existsSync(veraDir)) {
  const found = spawnSync('bash', ['-c', `find "${veraDir}" -name '*.pdf' | wc -l`], { encoding: 'utf8' });
  const count = Number.parseInt(found.stdout?.trim() ?? '', 10);
  if (count !== specimens) {
    failed += 1;
    console.error(`NG  veraPDF-corpus holds ${count} PDFs, lock says ${specimens} — corpus.lock.json is stale or the fetch was truncated`);
  }
}

if (failed > 0) {
  process.exit(1);
}
console.log(`\ncorpus ready under ${corpusRoot}`);
