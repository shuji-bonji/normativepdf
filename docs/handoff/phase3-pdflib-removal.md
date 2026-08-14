# 引き継ぎ: Phase 3（段階 2）— 生成パスの移行 = pdf-lib 撤去

- 対象リポジトリ: `normativepdf`（実装）+ `pdf-writer-mcp`（第一利用者）
- 根拠: [`../ROADMAP.md`](../ROADMAP.md) Phase 3 / [`../DESIGN.md`](../DESIGN.md)
- **これが今いちばん大きい。他の 2 件（自前 inflate / reader 移行）の着手条件がここに繋がっている**
- この文書だけで着手できる。他の引き継ぎを読む必要は無い

> **次に着手するもの = L3'（生成パスを器ごと載せ替える）。読む順は §3.5 → §3.6 → §4。**
> L2（文書モデル）は完了しており、詳細は [`l2-document-model.md`](l2-document-model.md) にある。
> **着手前に §3.6 末尾の「数えること」を先に済ませること。**

---

## 1. どこまで来たか（2026-08-14 実測）

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | 準備 | ✅ 2026-08-08 |
| 1 | 段階 0 = COS モデル + レキサ + パーサ | ✅ 受入充足（自前 inflate のみ残置） |
| 2 | 段階 1 = シリアライザ + 増分更新 | ✅ 受入充足 2026-08-13（npm 0.3.1 公開） |
| **3** | **段階 2 = 生成パス移行（pdf-lib 撤去）** | **⬅ ここ。部品 4 + 文書モデル（L2）完了。writer は L1 + L1.5 まで。次は L3' = 生成パスを器ごと載せ替え（§3.6）** |
| 4 | 段階 3 = PDF 2.0 の実体 | — |
| 5 | 段階 4 = PDF/UA-2 + WTPDF | — |

段階 1 までで、normativepdf は**読めて・書けて・追記できる**。
`writeFile` / `appendUpdate` / `buildObjectStream` / `buildXrefStream` が揃い、
往復はコーパス 2,881/2,881、qpdf は元ファイルに無い苦情を出さない。

**writer が normativepdf に移したのは、増分更新の「直前 xref セクションを読む」ところだけ**である
（0.19.0 = `readXrefSectionAt`。チェーンは歩かない・位置の特定と回復方針は writer に残る・
**直列化は pdf-lib のまま**）。読み側全般が移ったわけではない。

**2026-08-14 に normativepdf 側の部品が 4 つ入った**（§3）。ただし **writer は 1 行も載せ替えていない**。
`grep -rn "from 'pdf-lib'" src/` は依然 24 行である。「部品ができた」と「移行が進んだ」は別の数字なので、
進捗はこの grep の行数で見る。

## 1.5 受入の計器は立った（2026-08-13・ADR-0006）

**撤去に着手する前に、旧実装（pdf-lib 版 0.19.0）の出力をゴールデンとして採取した。**
根拠と決定は [`../adr/0006-phase3-differential-acceptance.md`](../adr/0006-phase3-differential-acceptance.md)、
実装は `pdf-writer-mcp/scripts/uc-oracle/`（`npm run oracle`）。

- 検体 24 本を**軸**（pdfVersion / フォント / tagged / origin / 署名 / 添付 / フォーム）で並べ、**23 本を採取**
- ダイジェストは **qpdf `--json`（独立実装）**から作る。family 内のパーサは撤去後に
  全部 normativepdf の上に乗るのでオラクルになれない（T-2）
- **T-3 を 3 面で実測**（演算子 / フォント辞書型 / ツール応答）。壊すと落ち、戻すと緑に戻る
- **AcroForm の入力検体を凍結した**（`inputs/form-basic.pdf`）。テストは検体を pdf-lib で
  組み立てているので、撤去すると**検体を作る手段ごと消える**

**ホスト実走で 4 面とも判定が付いた（2026-08-13・qpdf 12.4.0 + veraPDF）**:
`pdfa-3b` **146/146** / `pdfa-4f` **109/109** / `pdfua-1` **106/106**（2 本）/
素の `pdfa-4` は **108/109 NOT COMPLIANT**（`6.9-3` = 落ちることが正しい検体）/ 署名 2-2・6-5。
**受入基準の数字（§4）は、これでファイルに固定された。**

🔴 **ホスト初走で 1 件出たが writer の後退ではなかった** — qpdf 12.4.0 が 5 署名検体の追記出力を
`unable to find page tree` で拒否した（qpdf 10.6.3 は読めていた）。**入力の時点で**同じ苦情が出る
（page tree ノードに `/Type /Page` が無い・obj 56 が null）。→ 構造の面だけ `unreadable` にして
**入力も同じ読み手に通した結果を記録する**形にした。この検体の構造面は今後も qpdf 12 では測れない
（署名の面のための検体として残す）。

⚠️ **`compare_structure` はオラクルにならない**（ADR-0006 §3 で実測）。下記 §4 の記述は訂正済み。

### 片側しか無い軸を埋めた（2026-08-14・L2 の直前）

