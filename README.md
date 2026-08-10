# normativepdf

> **条文駆動の PDF ライブラリ。** すべての挙動を ISO の条項に紐づけ、紐づけられないものは主張しない。
>
> 🚧 **開発初期。** 設計は確定済み（2026-08-08・[`docs/DESIGN.md`](docs/DESIGN.md)）、
> 実装は段階 0（COS オブジェクトモデル + パーサ）から。コードはまだ無い。
> 名前の選定経緯は [`NAMING.md`](NAMING.md)、公開計画は [`docs/PUBLISHING.md`](docs/PUBLISHING.md)。

---

## 何を作るのか

**出力が veraPDF を通ることを、リリースごとに証明する TypeScript の PDF ツールチェーン。**
その中核として、`pdf-lib` への委譲を解消する構造層の純 TypeScript 実装を作ります。

「pdf-lib の後継」は名乗りません（その席は `@cantoo/pdf-lib` が埋めています）。
空いているのは「作れる」ではなく **「測ってある」** です — 詳細は [`docs/PUBLISHING.md`](docs/PUBLISHING.md)。

PDF family（`pdf-spec-mcp` / `pdf-reader-mcp` / `pdf-writer-mcp` / `pdf-verify-mcp`）は
仕様原文・読み・書き・検証を分離して持っていますが、**書き手の実体は `pdf-lib` に委譲**しています。
その結果、条文違反を特定できても直せない状態が生じています（[`docs/PRIOR-ART.md`](docs/PRIOR-ART.md) の W-2〜W-4）。

このライブラリは、その委譲を解消するために作ります。

## 射程

| ターゲット | 状態 |
|---|---|
| **ISO 32000-1:2008**（PDF 1.7） | ✅ 対象 |
| **ISO 32000-2:2020**（PDF 2.0）+ Errata Collection 3 | ✅ 対象 |
| **ISO 14289-1 / -2**（PDF/UA-1 / UA-2） | ✅ 対象 |
| **ISO/TS 32001〜32005** | ✅ 対象（UA-2 は TS 32005 をハード要件とする） |
| **ISO 19005-1〜4**（PDF/A） | ⏸ **保留** |

### なぜ PDF/A を保留するのか

**条文を手元に持っていないからです。** ISO 19005 は有償で、無償配布されていません。

条文なしに「PDF/A 対応」を名乗ると、検証器の出力に合わせて実装を調整するだけの
**検証器駆動**になり、veraPDF への過適合を招きます。
これは PDF family の射程定義（`~/workspace/shuji-bonji/Document-Note/mcps/PDFfamily/specs/09-family-scope.md` §2）で
**T2（機械判定のみ）**として明示的に区別している領域です。

**ただし、名乗らないことと通らないことは別です。**
PDF/A の要件の大半は 32000-1/-2 の機能制限（フォント埋め込み必須・暗号化禁止・OutputIntent 必須・
透明度制限）であり、**32000-1/-2 に厳密な実装は PDF/A の土台をほぼ満たします。**

| | 実力 | 主張 |
|---|---|---|
| このライブラリ | veraPDF を通せる | **PDF/A とは名乗らない** |
| （比較）pdfnative | Latin 既定で veraPDF 不合格 | PDF/A-2b を XMP に書く |

採用実績が増えるかスポンサーが付いた時点で ISO 19005-2 を調達し、初めて主張に格上げします。
それまでは無償資源（veraPDF validation profiles / PDF Association TechNote 0010）で補います。

## 設計方針（要点）

1. **戦う範囲は構造層。** XMP・構造木・タグ・フォント辞書・オブジェクト構文。
   テキストシェイピング（GSUB/GPOS・BiDi・複雑文字体系）は**別ドメインの沼**であり、当面は戦わない。
2. **PDF/UA を後付けにしない。** タグ付きを一級市民として設計する。`pdf-lib` で最も苦労している層。
3. **主張と実体を乖離させない。** 適合を主張するなら、その要件を満たせないときは書かずに落ちる（[`docs/GUARDS.md`](docs/GUARDS.md)）。
4. **PDF 2.0 を基盤にする。** ISO 14289-2 §6.2 が ISO 32000-2 + TS 32005 をハード要件とするため、
   PDF 1.7 基盤の実装は PDF/UA-2 に原理的に到達できない。

詳細は [`docs/DESIGN.md`](docs/DESIGN.md)。

## 開発の進め方

**検証器を先に完成させてから実装を書く**（テスト駆動の極大版）。

```
pdf-spec-mcp   条文（何が正しいか）
      ↓
   実装を書く
      ↓
pdf-reader-mcp 読み戻して入力と照合
      ↓
pdf-verify-mcp veraPDF で機械採点
      ↓
   条文に戻って差分を潰す
```

このループの手順則は [`docs/GUARDS.md`](docs/GUARDS.md) に G-1〜G-6 として固定しています。
**exit 0 を成功と読まない**、**宣言と検証をペアで呼ぶ**、**変換系は入力と出力の差分で採点する** など、
すべて実測から出たものです。

## 言語

**TypeScript（確定・2026-08-08）。** 理由の中核は査読可能性。
経緯は [`docs/adr/0001-language-choice.md`](docs/adr/0001-language-choice.md)（Accepted）。

## 想定される利用先

- `pdf-writer-mcp` の `pdf-lib` 依存の置き換え
- Editor PWA
- e-shiwake の PDF 操作（電帳法・PDF/A-3 添付）

## 関連

> ⚠️ 以下 `~/workspace/shuji-bonji/` 配下の参照は**作業環境内の非公開資料**であり、
> 公開リポジトリからは解決しません。公開時に必要な内容は
> [`docs/PRIOR-ART.md`](docs/PRIOR-ART.md) / [`docs/GUARDS.md`](docs/GUARDS.md) に転記済みです。

- `~/workspace/shuji-bonji/Document-Note/mcps/PDFfamily/specs/09-family-scope.md` — PDF family の射程定義（**正典**）
- `~/workspace/shuji-bonji/Document-Note/mcps/PDFfamily/specs/00-overview.md` — family 全体俯瞰
- `~/workspace/shuji-bonji/mcps/pdfnative-audit/AUDIT-2026-07-20.md` — 先行実装の受入監査
