# Design

## 実装

`src/text/text-string.ts` の `decodeUtf16Be` は、2 バイトずつ符号単位にしてから `String.fromCharCode` で文字列にしている。符号単位の配列を作った後、文字列にする前に次の 1 回の走査で孤立したサロゲートを `0xFFFD` に置き換える。

```ts
for (let i = 0; i < units.length; i += 1) {
  const unit = units[i];
  if (unit >= 0xd800 && unit <= 0xdbff) {
    const next = units[i + 1];
    if (next !== undefined && next >= 0xdc00 && next <= 0xdfff) { i += 1; continue; }
    units[i] = 0xfffd;
  } else if (unit >= 0xdc00 && unit <= 0xdfff) {
    units[i] = 0xfffd;
  }
}
```

上位の後に下位が続く組は飛ばす（1 文字として残す）。それ以外のサロゲートは 1 単位ずつ置き換える。最後に余った 1 バイトの U+FFFD は今のまま。

UTF-8 は `TextDecoder('utf-8', { fatal: false })` のままで、振る舞いを変えない。テストで固定するだけ。

## ライブラリの制約と仕様の制約

- 仕様（ISO 32000-2 §7.9.2.2.1）: 形の壊れたバイト列の読み方を定めない。UTF-16BE と UTF-8 は Unicode Standard の定義による。
- 仕様の外の定義（Unicode Standard の UTF-16 の定義）: 対になっていないサロゲートを含む符号単位列は UTF-16 として形が壊れている（ill-formed）。pdf-spec-mcp の収録範囲の外なので、条項番号は引けなかった。
- ライブラリ（JavaScript）: 文字列は UTF-16 の符号単位の列で、孤立したサロゲートをそのまま持てる。`String.fromCharCode` は検査しない。`TextEncoder` は孤立したサロゲートを U+FFFD にする。この差が、受け取った文字列と表示された文字列を食い違わせる。

## 読みと書き

この変更は読み（`decodeTextString`）だけ。書き（`encodeTextString`）は対象外（proposal）。

## 受入をどこで測るか

- 受入テスト 4 件（012 の Scenario）。
- コーパス（veraPDF-corpus と pdf20examples）のテキスト文字列すべてについて、変更前と変更後の `dist` の `decodeTextString` の答えを比べ、差が孤立したサロゲートを含む文字列だけであることを確かめる。差分オラクル（`scripts/text-oracle.mjs`）は pdf-lib を要するので使わず、同じ鍵の集め方で変更前後の自分どうしを比べる。