オラクルは毎回 `! 1 形しか無い軸: attachment, origin, signed, revisions` を出していた。
**L2 は load → 編集 → save の器そのもの**なので、`origin` と `revisions` が片側のままだと
そこの後退を検出できない。数え直したところ、2 軸は事情が違った:

- **`revisions` は検体が既にあり、ラベルだけ無かった。** 入力の実測は 1 / 2 / 4 / 8 の
  4 形あるのに、`axes` に書いてあるのは `8` の 1 本だけだった。
  **軸が閉じていたのではなく、閉じているように見えていただけ**である → ラベルを付けた
- **`origin` は本当に `>0` しか無かった** → corpus に**ほぼ同じ文書の対**がある。
  `Simple PDF 2.0 file.pdf`（origin=0・5,211 bytes）と
  `PDF 2.0 with offset start.pdf`（origin=656・5,264 bytes）は、どちらも 1 リビジョン・
  古典 xref テーブル・`%PDF-2.0`・同じ catalog / Pages / Page / Font 構成。同じ
  `add_annotation` を両方に掛ける `input-origin-zero` を足した（検体 25 → 26）

  ⚠️ **「違うのは先頭の詰め物だけ」ではない**（採取後に実測）。`Simple` には
  もう 1 本ストリーム（obj 5・`/Length 746`）があり、`offset start` には無い。
  そのため lock の `objectCount` は **14 対 13** になる。**この 1 の差は入力から来ていて、
  origin > 0 の経路が作ったものではない** — 将来この差分を読む人が欠陥と取り違えないよう
  ここに残す。対として使う分にはこの差は無害である（各々が自分の基準値と比べられる）。

結果: `origin` 2 形 / `revisions` 4 形。残る片側は `attachment` と `signed` で、
これらは L2 の関心から遠いので後回しにした。

⚠️ **ゴールデンの採り直しが要る**（`npm run oracle:update`）。新しい検体の基準値は
**旧実装（pdf-lib 版）から採る**必要があるが、L1 / L1.5 は 25 検体すべてで差 0 と
実測済みなので、今の作業ツリーから採って構わない。**測っていなければこの判断はできない。**
lock の更新は ADR-0006 §7 のとおり**単独のコミット**で。

## 2. 撤去の対象（2026-08-13 実測）

`pdf-writer-mcp/src/` の **`.ts` 39 ファイル中、24 ファイルが `pdf-lib` を import している**
（`from 'pdf-lib'` が 24 行・**合計 7,178 行**）。

**加えて `tests/` の 21 ファイル・5,475 行**が pdf-lib に依存している（当初は数えていなかった）。
**判断は済んでいる（ADR-0006 §9・2026-08-14 実測）**:

| 用途 | ファイル数 | 撤去後 |
|---|---|---|
| 検体を書いて writer に食わせる（入力の生産者） | 14 | 残す |
| 出力を読んで検査する（独立した読み手） | 5 + 混在 | 残す |
| 凍結済み検体 | **0** | 欠陥クラスを守る入力だけ順次凍結 |

受入は**実行時依存 0**（`dependencies` から消える）であって、`devDependencies` の pdf-lib は
撤去の失敗ではない。**`tests/` に凍結された PDF が 1 つも無い**ため、完全に消すと 14 ファイルは
検査対象ではなく**入力を失って**落ちる。落とすのは同じ面を qpdf で覆えたときで、今は覆えていない。

```
services/{incremental,ensure-tagged,font-conformance,output,pdfa-conformance,
editor,page-ops,attachment,outline,form,builder,page-number,xmp,font-manager,
layout,struct-tree,annotation,doc-level,pdf-version,struct-append,watermark}.ts
services/renderers/{table,text,markdown}.ts
```

> `constants.ts` は import を持たない（コメントで言及しているだけ）。
> **数え直すときは `grep -rn "from 'pdf-lib'" src/` で取る** — コメントを数えると多く出る。

**「pdf-lib を消す」ではなく「生成パスを normativepdf の上に建て直す」作業**である。

## 3. やること（ROADMAP Phase 3 の 7 項目）— 4 つ済み

- [x] **フィルタ・コンテンツストリームビルダ**（2026-08-14・`src/content/content-stream.ts` +
      `src/filter/encode.ts`）。書き側 deflate は非圧縮の膨張が **×1.28** と実測できたので見送り
- [x] **フォント辞書**（`src/font/embedded-font.ts`）— 辞書を**バイト列から導いて** W-2 を表現不能にした
- [x] **構造木・タグ・MarkInfo**（`src/struct/struct-tree.ts`）— MCID の出所を 1 つに畳んだ
- [x] **XMP・OutputIntent・catalog**（`src/conformance/declare.ts`）— 宣言と検査を同じ関数に（DESIGN §3）
- [ ] **文書モデル**（グラフ容器 + ページツリーの意味規定）— ROADMAP には項目が無いが、
      §3.5 の実測で「これが無いと他が動かない」ことが分かったので L2 として立てる。
      範囲と受入は [ADR-0007](../adr/0007-document-model-scope.md)、着手手順は
      [`l2-document-model.md`](l2-document-model.md)。**DESIGN §5 との線引きを先に決めた**
      （オーサリング API は作らず writer に残す）
