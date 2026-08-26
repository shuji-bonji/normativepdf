#!/usr/bin/env node
/**
 * Measurements page generator: renders the numbers the site's
 * "Measurements" section shows, from the only place they are canonical —
 * corpus.lock.json (plus package.json for the version).
 *
 * This script holds NO numbers of its own. If a figure is not in the lock,
 * it does not appear here; prose copies of the numbers (README, ROADMAP)
 * are transcriptions of the same lock. That is the rule that keeps the
 * published page from drifting: regenerating it cannot disagree with the
 * gate, because both read the same file.
 *
 * Usage:
 *   node scripts/measurements.mjs            Print markdown to stdout.
 *   node scripts/measurements.mjs --out FILE Write markdown to FILE.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(join(root, 'corpus.lock.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const c = lock.veraPDFCorpus;
if (
  !c ||
  typeof c.specimens !== 'number' ||
  typeof c.baselineParsed !== 'number' ||
  typeof c.baselineRoundTrip !== 'number' ||
  typeof c.commit !== 'string' ||
  typeof c.measuredAt !== 'string'
) {
  console.error('corpus.lock.json does not have the expected veraPDFCorpus shape');
  process.exit(1);
}

const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`;

const md = `# Measurements

_Generated from \`corpus.lock.json\` for normativepdf ${pkg.version}.
The lock file is the canonical record; this page is a transcription and is
regenerated, never edited._

## Corpus acceptance (veraPDF-corpus)

| Measure | Value |
| --- | --- |
| Corpus | [veraPDF-corpus](${c.repo}) \`${c.branch}\` @ \`${c.commit.slice(0, 12)}\` |
| Specimens | ${c.specimens} |
| Parsed end-to-end | ${c.baselineParsed} / ${c.specimens} (${pct(c.baselineParsed, c.specimens)}) |
| Round-trip (read → write → read, equal object graph) | ${c.baselineRoundTrip} |
| Measured at | ${c.measuredAt} |

Both figures are CI gates, not aspirations: the survey fails when a run
falls below the baseline **and** when it rises above it — an improvement
must update the lock in the same commit, so the floor never trails the
implementation (see \`scripts/parse-corpus.mjs\`).

The specimens that do not parse are intentionally broken \`-fail-\` files,
each rejected with the violated clause named. Every specimen veraPDF judges
COMPLIANT parses; a failure on one of those is a defect by definition.

Round-trip's denominator is smaller than parse's: a file can parse while
one object cannot be fetched, and encrypted specimens count as
not-measurable for the write path rather than as failures (ADR-0008).

## What these numbers do not claim

Parsing the corpus is a claim about reading structure, not about rendering,
text extraction, or semantic fidelity. The round-trip figure compares
object graphs, not bytes. Numbers for the writer's conformance profiles
live with the writer's own lock-generated report.
`;

// A closed stdout (e.g. `npm run docs:measurements | head`) is not an error.
process.stdout.on('error', (e) => {
  if (e.code === 'EPIPE') process.exit(0);
  throw e;
});

const outIdx = process.argv.indexOf('--out');
if (outIdx !== -1 && process.argv[outIdx + 1]) {
  writeFileSync(process.argv[outIdx + 1], md);
  console.error(`measurements written to ${process.argv[outIdx + 1]}`);
} else {
  process.stdout.write(md);
}
