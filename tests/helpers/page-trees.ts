/**
 * Page-tree fixtures for the document model (§7.7.3).
 *
 * **Why these exist.** veraPDF-corpus cannot measure most of what the document
 * model does. Measured over its 2,889 readable specimens (2026-08-14): the
 * whole corpus holds **11** intermediate page-tree nodes at a maximum depth of
 * **3** across 12,932 pages, so 99% of it is a flat root-to-pages tree; only
 * **11** pages inherit anything; and `/Count` mismatches, duplicate references
 * and non-indirect `/Parent` entries occur **zero** times. A corpus can show
 * that a change did not lower the bar. It cannot show that a newly written
 * check ever ran.
 *
 * **Why they are hand-written source rather than frozen bytes.** A reviewer
 * has to be able to see that `bad-count-high` says `/Count 5` over three
 * pages. Frozen bytes hide the very thing the fixture is for. (`uc-oracle`
 * froze its AcroForm input because the tool that produced it was being
 * deleted; nothing here disappears.)
 *
 * **Why a fixture is not merely "correct".** A fixture measures nothing unless
 * a plausible wrong implementation answers differently from a right one. Four
 * of these carry that difference deliberately; each says so in `carries`.
 */

import { buildPdf, obj } from './build-pdf.js';

export interface Fixture {
  readonly id: string;
  /** What was varied, so coverage can be counted rather than assumed. */
  readonly axes: Readonly<Record<string, string | number | boolean>>;
  /** What this fixture is for, in one line. */
  readonly why: string;
  /**
   * The difference this fixture carries: what a plausible wrong
   * implementation answers, against what the specification requires.
   * Absent when the fixture only has to be read without incident.
   */
  readonly carries?: { readonly wrong: string; readonly right: string };
  readonly bytes: Uint8Array;
}

export interface InvalidFixture extends Omit<Fixture, 'carries'> {
  /** The requirement the tree breaks. Saving it shall name this clause. */
  readonly violates: string;
  /**
   * Whether `parsePdf` accepts it. A fixture the parser rejects never reaches
   * the writing rule it was built for — it would pass the suite while
   * measuring nothing. Verified for every fixture here (2026-08-14).
   */
  readonly parses: true;
}

const CATALOG = obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
const MEDIA = '/MediaBox [0 0 612 792]';
/** A page with nothing but the entries §7.7.3.3 requires of it. */
const page = (n: number, parent: number, extra = '', generation = 0) =>
  obj(n, `<< /Type /Page /Parent ${parent} 0 R ${MEDIA} /Resources << >> ${extra}>>`, generation);
const node = (n: number, body: string) => obj(n, `<< /Type /Pages ${body} >>`);
/** A content stream, for the fixtures that need `/Contents` to point somewhere. */
const content = (n: number, ops: string) =>
  obj(n, `<< /Length ${ops.length} >> stream\n${ops}\nendstream`);

// ---------------------------------------------------------------- shape

const flat1 = buildPdf([CATALOG, node(2, '/Kids [3 0 R] /Count 1'), page(3, 2)]);

const flat3 = buildPdf([
  CATALOG,
  node(2, '/Kids [3 0 R 4 0 R 5 0 R] /Count 3'),
  page(3, 2),
  page(4, 2),
  page(5, 2),
]);

const balanced = buildPdf([
  CATALOG,
  node(2, '/Kids [6 0 R 7 0 R] /Count 4'),
  node(6, '/Parent 2 0 R /Kids [3 0 R 4 0 R] /Count 2'),
  node(7, '/Parent 2 0 R /Kids [5 0 R 8 0 R] /Count 2'),
  page(3, 6),
  page(4, 6),
  page(5, 7),
  page(8, 7),
]);

