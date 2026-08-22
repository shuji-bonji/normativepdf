# normativepdf へのコントリビューション

normativepdf は条文駆動の PDF ライブラリです。すべての挙動を ISO 32000（フィルタ層は RFC）の
条項に紐づけ、紐づけられないものは主張しません。コントリビューションは歓迎です —
ロードマップが「作らない（当面）」としている領域（レンダリング・テキスト抽出など）も含めて。
条件は既存コードと同じ規律に従うことだけで、その規律を先に全部書いておくのがこの文書です。
「知らなかった規則」で却下される、という形を作らないために。

English: [CONTRIBUTING.md](CONTRIBUTING.md)

## 受入の 3 規則

すべての変更はこの 3 つで判定します。既存コードが従っているものと同じで、正典は
[docs/DESIGN.md](docs/DESIGN.md) と [docs/GUARDS.md](docs/GUARDS.md) にあります。

**1. 条文に紐づく。** 新しい挙動は、実装するその場所のコメントに根拠条項
（ISO 32000-2 の条項・要求 ID・RFC の節）を書きます。条文が見つからなければ、
推測で番号を書かずに PR にそう書いてください —「規範文書が見つからなかった」は
受け入れられる記述で、創作した条項番号は受け入れられません。どの規範文書にも
縛られない挙動は、このライブラリではなく消費者側（MCP サーバ）の持ち物です。

**2. 測ってある。** 誰かが思い出したときにだけ確かめられる主張は、合格基準として
成立しません。新しい挙動には「その挙動を外すと落ちるテスト」を付けます
（GUARDS T-3 — 一度実際に変更を戻して、落ちることを確かめてください）。そして
corpus 門番が緑を保つこと: `npm run corpus:survey` と `npm run roundtrip:survey`
（pin された 2,907 検体）。`corpus.lock.json` の基準値は両側です — 下回れば退行、
**上回っても**落ちます（基準が床を守れなくなった合図なので、lock を別コミットで上げる）。

**3. pin は単独で動かす。** `corpus.lock.json` と `src/` を同じコミットで変えては
いけません — 基準値を同時に動かすと、旧基準なら捕まえた退行が隠れます。
CI がコミット単位で機械的に検査します（`pin-guard` ジョブ）。

## 作業の流れ

```bash
npm ci
node scripts/fetch-corpus.mjs   # corpus/ は gitignore。約 136 MB・コミットで pin
npm run typecheck && npm test && npm run check
npm run corpus:survey           # 2,907 検体のパース
npm run roundtrip:survey        # 読み → 書き → 読み + 独立実装の qpdf
```

roundtrip には qpdf が要ります（`apt-get install qpdf` / `brew install qpdf`）。
TypeScript は厳格設定です（`docs/adr/0002-type-strictness.md`）: `any` 禁止・
`noUncheckedIndexedAccess` 有効・逃げ道にはコメントが要ります。

検証は設計として外部にあります（DESIGN §4.2）: このライブラリは自前の検証器を
持ちません。独立実装（qpdf・veraPDF・poppler）での読み戻しがオラクルであり、
`exit 0` を成功と読みません（GUARDS G-1）。

## コントリビューションに開いている領域

ロードマップ（docs/ROADMAP.md）の「作らない（当面）」= レンダリング・抽出などは、
メンテナの時間についての記述であって、ライブラリの境界についての記述ではありません。
同じ 3 規則の下で歓迎します。大きなものを作る前に、まず Issue を立てて条文根拠と
測り方を合意してください — その会話は安く、却下される 3,000 行の PR は安くありません。

規律にかかわらず入らないもの: 規範文書を引けない挙動、自己検証（DESIGN §4.2）、
非決定論的な出力（時刻・乱数に依存しない。`/ID` や日時は呼び出し側が注入する = DESIGN §4.1）。

## コミットとリリース

コミットメッセージは「何を・なぜ」を命令形で書きます。リリースはタグ駆動で、
CI が同じ門番を通します（`publish.yml` が corpus survey 2 本を pure vs native の
差分オラクル ON で回してから `npm publish`）。合格率が下がるリリースは起きません。
