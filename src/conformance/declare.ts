/**
 * Conformance declarations — the one place a document may say what it is.
 *
 * DESIGN §3 states the rule this module exists to enforce:
 *
 *     declareConformance(level) は requirements(level) を検査し
 *     満たさないなら宣言を書かずにエラーを返す
 *
 * Writing the metadata is not offered as an operation of its own. A separate
 * "write the XMP" function is how a file comes to claim PDF/A-2b with an
 * unembedded font — the failure mode this library was started to answer
 * (PRIOR-ART F-1), and the one pdf-writer-mcp still has to paper over with a
 * warning on every `ensure_pdfa` call.
 *
 * **How strongly each level can be checked here is not uniform, and the
 * difference is reported rather than hidden.**
 *
 *   PDF/UA-1 (ISO 14289-1) — in this family's corpus. The document-level
 *     requirements can be quoted and checked: R-7.1-12 (dc:title in the
 *     catalog's Metadata stream), R-7.1-15 (ViewerPreferences with
 *     DisplayDocTitle true), R-7.1-18 (Suspects false), R-7.2-5 (natural
 *     language declared).
 *
 *   PDF/A (ISO 19005) — **outside the corpus** (pdf-spec-mcp coverage.gaps).
 *     There is no normative text here to trace a check to, so what this module
 *     verifies for a `pdfa-*` level are *structural preconditions*: things that
 *     must be in place for the claim to be even arguable (an output intent with
 *     a destination profile, no encryption, a file identifier, associated-file
 *     relationships for -3, no document information dictionary for -4). Passing
 *     them is not conformance. **veraPDF decides**, and `evidence.decidedBy`
 *     says so in every result.
 *
 * And in both cases the result carries `unchecked`: the requirements this
 * module cannot see from the objects it is handed — font embedding, colour
 * spaces, transparency, glyph coverage, reading order. A declaration whose
 * unchecked list is empty does not exist, so the list is never omitted.
 */

import type { CosDict, CosObject, CosRef } from '../cos/types.js';

export class DeclarationRefused extends Error {
  override readonly name = 'DeclarationRefused';
  constructor(
    readonly level: ConformanceLevel,
    readonly unmet: readonly UnmetRequirement[],
  ) {
    super(
      `${level} was not declared: ${unmet.length} requirement(s) unmet — ${unmet
        .map((u) => `${u.id} (${u.what})`)
        .join('; ')}`,
    );
  }
}

export interface UnmetRequirement {
  /** Clause id where one exists, or a `PRE-*` id for a structural precondition. */
  readonly id: string;
  readonly what: string;
  /** What the caller has to change. */
  readonly fix: string;
}

export type ConformanceLevel = 'pdfua-1' | 'pdfa-3b' | 'pdfa-4' | 'pdfa-4f';

/**
 * What the document is, as far as the caller has built it. Every field is a
 * fact the checks below key on; nothing is inferred.
 */
export interface DocumentFacts {
  /** Title. R-7.1-12 requires it in the XMP for PDF/UA-1. */
  readonly title?: string;
  /** Natural language, e.g. "en" or "ja" (R-7.2-5). */
  readonly lang?: string;
  /** `/ViewerPreferences` as built so far (R-7.1-15). */
  readonly viewerPreferences?: CosDict;
  /** `/MarkInfo` as built so far — `/Marked` and `/Suspects` (R-7.1-18). */
  readonly markInfo?: CosDict;
  /** Whether a structure tree exists (R-7.1-1 cannot be checked; its absence can). */
  readonly structTreeRoot?: CosRef;
  /** `/OutputIntents` entries as built so far. */
  readonly outputIntents?: readonly CosDict[];
  /** True when the document is encrypted. */
  readonly encrypted?: boolean;
  /** True when the trailer carries `/ID`. */
  readonly hasFileIdentifier?: boolean;
  /** Document information dictionary, if the caller intends to write one. */
  readonly info?: CosDict;
  /** Embedded file specifications, for the associated-file checks. */
  readonly embeddedFiles?: readonly CosDict[];
  /**
   * Creation / modification timestamps for the XMP. Supplied by the caller so
   * that the same document produces the same bytes (DESIGN §4.1); omitted, the
   * XMP simply carries no dates.
   */
  readonly createDate?: string;
  readonly modifyDate?: string;
}

export interface DeclarationEvidence {
  readonly level: ConformanceLevel;
  /** Requirement ids that were checked here and hold. */
  readonly checked: readonly string[];
  /**
   * What this module cannot see, and therefore did not check. Never empty:
   * no level's requirements are all visible from the document skeleton.
   */
  readonly unchecked: readonly string[];
  /**
   * Who is entitled to say the document conforms. Never this module.
   */
  readonly decidedBy: string;
}

