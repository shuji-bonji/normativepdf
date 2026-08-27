#!/usr/bin/env node
/**
 * §7.9 text-string differential oracle — pdf-lib as the second implementation.
 *
 * The same shape as the inflate oracle (ADR-0003 decision 5): a second
 * implementation answers the same inputs, and every disagreement is attributed
 * before it is accepted. Taken while pdf-lib is still in the family; track B of
 * pdf-agent-stack#21 removes it, so this is the last chance to compare with it.
 *
 * pdf-lib is NOT a dependency of this package. Install it for the run and take it
 * out afterwards:
 *
 *   npm i -D pdf-lib@^1.17.1 && npm run build
 *   node scripts/text-oracle.mjs corpus
 *   npm remove pdf-lib
 *
 * What it compares, per corpus file:
 *   - every string under a key that carries a text string — `decodeTextString`
 *     against pdf-lib's `decodeText()`
 *   - every /CreationDate and /ModDate — `parsePdfDate` against the regular
 *     expression `@shuji-bonji/pdf-constraints` uses today, copied in below
 *
 * A count of agreements is not enough on its own: two implementations that both
 * return null agree without measuring anything. The report therefore also counts
 * how many dates each side actually read.
 *
 * Baseline 2026-08-27 (veraPDF-corpus + pdf20examples, 2,917 files):
 *   text strings 2,612 — 2,606 identical, 6 differ, all six the UTF-8 byte order
 *   mark (R-7.9.2.2.1-4) that pdf-lib 1.x does not handle.
 *   dates 941 — 938 read by both and equal, 3 read by neither. Two of those three
 *   are dates behind a UTF-8 byte order mark, which this package reads once the
 *   string has been through `decodeTextString`: 938 -> 940.
 *
 * (requires `npm run build` first)
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, PDFDict, PDFArray, PDFString, PDFHexString } from 'pdf-lib';
import { decodeTextString, parsePdfDate } from '../dist/index.js';

/** pdf-constraints/src/evaluate.ts の現行実装（比較用にそのまま写す）。 */
function parsePdfDateConstraints(value) {
  if (typeof value !== 'string') return null;
  const m =
    /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:([Z+-])(?:(\d{2})'?(\d{2})?'?)?)?$/.exec(value);
  if (!m) return null;
  const [, year, month = '01', day = '01', hour = '00', min = '00', sec = '00', sign, oh = '00', om = '00'] = m;
  const mo = Number(month), d = Number(day), h = Number(hour), mi = Number(min), s = Number(sec);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const offsetMinutes = sign === '+' || sign === '-' ? (Number(oh) * 60 + Number(om)) * (sign === '-' ? -1 : 1) : 0;
  return Date.UTC(Number(year), mo - 1, d, h, mi, s) - offsetMinutes * 60_000;
}

/** テキスト文字列として読むべき辞書キー（§7.9.2.2.1 が例に挙げるもの + 実務のもの）。 */
const TEXT_KEYS = new Set([
  'Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer',
  'Alt', 'ActualText', 'Lang', 'E', 'TU', 'T', 'Contents', 'Name', 'Reason', 'Location', 'M',
  'CreationDate', 'ModDate',
]);
const DATE_KEYS = new Set(['CreationDate', 'ModDate', 'M']);

function walk(root) {
  const strings = [];   // { key, bytes }
  const seen = new Set();
  const stack = [root];
  let guard = 0;
  while (stack.length > 0 && guard < 200_000) {
    guard += 1;
    const node = stack.pop();
    if (node instanceof PDFDict) {
      if (seen.has(node)) continue;
      seen.add(node);
      for (const [name, value] of node.entries()) {
        const key = name.asString().slice(1);
        if ((value instanceof PDFString || value instanceof PDFHexString) && TEXT_KEYS.has(key)) {
          strings.push({ key, value });
        } else if (value instanceof PDFDict || value instanceof PDFArray) {
          stack.push(value);
        }
      }
    } else if (node instanceof PDFArray) {
      if (seen.has(node)) continue;
      seen.add(node);
      for (let i = 0; i < node.size(); i += 1) {
        const value = node.get(i);
        if (value instanceof PDFDict || value instanceof PDFArray) stack.push(value);
      }
    }
  }
  return strings;
}

