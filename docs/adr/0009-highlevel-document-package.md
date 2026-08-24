# ADR-0009: 高レベル層は別パッケージ `@normativepdf/document` として建てる

- 状態: **Accepted**
- 日付: 2026-08-24
- 決定者: shuji

## 背景

[ADR-0007](0007-document-model-scope.md) は「文書モデル」を 3 つに割り、
(c) オーサリング API（addPage / drawText / レイアウト）を **「writer（作らない）」** とした。
一方 [DESIGN §6.1-5](../DESIGN.md) は「高レベル層は…コアを崩さず**上に別パッケージとして
載せられる**形を保つ。将来のコントリビューション領域として設計上の受け皿を残す」と、
受け皿だけを確保していた。

2026-08-24、**「誰でも手軽に PDF を組み立てる高レベルライブラリ」を目指す**方針が決まり
（shuji）、この受け皿を行使する。ROADMAP 更新規則 3（スコープ変更は ADR に起こす）に従い
本 ADR がその記録である。

## 決定

### 1. 器 = 別 npm パッケージ `@normativepdf/document`

- npm Organization `normativepdf` は **2026-08-24 に確保済み**。
- **コアは unscoped `normativepdf` のまま**。`@normativepdf/core` への改名はしない —
  公開済みのパッケージ（v0.8.0）と二重になり、deprecation で誘導する移行コストだけが
  発生する。unscoped の所有権を org へ移す管理の一本化は、後からいつでもできる。
- 実行時のバンドルサイズは器の選択理由ではない（別パッケージでも subpath でも
  「import したエントリのグラフだけ」が入る。`sideEffects: false` は宣言済み）。
  別パッケージを選ぶ本質理由は 3 つ:
  **①semver の独立**（document は当面速い刻み・コアは安定期）
  **②コアの「dependencies: 0」を npm ページごと看板として維持できる**
  （document が将来 optionalDependencies を持ってもコアは汚れない）
  **③document がコアを通常 dependencies に持てば利用者は 1 install で済む**
  （2 パッケージであることの不便が実質消える）。

### 2. リポジトリ構成 = multi-repo

- `@normativepdf/document` は**独立リポジトリ**として新設する。monorepo にはしない。
  - 本リポジトリの CI・pin-guard・2,907 件のコーパス受入・tag 起動 publish.yml は
    すべて**リポジトリ単位で実証済み**であり、monorepo 化は workspaces + パッケージ別 tag +
    workflow フィルタへの作り直しになる。実証済みの機構は触らない。
  - document はコーパス基盤（136MB の fetch・survey）を**持たない**。受入の道具が違う
    （下記 §受入）。
- ローカルの作業場所は傘フォルダ `pdf-agent-stack/lib/document`（リポジトリは別。
  `lib/normativepdf` と同じ置き方）。
- **npm の scope とリポジトリ構成は独立**である。GitHub organization への移転は任意で、
  行う場合は **tag publish の合間に**行う（npm の Trusted Publisher 設定はリポジトリパスに
  束縛されており、移転後・次の tag の前に npmjs.com 側の更新が要る）。

### 3. 開発ループ = document は「公開済みの core」に依存する

- document は core を**通常の dependencies**（semver range）として持つ。
- 高レベル層の実装がコアへ要求を跳ね返したら（画像 XObject・フォントメトリクス読み等）、
  **core を先にリリースしてから document が上げる**。tag 1 つで門番付き publish が回るので
  この順序の摩擦は小さく、「公開版で動くものだけを積む」規律とも同じ向きである。

### 4. writer との関係 = 完成後に writer が消費者になる

高レベル層の抽出元は pdf-writer-mcp の services（layout / renderers / acroform /
tagged-cos / attachment-cos 等、約 10,300 行 — すべて normativepdf の上で動いている
実測済みコード）である。document が各マイルストーンを満たすたび、writer の該当部分を
document の消費に置き換える（Phase 3 = pdf-lib 撤去と同じ「抽出」の型。受入も同じ =
UC 回帰全緑 + veraPDF レポート維持）。

### 5. マイルストーンと受入（受入基準を先に決める）

| M | 内容 | 受入 |
|---|---|---|
| M1 | Document/Page・フォント登録（TTF/OTF・日本語）・drawText（自動改行・整列）・図形・save | 「10 行で日本語 1 ページ PDF」がそのまま動く・**タグ付きが既定**・qpdf clean・veraPDF 検査可 |
| M2 | 表・画像・ヘッダフッタ・Markdown → PDF | writer の `create_table_pdf` / `create_markdown_pdf` 相当を再現し UC オラクル同等の判定を通る |
| M3 | 既存文書の高レベル編集（ページ操作・透かし・しおり・添付） | writer 該当ツールの置き換えで UC 回帰全緑 |
| M4 | AcroForm・適合プロファイル save・暗号化オプション | acroform 抽出完了・veraPDF COMPLIANT 維持・`encryptPdf` 統合 |

サイト（normativepdf.dev）は 2 段: **第 1 段 = M1 完了でコアへの破壊的変更の弾が尽きた
時点（≒ core v1.0-rc）にコアのみで建てる**・第 2 段 = M2 完了でお披露目。
リファレンスと実測ページは生成にする（実装から乖離した文書を残さない）。

### 6. 決めないこと

- **DESIGN §5「低レベル一本」は改定しない** — 本 ADR は §6.1-5 の受け皿の行使であり、
  コアの範囲は変わらない。ADR-0007 (c) の帰属「writer」だけが「`@normativepdf/document`」に
  置き換わる。
- **テキスト抽出プリミティブ**（演算子イテレータ + §9.10.2/9.10.3 ToUnicode 復号 =
  文字と位置）は**コア側の需要駆動候補として記録するに留める**。条文アンカーと独立オラクル
  （pdftotext / pdfium）が立つことは確認済みだが、着火は実需要（reader の pdfjs-dist 置き換え
  起票、または外部需要の実測）を待つ。レイアウト復元・OCR・レンダリング（演算子 → ピクセル）は
  引き続き範囲外。

## 関連

- [ADR-0007](0007-document-model-scope.md) — 文書モデルの 3 分割（(c) の帰属を本 ADR が更新）
- [`../DESIGN.md`](../DESIGN.md) §5 / §6.1-5 — 低レベル一本の維持と受け皿
- [`../ROADMAP.md`](../ROADMAP.md) 高レベル層トラック — 進捗はそちらのチェックボックスが正典