- [ ] pdf-lib 差分オラクル運用 → **計器は稼働中**（`uc-oracle` 25 検体・4 面）。残るのは「移行の各段で回す」運用
- [ ] 受入: pdf-lib 撤去 + UC 回帰全緑 + PDF/A-3b COMPLIANT
- [ ] PDF family へ取り込み（writer が第一利用者・自身でコントリビュート）

**部品は揃った。ここから先は writer を載せ替える作業で、性質が違う。**

## 3.5 載せ替えの順序（2026-08-14 実測）

「どのサービスから引き剥がすか」は好みではなく、**依存の形が決める**。
`src/` の pdf-lib 依存を「型として使っているか・実体を呼んでいるか」で数え直した:

- **型としてだけ使うファイル: 1**（`output.ts`）/ **実体を呼ぶファイル: 23**
- 実体として呼ばれている識別子の出現ファイル数（多い順）:
  `PDFName` 15 / `PDFArray` 10 / `PDFDict` 9 / `PDFRef` 9 / `rgb` 8 /
  `PDFNumber` 7 / `PDFHexString` 7 / `PDFString` 4 / `PDFRawStream` 4 /
  `degrees` 3 / `decodePDFRawStream` 3 / **`PDFDocument` 3** / …
- 文書の寿命の境界は **4 箇所しかない**: `PDFDocument.load` は **`editor.ts:137` の 1 箇所**、
  `PDFDocument.create` は `builder.ts` と `page-ops.ts`（2 回）。出口は `output.ts` の 3 関数
- ページツリー / リソースに触るのは `getPages` 6・`addPage` 4・`.node.` 14・
  `context.register` 18・`context.lookup` 11

**この形が言っていること**: 上位に出てくるのは `PDFName` / `PDFArray` / `PDFDict` / `PDFRef` で、
これらは **normativepdf の COS 型と 1 対 1** に対応する。つまり難所は COS ではない。
難所は、それらが**生きた `PDFDocument.context` に対して register / lookup される**ことで、
そこを置き換えるには**文書モデルが要る**。

🔴 **そして normativepdf には文書モデルがまだ無かった。**（L2 で作った → [`l2-document-model.md`](l2-document-model.md)）
順序を間違えると、器が無いままサービスを 1 つずつ移そうとして
pdf-lib → COS の変換層を書くことになる（§6 で作らないと決めたもの）。

### 🔴 段取りを組み直した（2026-08-14・L2 完了後の実測）

**当初の L3 =「COS プリミティブの 1 対 1 の機械的な置換」は成立しない。**
L2 が終わったあとに writer を数え直して分かった:

- COS 型を含む **532 行のうち 302 行が、生きた pdf-lib 文書に触る文脈にある**
- 作り方が `context.obj({}) as PDFDict` → `dict.set(PDFName.of('Type'), …)` である。
  中身だけ normativepdf の COS に替えても、**入れる先が pdf-lib の `PDFDict` なので直列化されない**
- pdf-lib から**実体で import している識別子は 37 種**あり、COS プリミティブはそのうち 8 種にすぎない

**つまり COS は器に従属していて、器は writer が pdf-lib の
オーサリング API（`addPage` / `drawText` / `getForm` / `embedFont` / `copyPages`）越しに持っている。**
ADR-0007 は「オーサリング API は writer に残す」と決めたが、
**writer は自前のオーサリング層を持っていない** — pdf-lib のものを使っている。
だから「writer に残す」の実際の意味は
**「writer が normativepdf の上に自前のオーサリング層を作る」**である。

### 受け皿の有無（2026-08-14 実測）

| 面 | writer 側 | normativepdf の受け皿 |
|---|---|---|
| 描画演算子（10 個） | `annotation.ts` 221 行 | ✅ `ContentStreamBuilder` |
| 構造木・タグ | `struct-tree` / `struct-append` / `ensure-tagged` 860 行 | ✅ `StructTreeBuilder` |
| フォント辞書 | `font-conformance.ts` | ✅ `buildType0Font` |
| XMP・適合宣言 | `xmp.ts` / `pdfa-conformance.ts` | ✅ `declareConformance` |
| COS・直列化・増分更新 | `incremental.ts` 587 行 | ✅ `writeFile` / `appendUpdate` |
| 文書・ページツリー | `editor` / `builder` / `page-ops` | ✅ **`PdfDocumentEditor`（L2）** |
| **ページ生成・サイズ** | `addPage` 4 / `getSize` 2 | ❌ **無い**（器の上で数十行） |
| **描画の高レベル** | `drawText` 5 / `drawRectangle` 3 / `drawLine` 1 | ❌ **無い**（演算子は揃っている） |
| **フォント埋め込みの入口** | `embedFont` 2 + メトリクス | ❌ **無い**（L1.5 で writer の関心と決定済み） |
| **フォーム 7 クラス** | `form.ts` 546 行 | ❌ **無い** |
| **ページ複写** | `copyPages` 2 / `PDFObjectCopier` | ❌ **無い** |

### 段取り

