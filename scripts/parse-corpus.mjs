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
 *       2884/2907, all 23 failures are fail specimens (20 broken §6.1
 *       file structures, 2 encrypted, 1 Isartor broken xref entry).
 *
 * (requires `npm run build` first)
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parsePdf } from '../dist/index.js';

const root = join(import.meta.dirname, '..');

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
  if (passSpecimenFailures.length > 0) {
    console.log(`\nNG  ${passSpecimenFailures.length} pass specimen(s) failed to parse — this is the gate:`);
    for (const f of passSpecimenFailures) {
      console.log(`    ${f}`);
    }
    process.exit(1);
  }
  console.log('\nOK  every pass specimen parsed');
  process.exit(0);
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
