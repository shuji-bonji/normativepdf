# CLAUDE.md — normativepdf

条文駆動の PDF ライブラリ（純 TypeScript・構造層）。すべての挙動を ISO の条項に紐づけ、紐づけられないものは主張しない。
現況: **設計確定済み（2026-08-08）・実装は段階 0（COS オブジェクトモデル + パーサ）から。**

## 文書マップ（迷ったらここから）

| 知りたいこと | 正典 |
|---|---|
| **全体地図と進捗（設計→実装→試験→運用）** | [`docs/ROADMAP.md`](docs/ROADMAP.md) |
| 何を作り何を作らないか・API 粒度・移行段階 0〜4・適合性コーパス | [`docs/DESIGN.md`](docs/DESIGN.md) |
| 実装が守る不変条件（G-A〜G-E）・検証ループ手順（G-1〜G-6）・テスト規律（T-1〜T-4） | [`docs/GUARDS.md`](docs/GUARDS.md) |
| 置き換える対象の失敗モード（pdf-lib W-1〜W-4 / pdfnative F-1〜F-6） | [`docs/PRIOR-ART.md`](docs/PRIOR-ART.md) |
| 看板・主張の線引き（書ける/書けない）・公開チャネル・競合監視 | [`docs/PUBLISHING.md`](docs/PUBLISHING.md) |
| 言語選定（TypeScript・Accepted） | [`docs/adr/0001-language-choice.md`](docs/adr/0001-language-choice.md) |
| 型の厳格性ポリシー（tsconfig フラグ・any 禁止・逃げ道の規律） | [`docs/adr/0002-type-strictness.md`](docs/adr/0002-type-strictness.md) |
| フィルタ戦略（自前 inflate が正・native は暫定・CompressionStream は書きに使わない） | [`docs/adr/0003-filter-strategy.md`](docs/adr/0003-filter-strategy.md) |
| 名前の経緯・ドメイン（normativepdf.dev） | [`NAMING.md`](NAMING.md) |
| 未整理のアイデア置き場 | [`docs/IDEAS.md`](docs/IDEAS.md) |

文書間で食い違いがあれば、上の表の「正典」を正とし、食い違い自体を報告すること。

## 開発規律（要点）

1. **条文ファースト。** 実装仕様の判断前に、必ず `pdf-spec-mcp` で ISO 32000-1/-2・TS 32005 の
   原文を確認する。ライブラリの都合・慣習と、仕様の要求を混同しない。
   条項番号を推測で書かない — 引けなかったら「引けなかった」と書く。
2. **検証は外部。** 自前検証器を持たない（DESIGN §4.2 — 実装の盲点がそのまま検証の盲点になる）。
   採点は `pdf-verify-mcp`（veraPDF 委譲）、読み戻しは独立実装（`qpdf --check` / poppler / veraPDF）で行う（GUARDS T-2）。
3. **exit 0 を成功と読まない**（G-1）。宣言と検証はペアで呼び差分を出す（G-2）。
   変換系は「入力を採点 → 操作 → 出力を採点 → 差分」で回す（G-6）。
4. **主張と実体を乖離させない。** 適合宣言は要件検査と同じ関数に閉じる（DESIGN §3）。
   外向きの文言は PUBLISHING §1 の「書ける/書けない」に従う。**PDF/A は名乗らない**（T2 領域）。
5. **決定論的出力。** 時刻・乱数に依存しない。`/ID`・作成日時・署名は明示注入（DESIGN §4.1）。

## 実装方針（サマリ）

- TypeScript / ESM（`sideEffects: false`）/ **低レベル API 一本**（高レベルは MCP 側に置く）
- パーサは持つが**抽出はしない**（それは reader の pdfjs の仕事）
- テキストシェイピングは戦わない。フォントサブセットは harfbuzz へ外部化
  （ただし W-2 = サブセット結果と辞書型の整合は本ライブラリの射程内）
- pdf-lib は**差分オラクル**として残す（同一文書を両経路で書き `compare_structure` で構造差分）
- 進行は DESIGN §5.1 の段階 0 → 4。受け入れはコーパス全件パース → verify VALID 維持 → veraPDF COMPLIANT

## 関連（PDF family）

- `pdf-spec-mcp`（条文参照）/ `pdf-reader-mcp`(観測) / `pdf-writer-mcp`（生成・本ライブラリの第一の利用者）/ `pdf-verify-mcp`（採点）
- `~/workspace/shuji-bonji/Document-Note/` 配下への参照は**作業環境内の非公開資料**であり、
  公開リポジトリからは解決しない（公開に必要な内容は docs/ に転記済み）

## Claude スキル

プロジェクト固有スキルは [`.claude/skills/`](.claude/skills/) 配下。

- `normativepdf-dev` — 実装セッションの規律（条文 → 実装 → 読み戻し → 採点のループ）。
  現在は雛形。段階 0 の実装経験が溜まったら具体化する