| 段 | 中身 | 状態 |
|---|---|---|
| **L1** | `rgb` / `degrees` / `StandardFonts` の置き換え | ✅ 完了（2026-08-14）。実体呼び出し 23 → 19 ファイル |
| **L1.5** | **文字幅**（`TextMetrics` = `metrics.ts`） | ✅ 完了。🔴 当初この表に無かった段（下記） |
| **L2** | **文書モデル**（グラフ容器 + ページツリーの意味規定）→ [`l2-document-model.md`](l2-document-model.md) | ✅ 完了（ADR-0007・受入 4 面すべて充足・テスト 382） |
| **L3'.0** | **normativepdf 0.4.0 の公開** — 部品 4 + L2 + `create()` + MCR。writer の dep を 0.3.1 → 0.4.0 | ⬅ ここで止まっている。**公開されるまで L3' は 1 行も型検査を通らない** |
| **L3'** | **生成パスを器ごと載せ替える** — ページ生成 + 描画 3 種 + ページ複写を writer に自前化し、`PDFDocument` を `PdfDocumentEditor` に差し替える。**COS もここで一緒に置き換わる**。着手済み = `cos.ts` / `writer-doc.ts` / `font-embed.ts`（下記） | L3'.0 の後。§3.6 |
| **L4'** | **`form.ts`（546 行）** — AcroForm の外観生成を含む独立した部分系 | L3' の後 |
| **L5'** | **メトリクス自前化** — 標準 14 書体の幅表（L1.5 で帰属だけ決めて実装は残してある） | 最後 |

**各段の後に `npm run oracle` を回す。** 差が出たら「意図した差か」を人が判断し、
意図した差なら **lock を単独のコミットで**更新する（ADR-0006 §7）。

⚠️ **L1 を「軽いから」で飛ばさないこと。** 計器を**実際の移行**で 1 度通してから先へ行く。

⚠️ **writer の pdf-lib 依存は L2 完了時点でまだ 1 行も減っていない**（実体呼び出し 19 ファイルのまま）。
L2 はライブラリ側の前進であって、撤去の進捗ではない。**この 2 つを同じ数字で語らないこと。**

## 3.6 L3' の中身（次に着手するもの）

**生成パス（`builder.ts`）と編集パス（`editor.ts`）は分けられる。生成パスが先。**
入力 PDF が無いぶん器の差し替えが素直で、`PDFDocument.create` は
`builder.ts` と `page-ops.ts` の 2 箇所しかない（`load` は `editor.ts:137` の 1 箇所）。

自前化するもの（受け皿が無い 3 つのうち小さい方）:

1. **ページ生成** — ページ辞書を作って `Kids` に足す。`/Count` は `PdfDocumentEditor` が再計算する
2. **描画 3 種** — `drawText` / `drawRectangle` / `drawLine` を `ContentStreamBuilder` の上に。
   合計 9 呼び出し。演算子の文脈検査はビルダが持っているので、**書けない形は書けない**
3. **ページ複写** — オブジェクトグラフを辿って番号を振り直す。2 呼び出し。
   ⚠️ **`allocate` の採番規則がそのまま効く**（`/Size` を下限にする = [[read-range-is-not-the-whole-file]]）

### 数えた（2026-08-14・着手直前）

生成パス = `builder.ts` の到達閉包 + **コールバックで注入される `renderers/{text,table,markdown}.ts`**
（静的な import グラフには出ない — `RenderFn` として `handlers.ts` から渡る）。
そこが `PDFPage` に対して呼んでいるもの:

| 呼び出し | 回数 | 場所 |
|---|---|---|
| `drawText` | 3 | `layout.ts:253` / `renderers/markdown.ts:148` / `renderers/table.ts:91` |
| `drawRectangle` | 3 | `renderers/table.ts:69,77` / `renderers/markdown.ts:138` |
| `drawLine` | 1 | `layout.ts:279` |
| **`pushOperators`** | **4** | `struct-tree.ts:169,176,185,187`（BDC / EMC） |
| **`page.ref`** | **3** | `struct-tree.ts:196,289,302`（`/Pg`・MCR の `/Pg`） |
| **`page.node.set`** | **1** | `struct-tree.ts:239`（`/StructParents`） |
| **`PDFPage` を `Map` の鍵に** | **3 つの Map** | `struct-tree.ts:92,94,96` |

🔴 **`getSize` は生成パスに 1 つも無い。** 上の「`getSize` 以外に何があるか」は
getSize が生成パスにあるという前提で書いてあったが、実測 2 件は `page-number.ts` と
`watermark.ts` = **どちらも編集パス**。生成パスはページ寸法を `opts` から持っていて、
ページに訊き返さない。**器を差し替えるとき、ページから読み戻す経路は無い。**

🔴 **描画 3 種の外に 4 種目があった。** `pushOperators` / `page.ref` / `page.node` と、
**ページオブジェクトの同一性**（`StructTreeBuilder` が `PDFPage` を `Map` の鍵にしている）。
差し替える器は**ページに安定した同一性**を持たせる必要がある。

`grep -rn "from 'pdf-lib'" src/` は **23 行 / 23 ファイル**（L1 で 24 → 23）。

### この段で分かった、段取り表が持っていなかったもの

