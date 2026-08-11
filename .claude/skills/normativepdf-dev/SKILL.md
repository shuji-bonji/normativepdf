---
name: normativepdf-dev
description: normativepdf の実装・レビュー作業の規律。条文ファースト（pdf-spec-mcp で ISO 32000-1/-2・TS 32005 の原文確認）→ 実装 → 独立実装で読み戻し → veraPDF 採点、の検証ループを回す。normativepdf のコード・docs を変更するタスク、COS パーサ/シリアライザ/構造木/フォント辞書に触れるタスク全般で使う。
---

# normativepdf-dev

> 2026-08-11 更新: 段階 0 の実測でコマンド・コーパス手順を具体化済み。

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

## コマンド（2026-08-11 実測）

| コマンド | 実行場所 | 内容 |
|---|---|---|
| `npm run typecheck` / `npm run build` | sandbox 可（tsc は JS） | `npx -y -p typescript tsc` でも可 |
| `npm test` | **ホストのみ**（vitest = esbuild ネイティブ） | 2026-08-11 時点 104+ 緑 |
| `npm run check` | **ホストのみ**（biome ネイティブ） | sandbox は `npx -y -p @biomejs/biome biome check` が動く場合あり |
| `npm run corpus:fetch` | どちらでも | pdf20examples 7 点 + veraPDF-corpus（`staging` ブランチ clone・165MB） |
| `npm run corpus:parse` | build 後 | **門番**: pdf20examples 7/7 必須・1 件でも落ちたら exit 1 |
| `npm run corpus:survey` | build 後 | **門番**: veraPDF-corpus 2907 検体、pass 検体の失敗のみ exit 1。fail 検体の失敗は回復要求のデータ点（基準線 2026-08-11 = 2881/2907・落ちる 26 は全て fail 検体） |

- sandbox の注意: マウント上で git がロックを unlink できない（clone は /tmp 経由で rsync）・dist/ がホスト所有だと書けないことがある
- 回復パースの追加は「**pass 検体（= veraPDF が COMPLIANT と判じる = 読めなければならない）が落ちた**」を要求の立った証拠とする。fail 検体が落ちるのは strict 層の正しい仕事

## よく引く条項（段階 0 で頻出）

| 条項 | 内容 |
|---|---|
| §7.2.2 Table 1 / §7.2.3 | 空白・区切り。空白は構文要素の分離（xref 内の空白合法の根拠） |
| §7.3.8 R-7.3.8.1-6 | stream キーワード後は CRLF or LF（CR 単独禁止） |
| §7.3.10 R-7.3.10-13/-14 | 未定義参照は null。解決は resolver 層（パーサでない） |
| §7.5.2 | ヘッダ %PDF-M.n・オフセット原点 = PERCENT SIGN・NOTE 3 = /Version 格上げ |
| §7.5.4 | 20 バイト固定エントリ・EOL 3 形。**R-7.5.4-31（free 先頭 65535）は適合規則 = パーサは受理**（TWG pass 検体が根拠） |
| §7.5.5 Table 15 | trailer: Size/Root 必須・Encrypt = 暗号化の名指し・Size 超過は無視 |
| §7.5.7 | objstm はオフセット駆動・「参照のみ」禁止・世代暗黙 0 |
| §7.5.8.2 Table 17 / §7.5.8.3 Table 18 | W 幅 0 = 既定値（type 既定 1・**世代既定 0** — 65535 規則はストリームに無い） |
| §7.7.2 Table 29 | catalog /Version = name・ヘッダより後なら格上げ |

## TODO（段階が進んだら埋める）

- [ ] pdf-lib 差分オラクルの実行手順（compare_structure の呼び方 — 段階 2 = 生成パス移行時）
- [ ] 独立実装読み戻し（qpdf --check / poppler）のコマンドと判定の読み方（段階 1 = シリアライザから）
