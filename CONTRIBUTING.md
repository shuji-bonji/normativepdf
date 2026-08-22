# Contributing to normativepdf

normativepdf is a clause-driven PDF library: every behaviour is tied to a
clause of ISO 32000 (or an RFC, for the filter layer), and what cannot be
tied is not claimed. Contributions are welcome — including in areas the
roadmap marks "not built (for now)", such as rendering and text extraction —
as long as they follow the same discipline. This document states that
discipline up front so a contribution is never rejected for a rule it could
not have known.

日本語版: [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md)

## The three acceptance rules

Every change is judged against three rules. They are the same rules the
existing code follows; the canonical statements live in
[docs/DESIGN.md](docs/DESIGN.md) and [docs/GUARDS.md](docs/GUARDS.md).

**1. Tied to a clause.** New behaviour cites the clause it implements — an
ISO 32000-2 subclause, a named requirement id, or an RFC section — in a
comment at the point of implementation. If you cannot find a clause, say so
in the PR instead of guessing one; "I could not find normative text for
this" is an acceptable statement, an invented clause number is not.
Behaviour that no normative document constrains belongs in a consumer
(an MCP server), not in this library.

**2. Measured.** A claim that is only checked when somebody remembers to
check is not a gate. New behaviour comes with tests that fail when the
behaviour is removed (GUARDS T-3 — verify this by actually reverting your
change once), and the corpus gates must hold: `npm run corpus:survey` and
`npm run roundtrip:survey` against the pinned 2,907-specimen corpus. The
recorded baselines in `corpus.lock.json` are two-sided — a run below the
baseline is a regression, and a run **above** it means the lock has stopped
protecting the floor and must be raised in its own commit.

**3. The pin moves alone.** Never change `corpus.lock.json` and `src/` in
the same commit — a bumped baseline can hide a regression the old baseline
would have caught. CI enforces this per commit (the `pin-guard` job).

## Practical workflow

```bash
npm ci
node scripts/fetch-corpus.mjs   # corpus/ is gitignored; ~136 MB, pinned by commit
npm run typecheck && npm test && npm run check
npm run corpus:survey           # 2,907 specimens, parse
npm run roundtrip:survey        # read → write → read, plus qpdf as the independent face
```

qpdf is required for the round-trip survey (`apt-get install qpdf` /
`brew install qpdf`). TypeScript is strict (`docs/adr/0002-type-strictness.md`):
no `any`, `noUncheckedIndexedAccess` is on, and escapes need a comment.

Verification is external by design (DESIGN §4.2): this library ships no
validator of its own. Independent read-back (qpdf, veraPDF, poppler) is the
oracle, and `exit 0` is not read as success (GUARDS G-1).

## Areas open to contribution

The roadmap (docs/ROADMAP.md) marks rendering, text extraction and similar
areas as "not built (for now)". That is a statement about the maintainer's
time, not about the library's boundaries: a contribution in those areas is
welcome under the same three rules. Before building something large, open an
issue first so the clause basis and the measurement plan can be agreed on —
that conversation is cheap, a rejected 3,000-line PR is not.

What stays out regardless: behaviour that cannot cite normative text,
self-validation (DESIGN §4.2), and non-deterministic output — no clocks, no
randomness; `/ID` and dates are injected by the caller (DESIGN §4.1).

## Commit and release notes

Commit messages state what changed and why, in the imperative. Releases are
tag-driven and pass through the same gates in CI (`publish.yml` runs both
corpus surveys, with the pure-vs-native inflate differential oracle on,
before `npm publish`); a release that lowers the pass rate does not happen.