export interface Declaration {
  /** The XMP packet for the catalog's `/Metadata` stream. */
  readonly xmp: Uint8Array;
  /**
   * Catalog entries the declaration itself requires, to merge into the
   * catalog. `/Metadata` is not among them: the caller owns object numbering
   * and has to write the stream.
   */
  readonly catalogEntries: ReadonlyMap<string, CosObject>;
  readonly evidence: DeclarationEvidence;
}

const bool = (object: CosObject | undefined): boolean | undefined =>
  object?.kind === 'boolean' ? object.value : undefined;
const nameOf = (object: CosObject | undefined): string | undefined =>
  object?.kind === 'name' ? object.value : undefined;

/**
 * Check the requirements for `level` and, only if they hold, produce the
 * declaration.
 *
 * @throws DeclarationRefused with every unmet requirement at once — a caller
 * fixing them one error at a time would rebuild the document once per
 * requirement.
 */
export function declareConformance(level: ConformanceLevel, facts: DocumentFacts): Declaration {
  const unmet: UnmetRequirement[] = [];
  const checked: string[] = [];

  const require = (holds: boolean, id: string, what: string, fix: string): void => {
    if (holds) checked.push(id);
    else unmet.push({ id, what, fix });
  };

  if (level === 'pdfua-1') {
    // ISO 14289-1 — quotable, so these are checks, not preconditions.
    require(typeof facts.title === 'string' &&
      facts.title.trim().length >
        0, 'R-7.1-12', "the catalog's Metadata stream shall contain a dc:title that clearly identifies the document", 'pass a non-empty title');
    require(bool(facts.viewerPreferences?.entries.get('DisplayDocTitle')) ===
      true, 'R-7.1-15', 'ViewerPreferences shall be present and shall contain DisplayDocTitle with a value of true', 'set /ViewerPreferences <</DisplayDocTitle true>> (this module adds it when absent)');
    require(bool(facts.markInfo?.entries.get('Suspects')) !==
      true, 'R-7.1-18', 'a file claiming ISO 14289-1 shall have a Suspects value of false', 'remove /Suspects true from /MarkInfo');
    require(bool(facts.markInfo?.entries.get('Marked')) === true &&
      facts.structTreeRoot !==
        undefined, 'R-7.1-1', 'all real content shall be tagged; a file with no structure tree cannot satisfy it', 'build the structure tree (StructTreeBuilder) and set /MarkInfo <</Marked true>>');
    require(typeof facts.lang === 'string' &&
      facts.lang.length >
        0, 'R-7.2-5', 'natural language shall be declared', 'pass lang (it is written to the catalog /Lang)');
  } else {
    // ISO 19005 is outside the corpus. These are preconditions, and they are
    // named PRE-* so that no reader mistakes them for clause numbers.
    require((facts.outputIntents ?? []).some(
      (intent) =>
        nameOf(intent.entries.get('S')) === 'GTS_PDFA1' &&
        intent.entries.get('DestOutputProfile') !== undefined,
    ), 'PRE-OUTPUTINTENT', 'a PDF/A output intent with a destination profile is present', 'add an /OutputIntents entry with /S /GTS_PDFA1 and an embedded /DestOutputProfile');
    require(facts.encrypted !==
      true, 'PRE-NOENCRYPT', 'the document is not encrypted', 'write the document without encryption');
    require(facts.hasFileIdentifier ===
      true, 'PRE-FILEID', 'the trailer carries a file identifier /ID', 'write /ID in the trailer (§14.4)');
    if (level === 'pdfa-4' || level === 'pdfa-4f') {
      require(facts.info === undefined ||
        facts.info.entries.size ===
          0, 'PRE-NOINFO', 'PDF/A-4 does not carry a document information dictionary', 'move the metadata into the XMP and omit /Info');
    }
    if (level === 'pdfa-3b' || level === 'pdfa-4f') {
      require((facts.embeddedFiles ?? []).every(
        (spec) => spec.entries.get('AFRelationship') !== undefined,
      ), 'PRE-AFRELATIONSHIP', 'every embedded file declares its relationship to the document', 'set /AFRelationship on each file specification and list it in the catalog /AF');
    }
    if (level === 'pdfa-4') {
      require((facts.embeddedFiles ?? []).length ===
        0, 'PRE-NOATTACHMENTS', 'plain PDF/A-4 carries no embedded files (they would each have to be PDF/A themselves)', 'declare pdfa-4f instead, which exists for documents that carry attachments');
    }
  }

  if (unmet.length > 0) throw new DeclarationRefused(level, unmet);

  const catalogEntries = new Map<string, CosObject>();
  if (level === 'pdfua-1') {
    // Supplying what the clause requires is part of declaring it.
    catalogEntries.set('ViewerPreferences', {
      kind: 'dict',
      entries: new Map([['DisplayDocTitle', { kind: 'boolean', value: true }]]),
    });
    if (facts.lang !== undefined) {
      catalogEntries.set('Lang', {
        kind: 'string',
        bytes: new TextEncoder().encode(facts.lang),
        form: 'literal',
      });
    }
  }

  return {
    xmp: buildXmp(level, facts),
    catalogEntries,
    evidence: {
      level,
      checked,
      unchecked: UNCHECKED[level],
      decidedBy:
        level === 'pdfua-1'
          ? 'veraPDF (flavour pdfua-1). This module checked the document-level clauses it can see; the rest of ISO 14289-1 is about content it never inspects.'
          : 'veraPDF (ISO 19005 is outside this family’s normative corpus). Passing the preconditions above is not conformance.',
    },
  };
}

