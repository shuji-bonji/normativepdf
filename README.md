# normativepdf

> **A clause-driven PDF library in pure TypeScript.** Every behaviour is tied to a clause of the ISO specifications; what cannot be tied is not claimed.
>
> 🚧 **Early development.** Stage 0 (COS object model + parser) and stage 1 (serializer + incremental updates) are implemented and measured against public corpora.
>
> 日本語版: [README.ja.md](README.ja.md)

---

## What this aims to be

**A TypeScript PDF toolchain that proves, release by release, that its output passes veraPDF.**

The goal is a general-purpose, pure-TypeScript PDF library. It does not claim to be
"the pdf-lib successor" — that seat is taken. The empty seat in the JS/TS ecosystem is
not *"can build PDFs"* but ***"is measured"***: no JS/TS library today demonstrates,
release by release, that its output passes an independent validator. This library is
built to sit there ([docs/PUBLISHING.md](docs/PUBLISHING.md)).

Its first consumer is the PDF family of MCP servers
([pdf-spec-mcp](https://github.com/shuji-bonji/pdf-agent-stack) / pdf-reader-mcp /
pdf-writer-mcp / pdf-verify-mcp), whose writer currently delegates to `pdf-lib` — with
the result that clause violations can be *identified* but not *fixed*
([docs/PRIOR-ART.md](docs/PRIOR-ART.md)). The family is the first user, not the target.

## Current state (stage 1, 2026-08-13)

| Gate | Result |
|---|---|
| [pdf20examples](https://github.com/pdf-association/pdf20examples) (CC BY-SA 4.0) | **7/7 parsed** end-to-end (every in-use/compressed object resolved, catalog included) |
| [veraPDF-corpus](https://github.com/veraPDF/veraPDF-corpus) (CC BY 4.0, 2907 specimens, Isartor included) | **99.1% parsed; every *pass* specimen parses.** The 26 failures are all intentionally broken *fail* specimens, rejected with the violated clause named |
| Round-trip (read → write → read), all three output forms | **2879/2879** with an equal object graph — classic table, cross-reference stream, and object streams |
| `qpdf --check`, source vs rewrite | **2879/2879 introduce no complaint the source did not already have**, in all three forms |
| Incremental update on a signed specimen | **Both signatures stay VALID** (CAdES + document timestamp), whichever cross-reference form is appended |

The corpus is pinned by commit ([`corpus.lock.json`](corpus.lock.json)) so that a
rate is a claim about this code and not about whichever specimens upstream shipped
that week. Both figures are gates in CI, and a rate *above* the recorded baseline
fails too — a floor left behind an improvement stops catching the slide back to it.

Implemented — reading: COS object model (10-type discriminated union), lexer, object
parser, file-structure parser (classic xref, trailer, `Prev` chain, incremental
updates), cross-reference streams, object streams, FlateDecode + PNG/TIFF predictors,
catalog `/Version` upgrade (Table 29).

Implemented — writing: object and file serializers, classic cross-reference tables,
cross-reference streams (§7.5.8), object streams (§7.5.7), and incremental updates
(§7.5.6) that leave the original bytes untouched. Output is deterministic and
uncompressed; `CompressionStream` is declined because its bytes are not stable across
engines ([ADR-0003](docs/adr/0003-filter-strategy.md)).

Every error message cites the clause it enforces.

Recovery parsing is demand-driven: leniency is added only when a specimen that an
independent validator accepts fails to parse — each relaxation records the specimen
that forced it.

## Scope

| Target | Status |
|---|---|
| **ISO 32000-1:2008** (PDF 1.7) | ✅ in scope |
| **ISO 32000-2:2020** (PDF 2.0) + Errata Collection 3 | ✅ in scope |
| **ISO 14289-1 / -2** (PDF/UA-1 / UA-2) | ✅ in scope |
| **ISO/TS 32001–32005** | ✅ in scope (UA-2 treats TS 32005 as a hard requirement) |
| **ISO 19005-1–4** (PDF/A) | ⏸ **on hold** |

### Why PDF/A is on hold

**Because we do not hold the normative text.** ISO 19005 is a paid standard.
Claiming "PDF/A support" without the text degenerates into validator-driven
development — tuning the implementation to veraPDF's output instead of the standard.

Claiming and passing are different things, though: most PDF/A requirements are
functional restrictions of ISO 32000 (embedded fonts, no encryption, OutputIntent,
transparency limits), so an implementation strict about 32000-1/-2 covers most of the
ground. This library aims to *pass* veraPDF without *claiming* ISO 19005 conformance,
until the standard is acquired. What may and may not be claimed is fixed in
[docs/PUBLISHING.md](docs/PUBLISHING.md).

## Design principles

1. **The battleground is the structure layer.** XMP, structure tree, tags, font
   dictionaries, object syntax. Text shaping (GSUB/GPOS, BiDi, complex scripts) is a
   different swamp and is not fought here.
2. **Tagged PDF is a first-class citizen**, not an afterthought — the layer where
   `pdf-lib` struggles most.
3. **Claims never drift from reality.** Code that writes a conformance declaration is
   closed over the same function that checks the requirements; if it cannot check, it
   does not write ([docs/GUARDS.md](docs/GUARDS.md)).
4. **PDF 2.0 is the foundation.** ISO 14289-2 §6.2 requires ISO 32000-2 + TS 32005, so
   a PDF 1.7-based implementation cannot reach PDF/UA-2 even in principle.
5. **Deterministic output.** No hidden clock or randomness; `/ID`, dates, and
   signatures are injected explicitly.

## Development loop

The validator was finished before the implementation was started — test-driven
development at its largest scale:

```
pdf-spec-mcp    the clause (what is correct) — consulted before every decision
      ↓
  implement
      ↓
  read back     independent implementations (qpdf --check / poppler / veraPDF)
      ↓
pdf-verify-mcp  mechanical scoring via veraPDF
      ↓
  back to the clause, close the gap
```

The loop's invariants are fixed as G-1–G-6 in [docs/GUARDS.md](docs/GUARDS.md):
never read exit 0 as success, always pair a declaration with its verification, score
conversions by diffing input against output. All of them came from measurements.

## Language

**TypeScript** (decided 2026-08-08; reviewability was the deciding factor).
See [docs/adr/0001-language-choice.md](docs/adr/0001-language-choice.md).

## Intended consumers

- `pdf-writer-mcp` — replacing its `pdf-lib` dependency
- a PDF editor PWA
- [e-shiwake](https://github.com/shuji-bonji) — invoice issuing (digital signatures,
  PDF/A-3 attachments for Japanese e-bookkeeping law)

## License

[MIT](LICENSE)