1. 🔴 **`PdfDocumentEditor` に「空から作る」入口が無かった。** 構築子は `open(bytes)` と
   `of(base)` だけで、`save()` も `collectObjects(this.base)` と `base.trailer` を土台にする。
   生成パスは入力バイト列が無いので**そのままでは載らない**。§3.5 の受け皿表の
   「文書・ページツリー ✅ `PdfDocumentEditor`」は **load → 編集 → save の面についてで、
   create の面は測られていなかった**。→ **`PdfDocumentEditor.create()` を足した**
   （ADR-0007 §6.5 で改訂・`appendUpdate` は断る・`opened` が 2 つの入口を区別する）
2. 🔴 **「一度に建て直す」を選ぶと L5'（メトリクス自前化）が前に来る。** 段取り表は
   L5' を最後に置いているが、器が pdf-lib の `PDFDocument` でなくなると
   `doc.embedFont('Helvetica')` が呼べない。標準 14 の幅は `@pdf-lib/standard-fonts` の
   AFM から直接取ることになる（同梱済み・`Font.load(FontNames.Helvetica)` で
   `getWidthOfGlyph` / `Ascender` / `FontBBox` が取れることを実測）。
   **L1.5 の決定「メトリクスは writer の関心」はそのままだが、着手時期が動く。**
3. 🔴 **受け皿は「リポジトリにある」だけで、writer からは届いていない。** §3.5 の
   受け皿表の ✅ 6 個（`ContentStreamBuilder` / `StructTreeBuilder` / `TaggedStream` /
   `buildType0Font` / `sniffFontProgram` / `PdfDocumentEditor`）は、**writer が
   依存している `normativepdf@0.3.1` の公開表面に 1 つも無い**（`node_modules/normativepdf/dist/index.d.ts`
   は 30 行・COS / パーサ / シリアライザ / 増分更新まで）。部品 4 と L2 は 2026-08-14 に
   入ったが、0.3.1 の公開は 2026-08-13 で、**まだ載っていない**。
   `lib/normativepdf/package.json` の版も 0.3.1 のまま上がっていない。

   ⚠️ **表の ✅ は「作った」であって「使える」ではない**（[[shipped-is-not-used]]）。
   L3' の型検査は現在この 5 件だけで落ちていた = **書いたコードの誤りではなく、
   依存の順序**である。

   **決定（2026-08-14）: normativepdf 0.4.0 を先に公開し、writer の dep を上げる。**
   ローカル参照（`file:` / `npm link`）にしないのは、戻し忘れると
   **公開版で壊れる**ため（家の作法 = リリース後は npx で公開版を叩く）。
   0.4.0 に載せるのは 部品 4 + L2 + `PdfDocumentEditor.create()` + 下記 MCR で、
   **L3' が要求する表面を 1 度に出し切る**（2 回目のリリースを挟まないため、
   公開前に「L3' が何を呼ぶか」を数え終えてから版を切った）。

4. ⚠️ **生成検体 9 本はすべて 1 ページ**（lock の `pageCount` 実測）。つまり
   **構造要素がページをまたぐ経路（MCR 辞書・旧 `struct-tree.ts:299-305`）はオラクルが測っていない**。
   normativepdf の `StructTreeBuilder` は 2 ページにまたがる要素を**投げて**いた
   （エラー文が Table 357 を名指していた）ので、そのまま載せ替えると
   **測れない面で挙動が静かに変わる**（[[saturated-faces-cannot-carry-a-difference]]）。

   → **normativepdf 側に MCR（Table 357）を入れた**（0.4.0）。要素の内容項目が
   2 ページ以上にまたがるかを**書く直前に走査して**形を決める（`/Pg` + 素の整数 /
   MCR 辞書）ので、オーサリング層は「段落がページで割れた」ことを知らなくてよい。
   MCR は**直接オブジェクト**で書く（Table 357 は辞書を要求しており、
   内容項目 1 つに番号を 1 つ使う理由が無い）。合わせて `TaggedStream.artifact()` の
   subtype 無しを **`BDC <<>>` から `BMC` へ**（Table 352 が 2 つの演算子を持つのは
   プロパティリストの有無を分けるためで、空辞書は「何も持たないリスト」を宣言してしまう）。
   コーパスに素材が無い面なので、テストは合成した検体で取ってある。

   🔴 **この変更で 3 か所を踏んだ。同じ罠が下の L1 の ⚠️ に書いてあるのに踏んだ。**
   `artifact|BMC|Artifact` で grep して「テストは subtype 付きの 1 本だけ」と判断したが、
   拒否のほうを固定していたテスト（`what the builder refuses` の
   "refuses content items of one element on two pages"）は**その語のどれにも当たらない**。
   ホストの `npm test` で 1 件落ちて発覚した。さらに:

   - `docs/ROADMAP.md` に「2 ページにまたがる要素は Table 357 を使えと言って拒否」という
     **文**があった
   - `src/struct/struct-tree.ts` の冒頭の「何を強制するか」一覧にも同じ趣旨が書いてあった

   **教訓は「`tests/` も grep に含める」では足りない。** 変えるのは *挙動* なので、
   探すべきは実装の語ではなく**旧挙動を述べているもの全部**（テスト名・拒否のメッセージ・
   ROADMAP・モジュール冒頭のコメント）である。**文はテストが落ちないので、
   放っておくと嘘が残る**。挙動を変えるときは「これは何を約束していたか」を先に列挙し、
   その約束の文言で grep すること

