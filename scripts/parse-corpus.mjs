#!/usr/bin/env node
/**
 * Stage-0 acceptance runner (docs/DESIGN.md §5.1): parse every corpus
 * file end-to-end — structure walk plus getObject() for every in-use and
 * compressed entry in the merged cross-reference table.
 *
 * A missing corpus is a FAILURE, not a skip (GUARDS T-4: skipped-green is
 * vacuous). Run `node scripts/fetch-corpus.mjs` first.
 *
 * Usage:
 *   node scripts/parse-corpus.mjs
 *       Gate mode (pdf20examples): any failure exits 1.
 *   node scripts/parse-corpus.mjs --survey corpus/veraPDF-corpus
 *       Survey mode: walk the directory recursively, group failures by
 *       error message. veraPDF-corpus contains specimens that are
 *       *intentionally* broken (named "-fail-") — a failure there is a
 *       data point for recovery-parse requirements (ROADMAP Phase 1),
 *       not a regression. The gate: every "pass" specimen (a file veraPDF
 *       judges COMPLIANT, so a structure library must read it) shall
 *       parse — a pass-specimen failure exits 1. Baseline 2026-08-11:
 *       2881/2907, all 26 failures are fail specimens (23 intentionally
 *       broken file structures incl. 3 catalog /Version "/2,0" specimens,
 *       2 encrypted, 1 Isartor broken xref entry).
 *
 * (requires `npm run build` first)
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parsePdf } from '../dist/index.js';

// Differential oracle (ADR-0003 decision 5, GUARDS G-6): with
// NORMATIVEPDF_INFLATE_ORACLE=1, every successful pure-TS inflate is
// replayed through the interim native implementation and must be
// byte-identical. Zero cost when the variable is unset.
if (process.env.NORMATIVEPDF_INFLATE_ORACLE === '1') {
  const { setInflateOracle } = await import('../dist/filter/inflate.js');
  const { inflateNative } = await import('../dist/filter/inflate-native.js');
  let oracleCalls = 0;
  process.on('exit', () => {
    // A zero here means the oracle never fired — vacuous green, not a pass.
    console.error(`inflate differential oracle: ${oracleCalls} comparison(s), all byte-identical`);
    if (oracleCalls === 0) {
      process.exitCode = 1;
    }
  });
  setInflateOracle(async (input, output) => {
    oracleCalls += 1;
    const native = await inflateNative(input);
    if (native.length !== output.length || Buffer.compare(Buffer.from(native), Buffer.from(output)) !== 0) {
      throw new Error(
        `inflate oracle mismatch: pure ${output.length} byte(s), native ${native.length} byte(s)`,
      );
    }
  });
  console.error('inflate differential oracle: ON');
}

const root = join(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(join(root, 'corpus.lock.json'), 'utf8'));

/**
 * Refuse to act as a gate on an unidentified corpus.
 *
 * The pass rate only means something as a claim about a known set of files. If
 * the corpus on disk is not the one the lock describes, a drop cannot be
 * attributed: it could be this parser, or it could be that upstream added
 * twelve deliberately broken specimens overnight. Reporting a number anyway
 * would be reporting a measurement whose instrument is unknown, so this exits
 * non-zero instead — the same discipline as "a missing corpus is a failure,
 * not a skip".
 */
function assertPinnedCorpus() {
  const { commit } = lock.veraPDFCorpus;
  const shaFile = join(root, 'corpus', '.veraPDF-corpus.sha');
  if (!existsSync(shaFile)) {
    console.error(
      'NG  corpus/.veraPDF-corpus.sha is missing — the corpus on disk cannot be identified.\n' +
        '    Run: node scripts/fetch-corpus.mjs (it pins to corpus.lock.json)',
    );
    process.exit(1);
  }
  const present = readFileSync(shaFile, 'utf8').trim();
  if (present !== commit) {
    console.error(
      `NG  corpus is at ${present.slice(0, 12)} but corpus.lock.json pins ${commit.slice(0, 12)}.\n` +
        '    A rate measured against a different corpus is not comparable to the baseline.\n' +
        '    Run: node scripts/fetch-corpus.mjs',
    );
    process.exit(1);
  }
}

async function* walkPdfs(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    console.error(`NG  corpus not found at ${dir} — run: node scripts/fetch-corpus.mjs`);
    process.exit(1);
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkPdfs(full);
    } else if (entry.name.toLowerCase().endsWith('.pdf')) {
      yield full;
    }
  }
}

