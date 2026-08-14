/**
 * Conformance declarations (DESIGN §3) — the declaration and its check are one
 * function, so most of these cases are refusals.
 *
 * The refusals are the product here. A test suite for this module that mostly
 * asserted "the XMP came out right" would be testing a string builder; what
 * matters is that the string is unreachable while a requirement is unmet.
 */

import { describe, expect, it } from 'vitest';
import type { CosDict, CosObject } from '../src/cos/types.js';
import { DeclarationRefused, declareConformance } from '../src/index.js';

const dict = (entries: Record<string, CosObject>): CosDict => ({
  kind: 'dict',
  entries: new Map(Object.entries(entries)),
});
const yes: CosObject = { kind: 'boolean', value: true };
const ref = (objectNumber: number): CosObject => ({
  kind: 'ref',
  objectNumber,
  generationNumber: 0,
});
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** A document that satisfies every PDF/UA-1 clause this module can check. */
const uaFacts = {
  title: 'Invoice for July 2026',
  lang: 'en',
  viewerPreferences: dict({ DisplayDocTitle: yes }),
  markInfo: dict({ Marked: yes }),
  structTreeRoot: ref(5),
};

const outputIntent = dict({
  S: { kind: 'name', value: 'GTS_PDFA1' },
  DestOutputProfile: ref(9),
});
/** …and the same for the PDF/A preconditions. */
const pdfaFacts = { outputIntents: [outputIntent], hasFileIdentifier: true, title: 'Invoice' };

const unmetIds = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DeclarationRefused) return error.unmet.map((u) => u.id).sort();
    throw error;
  }
  throw new Error('the declaration was written when it should have been refused');
};

describe('PDF/UA-1 — clauses this family can quote (ISO 14289-1)', () => {
  it('writes pdfuaid:part and dc:title when the clauses hold', () => {
    const xmp = decode(declareConformance('pdfua-1', uaFacts).xmp);
    expect(xmp).toContain('<pdfuaid:part>1</pdfuaid:part>');
    expect(xmp).toContain('<rdf:li xml:lang="x-default">Invoice for July 2026</rdf:li>');
  });

  it('supplies the catalog entries the clauses require (R-7.1-15 / R-7.2-5)', () => {
    const { catalogEntries } = declareConformance('pdfua-1', uaFacts);
    const viewerPreferences = catalogEntries.get('ViewerPreferences');
    expect(
      viewerPreferences?.kind === 'dict'
        ? viewerPreferences.entries.get('DisplayDocTitle')
        : undefined,
    ).toEqual(yes);
    const lang = catalogEntries.get('Lang');
    expect(lang?.kind === 'string' ? decode(lang.bytes) : null).toBe('en');
  });

  it('refuses a document with no title (R-7.1-12)', () => {
    expect(unmetIds(() => declareConformance('pdfua-1', { ...uaFacts, title: undefined }))).toEqual(
      ['R-7.1-12'],
    );
  });

  it('refuses a document without DisplayDocTitle (R-7.1-15)', () => {
    expect(
      unmetIds(() => declareConformance('pdfua-1', { ...uaFacts, viewerPreferences: undefined })),
    ).toEqual(['R-7.1-15']);
  });

  it('refuses a document whose /MarkInfo says Suspects true (R-7.1-18)', () => {
    expect(
      unmetIds(() =>
        declareConformance('pdfua-1', {
          ...uaFacts,
          markInfo: dict({ Marked: yes, Suspects: yes }),
        }),
      ),
    ).toEqual(['R-7.1-18']);
  });

  it('refuses a document with no structure tree (R-7.1-1)', () => {
    expect(
      unmetIds(() => declareConformance('pdfua-1', { ...uaFacts, structTreeRoot: undefined })),
    ).toEqual(['R-7.1-1']);
  });

  it('reports every unmet requirement at once, not the first', () => {
    // A caller fixing them one error at a time would rebuild the document once
    // per requirement.
    expect(unmetIds(() => declareConformance('pdfua-1', {}))).toEqual([
      'R-7.1-1',
      'R-7.1-12',
      'R-7.1-15',
      'R-7.2-5',
    ]);
  });
});