/**
 * The `/Count` fixture. In a flat tree `Kids.length` and the descendant page
 * count are the same number, so an implementation that returns the former is
 * indistinguishable from one that obeys R-7.7.3.2-8. Here the root holds one
 * intermediate node and one page, and the two answers separate: 2 against 3.
 * The mixed `Kids` array also exercises "children shall only be page objects
 * or other page tree nodes" (R-7.7.3.2-7) with both kinds present at once.
 */
const unbalanced = buildPdf([
  CATALOG,
  node(2, '/Kids [6 0 R 5 0 R] /Count 3'),
  node(6, '/Parent 2 0 R /Kids [3 0 R 4 0 R] /Count 2'),
  page(3, 6),
  page(4, 6),
  page(5, 2),
]);

/** Deeper than anything in the corpus (whose maximum depth is 3). */
const deep = buildPdf([
  CATALOG,
  node(2, '/Kids [6 0 R] /Count 1'),
  node(6, '/Parent 2 0 R /Kids [7 0 R] /Count 1'),
  node(7, '/Parent 6 0 R /Kids [8 0 R] /Count 1'),
  node(8, '/Parent 7 0 R /Kids [3 0 R] /Count 1'),
  page(3, 8),
]);

/**
 * A page whose generation is not 0. The corpus holds twelve such objects
 * across two specimens, none of them in a page tree — so an overlay keyed by
 * object number alone reads `3 4 R` back as `3 0 R` and never notices.
 */
const genNonZero = buildPdf([CATALOG, node(2, '/Kids [3 4 R] /Count 1'), page(3, 2, '', 4)]);

// ---------------------------------------------------------------- inheritance

const inheritFromParent = buildPdf([
  CATALOG,
  node(2, '/Kids [6 0 R] /Count 1'),
  node(6, `/Parent 2 0 R /Kids [3 0 R] /Count 1 ${MEDIA} /Resources << >>`),
  obj(3, '<< /Type /Page /Parent 6 0 R >>'),
]);

/**
 * Two ancestors, different values. R-7.7.3.4-5/-6 require the search to walk
 * up from the page and **stop at the first hit**; with only one ancestor
 * holding a value, "nearest" and "root" and "last" all agree and the fixture
 * proves nothing. A4 (595×842) sits nearer the page than US Letter.
 */
const inheritShadowed = buildPdf([
  CATALOG,
  node(2, '/Kids [6 0 R] /Count 1 /MediaBox [0 0 612 792]'),
  node(6, '/Parent 2 0 R /Kids [3 0 R] /Count 1 /MediaBox [0 0 595 842]'),
  obj(3, '<< /Type /Page /Parent 6 0 R /Resources << >> >>'),
]);

/**
 * R-7.7.3.4-4: values are inherited as-is, "without merging, even for
 * composite data types such as arrays and dictionaries". Two ancestors hold
 * `/Resources` with **disjoint keys**, so a merging implementation returns two
 * keys where the specification allows one.
 */
