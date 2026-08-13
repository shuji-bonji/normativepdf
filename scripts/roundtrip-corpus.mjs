#!/usr/bin/env node
/**
 * Stage-1 acceptance runner (ADR-0004): read → write → read over the corpus.
 *
 * The comparison rules, the three intentional differences, and — most
 * importantly — the reason this cannot be the only gate are in
 * docs/adr/0004-roundtrip-acceptance.md. In short: both sides share this
 * repository's parser, so a reading mistake and a writing mistake cancel. The
 * second face is an independent reader; run with --qpdf to add it.
 *
 * Usage:
 *   node scripts/roundtrip-corpus.mjs                     # pdf20examples (gate)
 *   node scripts/roundtrip-corpus.mjs --survey corpus/veraPDF-corpus
 *   node scripts/roundtrip-corpus.mjs --survey <dir> --qpdf [--qpdf-sample N]
 *
 * (requires `npm run build` first)
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { dictGetRaw } from '../dist/cos/types.js';
import { collectObjects, parsePdf, writeFile } from '../dist/index.js';

const root = join(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(join(root, 'corpus.lock.json'), 'utf8'));

async function* walkPdfs(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    console.error(`NG  corpus not found at ${dir} — run: node scripts/fetch-corpus.mjs`);
    process.exit(1);
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkPdfs(full);
    } else if (entry.name.toLowerCase().endsWith('.pdf')) {
      yield full;
    }
  }
}

/* ---------------------------------------------------------------- *
 * structural equality (ADR-0004 §3)
 * ---------------------------------------------------------------- */

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Compare two COS objects. Returns null when equal, otherwise a path-tagged
 * reason — the path matters, because "a dictionary differs" is not actionable
 * and "/Root/Pages/Kids[0]/Contents differs in kind" is.
 */
function diff(a, b, path = '') {
  if (a.kind !== b.kind) {
    return `${path || '<root>'}: kind ${a.kind} → ${b.kind}`;
  }
  switch (a.kind) {
    case 'null':
      return null;
    case 'boolean':
    case 'integer':
    case 'real':
      return a.value === b.value ? null : `${path}: ${a.value} → ${b.value}`;
    case 'name':
      return a.value === b.value ? null : `${path}: /${a.value} → /${b.value}`;
    case 'string':
      // form is compared, not just bytes: the type carries it precisely so a
      // round-trip can show whether the written form survived.
      if (a.form !== b.form) return `${path}: string form ${a.form} → ${b.form}`;
      return bytesEqual(a.bytes, b.bytes) ? null : `${path}: string bytes differ`;
    case 'ref':
      return a.objectNumber === b.objectNumber && a.generationNumber === b.generationNumber
        ? null
        : `${path}: ref ${a.objectNumber} ${a.generationNumber} → ${b.objectNumber} ${b.generationNumber}`;
    case 'array': {
      if (a.items.length !== b.items.length) {
        return `${path}: array length ${a.items.length} → ${b.items.length}`;
      }
      for (let i = 0; i < a.items.length; i += 1) {
        const d = diff(a.items[i], b.items[i], `${path}[${i}]`);
        if (d) return d;
      }
      return null;
    }
    case 'dict':
      return diffDict(a, b, path);
    case 'stream': {
      // /Length is the one intentional normalisation (ADR-0004 §4.1). It is
      // not skipped: both sides must state the length they actually carry.
      const lengthDiff = checkLength(a, `${path} (source)`) ?? checkLength(b, `${path} (rewritten)`);
      if (lengthDiff) return lengthDiff;
      const d = diffDict(a.dict, b.dict, `${path}<dict>`, new Set(['Length']));
      if (d) return d;
      return bytesEqual(a.raw, b.raw)
        ? null
        : `${path}: stream bytes differ (${a.raw.length} vs ${b.raw.length})`;
    }
    default:
      return `${path}: unhandled kind ${a.kind}`;
  }
}