/** Parse one file fully; returns null on success or the error message. */
async function tryParse(bytes) {
  try {
    const doc = await parsePdf(bytes);
    for (const [num, entry] of doc.xref) {
      if (entry.type !== 'in-use' && entry.type !== 'compressed') {
        continue;
      }
      await doc.getObject(num, entry.type === 'in-use' ? entry.generation : 0);
    }
    const catalog = await doc.getCatalog();
    if (catalog.kind !== 'dict') {
      throw new Error(`catalog resolved to ${catalog.kind}`);
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Collapse numbers/names so identical failure shapes group together. */
function normalize(message) {
  return message
    .replace(/\b\d+\b/g, 'N')
    .replace(/0x[0-9a-fA-F]+/g, '0xN')
    .replace(/\/[A-Za-z][A-Za-z0-9]*\b/g, '/Name');
}

const surveyIndex = process.argv.indexOf('--survey');

if (surveyIndex !== -1) {
  const target = process.argv[surveyIndex + 1];
  if (!target) {
    console.error('NG  --survey requires a directory argument');
    process.exit(1);
  }
  assertPinnedCorpus();
  const dir = join(root, target);
  let ok = 0;
  const failures = new Map(); // normalized message -> { count, sample, files }
  const passSpecimenFailures = [];
  let total = 0;
  for await (const file of walkPdfs(dir)) {
    total += 1;
    const bytes = new Uint8Array(await readFile(file));
    const message = await tryParse(bytes);
    if (message === null) {
      ok += 1;
      continue;
    }
    const rel = relative(dir, file);
    if (/pass/i.test(rel)) {
      passSpecimenFailures.push(`${rel} — ${message}`);
    }
    const key = normalize(message);
    const group = failures.get(key) ?? { count: 0, sample: message, files: [] };
    group.count += 1;
    if (group.files.length < 5) {
      group.files.push(rel);
    }
    failures.set(key, group);
  }

  console.log(`\n${ok}/${total} parsed (${((ok / total) * 100).toFixed(1)}%)\n`);
  const sorted = [...failures.entries()].sort((a, b) => b[1].count - a[1].count);
  for (const [key, group] of sorted) {
    console.log(`${String(group.count).padStart(4)}  ${key}`);
    console.log(`      e.g. ${group.sample}`);
    for (const f of group.files) {
      console.log(`      - ${f}`);
    }
  }
  let failedGate = false;

  if (passSpecimenFailures.length > 0) {
    console.log(`\nNG  ${passSpecimenFailures.length} pass specimen(s) failed to parse — this is the gate:`);
    for (const f of passSpecimenFailures) {
      console.log(`    ${f}`);
    }
    failedGate = true;
  } else {
    console.log('\nOK  every pass specimen parsed');
  }

  // Second gate: the overall rate against the recorded baseline.
  //
  // The pass-specimen gate above cannot see a regression among the *fail*
  // specimens, and that is where most of the corpus lives. Those files are
  // intentionally broken, so failing to parse them is not wrong — but going
  // from "read 2881 of them" to "read 2860" means something changed, and the
  // survey would otherwise print a smaller number in the same green shape.
  //
  // An INCREASE is also non-zero, deliberately. A floor that is never raised
  // stops detecting anything: improve to 2890 without moving the lock, and a
  // later slide back to 2882 passes silently. Raising it in the same commit as
  // the improvement is the whole cost, and it keeps the number in ROADMAP.md a
  // measurement rather than a memory.
  const { baselineParsed, specimens } = lock.veraPDFCorpus;
  if (total !== specimens) {
    console.log(
      `\nNG  walked ${total} specimens, corpus.lock.json says ${specimens} — the corpus is not what the lock describes`,
    );
    failedGate = true;
  } else if (ok < baselineParsed) {
    console.log(
      `\nNG  ${ok}/${total} parsed, below the recorded baseline ${baselineParsed}/${specimens}.\n` +
        `    ${baselineParsed - ok} specimen(s) that used to parse no longer do — see the grouped failures above.`,
    );
    failedGate = true;
  } else if (ok > baselineParsed) {
    console.log(
      `\nNG  ${ok}/${total} parsed, ABOVE the recorded baseline ${baselineParsed}/${specimens} — this is good news, and the gate still fails.\n` +
        `    Set "baselineParsed": ${ok} in corpus.lock.json in this same commit.\n` +
        '    A baseline left behind an improvement stops catching the slide back to it.',
    );
    failedGate = true;
  } else {
    console.log(`OK  ${ok}/${total} parsed — matches the recorded baseline`);
  }

  process.exit(failedGate ? 1 : 0);
}

// --- gate mode: pdf20examples, any failure is a regression ---

const dir = join(root, 'corpus', 'pdf20examples');
let failed = 0;
let count = 0;
for await (const file of walkPdfs(dir)) {
  count += 1;
  const bytes = new Uint8Array(await readFile(file));
  const name = relative(dir, file);
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
    console.log(`OK  ${name} — v${doc.version}, ${objects} objects (${summary})`);
  } catch (error) {
    failed += 1;
    console.log(`NG  ${name} — ${error instanceof Error ? error.message : error}`);
  }
}
if (count === 0) {
  console.error('NG  corpus directory is empty');
  process.exit(1);
}

console.log(`\n${count - failed}/${count} parsed`);
process.exit(failed > 0 ? 1 : 0);