### L3' の着手分（2026-08-14・**未完・型検査は L3'.0 待ち**）

`pdf-writer-mcp/src/services/` に 3 ファイル。**まだどこからも呼ばれていない**ので、
`grep -rn "from 'pdf-lib'" src/` は 23 行のまま動いていない（[[shipped-is-not-used]] を
自分で踏まないよう明記する）。

| ファイル | 中身 |
|---|---|
| `cos.ts` | COS 値の短縮記法。判断は 1 つも入っていない。`textString` は ASCII ならリテラル・そうでなければ UTF-16BE + BOM（§7.9.2.2）で、**呼び出し側に選ばせない** |
| `writer-doc.ts` | `WriterDocument`（ADR-0007 の (c)）+ `WriterPage`。描画 3 種 = `drawText` / `drawRectangle` / `drawLine` |
| `font-embed.ts` | 標準 14（`@pdf-lib/standard-fonts` の AFM 直読み）と埋め込み Type0（`buildType0Font` + fontkit）。`/W`・記述子・`/ToUnicode` はここで作る |

**旧実装の演算子列は実測してある**（`qpdf --filtered-stream-data`）。テキストは
`q BT r g b rg /F n Tf 24 TL 1 0 0 1 x y Tm <hex> Tj T* ET Q` で、これは踏襲した。

**意図して変えたもの（オラクルに差として出る。出たら「これ」と照合する）**:

1. 🔴 **フォントのリソース名を 1 フォント 1 エントリにする。** 旧実装は `drawText` の
   たびに pdf-lib の `setFont` を通り、**そのたびに乱数サフィックス付きの新しい鍵**を
   作っていた（実測: 1 ページの見出し + 本文で `/NotoSansJP-Regular-7098480789` と
   `-9742682568` の 2 エントリが同じフォントを指す）。同じものに違う名前を配ると、
   読み手にはそれが同じフォントだとファイルから分からない
2. **矩形を `re` で書く。** 旧実装は `translate → rotate(0) → skew(0)` の `cm` を 3 つ
   書いてから `m`/`l` を 4 本並べていた。回転も傾斜も無い矩形に単位行列の `cm` を
   2 つ書くのは**何もしない演算子**である（Table 58 の `re` が同じ図形を 1 つで表す）
3. `/ExtGState` の空辞書と `/Annots` の空配列を書かない（旧実装は常に置いていた）
4. `/Contents` を 1 要素の配列で包まない（Table 31 はストリームそのものを許す）
5. `/ToUnicode` の CMap を自前で組む。**ダイジェストは sha256 しか見ない**ので、
   ここの差は「正しいかどうか」を運ばない → 抽出結果を pdf-reader で読み戻して測ること

⚠️ **記述子の数値は旧実装と一致することを先に確かめた**（Noto Sans JP のサブセットで
`Ascent 1160 / Descent -288 / CapHeight 733 / XHeight 543 / FontBBox [-1002,-1048,2928,1808]`）。
式（`値 × 1000 / unitsPerEm`）は推測ではなく、この照合で決めてある。

**残り**: `struct-tree.ts` の載せ替え・`builder.ts` / `layout.ts` / `renderers` の接続・
`color.ts` の `toPdfLibColor` 撤去・生成用の出口（`finalizePdf` 相当 = Info / XMP / `/ID` /
ヘッダ版）・`page-ops.ts` のページ複写。

### L1 の第 1 手（色）の実測 — 2026-08-14

`src/services/color.ts` を置き、`Rgb` = DeviceRGB の 3 成分（§8.6.4.3）を自前の値にした。
**`renderers/{markdown,table,text}.ts` から pdf-lib の import が消えた**（24 → **22**）。

🔴 **想定が実測で否定された 1 件**: 「描画境界は `layout.ts` だけ」と踏んで変換関数をそこに置いたが、
**型検査が `renderers/{markdown,table}.ts` も `engine.page.drawRectangle` / `drawText` を
直接呼んでいる**ことを突き付けた（境界は 4 箇所）。変換は `color.ts` に移し、
**pdf-lib の色の形を知るファイルを 1 つに**した。撤去が進めば、この関数の中身が
`ContentStreamBuilder` に `rg` を書く実装に変わるだけになる。

**ホスト実走で確定 = 差なし**（25 検体・4 面すべて一致・veraPDF 判定も署名も込み）。
pdf-lib への依存だけが減った。**計器が実際の移行を採点した初回**。

⚠️ **訂正（2026-08-14 実測）**: ここに「出力は 1 バイトも変わらず」と書いていたが、**それは測っていない**。
writer の出力は**バイト単位では決定論的でない** — 同じ dist で 2 回回すと 8 検体すべてが差になる。
差は `/CreationDate` / `/ModDate` / `/ID` の 3 箇所だけで、生バイトでは 585 バイト動く。
だから計器は qpdf の意味的ダイジェストで測っている。**言える主張は「ダイジェストが一致」**であって、
バイト同一ではない。（normativepdf の DESIGN §4.1 の決定論的出力はライブラリ側の保証で、
pdf-lib 版の writer の話ではない。）