/** A stream's /Length shall equal the bytes it carries (R-7.3.8.2-1). */
function checkLength(stream, path) {
  const declared = dictGetRaw(stream.dict, 'Length');
  if (declared === undefined) return `${path}: stream has no /Length (R-7.3.8.2-1)`;
  // An indirect /Length is legal in the source; it is resolved by the parser
  // when the stream is read, so only a direct integer can be checked here.
  if (declared.kind !== 'integer') return null;
  return declared.value === stream.raw.length
    ? null
    : `${path}: /Length ${declared.value} ≠ ${stream.raw.length} bytes`;
}

function diffDict(a, b, path, ignore = new Set()) {
  const keys = new Set([...a.entries.keys(), ...b.entries.keys()]);
  for (const key of keys) {
    if (ignore.has(key)) continue;
    const av = a.entries.get(key);
    const bv = b.entries.get(key);
    // A null value is preserved, not dropped (ADR-0004 §3) — so a key present
    // on one side only is a difference even when its value is null.
    if (av === undefined) return `${path}/${key}: absent → present`;
    if (bv === undefined) return `${path}/${key}: present → absent`;
    const d = diff(av, bv, `${path}/${key}`);
    if (d) return d;
  }
  return null;
}

/* ---------------------------------------------------------------- *
 * one specimen
 * ---------------------------------------------------------------- */

/**
 * Outcomes are three-valued on purpose. "Could not be measured" is not a pass
 * and not a failure: an encrypted document cannot be round-tripped because
 * decryption is not implemented, and counting it either way would misstate
 * what was tested (GUARDS T-4).
 */
