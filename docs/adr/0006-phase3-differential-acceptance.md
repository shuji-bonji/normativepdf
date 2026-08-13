# ADR-0006: Phase 3（生成パス移行 = pdf-lib 撤去）の受入 — 差分オラクルで測る

- 状態: Accepted（2026-08-13）
- 関連: [ADR-0004](0004-roundtrip-acceptance.md)（二面で測る）/ [ADR-0005](0005-incremental-update-acceptance.md) /
  [`../ROADMAP.md`](../ROADMAP.md) Phase 3 / [`../GUARDS.md`](../GUARDS.md) T-2・G-6 /
  [`../handoff/phase3-pdflib-removal.md`](../handoff/phase3-pdflib-removal.md)
- 実装: `pdf-writer-mcp/scripts/uc-oracle/`（`npm run oracle`）

## 文脈

Phase 3 は「pdf-lib を消す」作業ではなく「生成パスを normativepdf の上に建て直す」作業である。
**着手前の実測（2026-08-13）**:

| 面 | 実測 |
|---|---|
| `src/` の pdf-lib 依存 | **24 ファイル / 7,178 行**（`grep -rn "from 'pdf-lib'" src/` = 24 行） |
| `tests/` の pdf-lib 依存 | **21 ファイル / 5,475 行**（handoff は数えていなかった） |
| 依存 | `pdf-lib` / `@pdf-lib/fontkit` / `subset-font` |
| 使っている型（多い順） | PDFDocument 16 / PDFName 15 / PDFRef 12 / PDFDict 12 / PDFArray 11 / PDFPage 9 …
  加えて AcroForm 高水準 API・`PDFObjectCopier`・`PDFObjectParser`・演算子群 |

段階 1 と違い、**バイト一致は最初から成立しない**。直列化も採番も圧縮も変わるからである。
では何と一致すれば「壊していない」と言えるのか — それを先に決めるのが本 ADR である
（ADR-0004 / ADR-0005 と同じ順序: 受入基準を実装より先に決める）。

そして急ぐ理由がある。**旧実装の出力は、撤去してしまえば二度と作れない。**
verify の `revision-diff.ts` 置換では旧実装を git から復元して 2,987 件を A/B し、
差 13 件を洗い出した（[[ab-old-implementation-from-git]]）。
そのとき**ユニットテストは前後とも全緑で 1 件も出さなかった**。
writer は 24 ファイル 7,178 行なので「git から復元して並走させる」形は取れない。
**採取を撤去の前に済ませる**ほかない。

## 決定

### 1. 受入は 4 面で取る。1 面でも欠けたら受入としない

| 面 | 何を見るか | 誰が判定するか |
|---|---|---|
| **構造** | 意味的構造ダイジェストがゴールデンと一致 | qpdf（独立実装） |
| **応答** | MCP ツールの応答 JSON が一致（警告文を含む） | writer 自身 |
| **可読性** | `qpdf --check` の苦情が増えていない | qpdf |
| **適合** | veraPDF `pdfa-3b` **146/146** / `pdfua-1` **106/106** / `pdfa-4f` **109/109** | veraPDF |

「応答」を面に入れるのは、**警告が消えることが後退だから**である。
`ensure_pdfa` が返す「この文書は適合を*名乗った*が検査はしていない」の警告は
family の規律そのもので、出力バイト列には現れない。

### 2. ダイジェストは qpdf から作る。family 内のパーサでは作らない

自分の出力を自分のパーサで読み戻すと、書きの誤りと読みの誤りが打ち消し合う（GUARDS T-2）。
Phase 3 の後は writer も pdf-reader-mcp も normativepdf の上に乗るので、
**family 内のどのパーサもオラクルになれない**。読み手は qpdf（C++ の別実装）1 つに限る。

### 3. `compare_structure` はオラクルにしない（handoff の記述を訂正する）