/**
 * What no amount of looking at the document skeleton can settle. Kept as data
 * so that it appears in every result — a declaration that reported only what it
 * checked would read as a clean bill of health.
 */
const UNCHECKED: Readonly<Record<ConformanceLevel, readonly string[]>> = {
  'pdfua-1': [
    'R-7.1-3 semantically appropriate tags in a logical reading order',
    'R-7.1-5/-8 role map terminates at a standard type / standard tags not remapped',
    'R-7.2-3 character codes map to Unicode',
    'R-7.21.4.1 fonts are embedded (a tagged file with standard-14 fonts fails)',
  ],
  'pdfa-3b': [
    'font embedding and glyph coverage',
    'colour spaces and the output intent profile actually matching them',
    'transparency, JavaScript, and other forbidden constructs',
  ],
  'pdfa-4': [
    'font embedding and glyph coverage',
    'colour spaces and the output intent profile actually matching them',
    'PDF 2.0 constructs the profile forbids',
  ],
  'pdfa-4f': [
    'font embedding and glyph coverage',
    'colour spaces and the output intent profile actually matching them',
    'PDF 2.0 constructs the profile forbids',
  ],
};

const XML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};
const escapeXml = (value: string): string =>
  value.replace(/[&<>"]/g, (c) => XML_ESCAPES[c] as string);

/**
 * The XMP packet. Deterministic by construction: no generated identifiers, no
 * clock — dates come from the caller or are absent (DESIGN §4.1).
 */
function buildXmp(level: ConformanceLevel, facts: DocumentFacts): Uint8Array {
  const identification =
    level === 'pdfua-1'
      ? '      <rdf:Description rdf:about="" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">\n' +
        '        <pdfuaid:part>1</pdfuaid:part>\n' +
        '      </rdf:Description>\n'
      : '      <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">\n' +
        `        <pdfaid:part>${level === 'pdfa-3b' ? 3 : 4}</pdfaid:part>\n` +
        (level === 'pdfa-3b'
          ? '        <pdfaid:conformance>B</pdfaid:conformance>\n'
          : level === 'pdfa-4f'
            ? '        <pdfaid:conformance>F</pdfaid:conformance>\n'
            : '') +
        (level === 'pdfa-3b' ? '' : '        <pdfaid:rev>2020</pdfaid:rev>\n') +
        '      </rdf:Description>\n';

  const dublinCore =
    facts.title === undefined && facts.lang === undefined
      ? ''
      : '      <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">\n' +
        (facts.title === undefined
          ? ''
          : '        <dc:title>\n          <rdf:Alt>\n' +
            `            <rdf:li xml:lang="x-default">${escapeXml(facts.title)}</rdf:li>\n` +
            '          </rdf:Alt>\n        </dc:title>\n') +
        (facts.lang === undefined
          ? ''
          : `        <dc:language>\n          <rdf:Bag>\n            <rdf:li>${escapeXml(facts.lang)}</rdf:li>\n          </rdf:Bag>\n        </dc:language>\n`) +
        '      </rdf:Description>\n';

  const basic =
    facts.createDate === undefined && facts.modifyDate === undefined
      ? ''
      : '      <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">\n' +
        (facts.createDate === undefined
          ? ''
          : `        <xmp:CreateDate>${escapeXml(facts.createDate)}</xmp:CreateDate>\n`) +
        (facts.modifyDate === undefined
          ? ''
          : `        <xmp:ModifyDate>${escapeXml(facts.modifyDate)}</xmp:ModifyDate>\n`) +
        '      </rdf:Description>\n';

  const packet =
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
    '  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    identification +
    dublinCore +
    basic +
    '  </rdf:RDF>\n' +
    '</x:xmpmeta>\n' +
    '<?xpacket end="w"?>\n';
  return new TextEncoder().encode(packet);
}