async function roundTrip(bytes) {
  let source;
  try {
    source = await parsePdf(bytes);
  } catch (error) {
    return { outcome: 'unreadable', reason: message(error) };
  }
  if (dictGetRaw(source.trailer, 'Encrypt') !== undefined) {
    return { outcome: 'not-measurable', reason: 'encrypted (§7.6; decryption not implemented)' };
  }

  // Collecting and writing are separated so a failure names the side that
  // failed. `parsePdf` only resolves the catalog, so a specimen with a broken
  // stream object parses fine and blows up when every object is actually
  // fetched — that is the reader reaching its limit, not the writer producing
  // bad bytes, and reporting it as "write-failed" would send the next person
  // to the wrong file.
  let objects;
  try {
    objects = await collectObjects(source);
  } catch (error) {
    return { outcome: 'source-unreadable', reason: message(error) };
  }

  let written;
  try {
    written = writeFile(objects, source.trailer, { version: source.headerVersion, ...writeOptions });
  } catch (error) {
    return { outcome: 'write-failed', reason: message(error) };
  }

  let back;
  try {
    back = await parsePdf(written);
  } catch (error) {
    return { outcome: 'reparse-failed', reason: message(error), written };
  }

  for (const [objectNumber, entry] of source.xref) {
    if (objectNumber === 0 || entry.type === 'free' || entry.type === 'unknown') continue;
    const generation = entry.type === 'in-use' ? entry.generation : 0;
    let before;
    try {
      before = await source.getObject(objectNumber, generation);
    } catch (error) {
      return { outcome: 'not-measurable', reason: `source object ${objectNumber}: ${message(error)}` };
    }
    if (before.kind === 'null') continue;
    // Cross-reference and object streams are replaced by the new table
    // (ADR-0004 §4.2), so they are absent from the output by design.
    if (before.kind === 'stream') {
      const type = dictGetRaw(before.dict, 'Type');
      if (type?.kind === 'name' && (type.value === 'XRef' || type.value === 'ObjStm')) continue;
    }
    let after;
    try {
      after = await back.getObject(objectNumber, generation);
    } catch (error) {
      return { outcome: 'mismatch', reason: `object ${objectNumber}: ${message(error)}`, written };
    }
    const d = diff(before, after, `obj ${objectNumber}`);
    if (d) return { outcome: 'mismatch', reason: d, written };
  }

  return { outcome: 'ok', written };
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Collapse specimen-specific detail so failures group (same as parse-corpus). */
function normalize(text) {
  return text
    .replace(/\b\d+\b/g, 'N')
    .replace(/0x[0-9a-fA-F]+/g, '0xN')
    .replace(/\/[A-Za-z][A-Za-z0-9]*\b/g, '/Name');
}

/* ---------------------------------------------------------------- *
 * independent reader (ADR-0004 §2)
 * ---------------------------------------------------------------- */

/**
 * What qpdf says about a file, reduced to a comparable shape.
 *
 * Numbers are collapsed because offsets move between the source and the
 * rewrite even when the complaint is the same one.
 */
function qpdfVerdict(bytes, scratch, name) {
  const file = join(scratch, name);
  writeFileSync(file, bytes);
  const run = spawnSync('qpdf', ['--check', file], { encoding: 'utf8' });
  const lines = `${run.stdout ?? ''}${run.stderr ?? ''}`
    .split('\n')
    .filter((line) => /^(ERROR|WARNING)/.test(line.trim()))
    // The scratch path differs between the two runs and would make every
    // message look new. Strip it before normalising — leaving it in also
    // turned the message into unreadable noise, since `normalize` collapses
    // every path segment that looks like a name.
    .map((line) => normalize(line.trim().split(file).join('')))
    .map((line) => line.replace(/^(ERROR|WARNING):\s*:?\s*/, '$1: '));
  return new Set(lines);
}

/**
 * Compare the two verdicts and report only what the rewrite *introduced*.
 *
 * 🔴 The first version of this gate demanded a clean bill of health from the
 * output and failed 4 specimens. Every one of them produced the identical
 * complaint from the source file: deliberately broken content streams, copied
 * through byte for byte, exactly as a round-trip should. Demanding absolute
 * cleanliness measured the corpus, not the writer — the question a round-trip
 * can actually answer is "did this make it worse".
 *
 * A complaint that disappears is not treated as a win either; it is not
 * reported, because this writer does not repair anything on purpose and a
 * vanished warning most likely means the defect stopped being reachable.
 */
function qpdfRegression(sourceBytes, writtenBytes, scratch) {
  const before = qpdfVerdict(sourceBytes, scratch, 'before.pdf');
  const after = qpdfVerdict(writtenBytes, scratch, 'after.pdf');
  const introduced = [...after].filter((line) => !before.has(line));
  return introduced.length > 0 ? introduced[0] : null;
}

/* ---------------------------------------------------------------- *
 * runners
 * ---------------------------------------------------------------- */

const args = process.argv.slice(2);
const surveyIndex = args.indexOf('--survey');
const withQpdf = args.includes('--qpdf');
const qpdfSampleIndex = args.indexOf('--qpdf-sample');
const qpdfSample = qpdfSampleIndex !== -1 ? Number.parseInt(args[qpdfSampleIndex + 1], 10) : Infinity;

/**
 * Which cross-reference form the rewrite uses. The baseline in
 * corpus.lock.json is measured with the default (`table`); the other modes are
 * run the same way so a comparison is like for like.
 *   --mode table | stream | objstm
 */
const modeIndex = args.indexOf('--mode');
const mode = modeIndex !== -1 ? args[modeIndex + 1] : 'table';
const writeOptions =
  mode === 'objstm'
    ? { xref: 'stream', objectStreams: true }
    : mode === 'stream'
      ? { xref: 'stream' }
      : {};
if (!['table', 'stream', 'objstm'].includes(mode)) {
  console.error(`NG  --mode shall be table, stream or objstm; got ${mode}`);
  process.exit(1);
}

function assertPinnedCorpus() {
  const { commit } = lock.veraPDFCorpus;
  const shaFile = join(root, 'corpus', '.veraPDF-corpus.sha');
  if (!existsSync(shaFile)) {
    console.error('NG  corpus/.veraPDF-corpus.sha is missing — run: node scripts/fetch-corpus.mjs');
    process.exit(1);
  }
  if (readFileSync(shaFile, 'utf8').trim() !== commit) {
    console.error(`NG  corpus is not at the pinned ${commit.slice(0, 12)} — run: node scripts/fetch-corpus.mjs`);
    process.exit(1);
  }
}

const target = surveyIndex !== -1 ? args[surveyIndex + 1] : 'corpus/pdf20examples';
const survey = surveyIndex !== -1;
if (survey) assertPinnedCorpus();

const dir = join(root, target);
const scratch = mkdtempSync(join(tmpdir(), 'normativepdf-rt-'));
const counts = { ok: 0, mismatch: 0, 'write-failed': 0, 'reparse-failed': 0, 'source-unreadable': 0, unreadable: 0, 'not-measurable': 0 };
const groups = new Map();
let qpdfChecked = 0;
let qpdfFailed = 0;
const qpdfFailures = [];

try {
  for await (const file of walkPdfs(dir)) {
    const rel = relative(dir, file);
    const source = new Uint8Array(await readFile(file));
    const result = await roundTrip(source);
    counts[result.outcome] += 1;

    if (result.outcome !== 'ok' && result.outcome !== 'unreadable') {
      const key = `${result.outcome}: ${normalize(result.reason)}`;
      const group = groups.get(key) ?? { count: 0, sample: result.reason, files: [] };
      group.count += 1;
      if (group.files.length < 3) group.files.push(rel);
      groups.set(key, group);
    }

    if (withQpdf && result.outcome === 'ok' && qpdfChecked < qpdfSample) {
      qpdfChecked += 1;
      const problem = qpdfRegression(source, result.written, scratch);
      if (problem) {
        qpdfFailed += 1;
        if (qpdfFailures.length < 5) qpdfFailures.push(`${rel} — ${problem}`);
      }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// The denominator is what the writer was actually asked to do: specimens
// whose objects could not all be read were never handed to it.
const attempted = counts.ok + counts.mismatch + counts['write-failed'] + counts['reparse-failed'];
console.log(`\nround-trip ${counts.ok}/${attempted} of the specimens this parser can read`);
console.log(
  `  file unreadable: ${counts.unreadable}   an object unreadable: ${counts['source-unreadable']}   not measurable (encrypted): ${counts['not-measurable']}`,
);

const sorted = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
for (const [key, group] of sorted) {
  console.log(`\n${String(group.count).padStart(4)}  ${key}`);
  console.log(`      e.g. ${group.sample}`);
  for (const f of group.files) console.log(`      - ${f}`);
}

let failed = false;

if (withQpdf) {
  console.log(`\nqpdf --check (source vs rewrite): ${qpdfChecked - qpdfFailed}/${qpdfChecked} introduced nothing new`);
  for (const f of qpdfFailures) console.log(`    ${f}`);
  if (qpdfFailed > 0) {
    console.log('NG  the rewrite introduced complaints the source did not have — ADR-0004 §2');
    failed = true;
  }
}

if (survey) {
  const baseline = lock.veraPDFCorpus.baselineRoundTrip;
  if (baseline === undefined) {
    console.log(`\n--  no baselineRoundTrip in corpus.lock.json yet; observed ${counts.ok}`);
  } else if (counts.ok < baseline) {
    console.log(`\nNG  ${counts.ok} round-tripped, below the recorded baseline ${baseline}`);
    failed = true;
  } else if (counts.ok > baseline) {
    console.log(
      `\nNG  ${counts.ok} round-tripped, ABOVE the recorded baseline ${baseline} — set "baselineRoundTrip": ${counts.ok} in corpus.lock.json in this same commit`,
    );
    failed = true;
  } else {
    console.log(`\nOK  ${counts.ok} round-tripped — matches the recorded baseline`);
  }
} else if (counts.ok !== attempted || attempted === 0) {
  console.log('\nNG  every pdf20examples specimen shall round-trip');
  failed = true;
} else {
  console.log(`\nOK  all ${attempted} specimens round-tripped`);
}

process.exit(failed ? 1 : 0);
