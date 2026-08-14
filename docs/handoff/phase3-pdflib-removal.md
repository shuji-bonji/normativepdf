# 引き継ぎ: Phase 3（段階 2）— 生成パスの移行 = pdf-lib 撤去

- 対象リポジトリ: `normativepdf`（実装）+ `pdf-writer-mcp`（第一利用者）
- 根拠: [`../ROADMAP.md`](../ROADMAP.md) Phase 3 / [`../DESIGN.md`](../DESIGN.md)
- **これが今いちばん大きい。他の 2 件（自前 inflate / reader 移行）の着手条件がここに繋がっている**
- この文書だけで着手できる。他の引き継ぎを読む必要は無い

---

## 1. どこまで来たか（2026-08-14 実測）

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | 準備 | ✅ 2026-08-08 |
| 1 | 段階 0 = COS モデル + レキサ + パーサ | ✅ 受入充足（自前 inflate のみ残置） |
| 2 | 段階 1 = シリアライザ + 増分更新 | ✅ 受入充足 2026-08-13（npm 0.3.1 公開） |
| **3** | **段階 2 = 生成パス移行（pdf-lib 撤去）** | **⬅ ここ。7 項目中 4 つ完了（部品は揃った）。writer は L1（値）+ L1.5（文字幅）まで。L2（文書モデル）が次** |
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

🔴 **そして normativepdf には文書モデルがまだ無い。**
今あるのは COS・パーサ・シリアライザ・増分更新・コンテンツ/フォント/構造木/宣言のビルダで、
**ページツリー・リソース辞書・catalog を持つ「文書」と、その load → 編集 → save の器が無い**。
これが次に作るものである。順序を間違えると、器が無いままサービスを 1 つずつ移そうとして
pdf-lib → COS の変換層を書くことになる（§6 で作らないと決めたもの）。

### 段取り

| 段 | 中身 | なぜここか | 見える成果 |
|---|---|---|---|
| **L1** | `rgb` / `degrees` / `StandardFonts` の置き換え | PDF の意味を持たない値コンストラクタで、文書モデルに触らない | **完了（2026-08-14）。実体呼び出し 23 → 19 ファイル** |
| **L1.5** | **文字幅**（`TextMetrics` = `metrics.ts`） | 🔴 **当初この表に無かった。** L2 の器を建てても、幅を訊く先が無いとテキストが 1 文字も置けない（下記） | **完了（2026-08-14）。実体呼び出しは 19 のまま — この段は依存数を動かさない** |
| **L2** | **文書モデル**（グラフ容器 + ページツリーの意味規定）→ [`l2-document-model.md`](l2-document-model.md) | 上の実測どおり、ここが無いと他が動かない。**load の入口が 1 箇所**なので seam は 1 つで済む | 器が立つ。ここだけは新規実装で、オラクルは「まだ writer が使っていない」ので緑のまま。**受入は normativepdf 側で完結させる**（ADR-0007 §5） |
| **L3** | COS プリミティブ（`PDFName`/`PDFArray`/`PDFDict`/`PDFRef`/`PDFNumber`/文字列系） | L2 の器の上でしか置き換えられない。件数は多いが 1 対 1 の機械的な置換 | 依存の大半が消える |
| **L4** | 部分系: フォーム API（`form.ts` に 7 クラス）・注釈の外観（`annotation.ts` の演算子 10 個 → `ContentStreamBuilder`）・構造木（`struct-*.ts` → `StructTreeBuilder`）・`PDFObjectCopier`（merge）・`decodePDFRawStream` | 今日作った部品が受け皿になる。**annotation と struct 系は置き換え先が既にある** | 残りが落ちる |

**各段の後に `npm run oracle` を回す。** 差が出たら「意図した差か」を人が判断し、
意図した差なら **lock を単独のコミットで**更新する（ADR-0006 §7）。

⚠️ **L1 を「軽いから」で飛ばさないこと。** 計器を**実際の移行**で 1 度通してから先へ行く。

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
