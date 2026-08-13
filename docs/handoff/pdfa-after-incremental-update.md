# 引き継ぎ: 増分更新後に PDF/A 適合が保たれるかを測る

- 対象リポジトリ: `normativepdf`（この文書のある repo）
- 根拠: [`../adr/0005-incremental-update-acceptance.md`](../adr/0005-incremental-update-acceptance.md) 「測らないと決めたこと」
- **今は「未測定」であって「緑」でも「赤」でもない**。この作業はその状態を解消するもの
- この文書だけで着手できる。他の引き継ぎを読む必要は無い

---

## 1. 何が測られていないのか

ADR-0005 は増分更新（§7.5.6）の受入を 3 段で決め、**3 段とも緑**である。

| 段 | 内容 | 状態 |
|---|---|---|
| 1 | 元バイト列の完全一致 | ✅ 全経路で常時 |
| 2 | チェーンが正しく読める | ✅ ユニットテスト |
| 3 | qpdf が新しい苦情を出さない・実署名検体の署名が VALID を維持 | ✅ 実測 |

ADR-0005 にはこう書いてある。

> **PDF/A 適合の維持は、まだ測っていない。** veraPDF は pdf-verify-mcp 経由でしか
> 手元に無く、増分更新後の PDF/A 判定は回していない。

**署名が生き残ることと、PDF/A が生き残ることは別の主張である。** 前者はバイト列の不変で
決まるが、後者は**追記した側が PDF/A の規則を守っているか**で決まる。追記部分が
新しいオブジェクトを足す以上、そこに PDF/A 違反を持ち込む余地がある。

GUARDS G-C が根拠として挙げている pdfnative F-3 が、まさにその実例である
（**署名したら、入力に無かった PDF/A 違反が増えた**）。

## 2. なぜ今できるのか（前提はすでに揃っている）

- `appendUpdate` / `appendUpdateTo` が実装済み（`src/serialize/incremental.ts`）
- **PDF/A-3b COMPLIANT な検体を作る手段がある** — `pdf-writer-mcp` の
  `ensure_pdfa`（v0.15.0 で veraPDF 146/146 COMPLIANT を実測済み）
- **判定器がある** — `pdf-verify-mcp` の `validate_conformance`。
  flavour は `pdfa-3b` / `pdfa-4` / `pdfa-4f` / `pdfua-1` を受ける

つまり **write → append → validate のループが今すぐ回る**。

## 3. 手順

### 3.1 まず「入力が緑であること」を確定させる

```
pdf-writer-mcp create_text_pdf  → ensure_pdfa(flavour: 'pdfa-3b')  → out.pdf
pdf-verify-mcp validate_conformance(out.pdf, flavour: 'pdfa-3b')   → COMPLIANT
```

**ここが緑でなければ以降は何も言えない。** 追記後に落ちたとき、追記が原因なのか
入力が元から落ちていたのか区別できなくなる。

### 3.2 追記して、もう一度同じ判定を掛ける

`appendUpdateTo` で最小の追記を入れる。**最小から始める** — 何を足すと落ちるのかを
切り分けたいので、最初から注釈や添付のような重いものを足さない。

段階を上げる順序（落ちた段で止めて原因を名指しする）:

1. 何も参照されないオブジェクトを 1 つ足すだけ
2. `/Info` を差し替える（XMP との整合が要求される領域に入る）
3. ページに注釈を 1 つ足す（`/AP` が要求される = pdf-constraints CT-ANNOT-3 の領域）
4. xref ストリーム形式で追記する（`finishWithXrefStream`）

各段で:

```
pdf-verify-mcp validate_conformance(updated.pdf, flavour: 'pdfa-3b')
```

### 3.3 4 通りの形式混在も掛ける

ADR-0005 が 2026-08-13 に測った 4 通り（table→table / table→stream / stream→table /
stream→stream）は **qpdf と署名でしか測っていない**。PDF/A でも同じ 4 通りを回す。

## 4. 受入と、結果の書き方

- **緑の場合**: ADR-0005 の「測らないと決めたこと」から PDF/A の項を外し、
  **測った条件を明記して**「測った」欄に移す。「PDF/A-3b で、この 4 段階・4 形式について」
  という限定を落とさない。veraPDF が見ていない範囲は依然として未知である
- **赤の場合**: **落ちた規則番号と、それを持ち込んだ追記内容を対にして記録する**。
  「PDF/A が壊れる」ではなく「§ X の規則 Y が、Z を足したときに落ちる」と書く
- どちらの場合も **T2 の言い方を守る**: veraPDF の判定は
  「veraPDF judged this COMPLIANT」であって「ISO 19005 に適合する」ではない。
  ISO 19005 は family のコーパスに無い

## 5. 触ってはいけないもの

- **第 1 段（元バイト列の完全一致）の検査を緩めない。** PDF/A を通すために元を書き換える
  のは、増分更新であることをやめるのと同じ
- **`appendUpdate` に PDF/A 用の分岐を足さない。** このライブラリは適合を作る道具ではない
  （DESIGN §1「作らない」）。落ちたなら、それは呼ぶ側 = writer が何を追記するかの問題として
  writer 側に返す

## 6. 参照

- [`../adr/0005-incremental-update-acceptance.md`](../adr/0005-incremental-update-acceptance.md) — 3 段の受入と、測らないと決めたこと
- [`../adr/0004-roundtrip-acceptance.md`](../adr/0004-roundtrip-acceptance.md) — 「二面で測る」の正典
- [`../GUARDS.md`](../GUARDS.md) G-C — pdfnative F-3（署名で PDF/A 違反が増えた実例）
- `pdf-writer-mcp/docs/TASKS.md` の B-8 / B-20 — `ensure_pdfa` の実測値と T2 残件リスト
