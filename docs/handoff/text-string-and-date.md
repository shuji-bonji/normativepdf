# 引き継ぎ: §7.9 の文字列層（テキスト文字列の復号 + 日付）

- 対象リポジトリ: `normativepdf`（この文書のある repo）
- 起票: 2026-08-27
- **要求は消費者から立った。4 つの消費者が同じものを 4 通りに実装している**（§1）
- これは `family` 側の 2 段（pdf-constraints → verify の pdf-lib 撤去）の**前提**にあたる。
  先に 1 リリース出しておけば、両方が同じものを消費できる
- この文書だけで着手できる
- **family 側の起票先: [shuji-bonji/pdf-agent-stack#21](https://github.com/shuji-bonji/pdf-agent-stack/issues/21)**（トラック B の第 1 段 = N）

---

## 1. 要求の実測（2026-08-27）

`CosName.value` は `#xx` 解決と UTF-8 復号を済ませている（R-7.3.5-13・lexer）。
足りないのは **`CosString` のバイト列を「読める文字列」にする層**と、**日付**である。

| 消費者 | §7.9.2 テキスト文字列 | §7.9.4 日付 |
|---|---|---|
| `pdf-reader-mcp` | `content-stream-service.ts:155` の `decodeTextString` を自前実装。ただし変換テーブル 2 本（`pdfDocEncodingDecode` / `utf16Decode`）は **pdf-lib から借用**（2 箇所） | — |
| `pdf-verify-mcp` | pdf-lib の `decodeText()` × **19**（`/Lang` `/Alt` `/Title` RoleMap など） | — |
| `@shuji-bonji/pdf-constraints` | pdf-lib の `decodeText()` × **6** | `parsePdfDate` を自前実装（`src/evaluate.ts`・**`export` 済み**） |
| `pdf-writer-mcp` | **書き側を自前**（`cos.ts` の PDFDocEncoding 範囲検査・`outline.ts` の UTF-16BE + BOM） | **`pdf-date.ts`（18 行）を自前**（書き側） |

normativepdf 側は **どちらも無い**（実測: `src/` の §7.9.4 grep は 0 件。
`CosString` は `{ bytes, form }` しか持たない。§7.6 のパスワード処理が
PDFDocEncoding に言及するだけ）。

🔴 **pdf-lib 1.x は `R-7.9.2.2.1-4`（UTF-8 BOM）を満たしていない。**
reader はそれを自分で足している（`content-stream-service.ts:159-161`）。
**借りている実装のほうが条文から遠い**、という状態である。

## 2. 条文（pdf-spec-mcp `get_requirements` で実測）

### §7.9.2 — テキスト文字列

| 規則 | 内容 |
|---|---|
| `R-7.9.2.1-1` | 文字列オブジェクトは text string / ASCII string / byte string のいずれかとして限定される |
| `R-7.9.2.2.1-2` | text string は **PDFDocEncoding / UTF-16BE / （PDF 2.0）UTF-8** のいずれか |
| `R-7.9.2.2.1-3` | UTF-16BE は先頭が **254, 255**（`FE FF`） |
| `R-7.9.2.2.1-4` | UTF-8 は先頭が **239, 187, 191**（`EF BB BF`） |
| `R-7.9.2.2.1-5` | 読み手は**補助文字**（2 バイトを超える文字）を扱えること |
| `R-7.9.2.2.2-2/-3` | 言語エスケープ列は文字列中のどこにでも現れうる。要素の順序が定まっている |
| `R-7.9.2.3-1` | PDFDocEncoded string は 1 バイト 1 文字 |
| `R-7.9.2.4-1` | byte string は任意の 8 ビット値の並び |

### §7.9.4 — 日付

`D:YYYYMMDDHHmmSSOHH'mm'`（Table 4）。writer の `pdf-date.ts` が書き側で既に引用している。
省略可能な後続部と、`Z` / `+` / `-` の扱いを条文どおりに定める。

## 3. 足す面

### 読み側（無い）

```ts
/** §7.9.2.2 — text string のバイト列を文字列にする */
export function decodeTextString(bytes: Uint8Array): string;

/** §7.9.2.2.2 — 言語エスケープ列を取り除く（decodeTextString が内部で使う） */
export function stripLanguageEscape(bytes: Uint8Array): Uint8Array;

/** §7.9.4 Table 4 — 日付文字列を読む。読めなければ null */
export function parsePdfDate(value: string): PdfDate | null;
```

### 書き側（writer から持ち上げる）

```ts
/** §7.9.2.2 — PDFDocEncoding で書ける範囲なら literal、超えるなら UTF-16BE + BOM */
export function encodeTextString(text: string): CosString;

/** §7.9.4 Table 4 — UTC で書く（`Z` ではなく `+00'00'`） */
export function formatPdfDate(when: Date): string;
```

**書き側は新規実装ではない。** writer が Phase 3（pdf-lib 撤去）の過程で条文つきで書いたものを
持ち上げる。`cos.ts` の PDFDocEncoding 範囲検査は既に `R-7.9.2.2` を引用しており、
`outline.ts` は「旧実装は常に UTF-16BE で書いていた／条文はどちらも許す」と経緯まで書いてある。

**読み側と書き側を対にする理由**は、PDFDocEncoding のテーブルが 1 本で済むことと、
往復（encode → decode）が受入の面になることである。

## 4. 受入基準（着手前に決める）

### 面 1 — 条文の被覆

§2 の 8 規則それぞれに対応するテストがあり、**T-3 で落ちることを実測する**
（最低 3 通り: BOM 検査を外す / 言語エスケープの除去を外す / 補助文字の扱いを壊す）。

### 面 2 — 差分オラクル（pdf-lib が在るうちに取る）

**pdf-lib の `decodeText()` と突き合わせる。** ADR-0003（inflate）と同じ形。

- コーパス 2,907 検体の Info 辞書・アウトライン題名・`/Alt` `/ActualText` `/Lang` を
  両実装で復号し、バイト一致を数える
- 🔴 **一致しない形が 1 つ分かっている**: UTF-8 BOM（`R-7.9.2.2.1-4`）。
  pdf-lib 1.x は扱わない。**ここは条文が正で、差は改善として帰属させる**。
  差の件数と検体名を記録する
- 日付は **2 つの既存実装**と突き合わせる:
  `pdf-constraints/src/evaluate.ts` の `parsePdfDate`（読み）と
  `pdf-writer-mcp/src/services/pdf-date.ts` の `pdfDate`（書き）

### 面 3 — 往復

`encodeTextString` → `decodeTextString` が元の文字列に戻る。
PDFDocEncoding の範囲内・範囲外（日本語）・補助文字（サロゲートペア）・
言語エスケープ入りの 4 軸で測る。

### 面 4 — 消費者が実際に使える

**受入は「API が生えた」ではなく「消費者が置き換えられた」で取る。**
第 1 消費者は `@shuji-bonji/pdf-constraints`（`decodeText()` × 6 + 自前 `parsePdfDate`）。
そこで置き換えが通ってから公開する。

## 5. 測らないと決めること

- **性能。** 文字列復号の速度は受入に入れない
- **PDFDocEncoding のテーブルの出典比較。** Annex D の表を条文から起こすのであって、
  pdf-lib のテーブルを写すのではない。ただし差分オラクルとしては pdf-lib を使う
- **ASCII string / byte string の型付け。** `R-7.9.2.1-1` は 3 種の区別を要求するが、
  どれとして扱うかは**呼び出し側が知っている**（辞書のキーで決まる）。
  ライブラリは text string の復号だけを提供し、区別は消費者に残す

## 6. 関連

- `pdf-agent-stack/lib/pdf-constraints/docs/handoff/pdflib-removal.md` — 第 1 消費者（B1）
- `pdf-agent-stack/mcp/pdf-verify-mcp/docs/handoff/pdflib-removal.md` — 第 2 消費者（B2）
- `pdf-agent-stack/information/issue-draft-08-sdk-v2-and-version-alignment.md` — トラック A
- `docs/ROADMAP.md` Phase 1 の未チェック項目「reader から使わせる（第 2 消費者）」
  — reader も `decodeTextString` を自前で持っているので、将来の消費者にあたる