handoff `phase3-pdflib-removal.md` は「`compare_structure`（pdf-reader-mcp）が構造木の比較に使える」と
書いているが、**実測すると使えない**（2026-08-13・`invoice.pdf` × `invoice-with-data.pdf`）:

- 比較するのは **11 プロパティ**（ページ数・版・暗号化・タグ有無・総オブジェクト数・
  ストリーム数・寸法・ファイルサイズ・catalog エントリ数・署名有無・フォント数）
- うち **総オブジェクト数・ストリーム数・ファイルサイズ・catalog エントリ数は、
  直列化方式が変われば必ず differ になる**（オブジェクトストリーム化・採番・圧縮）
- **構造木・フォント辞書の型・コンテンツ演算子はひとつも見ていない**

つまり Phase 3 の差を運べない面である（[[saturated-faces-cannot-carry-a-difference]]）。
名前が「構造の比較」なので、読むと使えるように見えるところが危ない。

### 4. 何を「差ではない」とするかを列挙して固定する

正規化する（差と見なさない）: オブジェクト番号・世代・オフセット・xref 形式・
オブジェクトストリーム化・圧縮フィルタ・`/Length`・`/ID`・日付（`/M` は `<date>` に畳むが**キーの有無は見る**）・
`/Producer` `/Creator`・**リソース辞書のキー名**（`/F1` か `/NotoSansJP-Regular-1848524175` かは実装の勝手）・
実数の表記（4 桁に丸め）・文字列リテラルの中身（長さと種別のみ）。

**ここに挙がっていないものは全部差として出る。** 一覧は `digest.mjs` の先頭に置き、
足すときは理由を書く。

### 5. 検体は「ツールごと」ではなく「軸の組み合わせ」で並べる

フィクスチャが 1 形しか作らない軸は永久に測られない
（[[fixtures-produce-only-one-shape]]。既存テストが全部 origin = 0 だったせいで、
`startxref` を絶対位置として扱う欠陥 B-22 が 0.19.0 まで生き延びた）。
軸: pdfVersion / フォント種別 / tagged / 入力の xref 形式 / origin / 署名 / 添付 / フォーム。
ハーネスは **1 形しか無い軸を毎回出力する**（`axisCoverage`）。

### 6. 判定不能は緑に数えない

veraPDF が無い・フォントが無い・入力検体が無い場合は `unavailable` / `undecided` として
**本数を lock に固定する**。緑にも赤にもしない。測れなかったものを合格に数えると、
**下手な実装ほど失敗が減る**（[[undecided-is-not-innocent]]）。
「ゴールデンでは判定できていたものが判定不能になった」は**後退として赤にする**。

### 7. ゴールデンは pdf-lib 版 0.19.0 で採る。実装変更と同じコミットで更新しない

corpus 門番と同じ規律（`corpus.lock.json`）。基準を動かしながら測ることになるため。

### 8. AcroForm の入力検体は今のうちに凍結する

writer のテストはフォーム検体を **pdf-lib で毎回組み立てている**（`tests/form.test.ts` の `makeFormPdf`）。
撤去すると**検体を作る手段ごと消える**ので、フォーム系の UC は
「新実装で作った入力を新実装で読む」ことになり、誤りが打ち消し合う（T-2）。
→ `scripts/uc-oracle/make-inputs.mjs` で 1 回だけ生成し、
`scripts/uc-oracle/inputs/form-basic.pdf` としてバイト列で固定した。以後再生成しない。

### 9. pdf-lib は「実行時依存 0」を受入とする。テストの pdf-lib は役割で分ける

受入の文言は「`grep -rn "from 'pdf-lib'" src/` が 0 件・`dependencies` から消える」。
`devDependencies` に残る pdf-lib は撤去の失敗ではない。ただし「残してよい」で済ませると
何が守られているのか分からなくなるので、**用途を実測して分けた**（2026-08-14）:

| 用途 | ファイル数 | 撤去後の扱い |
|---|---|---|
| 検体をディスクに書いて writer に食わせる（入力の生産者） | **14** | **残す** — 他所が作った PDF を食う形が実態に近い |
| 出力を読んで検査する（独立した読み手） | **5**（＋他ファイルにも混在） | **残す** — normativepdf と 1 行もコードを共有しない外の目（T-2） |
| 凍結済みの検体ファイル | **0** | ← ここが問題 |

**`tests/` に凍結された PDF は 1 つも無く、入力は毎回 pdf-lib が組み立てている。**
つまり pdf-lib を完全に消すと、14 ファイルは**検査対象ではなく入力を失って**落ちる。
これは「テストを直す」作業ではなく「測る対象が消える」事故なので、順序を決めておく:

1. **実行時依存だけを 0 にする**（受入はここ）。`devDependencies` の pdf-lib は残す
2. **欠陥クラスを 1 つ守っている入力は凍結する** — その検体が消えると、対応する欠陥の再発を
   誰も見なくなるもの。既に凍結したのは AcroForm（`uc-oracle/inputs/form-basic.pdf`）。
   同じ資格を持つのは origin > 0（B-22）とフォント種別（W-2）で、どちらも
   `uc-oracle` 側に外部検体として置いてある
3. **devDependencies からも落とすのは、同じ面を qpdf で覆えたとき**。今は覆えていない —
   `uc-oracle` は成果物の粒度で測っており、`tests/` は writer 内部の分岐の粒度で突いている。
   粒度が違うものを「どちらも緑だから片方でよい」と畳まない

## 測ってあること（2026-08-13・サンドボックス実走）

- 検体 24 本中 **23 本を採取**・1 本は `unavailable`
- **2 回続けて回して差 0**（決定論。初回は注釈の `/M` が実行ごとに変わって割れた → `<date>` に正規化）
- **T-3（壊すと落ちるか）を 3 面で実測**:

| 壊した箇所 | 出た差 |
|---|---|
| ページ番号の色 `#666666` → `#3366aa` | `/pages/0//Contents/3/@stream/ops`: `0.4 0.4 0.4 rg` → `0.2 0.4 0.6667 rg` |
| W-2 の是正を戻す（`CIDFontType0` → `CIDFontType2`） | `/pages/0//Resources//Font//Font#0//DescendantFonts/0//Subtype` |
| `ensure_pdfa` の警告文 `CLAIMS` → `claims` | `[tool-response] /1/response/warnings/0` |
| 読み手を厳しくする（qpdf 12 の拒否を再現） | `[structure-readability] measured → unreadable`（入力も読めない旨つき） |

- 🔴 **T-3 が最初に発火せず、計器の欠陥を 1 件見つけた**。ページへの参照を全部
  `{"@page": i}` に畳んでいたため、**ページの中身（リソース・注釈・コンテンツストリーム）が
  ダイジェストに 1 バイトも入っていなかった**。色を変えても差が出ないことで露見した。
  ページは page tree の位置で 1 回だけ展開し、他の場所からの参照だけを畳む形に修正した。
  **計器も T-3 を通すまでは信用しない。**

### 面ごとに測る（1 面が測れないことを「失敗」に化けさせない）

読み手が拒む検体がある。**そのとき残りの面まで捨てない。**
実測（2026-08-13・ホスト qpdf **12.4.0**）: `dss-pades-5sigs-doctimestamp.pdf` に注釈を追記した出力を
qpdf 12 が `unable to find page tree` で拒み、検体ごと `failed` になった。
サンドボックスの qpdf **10.6.3** は同じ出力を読めていた。

切り分けると **writer の後退ではなかった**:

- **入力の時点で**同じ苦情が出る（`qpdf --check` = page tree ノードに `/Type /Page` が無い・obj 56 が null）
- qpdf 10 は "overriding" して進み、qpdf 12 は `--json` で拒む
- 署名の面は両方で測れている（署名 6 本・有効 5 本・digest 一致 6）