🔴 **その過程で計器の欠陥をもう 1 件直した**: ゴールデンを `--verify` 付きで採ってあるのに
素の `npm run oracle` は判定面を測らないため、**毎回 7 件差が出て決して緑にならない**状態だった。
実装の差 0 がその 7 件に埋もれる — **緑にならない検査は読まれなくなる**。
lock が `verifyRan: true` かつ verify サーバがあるときは**既定で判定面も測る**ようにした。

### L1 の残り（回転角・標準 14 書体）— 2026-08-14

`src/services/rotation.ts` を同じ形で置いた（`/Rotate` は 90 の倍数 = §7.7.3.3 Table 31 を
`normalizeRotation` が検査する）。併せて `annotation.ts` の `parseHexColor` を
`color.ts` の `rgbFromHex` に吸収し、**色の表現をコードベースに 1 つ**にした
（`{red,green,blue}` と `{r,g,b}` が並存していた）。`StandardFonts.Helvetica` は
素の名前に（列挙は型の飾りで、実体は PostScript 名の文字列）。

⚠️ **関数を動かすときは `tests/` も同じ grep に含める。** `parseHexColor` を `color.ts` へ吸収したとき、
**呼び出し元は `src/` を全部追ったのに、テストが直接その関数を叩いていることを見落として 2 件落ちた**。
ADR-0006 §9 の用途分類（入力の生産者 14 / 独立した読み手 5）にも、この
**「実装関数そのものを単体で叩くテスト」という第 3 の用途が数えられていない**。
L3（COS プリミティブの置換）では同じ形が何度も出る。

⚠️ **数え方を決めておくこと。** `grep -rl "from 'pdf-lib'" src/` の**ファイル数は 24 → 23 にしか
減らない** — 変換関数を置いた `color.ts` / `rotation.ts` が新たな import 元になるからで、
**依存が減っても数字が動かない**ことがある。進捗は
**「実体（値）を呼ぶファイル数」= 23 → 19** で見る。最終受入（`src/` から 0 件）は、
変換関数の中身が normativepdf の演算子書き込みに変わったときに達成される。

### L1.5 = 文字幅 — 🔴 段取りに無かった第 2 の欠落（2026-08-14）

**L2（文書モデル）を建てても、それだけでは writer は移せない。**
上の §3.5 は「難所は `PDFDocument.context` への register / lookup」と書いており、それは実測どおりだが、
**「この文字列は何 pt 幅か」に答える経路が normativepdf に無い**（実測）:

- normativepdf は `dependencies: {}`。メトリクスの概念がコードベースに 1 行も無い
- `buildType0Font` の `Type0FontSpec.widths` は **呼び出し側が用意する入力**である。
  `/W`（§9.7.4.3）について仕様が決めるのは「辞書にどう書くか」だけで、
  グリフが何 unit 進むかは仕様ではなくフォントプログラム（AFM / hmtx / CFF）が持つ

この穴は L3 にも L4 にも書かれていなかった。見つけずに L2 へ進むと、
**器はできたのに `drawText` を外せない**状態で止まる。

**決定: メトリクスは writer の関心に残す。** normativepdf に AFM を抱えさせると
「仕様が要求する形を書く自前依存 0 のライブラリ」という性格が変わる。writer は既に
`@pdf-lib/fontkit` と `subset-font` を直接の依存に持つので、**埋め込みフォントの
advance の出所はこちら側にある**。残る穴は**標準 14 書体（§9.6.2.2）だけ**で、
その幅は今なお pdf-lib の `PDFFont`（`@pdf-lib/standard-fonts` の AFM）から来ている。

`src/services/metrics.ts` に `TextMetrics` を置き、幅を測る 6 箇所
（`layout.ts` 3 / `table.ts` / `watermark.ts` / `page-number.ts`）をこの型経由にした。
**メソッド名を pdf-lib の `PDFFont` と揃えてある**ので `PDFFont` が構造的にこの型を満たし、
変換関数もアダプタも要らない（§6「変換層を作らない」に触れない）。
`LayoutEngine` は `defaultFont`（描画・pdf-lib のまま）と `defaultMetrics`（測定・自前の型）に
**用途で分けた** — 分けないと、描画が外れる L4 まで測定も動かせない形になる。

⚠️ **この段は依存数を 1 も動かさない**（実体呼び出し 19 → 19）。動くのは
**「pdf-lib の値に直接 `widthOfTextAtSize` を呼ぶ箇所」= 6 → 0**（全 6 箇所が
`TextMetrics` 型の値を経由するようになった）のほう。該当 4 ファイルは今も `PDFFont` を
**描画のために**名指しているので、`grep PDFFont` では動かない。**進捗を 1 本の数字で見ていると
「何もしていない段」に見える**ので、段ごとに何を数えるかを先に決めること。