function listPdfs(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.isDirectory()) out.push(...listPdfs(path));
    else if (entry.toLowerCase().endsWith('.pdf')) out.push(path);
  }
  return out;
}

const CORPUS = process.argv[2];
const LIMIT = Number(process.argv[3] ?? Infinity);
const files = listPdfs(CORPUS).slice(0, LIMIT);

const stat = {
  files: files.length, loaded: 0, unreadable: 0,
  strings: 0, same: 0, differ: 0,
  byCause: new Map(), samples: [],
  dates: 0, dateSame: 0, dateDiffer: 0, dateSamples: [],
  dateParsedMine: 0, dateParsedFromMineDecode: 0, dateParsedConstraints: 0, dateBothNull: 0, dateBothSameValue: 0, dateUnparsedSamples: [],
};

const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

for (const file of files) {
  let doc;
  try {
    doc = await PDFDocument.load(readFileSync(file), {
      ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false,
    });
  } catch { stat.unreadable += 1; continue; }
  stat.loaded += 1;
  let found;
  try { found = walk(doc.context.trailerInfo.Root ?? doc.catalog); } catch { found = []; }
  try {
    const info = doc.context.trailerInfo.Info;
    if (info instanceof PDFDict) found.push(...walk(info));
    else if (info) { const d = doc.context.lookup(info); if (d instanceof PDFDict) found.push(...walk(d)); }
  } catch { /* Info が読めない検体は本文だけで測る */ }

  for (const { key, value } of found) {
    let raw, mine, theirs;
    try { raw = value.asBytes(); } catch { continue; }
    try { theirs = value.decodeText(); } catch { bump(stat.byCause, 'pdf-lib が投げる'); continue; }
    try { mine = decodeTextString(raw); } catch { bump(stat.byCause, 'normativepdf が投げる'); continue; }
    stat.strings += 1;
    if (mine === theirs) stat.same += 1;
    else {
      stat.differ += 1;
      const cause =
        raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf ? 'UTF-8 BOM（R-7.9.2.2.1-4・pdf-lib 1.x は扱わない）'
        : raw[0] === 0xfe && raw[1] === 0xff ? 'UTF-16BE'
        : mine.includes('') || theirs.includes('') ? '言語エスケープ'
        : 'その他';
      bump(stat.byCause, cause);
      if (stat.samples.length < 12) {
        stat.samples.push({ file: file.slice(CORPUS.length + 1), key, cause,
          mine: mine.slice(0, 60), theirs: theirs.slice(0, 60) });
      }
    }
    if (DATE_KEYS.has(key)) {
      // pdf-lib の decodeText() は UTF-8 BOM を剥がさない。日付の読み比べは
      // その文字列で行い、normativepdf の decode を通した場合との差も数える。
      const text = theirs;
      if (parsePdfDate(mine) !== null) stat.dateParsedFromMineDecode += 1;
      const a = parsePdfDate(text); const b = parsePdfDateConstraints(text);
      stat.dates += 1;
      if (a !== null) stat.dateParsedMine += 1;
      if (b !== null) stat.dateParsedConstraints += 1;
      if (a === null && b === null) stat.dateBothNull += 1;
      if (a !== null && b !== null && a.epochMs === b) stat.dateBothSameValue += 1;
      if ((a?.epochMs ?? null) === b) stat.dateSame += 1;
      else {
        stat.dateDiffer += 1;
        if (stat.dateSamples.length < 12) {
          stat.dateSamples.push({ text, mine: a?.epochMs ?? null, constraints: b });
        }
      }
      if (a === null && stat.dateUnparsedSamples.length < 12) {
        stat.dateUnparsedSamples.push(text.slice(0, 40));
      }
    }
  }
}

const report = {
  ...stat,
  byCause: Object.fromEntries(stat.byCause),
};
writeFileSync('oracle-report.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2).slice(0, 4000));
