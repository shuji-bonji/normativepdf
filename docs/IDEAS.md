# アイデアプール

思いついた順に追記する。整理は後回しでよい。
確定した方針は `DESIGN.md` / `adr/` へ移す。

---

## 未整理

- （ここに追記）

---

## 検討済み・保留

- **ISO 19005 の調達** — 有償。採用実績かスポンサーが付いた時点で 19005-2 から。
  それまでは veraPDF validation profiles（XML・条項番号を明示参照・ルール ID が veraPDF 出力と一致）と
  PDF Association TechNote 0010（CC-BY 4.0）で補う
- **veraPDF validation profiles の取り込み** — 無償・機械可読。
  「ルール ID → 条項番号 → テスト条件」を辿れるので、検証器駆動への過適合を一段防げる。
  着手前の安い前提整備として有力
- **共有基盤パッケージ** — ISO 条項番号 / veraPDF ルール ID / 適合レベルの対応表。
  houki family の `houki-abbreviations` に相当。抽出の形は連携試験で決める