const inheritNotMerged = buildPdf([
  CATALOG,
  node(2, '/Kids [6 0 R] /Count 1 /Resources << /ProcSet [/PDF] >>'),
  node(6, '/Parent 2 0 R /Kids [3 0 R] /Count 1 /Resources << /Font << /F1 8 0 R >> >>'),
  obj(3, `<< /Type /Page /Parent 6 0 R ${MEDIA} >>`),
  obj(8, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
]);

/**
 * All four inheritable attributes of Table 31 at once, plus one that is not
 * inheritable: R-7.7.3.3-2 says attributes not identified as inheritable
 * "shall not be inherited", so `/Tabs` shall stay on the ancestor.
 */
const inheritAllFour = buildPdf([
  CATALOG,
  node(
    2,
    '/Kids [3 0 R] /Count 1 /MediaBox [0 0 595 842] /CropBox [10 10 585 832] ' +
      '/Rotate 90 /Resources << /ProcSet [/PDF] >> /Tabs /R',
  ),
  obj(3, '<< /Type /Page /Parent 2 0 R >>'),
]);

/**
 * The page carries an **empty** `/Resources` dictionary, which R-7.7.3.3-8
 * calls for when a page needs no resources. Omitting the entry means
 * something different (inherit), so an implementation that treats empty as
 * absent inherits the ancestor's `/ProcSet` instead of answering with nothing.
 */
const resourcesEmptyDict = buildPdf([
  CATALOG,
  node(2, '/Kids [3 0 R] /Count 1 /Resources << /ProcSet [/PDF] >>'),
  obj(3, `<< /Type /Page /Parent 2 0 R ${MEDIA} /Resources << >> >>`),
]);

/**
 * R-7.7.3.3-22 admits two forms: "either a single stream or an array of
 * streams". Both arms are here, because a model that handles only the common
 * one passes every corpus specimen and then breaks on the other.
 */
const contentsSingle = buildPdf([
  CATALOG,
  node(2, '/Kids [3 0 R] /Count 1'),
  page(3, 2, '/Contents 4 0 R '),
  content(4, 'q 1 0 0 1 0 0 cm Q'),
]);

const contentsArray = buildPdf([
  CATALOG,
  node(2, '/Kids [3 0 R] /Count 1'),
  page(3, 2, '/Contents [4 0 R 5 0 R] '),
  content(4, 'q 1 0 0 1 0 0 cm'),
  content(5, 'Q'),
]);

export const PAGE_TREES: readonly Fixture[] = [
  {
    id: 'flat-1page',
    axes: { depth: 1, intermediates: 0, pages: 1, generation: 0, contents: 'none' },
    why: '最小の木。ここが読めなければ他を読む意味がない',
    bytes: flat1.bytes,
  },
  {
    id: 'flat-3pages',
    axes: { depth: 1, intermediates: 0, pages: 3 },
    why: 'コーパスの 99% と同じ形',
    bytes: flat3.bytes,
  },
  {
    id: 'nested-balanced',
    axes: { depth: 2, intermediates: 2, pages: 4 },
    why: '走査が再帰すること',
    carries: { wrong: 'Kids.length = 2', right: 'Count = 4' },
    bytes: balanced.bytes,
  },
  {
    id: 'nested-unbalanced',
    axes: { depth: 2, intermediates: 1, pages: 3, mixedKids: true },
    why: '/Count は Kids の長さではなく子孫ページ数（R-7.7.3.2-8）',
    carries: { wrong: 'Kids.length = 2', right: 'Count = 3' },
    bytes: unbalanced.bytes,
  },
  {
    id: 'nested-deep',
    axes: { depth: 4, intermediates: 3, pages: 1 },
    why: 'コーパスの最大深さ 3 を超える',
    bytes: deep.bytes,
  },
  {
    id: 'gen-nonzero',
    axes: { depth: 1, intermediates: 0, pages: 1, generation: 4 },
    why: 'オーバーレイの鍵に世代番号が要ること',
    carries: { wrong: '番号だけの鍵は 3 0 R として読む', right: '3 4 R と 3 0 R は別物' },
    bytes: genNonZero.bytes,
  },
  {
    id: 'inherit-from-parent',
    axes: {
      depth: 2,
      intermediates: 1,
      pages: 1,
      inherits: 'Resources,MediaBox',
      ancestorsWithValue: 1,
    },
    why: '継承の基本（§7.7.3.4）',
    bytes: inheritFromParent.bytes,
  },
  {
    id: 'inherit-shadowed',
    axes: { depth: 2, intermediates: 1, pages: 1, inherits: 'MediaBox', ancestorsWithValue: 2 },
    why: '探索は最初のヒットで止まる（R-7.7.3.4-5/-6）',
    carries: { wrong: '根から探すと 612×792', right: '近いほうの 595×842' },
    bytes: inheritShadowed.bytes,
  },
  {
    id: 'inherit-not-merged',
    axes: { depth: 2, intermediates: 1, pages: 1, inherits: 'Resources', ancestorsWithValue: 2 },
    why: '継承はマージしない（R-7.7.3.4-4）',
    carries: { wrong: 'マージすると /Font と /ProcSet', right: '/Font だけ' },
    bytes: inheritNotMerged.bytes,
  },
  {
    id: 'inherit-all-four',
    axes: { depth: 1, intermediates: 0, pages: 1, inherits: 'Resources,MediaBox,CropBox,Rotate' },
    why: '4 属性が同じ経路を通ること・継承されない属性が降りてこないこと（R-7.7.3.3-2）',
    carries: { wrong: '全部の祖先エントリを降ろすと /Tabs も付く', right: '/Tabs は降りない' },
    bytes: inheritAllFour.bytes,
  },
  {
    id: 'resources-empty-dict',
    axes: { depth: 1, intermediates: 0, pages: 1, inherits: 'none' },
    why: '空の /Resources は「無い」ではない（R-7.7.3.3-8）',
    carries: { wrong: '空を不在と見て /ProcSet を継承', right: '空辞書のまま' },
    bytes: resourcesEmptyDict.bytes,
  },
  {
    id: 'contents-single',
    axes: { depth: 1, intermediates: 0, pages: 1, contents: 'single' },
    why: '/Contents が単一ストリームの形（R-7.7.3.3-22 の一方）',
    bytes: contentsSingle.bytes,
  },
  {
    id: 'contents-array',
    axes: { depth: 1, intermediates: 0, pages: 1, contents: 'array' },
    why: '/Contents が配列の形（R-7.7.3.3-22 のもう一方・R-7.7.3.3-23）',
    bytes: contentsArray.bytes,
  },
];

// ---------------------------------------------------------------- invalid

const badCount = (count: string) =>
  buildPdf([
    CATALOG,
    node(2, `/Kids [3 0 R 4 0 R 5 0 R] ${count}`),
    page(3, 2),
    page(4, 2),
    page(5, 2),
  ]).bytes;

export const INVALID_PAGE_TREES: readonly InvalidFixture[] = [
  {
    id: 'bad-count-high',
    axes: { defect: 'count', declared: 5 },
    why: '実際は 3 ページなのに /Count 5',
    violates: 'R-7.7.3.2-8',
    parses: true,
    bytes: badCount('/Count 5'),
  },
  {
    id: 'bad-count-low',
    axes: { defect: 'count', declared: 1 },
    why: '実際は 3 ページなのに /Count 1',
    violates: 'R-7.7.3.2-8',
    parses: true,
    bytes: badCount('/Count 1'),
  },
  {
    id: 'bad-count-missing',
    axes: { defect: 'count', declared: 'なし' },
    why: '実際は 3 ページで /Count が無い（Table 30 では Required）',
    violates: 'R-7.7.3.2-1',
    parses: true,
    bytes: badCount(''),
  },
  {
    id: 'bad-count-nonint',
    axes: { defect: 'count', declared: '3.0' },
    why: '実際は 3 ページ。値は合っているが実数で書かれている',
    violates: 'R-7.7.3.2-8',
    parses: true,
    bytes: badCount('/Count 3.0'),
  },
  {
    id: 'dup-page-ref',
    axes: { defect: 'duplicate', target: 'page' },
    why: '同じページオブジェクトへの複数の間接参照',
    violates: 'R-7.7.3.3-3',
    parses: true,
    bytes: buildPdf([CATALOG, node(2, '/Kids [3 0 R 3 0 R] /Count 2'), page(3, 2)]).bytes,
  },
  {
    id: 'dup-node-ref',
    axes: { defect: 'duplicate', target: 'node' },
    why: '2 つの中間ノードが同じ子ノードを指す',
    violates: 'R-7.7.3.2-4',
    parses: true,
    bytes: buildPdf([
      CATALOG,
      node(2, '/Kids [6 0 R 7 0 R] /Count 2'),
      node(6, '/Parent 2 0 R /Kids [8 0 R] /Count 1'),
      node(7, '/Parent 2 0 R /Kids [8 0 R] /Count 1'),
      node(8, '/Parent 6 0 R /Kids [3 0 R] /Count 1'),
      page(3, 8),
    ]).bytes,
  },
  {
    id: 'parent-direct',
    axes: { defect: 'parent', form: '直接辞書' },
    why: '/Parent は間接参照でなければならない',
    violates: 'R-7.7.3.3-5',
    parses: true,
    bytes: buildPdf([
      CATALOG,
      node(2, '/Kids [3 0 R] /Count 1'),
      obj(
        3,
        `<< /Type /Page /Parent << /Type /Pages /Kids [3 0 R] /Count 1 >> ${MEDIA} /Resources << >> >>`,
      ),
    ]).bytes,
  },
  {
    id: 'parent-wrong',
    axes: { defect: 'parent', form: '別のノードを指す' },
    why: '/Parent は「直接の親」であること',
    violates: 'R-7.7.3.3-5',
    parses: true,
    bytes: buildPdf([
      CATALOG,
      node(2, '/Kids [6 0 R] /Count 1'),
      node(6, '/Parent 2 0 R /Kids [3 0 R] /Count 1'),
      page(3, 2), // 実際の親は 6
    ]).bytes,
  },
  {
    id: 'parent-missing',
    axes: { defect: 'parent', form: 'なし' },
    why: '根以外は /Parent が Required',
    violates: 'R-7.7.3.3-5',
    parses: true,
    bytes: buildPdf([
      CATALOG,
      node(2, '/Kids [3 0 R] /Count 1'),
      obj(3, `<< /Type /Page ${MEDIA} /Resources << >> >>`),
    ]).bytes,
  },
  {
    id: 'rotate-45',
    axes: { defect: 'rotate', value: 45 },
    why: '/Rotate は 90 の倍数',
    violates: 'R-7.7.3.3-28',
    parses: true,
    bytes: buildPdf([CATALOG, node(2, '/Kids [3 0 R] /Count 1'), page(3, 2, '/Rotate 45 ')]).bytes,
  },
  {
    id: 'contents-empty-array',
    axes: { defect: 'contents', value: '[]' },
    why: '空の /Contents 配列を作ってはならない',
    violates: 'R-7.7.3.3-26',
    parses: true,
    bytes: buildPdf([CATALOG, node(2, '/Kids [3 0 R] /Count 1'), page(3, 2, '/Contents [] ')])
      .bytes,
  },
  {
    id: 'resources-nowhere',
    axes: { defect: 'resources', value: 'ページにも祖先にも無い' },
    why: '必須の継承属性は祖先のどこかで供給されること',
    violates: 'R-7.7.3.4-2',
    parses: true,
    bytes: buildPdf([
      CATALOG,
      node(2, '/Kids [3 0 R] /Count 1'),
      obj(3, `<< /Type /Page /Parent 2 0 R ${MEDIA} >>`),
    ]).bytes,
  },
];

/** How many shapes each axis has. An axis with one shape is not being measured. */
export function axisCoverage(
  fixtures: readonly { axes: Fixture['axes'] }[],
): Record<string, { shapes: Record<string, number>; distinct: number }> {
  const axes = new Map<string, Map<string, number>>();
  for (const f of fixtures) {
    for (const [k, v] of Object.entries(f.axes)) {
      const shapes = axes.get(k) ?? new Map<string, number>();
      shapes.set(String(v), (shapes.get(String(v)) ?? 0) + 1);
      axes.set(k, shapes);
    }
  }
  return Object.fromEntries(
    [...axes].map(([k, shapes]) => [
      k,
      { shapes: Object.fromEntries([...shapes].sort()), distinct: shapes.size },
    ]),
  );
}
