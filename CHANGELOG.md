# Changelog

All notable changes to `normativepdf` are recorded here. The corpus pass
rate is the measurement; `corpus.lock.json` is its source of truth.

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
