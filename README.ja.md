# normativepdf

> **条文駆動の PDF ライブラリ（純 TypeScript）。** すべての挙動を ISO の条項に紐づけ、紐づけられないものは主張しない。
>
> 🚧 **開発初期。** 段階 0（COS オブジェクトモデル + パーサ）は実装済みで、公開コーパスで実測済み。npm は未公開。
>
> English: [README.md](README.md)

---

## 何を目指すのか

**出力が veraPDF を通ることを、リリースごとに証明する TypeScript の PDF ツールチェーン。**

目指すのは汎用の純 TypeScript PDF ライブラリです。「pdf-lib の後継」は名乗りません — その席は埋まっています。
JS/TS 圏で空いている席は「作れる」ではなく **「測ってある」** です:
独立検証器を通ることをリリースごとに示し続けているライブラリは今日存在しません。
このライブラリはそこに座るために作ります（[docs/PUBLISHING.md](docs/PUBLISHING.md)）。

最初の利用者は PDF family（pdf-spec-mcp / pdf-reader-mcp / pdf-writer-mcp / pdf-verify-mcp）です。
family の書き手は現在 `pdf-lib` に委譲しており、条文違反を特定できても直せない状態が生じています
（[docs/PRIOR-ART.md](docs/PRIOR-ART.md)）。**family は最初の利用者であって、ターゲットではありません。**

## 現在地（段階 0・2026-08-11）

| 門番 | 結果 |
|---|---|
| [pdf20examples](https://github.com/pdf-association/pdf20examples)（CC BY-SA 4.0） | **7/7 パース**（全 in-use/compressed オブジェクトの解決 + catalog まで） |
| [veraPDF-corpus](https://github.com/veraPDF/veraPDF-corpus)（CC BY 4.0・2907 検体・Isartor 同梱） | **99.1% パース・pass 検体は全件通過。** 落ちる 26 件はすべて意図的破損の fail 検体で、違反条項を名指しして拒否 |

実装済み: COS オブジェクトモデル（10 種判別ユニオン）・レキサ・オブジェクトパーサ・
ファイル構造パーサ（古典 xref・trailer・Prev チェーン・増分更新）・xref ストリーム・
オブジェクトストリーム・FlateDecode + PNG/TIFF Predictor・catalog /Version 格上げ（Table 29）。
エラーメッセージはすべて根拠条項を引用します。

回復パースは実測駆動です: 独立検証器が受理する検体がパースできないときにだけ緩和し、
各緩和は根拠となった検体名を記録します。

## 射程

| ターゲット | 状態 |
|---|---|
| **ISO 32000-1:2008**（PDF 1.7） | ✅ 対象 |
| **ISO 32000-2:2020**（PDF 2.0）+ Errata Collection 3 | ✅ 対象 |
| **ISO 14289-1 / -2**（PDF/UA-1 / UA-2） | ✅ 対象（UA-2 は TS 32005 をハード要件とする） |
| **ISO/TS 32001〜32005** | ✅ 対象 |
| **ISO 19005-1〜4**（PDF/A） | ⏸ **保留** |

### なぜ PDF/A を保留するのか

**条文を手元に持っていないからです。** ISO 19005 は有償です。条文なしに「PDF/A 対応」を
名乗ると、検証器の出力に実装を合わせるだけの検証器駆動になります。

ただし、名乗らないことと通らないことは別です。PDF/A の要件の大半は 32000 の機能制限
（フォント埋め込み必須・暗号化禁止・OutputIntent・透明度制限）であり、32000-1/-2 に厳密な
実装は土台をほぼ満たします。**規格を調達するまで、veraPDF を「通す」ことは目指しても
ISO 19005 適合は「名乗らない」** — 書ける/書けないの線引きは
[docs/PUBLISHING.md](docs/PUBLISHING.md) が正典です。

## 設計方針（要点）

1. **戦う範囲は構造層。** XMP・構造木・タグ・フォント辞書・オブジェクト構文。
   テキストシェイピング（GSUB/GPOS・BiDi・複雑文字体系）は別ドメインの沼であり戦わない。
2. **タグ付き PDF を一級市民として設計する** — `pdf-lib` が最も苦労している層。
3. **主張と実体を乖離させない。** 適合宣言を書くコードは要件検査と同じ関数に閉じ、
   検査できなければ書かずに落ちる（[docs/GUARDS.md](docs/GUARDS.md)）。
4. **PDF 2.0 を基盤にする。** ISO 14289-2 §6.2 が ISO 32000-2 + TS 32005 を要求するため、
   PDF 1.7 基盤では PDF/UA-2 に原理的に到達できない。
5. **決定論的出力。** 時刻・乱数に依存しない。`/ID`・日時・署名は明示注入。

## 開発の進め方

検証器を先に完成させてから実装を書く（テスト駆動の極大版）:

```
pdf-spec-mcp   条文（何が正しいか）— 実装判断の前に必ず引く
      ↓
   実装を書く
      ↓
   読み戻し    独立実装（qpdf --check / poppler / veraPDF）で照合
      ↓
pdf-verify-mcp veraPDF で機械採点
      ↓
   条文に戻って差分を潰す
```

このループの不変条件は [docs/GUARDS.md](docs/GUARDS.md) に G-1〜G-6 として固定しています。

## 言語

**TypeScript**（2026-08-08 確定・中核は査読可能性）。
経緯は [docs/adr/0001-language-choice.md](docs/adr/0001-language-choice.md)。

## 想定される利用先

- `pdf-writer-mcp` の `pdf-lib` 依存の置き換え
- PDF エディタ PWA
- e-shiwake の請求書発行（電子署名・電帳法向け PDF/A-3 添付）

## ライセンス

[MIT](LICENSE)
