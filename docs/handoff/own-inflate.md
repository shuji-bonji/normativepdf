# 引き継ぎ: 自前 inflate（純 TS）への置き換え — ADR-0003

- 対象リポジトリ: `normativepdf`（この文書のある repo)
- 根拠: [`../adr/0003-filter-strategy.md`](../adr/0003-filter-strategy.md)
- **✅ 完了（2026-08-22・v0.7.0）。以下は完了した作業の記録として残す。**

## 完了の記録（2026-08-22）

**トリガー判定**: §0 の 3 条件のうち **トリガー 3（段階 2 = pdf-lib 撤去の完了）が先着**した
（Phase 3 受入充足 2026-08-18・writer 0.20.1）。トリガー 1・2 は来ないままである。

**実装**: `src/filter/inflate.ts` を RFC 1950/1951 準拠の純 TS に置き換えた。
条文は `ietf` MCP で取得し、全分岐にコメントで条文番号を付けた
（RFC 1950 §2.2 ヘッダ / §2.3 検査義務 / Adler-32、RFC 1951 §3.1.1 ビット詰め /
§3.2.2 canonical code / §3.2.3 ブロックとコピー / §3.2.4 stored / §3.2.5 長さ・距離表 /
§3.2.6 fixed / §3.2.7 dynamic）。native は `src/filter/inflate-native.ts` の
`inflateNative` へ移し、runtime 経路から外した（§3 のとおり）。公開 API は async のまま。

**strict 挙動は native と実測で揃えた**: 着手前に native の挙動を測り
（trailing junk / truncated / bad Adler-32 = すべてエラー）、同じ入力を同じ向きに拒む。
拒否 10 形（CM≠8・FCHECK・FDICT・予約ブロック型・NLEN 補数・過剰/不完全 code・
EOB 無し dynamic code・出力先頭より遠い距離・切断・ADLER32・末尾余剰）は
ユニットテストで**両実装が拒む**ことを対にして検査している。

**受入（§4 の 2 条件とも充足・2026-08-22 サンドボックス実測）**:

1. **差分検査** — survey スクリプト 2 本に env ゲートのオラクル
   （`NORMATIVEPDF_INFLATE_ORACLE=1`）を足し、全 inflate 呼び出しを native と突き合わせた。
   `corpus:survey` / `roundtrip:survey` とも **1,386 回の比較すべてバイト一致**。
   オラクルは発火回数を数え、**0 回なら exit 1**（空振りを緑にしない）。
   native 側に不一致を仕込むと parse が実際に落ちることも実測した
2. **門番維持** — `baselineParsed` **2884/2907**・`baselineRoundTrip` **2881**
   （qpdf 差分なし）。lock の値と一致し、上回りも下回りもしない = lock 更新は不要

ユニットは 61 件追加（node:zlib を生成器に、レベル 0/1/6/9 × 既定/Z_FIXED/Z_RLE/
Z_HUFFMAN_ONLY × 空〜1MB の決定論データ。1MB の比較は `Buffer.compare` —
vitest の `toEqual` は 1MB 配列で数秒かかりタイムアウトする）。
既存テストは全緑（計 468 件）・typecheck / biome 緑。

---

以下は着手前の引き継ぎ本文（当時のまま）。

- **⚠️ 着手条件はまだ満たされていない。** 最初にやるのは実装ではなく**トリガー判定**である
- この文書だけで着手できる。他の引き継ぎを読む必要は無い

---

## 0. まずトリガーを判定する（これを飛ばさない）

ADR-0003 は着手条件を「詰まったから」ではない形で 3 つ置いた。**いずれか最初に来たものが引き金**である。

| # | トリガー | 2026-08-13 時点の状態 |
|---|---|---|
| 1 | 回復パースが**破損ストリームの部分回収**を要求した | ❌ 来ていない |
| 2 | **書き側で deflate（圧縮出力）が必要**になった | ❌ **実測して立たないと判定した**（下記） |
| 3 | 上記が来ないまま**段階 2（Phase 3 = pdf-lib 撤去）が完了**した | 🚧 Phase 3 着手済み・未完了 |

### トリガー 2 の判定（2026-08-13・実測）

Phase 3 の第 1 項目「フィルタ・コンテンツストリームビルダ」に着手する前に、
**非圧縮で書くと実際どれだけ膨らむか**を測った（UC オラクルが生成する 32 ファイル・
`/Filter /FlateDecode` の全ストリームを qpdf で展開して差し替えた場合の推計）:

| 種別 | 圧縮後 → 展開後 | 倍率 |
|---|---|---|
| フォント本体 | 254 KB → 340 KB | ×1.3 |
| その他 | 113 KB → 172 KB | ×1.5 |
| オブジェクトストリーム | 29 KB → 77 KB | ×2.6 |
| コンテンツストリーム | 12 KB → 54 KB | ×4.5 |
| **合計** | **856 KB → 1,092 KB** | **×1.28**（最悪の検体で ×1.68） |

**倍率の大きい種別ほど絶対量が小さい。** 実務のファイルはフォント本体が支配的で、
CFF/OpenType は既に密なので ×1.3 にしかならない。**×1.28 は「圧縮が必要になった」ではない**
と判定し、書き側は無圧縮のまま進める（`/Filter` は任意 = §7.3.8.2）。

