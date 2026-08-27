# Changelog

All notable changes to `normativepdf` are recorded here. The corpus pass
rate is the measurement; `corpus.lock.json` is its source of truth.

## [0.9.0] — 2026-08-27

The §7.9 text-string layer: decoding a string object into readable text, and
reading and writing dates. The requirement came from consumers — four of them
were implementing the same thing four different ways.

### Added — text strings (§7.9.2)

- `decodeTextString(bytes)` reads a text string in any of the three encodings
  R-7.9.2.2.1-2 allows, told apart by what the bytes begin with: `FE FF` for
  UTF-16BE (R-7.9.2.2.1-3), `EF BB BF` for UTF-8 (R-7.9.2.2.1-4, PDF 2.0), and
  PDFDocEncoding otherwise. Supplementary characters survive
  (R-7.9.2.2.1-5).
- `encodeTextString(text)` writes PDFDocEncoding when every character has a
  code point in Table D.3, and UTF-16BE with a byte order mark otherwise. The
  caller does not choose: choosing leaves a path where a string is written in
  an encoding that cannot hold it. A string whose PDFDocEncoded bytes would
  begin `FE FF` or `EF BB BF` also goes to UTF-16BE, because it would be read
  back as a different encoding (NOTE 3 and NOTE 4 of §7.9.2.2.1).
- `stripLanguageEscape(text)` removes language escape sequences (§7.9.2.2.2).
  The clause says they may appear *anywhere* in a Unicode text string, so this
  is not limited to the start. It is not applied to PDFDocEncoded strings:
  PDFDocEncoding has no ESCAPE — byte 0x1B is U+02D9 DOT ABOVE — so the
  sequence cannot be written in one, and removing it there would delete text.
- `pdfDocDecode` / `pdfDocEncode` / `UNDEFINED_CODES` / `TABLE_D3_DEFECTS`
  (§7.9.2.3, Annex D.3). The table is transcribed from Table D.3, not from
  another library: 232 defined code points and 24 undefined ones.

### Added — dates (§7.9.4)

- `parsePdfDate(value)` returns the fields (`PdfDate`) or `null`. Every rule
  the clause states is enforced: the `D:` prefix and the year are required and
  every later field needs its predecessors (R-7.9.4-12); the APOSTROPHE needs
  the hour offset (R-7.9.4-14) and the minute offset needs the APOSTROPHE
  (R-7.9.4-15); MM and DD default to 01 and the rest to zero (R-7.9.4-16); no
  UT information means GMT (R-7.9.4-17). The terminating APOSTROPHE of PDF 1.7
  and earlier is accepted (NOTE 2 of §7.9.4).
- `formatPdfDate(when)` writes the ISO 32000-2 form in UT, **without** a
  terminating APOSTROPHE. That character belongs to PDF 1.7 and earlier; NOTE 2
  recommends accepting it on input, not writing it.

### Measured

- **Differential oracle against pdf-lib** (`scripts/text-oracle.mjs`; pdf-lib is
  not a dependency — install it for the run). Over the corpus, 2,916 of 2,917
  files read: **2,606 of 2,612 text strings are byte-identical**. All six
  differences are the UTF-8 byte order mark, which pdf-lib 1.x does not handle;
  the clause is right, so the difference is recorded as an improvement.
  **938 of 941 dates are read alike** (against the regular expression
  `@shuji-bonji/pdf-constraints` uses today), and three are read by neither —
  two of those are dates behind a UTF-8 byte order mark, which this library
  reads once the string has been decoded (938 → 940), and one is written in
  ISO 8601, which is not the form §7.9.4 defines.
- **T-3, seven ways, all of them turn tests red**: removing the UTF-16BE mark
  check (10 tests), removing the UTF-8 mark check (4), not removing language
  escapes (7), folding a supplementary character into one code unit (2), not
  avoiding a PDFDocEncoding that collides with a mark (1), making the date
  APOSTROPHE optional (1), and allowing undefined code points to be written (1).
- Round trip over four axes plus all 232 defined bytes. The language-escape axis
  is deliberately not the identity: decoding removes the sequence.

### Note — Table D.3 contradicts itself in three rows