describe('PDF/A — outside the corpus, so preconditions rather than clauses', () => {
  it('writes the identification schema for each level', () => {
    expect(decode(declareConformance('pdfa-3b', pdfaFacts).xmp)).toContain(
      '<pdfaid:conformance>B</pdfaid:conformance>',
    );
    const f = decode(
      declareConformance('pdfa-4f', {
        ...pdfaFacts,
        embeddedFiles: [dict({ AFRelationship: { kind: 'name', value: 'Data' } })],
      }).xmp,
    );
    expect(f).toContain('<pdfaid:part>4</pdfaid:part>');
    expect(f).toContain('<pdfaid:conformance>F</pdfaid:conformance>');
    expect(f).toContain('<pdfaid:rev>2020</pdfaid:rev>');
  });

  it('names its checks PRE-* so none of them reads as a clause number', () => {
    const { evidence } = declareConformance('pdfa-3b', pdfaFacts);
    expect(evidence.checked.every((id) => id.startsWith('PRE-'))).toBe(true);
    expect(evidence.decidedBy).toMatch(/outside/);
  });

  it('refuses without an output intent that has a destination profile', () => {
    expect(
      unmetIds(() => declareConformance('pdfa-3b', { ...pdfaFacts, outputIntents: [] })),
    ).toEqual(['PRE-OUTPUTINTENT']);
  });

  it('refuses an encrypted document and one with no file identifier', () => {
    expect(
      unmetIds(() => declareConformance('pdfa-3b', { ...pdfaFacts, encrypted: true })),
    ).toEqual(['PRE-NOENCRYPT']);
    expect(
      unmetIds(() => declareConformance('pdfa-3b', { ...pdfaFacts, hasFileIdentifier: false })),
    ).toEqual(['PRE-FILEID']);
  });

  it('refuses an attachment that does not say how it relates to the document', () => {
    expect(
      unmetIds(() =>
        declareConformance('pdfa-3b', {
          ...pdfaFacts,
          embeddedFiles: [dict({ F: { kind: 'null' } })],
        }),
      ),
    ).toEqual(['PRE-AFRELATIONSHIP']);
  });

  it('refuses /Info under PDF/A-4', () => {
    expect(
      unmetIds(() =>
        declareConformance('pdfa-4', { ...pdfaFacts, info: dict({ Title: { kind: 'null' } }) }),
      ),
    ).toEqual(['PRE-NOINFO']);
  });

  it('refuses plain PDF/A-4 for a document that carries attachments, and names -4f', () => {
    // Measured, not hypothetical: the UC oracle's `conformance-attach-pdfa4-bare`
    // is exactly this document, and veraPDF fails it 108/109 on
    // ISO 19005-4:2020 6.9-3. Here the claim is refused before it is written.
    let message = '';
    try {
      declareConformance('pdfa-4', {
        ...pdfaFacts,
        embeddedFiles: [dict({ AFRelationship: { kind: 'name', value: 'Data' } })],
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('PRE-NOATTACHMENTS');
  });
});

describe('what every result carries', () => {
  it('lists what was not checked, for every level', () => {
    for (const level of ['pdfua-1', 'pdfa-3b', 'pdfa-4', 'pdfa-4f'] as const) {
      const facts =
        level === 'pdfua-1'
          ? uaFacts
          : level === 'pdfa-4f'
            ? {
                ...pdfaFacts,
                embeddedFiles: [dict({ AFRelationship: { kind: 'name', value: 'D' } })],
              }
            : pdfaFacts;
      const { evidence } = declareConformance(level, facts);
      // A declaration whose unchecked list is empty does not exist: font
      // embedding alone is invisible from the document skeleton.
      expect(evidence.unchecked.length).toBeGreaterThan(0);
      expect(evidence.decidedBy).toMatch(/veraPDF/);
    }
  });
});

describe('the XMP itself', () => {
  it('is deterministic for the same input (DESIGN §4.1)', () => {
    const once = decode(
      declareConformance('pdfa-3b', { ...pdfaFacts, createDate: '2026-08-14T00:00:00Z' }).xmp,
    );
    const twice = decode(
      declareConformance('pdfa-3b', { ...pdfaFacts, createDate: '2026-08-14T00:00:00Z' }).xmp,
    );
    expect(once).toBe(twice);
  });

  it('carries no date when the caller supplies none — it does not read the clock', () => {
    expect(decode(declareConformance('pdfa-3b', pdfaFacts).xmp)).not.toContain('CreateDate');
  });

  it('escapes XML metacharacters in the title', () => {
    const xmp = decode(declareConformance('pdfua-1', { ...uaFacts, title: 'a & b <c>' }).xmp);
    expect(xmp).toContain('a &amp; b &lt;c&gt;');
  });
});