代わりに **書き側のフィルタ層の席だけ先に作った**（`src/filter/encode.ts`）。
`encodeStream` は無変換 1 種のみを持ち、`FlateDecode` を頼まれたら
**ADR-0003 §4 を名指しして拒む**。「圧縮しない」を、実装漏れではなくコード上の言明にするため。

⚠️ **サイズはオラクルが見ていない面である。** 差分ダイジェストは圧縮を正規化して落とすので、
**非圧縮化による ×1.28 は差として出ない**。Phase 3 で生成パスを建て直したら、
`uc-oracle` にファイルサイズの帯（例: ゴールデン比 2.0 倍で赤）を足すこと。

**3 つとも立っていないなら、この作業は今やることではない。** 上の表を実測で更新してから
判断すること。特に 2 は「オブジェクトストリームを圧縮したい」という要求が来た瞬間に立つ。

判定の実測方法:

- 1 → `git log` と Issue に「破損 deflate から部分回収したい」という要求があるか
- 2 → `src/serialize/` に圧縮を書く要求が入っているか。`writeFile` の出力サイズが
      問題になった記録があるか
- 3 → [`../ROADMAP.md`](../ROADMAP.md) の Phase 3 が完了しているか

## 1. 今そこにあるもの

`src/filter/inflate.ts` は **24 行**で、中身は WHATWG `DecompressionStream('deflate')` の
ラッパである。ファイル冒頭に自分でこう書いてある。

```
⚠️ INTERIM IMPLEMENTATION (ADR-0003). The canonical implementation is a
pure-TS inflate written against RFC 1950/1951; this wrapper temporarily
occupies the same seat behind the filter boundary and must not leak
outside `src/filter/`.
```

**境界はすでに切ってある**（ADR-0003 決定 2）。`decode.ts`（134 行）の背後にあり、
`inflate` を差し替えるだけで置き換わる設計になっている。PNG Predictor（§7.4.4.4）の
逆適用は `predictor.ts`（165 行）に**すでに自前で**あり、この作業の範囲外である。

## 2. なぜ自前が「正」なのか（ADR-0003 の理由を再掲）

- **条文駆動の一貫性。** RFC 1950/1951 は `ietf` MCP で原文が引ける。
  「すべての挙動を規範文書に紐づける」というこのライブラリの中核原則を、
  フィルタ層でも成立させられる。native はブラックボックスで紐づけられない
- **査読可能性**（ADR-0001 と同じ根拠）
- **回復パースの制御。** 破損 deflate からの部分回収・エラー位置の特定は、
  native では chunk 粒度が限界
- **書き側との対称性。** 決定論的 deflate はどのみち自前になる

## 3. やること

- [ ] RFC 1950（zlib）と RFC 1951（DEFLATE）を `ietf` MCP で引きながら書く。
      **条文番号をコメントに残す**（このライブラリの全挙動がそうなっている）
- [ ] `src/filter/inflate.ts` を純 TS 実装に置き換える
- [ ] **native を消さない。** `src/filter/inflate-native.ts` 等に移し、
      **差分オラクルとして test に残す**（ADR-0003 決定 5・GUARDS G-6）
- [ ] 公開 API は **async を維持する**（ADR-0003 決定 3）。同期版が可能になっても、
      互換性のため既存 API の形は変えない。sync 版は非破壊追加として別途検討

## 4. 受入

**2 つとも要る。片方では足りない。**

1. **差分検査**: 同一入力に対して自前と native の出力が**バイト一致**する。
   コーパス全件で回す。**門番スクリプトは 2 本あり、役割が違う**:
   `npm run corpus:survey`（パース = `baselineParsed`）と
   `npm run roundtrip:survey`（往復 = `baselineRoundTrip`・`--qpdf` 込み）。
   差分オラクルは inflate を通る経路すべてに掛けたいので **2 本とも回す**
2. **コーパス門番が緑を維持**: `corpus.lock.json` が pin する 2,907 検体に対し
   `baselineParsed` = 2,883 / `baselineRoundTrip` = 2,881 を**下回らない**。
   門番は**上回った場合も落ちる**ので、良くなったなら lock を同じ commit で更新する

> **改善で門番が落ちるのは仕様である。** 「良くなった」を無言で通すと、
> 次の人がその数字を基準だと信じられなくなる。

## 5. 触ってはいけないもの

- **`predictor.ts`。** PNG Predictor は zlib の外側にある PDF 固有の前処理で、
  最初から自前。inflate の置き換えとは無関係
- **書き側に `CompressionStream` を持ち込まない**（ADR-0003 決定 4）。
  圧縮出力はエンジン間で一意でなく、決定論的出力（DESIGN §4.1）と正面衝突する。
  圧縮が要るなら**固定パラメータの自前 deflate**である
- **`corpus.lock.json` の pin と実装変更を同じ commit に入れない**
  （lock ファイル自身の `$comment` に書いてある規則）

## 6. 参照

- [`../adr/0003-filter-strategy.md`](../adr/0003-filter-strategy.md) — 決定と着手トリガーの正典
- [`../adr/0001-language-choice.md`](../adr/0001-language-choice.md) — 査読可能性の原則
- [`../DESIGN.md`](../DESIGN.md) §4.1 決定論的出力
- [`../GUARDS.md`](../GUARDS.md) G-6 差分で採点する
- [`../ROADMAP.md`](../ROADMAP.md) Phase 1 の残件行（自前 inflate はここに残置されている）