✅ 実走（サンドボックス・qpdf 10.6.3 + verify）: `create-` 8 検体・`edit-` 9 検体とも**差なし**。
`tests/layout.test.ts` は `PDFFont` を `wrapText` に直接渡しているが、構造的に満たすので**無修正で通る**
（§「関数を動かすときは tests/ も同じ grep に含める」の罠を、型を構造的にすることで回避した形）。

⚠️ **writer は TypeScript 7（プラットフォーム依存バイナリ）なのでサンドボックスで `tsc` が動かない。**
`node ../../lib/normativepdf/node_modules/typescript/bin/tsc -p tsconfig.json` で
normativepdf 側の TS 5.9（純 JS）を借りると型検査もビルドも通る。**借りずに dist を古いまま
オラクルに掛けると、移行していないバイナリを採点して緑になる。**

## 4. 受入

**3 つとも要る。**

1. **pdf-lib の完全撤去** — `grep -rn "pdf-lib" src/` が 0 件、`package.json` からも消える
2. **UC 回帰が全緑** — UC = `pdf-writer-mcp/docs/TASKS.md` のユースケース回帰。
   writer の既存テストと、実測済みの数字を下回らないこと。
   基準値（すべて veraPDF 実測）: PDF/A-3b **146/146 COMPLIANT** / PDF/UA-1 **106/106** /
   PDF/A-4 **109/109**
3. **リリースごとの veraPDF レポート同梱を開始**（ROADMAP 公開トラック）

### 差分オラクルの使い方

移行の各段で **旧実装（pdf-lib 版）と新実装の出力を突き合わせる**（`npm run oracle`）。
これは推奨ではなく、この family で最も効いた検査である —— verify の
`revision-diff.ts` 置換では、旧実装を git から復元して 2,987 件を A/B し、
2,974 件同一・差 13 件を洗い出した。**0.15.0 の修正 2 件はどちらもこの比較で見つかり、
ユニットテストは前後とも全緑で何も出さなかった**。

**writer では git からの復元は取れない**（24 ファイル 7,178 行）。だから
**先にゴールデンを採ってある**（ADR-0006・`scripts/uc-oracle/`）。

~~`compare_structure`（pdf-reader-mcp）が構造木の比較に使える。~~
**訂正（2026-08-13 実測）**: `compare_structure` は 11 プロパティしか比較せず、
うち総オブジェクト数・ストリーム数・ファイルサイズ・catalog エントリ数は
**直列化方式が変われば必ず differ になる**。構造木・フォント辞書の型・コンテンツ演算子は
ひとつも見ていない。この用途では差を運べない（ADR-0006 §3）。

## 5. これが解ける 2 つの詰まり

### reader（`pdf-reader-mcp`）の normativepdf 移行

2026-08-13 に**版数報告だけの部分移行は取り下げた**。理由は ROADMAP に書いてある:

> reader の版数経路は pdf-lib 依存であり、1 フィールドのために normativepdf で
> もう一度フルパースして strict throw を pdf-lib で受けるフォールバック二重構造になる。

**Phase 3 で pdf-lib が消えたら、この二重構造ごと不要になる。** reader の移行は
Phase 3 と一括で行う。

### 自前 inflate（ADR-0003）

ADR-0003 の着手トリガー 3 番が「**段階 2 完了**」である。Phase 3 が終わった時点で、
他の 2 つのトリガーが来ていなくても自前 inflate に着手する条件が立つ。
→ [`own-inflate.md`](own-inflate.md)

⚠️ **ただし Phase 3 の第 1 項目が「フィルタ・コンテンツストリームビルダ」なので、
トリガー 2（書き側 deflate）のほうが先に立つ公算が高い。** 圧縮出力を書くと決めた時点で
inflate の自前化に着手すること — その時に `CompressionStream` に手を伸ばすと
ADR-0003 決定 4 に正面から反する。

## 6. 触ってはいけないもの

- **writer 側の方針を normativepdf に持ち込まない。** `incremental.ts`（**587 行**・2026-08-13 実測）には
  `/ID` の更新（§14.4）・DocMDP 判定・dirty 参照追跡という **writer の方針**が入っている。
  これは移行後も writer に残るもので、ライブラリ側の関心ではない
- **pdf-lib → COS の変換層を作らない。** 段階 1 の判断（2026-08-13）で明示的に見送った。
  Phase 3 で pdf-lib が消えたら丸ごと不要になるものだから
- **決定論的出力（DESIGN §4.1）を崩さない。** 圧縮を入れたくなったら
  `CompressionStream` ではなく固定パラメータの自前 deflate（ADR-0003 決定 4）
- **コーパス門番の pin と実装変更を同じ commit に入れない**

## 7. 参照

- [`../ROADMAP.md`](../ROADMAP.md) Phase 3 — 項目の正典
- [`../DESIGN.md`](../DESIGN.md) §3（適合宣言は要件検査と同関数に）/ §4.1（決定論的出力）
- [`../adr/0004-roundtrip-acceptance.md`](../adr/0004-roundtrip-acceptance.md) — 「二面で測る」
- [`../GUARDS.md`](../GUARDS.md) — T-2（自分で読み戻しても共有の誤りは出ない）/ G-6（差分で採点する）
- `pdf-writer-mcp/docs/DESIGN.md` — 撤去される側の設計
