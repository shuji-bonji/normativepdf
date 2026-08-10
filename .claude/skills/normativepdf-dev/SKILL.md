---
name: normativepdf-dev
description: normativepdf の実装・レビュー作業の規律。条文ファースト（pdf-spec-mcp で ISO 32000-1/-2・TS 32005 の原文確認）→ 実装 → 独立実装で読み戻し → veraPDF 採点、の検証ループを回す。normativepdf のコード・docs を変更するタスク、COS パーサ/シリアライザ/構造木/フォント辞書に触れるタスク全般で使う。
---

# normativepdf-dev

> ⚠️ **雛形（2026-08-08 作成）。** 段階 0 の実装経験が溜まったら、実測に基づいて手順を具体化する。
> 机上で手順を先に膨らませない（早すぎる具体化は GUARDS の思想に反する）。

## 参照順序

1. [`../../CLAUDE.md`](../../CLAUDE.md) — 文書マップと規律の要点
2. [`../../docs/DESIGN.md`](../../docs/DESIGN.md) — 作る範囲・段階 0〜4・コーパス
3. [`../../docs/GUARDS.md`](../../docs/GUARDS.md) — G-1〜G-6 / T-1〜T-4（このループを崩さない）
4. [`../../docs/PRIOR-ART.md`](../../docs/PRIOR-ART.md) — 同じ失敗を繰り返さないための W-* / F-*

## 検証ループ（骨子）

```
pdf-spec-mcp   条文（何が正しいか）— 実装判断の前に引く。推測で条項番号を書かない
      ↓
   実装を書く
      ↓
   読み戻し    独立実装（qpdf --check / poppler / veraPDF）で照合 — 自分の出力を自分で読まない（T-2）
      ↓
pdf-verify-mcp veraPDF で機械採点
      ↓
   条文に戻って差分を潰す
```

## 決まりごと（最小セット）

- exit 0 を成功と読まない（G-1）
- 緑のテストは空振りしうる — 修正を戻すと落ちることを実測で確認（T-3）
- コーパス（pdf20examples / veraPDF-corpus）は段階 0 の受け入れ基準（DESIGN §5.2）
- 適合宣言を書くコードは、要件検査と同じ関数に閉じる（DESIGN §3）

## TODO（実装経験で埋める）

- [ ] 段階 0 のビルド・テストコマンド（コードができたら記載）
- [ ] コーパス実行のスクリプトと合格基準の具体値
- [ ] pdf-lib 差分オラクルの実行手順（compare_structure の呼び方）
- [ ] よく引く条項の索引（実装中に頻出したものを追記）
