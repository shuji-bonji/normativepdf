# 引き継ぎ: Phase 3（段階 2）— 生成パスの移行 = pdf-lib 撤去

- 対象リポジトリ: `normativepdf`（実装）+ `pdf-writer-mcp`（第一利用者）
- 根拠: [`../ROADMAP.md`](../ROADMAP.md) Phase 3 / [`../DESIGN.md`](../DESIGN.md)
- **これが今いちばん大きい。他の 2 件（自前 inflate / reader 移行）の着手条件がここに繋がっている**
- この文書だけで着手できる。他の引き継ぎを読む必要は無い

---

## 1. どこまで来たか（2026-08-13 実測）

| Phase | 内容 | 状態 |
|---|---|---|
| 0 | 準備 | ✅ 2026-08-08 |
| 1 | 段階 0 = COS モデル + レキサ + パーサ | ✅ 受入充足（自前 inflate のみ残置） |
| 2 | 段階 1 = シリアライザ + 増分更新 | ✅ 受入充足 2026-08-13（npm 0.3.1 公開） |
| **3** | **段階 2 = 生成パス移行（pdf-lib 撤去）** | **⬅ ここ・未着手** |
| 4 | 段階 3 = PDF 2.0 の実体 | — |
| 5 | 段階 4 = PDF/UA-2 + WTPDF | — |

段階 1 までで、normativepdf は**読めて・書けて・追記できる**。
`writeFile` / `appendUpdate` / `buildObjectStream` / `buildXrefStream` が揃い、
往復はコーパス 2,881/2,881、qpdf は元ファイルに無い苦情を出さない。

**writer が normativepdf に移したのは、増分更新の「直前 xref セクションを読む」ところだけ**である
（0.19.0 = `readXrefSectionAt`。チェーンは歩かない・位置の特定と回復方針は writer に残る・
**直列化は pdf-lib のまま**）。読み側全般が移ったわけではない。

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

## 3. やること（ROADMAP Phase 3 の 7 項目）

- [ ] フィルタ・コンテンツストリームビルダ
- [ ] フォント辞書 — **W-2 の再発を構造的に封じる**。W-2 自体は
      **writer v0.14.0 で是正済み**（CFF `.otf` を `CIDFontType2 + FontFile2` で埋めていた =
      R-9.9.1-33/-34 の shall 違反。`pdf-writer-mcp/docs/SPEC-REAUDIT-2026-07-19.md`）。
      ここでやるのは修正ではなく、**サブセット結果とフォント辞書型が食い違えないデータ構造にする**こと
- [ ] 構造木・タグ・MarkInfo（PDF/UA-1 系）
- [ ] XMP・OutputIntent・catalog — **適合宣言は要件検査と同関数に**（DESIGN §3）
- [ ] pdf-lib 差分オラクル運用（`compare_structure`）
- [ ] 受入: pdf-lib 撤去 + UC 回帰全緑 + PDF/A-3b COMPLIANT
- [ ] PDF family へ取り込み（writer が第一利用者・自身でコントリビュート）

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