Recorded in `TABLE_D3_DEFECTS`. All three are rows the Notes column marks `U`
(undefined in PDFDocEncoding), so no conforming string reaches them:

- 0x16 — the Unicode column says U+0017 while the name says "(SYNCRONOUS
  IDLE)", which is U+0016; 0x16 and 0x17 are given the same code point.
  pdf-lib 1.x has the same defect, transcribed from the same table.
- 0x04 — named "(END OF TEXT)", which is 0x03.
- 0x38 — named "DIGIT EIGJT".

The Unicode column is followed, since that is the column a decoder reads.
Separately, the glyph names in NOTE 4 of §7.9.2.2.1 do not match the code
points of Table D.3: the first of "dieresis, guillemotright, questiondown" is
U+00A8, which is byte 0xA8, not the byte 0xEF the note is about.

### Gates

Unchanged: 2886/2907 parsed, 2881 round-tripped, `qpdf --check` 2881/2881
introducing nothing new, inflate differential oracle byte-identical over 1,395
and 1,386 comparisons.

## [0.8.0] — 2026-08-24

Phase 4 (encryption, ADR-0008) — read and write sides of the standard
security handler.

### Added — reading (§7.6)

- Standard security handler decryption: RC4 (V 1/2, R 2–4), AES-128-CBC
  (AESV2, V 4), AES-256-CBC (AESV3, V 5/R 6), and AES-GCM (AESV4, V 6/R 7 —
  ISO/TS 32003). Key derivation Algorithms 2, 2.A, 2.B; user and owner
  password authentication (Algorithms 6/7, 11/12); the R 6 Perms "adb"
  check. Crypto primitives (MD5, RC4, SHA-256/384/512, AES-CBC/ECB,
  AES-GCM) are pure TS with clause/RFC anchors; the tests replay every one
  through node:crypto (RC4 through RFC 6229 vectors) as a differential
  oracle.
- `parsePdf(bytes, { password })` decrypts strings and streams on
  materialisation, applying the §7.6.2 exceptions (trailer /ID, the
  encryption dictionary, signature /Contents under /ByteRange, and — for
  cross-reference streams — the whole object). `PdfDocument.encryption`
  exposes the observed facts.
- An encrypted document without a decryptor now refuses `getObject` by
  name (ADR-0008 decision 3): ciphertext is never returned wearing a
  plaintext face. Two corpus specimens used to do exactly that.

### Added — writing (§7.6, ISO/TS 32003)

- `encryptPdf(objects, trailer, options)` writes a standard-security-handler
  PDF at revision 6 (AES-256-CBC, AESV3) or revision 7 (AES-GCM, AESV4 —
  ISO/TS 32003). Encryption-dictionary derivation Algorithms 8/9/10; the
  file key is used directly (no per-object key for R 6/7). AES-GCM is pure
  TS (CTR + GHASH); the random source is `globalThis.crypto.getRandomValues`
  by default and injectable for reproducible tests.

### Measurements

- Corpus parse gate **2884 → 2886/2907** (the two AES-GCM/AES-256 specimens
  that were named errors are now read decrypted); every *pass* specimen
  parses; round-trip **2881/2881** unchanged (encrypted specimens stay
  not-measurable — write-side encryption is not a round trip). Inflate
  differential oracle 1,395 comparisons, all byte-identical.
- Write-side acceptance is two-sided: an AESV3 document is decrypted whole
  by qpdf 11.9.0 (`--decrypt`; `--check` clean); an AESV4 document is
  decrypted per object by node:crypto (qpdf 11.9.0 refuses R 7/V 6).

### Deferred

- ISO/TS 32004 (MAC / integrity protection) — a CMS/ASN.1 layer with no
  independent verifier available (qpdf and veraPDF do not implement it) and
  no demand. It will be built requirement-driven (ADR-0008 decision 4).

## [0.7.0] — 2026-08-22

- Own-implementation inflate (RFC 1950/1951, pure TS); the interim native
  path becomes a differential oracle (ADR-0003). Phases 0–3 implementation
  items closed. First Trusted Publisher release (npm OIDC) with provenance.
