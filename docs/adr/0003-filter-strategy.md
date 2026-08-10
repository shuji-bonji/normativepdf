# ADR-0003: ストリームフィルタ戦略 — 自前 inflate を正とし、native を暫定とする

- 状態: **Accepted**
- 日付: 2026-08-11
- 決定者: shuji

## 背景

xref ストリーム・オブジェクトストリーム（§7.5.7/7.5.8)の読みには FlateDecode
(ISO 32000-2 §7.4.4 = RFC 1950 zlib + RFC 1951 DEFLATE）が必要になる。
実装は 2 通り: ランタイムの WHATWG `DecompressionStream`（Chrome/Edge 80+・
Safari 16.4+・Firefox 113+・Node 18+。Baseline 2023-05 → 現在は実質 Widely）か、
純 TS の自前 inflate か。

どちらを選んでも **PNG Predictor（§7.4.4.4）の逆適用は自前実装**である
（zlib の外側にある PDF 固有の前処理。xref ストリームは実務上ほぼ
Flate + Predictor 12 の組で来る）。選択が分けるのは inflate 本体だけ。

## 決定

1. **正（目的地）は自前 inflate（純 TS）である。** `DecompressionStream` は
   段階 0 を早く通すための**暫定実装**であり、恒久の地位を持たない。
2. **境界を先に切る。** フィルタは `FilterRegistry` 的な抽象
   （`decode(name, bytes, parms) → Promise<Uint8Array>`）の背後に置き、
   暫定 native と自前実装を同じ席で差し替え可能にする。
3. 暫定 native の帰結として **`parsePdf` は async になる**。自前化後も
   公開 API は async を維持する（互換性。sync 版は自前化後に
   非破壊追加として検討してよい）。
4. **書き側（圧縮）に `CompressionStream` は使わない。** 圧縮出力は
   エンジン間で一意でなく、決定論的出力（DESIGN §4.1）と正面衝突する。
   書きは無圧縮から始め（`/Filter` は任意・合法）、サイズが問題になったら
   **固定パラメータの自前 deflate** で決定論を保つ。
5. 自前化の際は native を**差分オラクル**として test に残す
   （同一入力の出力一致検査 = GUARDS G-6 の再適用）。自前化までの間は逆に、
   自前実装の開発時に native が答え合わせになる。

## なぜ自前を正とするのか

- **条文駆動の一貫性。** RFC 1950/1951 は ietf MCP で原文を引ける。
  「すべての挙動を規範文書に紐づける」という本ライブラリの中核原則を、
  フィルタ層でも成立させられる（native はブラックボックスで紐づけられない）
- **査読可能性**（ADR-0001 と同じ根拠）。生成・実装されたコードを条文と
  突き合わせて読める
- **回復パースの制御。** 破損 deflate ストリームからの部分回収・エラー位置の
  特定は native では chunk 粒度が限界
- **書き側との対称性。** 決定論的 deflate はどのみち自前になる。
  inflate を持てば表の裏として整合が取れる

## 着手トリガー（自前 inflate）

「詰まったから」ではない条件で置く（specs/15 の購入判断と同じ形式）:

- 回復パースが破損ストリームの部分回収を要求した時、**または**
- 書き側で deflate（圧縮出力）が必要になった時、**または**
- 上記が来ないまま段階 2（pdf-lib 撤去）が完了した時

いずれか最初に来たものが引き金。実装時は RFC 1950/1951 を引きながら書き、
native との差分検査 + コーパス全件で受け入れる。

## 関連

- [`0001-language-choice.md`](0001-language-choice.md) — 査読可能性の原則
- [`0002-type-strictness.md`](0002-type-strictness.md) — 逃げ道の規律
- [`../DESIGN.md`](../DESIGN.md) §4.1 決定論的出力 / §5.1 段階 0
- [`../GUARDS.md`](../GUARDS.md) G-6 差分で採点する