→ 構造の面だけを `unreadable` として記録し、**入力を同じ読み手に通した結果（`inputReadable`）を
一緒に残す**。原因の帰属を人の記憶ではなく記録で決めるため。
「読めていた → 読めない」は後退として赤にする（逆向きも黙って通さない）。

**読み手の版はゴールデンに記録し、違えば警告する。** 差が実装のものか読み手のものか
切り分けられないため（qpdf 10 と 12 で結果が違う実例がこれである）。

## ゴールデンの中身（2026-08-13・ホスト実走・qpdf 12.4.0 + veraPDF）

`uc-oracle.lock.json` = writer 0.19.0 / **測定 25・測れず 0・失敗 0**（うち構造を読めなかった検体 1。
TrueType 検体 2 本を足した後の数字）。**適合の 4 面がすべて判定済みになった**:

| 検体 | flavour | 判定 |
|---|---|---|
| `conformance-attach-pdfa3b` | `pdfa-3b` | COMPLIANT **146/146** |
| `conformance-ttf-pdfa3b` | `pdfa-3b` | COMPLIANT **146/146**（TrueType 埋め込み側） |
| `conformance-attach-pdfa4f` | `pdfa-4f` | COMPLIANT **109/109** |
| `conformance-attach-pdfa4-bare` | `pdfa-4` | **NOT COMPLIANT 108/109**（`ISO 19005-4:2020 6.9-3`）= **落ちることが正しい検体** |
| `conformance-ensure-tagged-ua1` / `conformance-tagged-ua1` | `pdfua-1` | COMPLIANT **106/106**（2 本とも） |
| `input-signed-preserve` | 署名 | 2 本・有効 2・digest 一致 2 |
| `input-signed-5sigs` | 署名 | 6 本・有効 5・digest 一致 6（構造面のみ unreadable） |

`docs/TASKS.md` の散文に手で書かれていた 146/146 ・106/106 ・109/109 が、
**再現手順つきでファイルに固定された**。判定は veraPDF のものであって「ISO 19005 準拠」ではない（T2）。

## フォント種別の軸を開けた（2026-08-14・追記）

当初「`.ttf` が手元に 1 本も無い」ため測れていなかった軸を埋めた。
Liberation Sans（SIL OFL 1.1）を `scripts/uc-oracle/fonts/` に同梱し（出所と全文は同ディレクトリの
`.LICENSE.txt`・公開パッケージには入らない）、検体を 2 本足した:
`create-text-ttf-17-tagged` と `conformance-ttf-pdfa3b`。

**分岐が本当に別であることを先に実測した**（同じ本文・同じ引数でフォントだけ差し替え）:

| 入力 | 出る辞書 |
|---|---|
| `.otf`（CFF ベース） | `/Subtype /CIDFontType0` + `/FontFile3 /Subtype /OpenType` |
| `.ttf`（glyf ベース） | `/Subtype /CIDFontType2` + `/FontFile2` |

W-2 は **前者を後者の形で埋めていた** shall 違反（R-9.9.1-33/-34）である。
片方しか検体が無ければ、分岐を取り違えても緑のままになる。適合の面も種別ごとに分けた —
PDF/A のフォント規則は辞書型ごとに別経路なので、CFF 側の 146/146 は TrueType 側の保証にならない。

## 測っていないこと（このコミット時点）
- 暗号化 PDF（writer は復号しない）・画像 XObject を含む検体・複数ページ構造木の深い入れ子

## 結果として何が変わるか

1. Phase 3 の各段で `npm run oracle` を回す。差が出たら**それが意図した差か**を人が判断し、
   意図した差なら lock を**単独のコミット**で更新する
2. reader の normativepdf 移行（Phase 3 と一括）でも同じ形が使える。
   reader は読み手なので、ゴールデンは「ツール応答 JSON」側が主になる
3. 「146/146」のような数字が**文書の散文ではなくファイルに固定される**。
   これまで veraPDF の数字は `docs/TASKS.md` の本文に手で書かれており、
   再現手順が無く、誰も回していなかった
