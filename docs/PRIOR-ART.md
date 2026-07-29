# 先行実装の調査

実装前に、置き換える対象（`pdf-lib`）と競合になりうる実装（`pdfnative`）の
**具体的な失敗モード**を記録する。設計はここから逆算する。

---

## 1. pdf-lib — 置き換える対象

`pdf-writer-mcp` が委譲している実装。**条文違反を特定できても直せない**のが問題。
出典: `~/workspace/shuji-bonji/mcps/pdf-writer-mcp/docs/SPEC-REAUDIT-2026-07-19.md`

| ID | 内容 | 条項 |
|---|---|---|
| **W-2** 🔴 | **CFF(.otf) を `CIDFontType2` + `FontFile2` で埋め込む**（中身は OTTO） | ISO 32000-2 Table 124 shall 違反 |
| **W-3** | サブセット名に `ABCDEF+` タグがない | R-9.9.2-2 / -3 |
| **W-4** | `FontFile2` の `Length1` 欠落（pdf-lib は書かない） | Table 127 |
| **W-1** 🔴 | catalog へ carry したエントリを直接オブジェクトで埋め、**出力 PDF が壊れる** | R-7.3.8.1-5 / R-7.7.2-22 |
| — | `/DA` のフォントが `/DR` から解決できない（pdf-lib は `/DA` を書くが `/DR` を作らない） | R-12.7.4.3-7 |
| — | 添付 `/Params` の日時が PDF 生成時刻（正しくはソースファイルの mtime）。**電帳法の証跡が壊れる** | Table 45 / R-14.13.2-2 |

### W-2 の教訓が最も重い

自 writer は v0.14.0 で `doc.save()` 直前に辞書を開き直して是正したが、**本丸は辞書名ではなくグリフ選択だった。**

`CIDFontType0` は `CID → charset → GID`（R-9.7.4.2-4）で解決し、`CIDFontType2` の `CID → GID` とは**別経路**。
CID-keyed CFF を harfbuzz でサブセットすると charset は「新 GID → 元の GID」を保つ
（実測 gid1→cid1, gid2→cid18, gid9→cid1478）ため、
**名前だけ直すと、条文どおりに解決する処理系が別のグリフを描く。**

→ **設計含意**: フォント埋め込みは「辞書を書く」ではなく
「**フォントプログラムの内部表現と辞書型を整合させる**」問題として扱う。

### なぜ委譲では直らないか

- pdf-lib は**自分が書いた辞書をそのまま読む**ので、この層を原理的に検出できない
- 是正を後段パッチ（save 直前の書き換え）で行うのは、**構造的に脆い**
- 上記はすべて**構造層**の問題であり、シェイピング層ではない

---

## 2. pdfnative — 競合になりうる実装

ゼロ依存の純 TypeScript PDF エンジン（Nizoka 製・MIT・pdfnative.dev）。
**2026-07-20 に本 family で受入監査を実施。** 全文: `~/workspace/shuji-bonji/mcps/pdfnative-audit/AUDIT-2026-07-20.md`

### 結論: エンジンは本物、自己検証が循環している

| | 評価 |
|---|---|
| ✅ | `--font ja` 指定時、日本語 + アラビア語 + タイ語混載で **veraPDF 144/144 PASS** |
| ✅ | CMS/PKCS#7 署名は独立実装の検証器から見て正当（RSA / ECDSA P-256 とも `signatureVerified: true`） |
| ✅ | 注釈の増分更新後も署名が生存。追加バイトは検出可能（隠蔽していない） |
| ✅ | PDF/A 4 レベルの `pdfaid` を正しく作り分け |
| 🔴 | **Latin 文書の PDF/A 出力は既定で非適合**（base-14 未埋め込み、`ISO 19005-2 6.2.11.4.1-1`） |
| 🔴 | **`--encrypt aes-256` が exit 0 で平文を返す**（`/Encrypt` なし・警告なし） |
| 🟠 | 署名で違反 1 → 2、マージで違反 1 → 3 |
| 🟠 | フォント未登録で日本語・アラビア語が exit 0 のまま消失 |
| 🟡 | help が `--lang latin` を許可と書くのに実装が拒否 |

### 決定的な観測

| 検査主体 | 同一ファイルへの判定 |
|---|---|
| pdfnative 自前 validator | **合格**（`pdfaConformance: "2b"`、errors 0 件） |
| veraPDF（`pdf-verify-mcp` 経由） | **不合格** 143/144 |

自前 validator は `/MarkInfo`・`/StructTreeRoot`・`/Metadata`・`/Lang` を
ISO 14289-1 の条番号付きで検査しており作りは丁寧。
しかし**フォント埋め込みを検査項目に持たない**。
**144 ルール中で唯一落ちた 1 個が、自前検査の盲点と正確に一致した。**

→ **設計含意**: このライブラリは**自己検証機能を持たない**（[`DESIGN.md`](DESIGN.md) §4.2）。

### 天井

pdfnative は **ISO 32000-1（PDF 1.7）基盤**。したがって:

| 到達可能 | 到達不能 |
|---|---|
| PDF/UA-1、PDF/A-1b/2b/2u/3b | **PDF/UA-2**、**PDF/A-4**、WTPDF 1.0、TS 32001〜32005 |

ISO 14289-2 §6.2 が ISO 32000-2 + TS 32005 をハード要件とするため、
1.7 基盤の実装は PDF/UA-2 に**原理的に**到達できない。

→ **設計含意**: PDF 2.0 基盤にすることが、そのまま差別化になる（[`DESIGN.md`](DESIGN.md) §2）。

### 学ぶべき点

競合の失敗だけでなく、**正しくやっている点**も記録する。

- **ゼロ依存**は supply-chain の観点で強い主張。ただしシェイピングのエッジケースを全部自分で踏む代償がある
- **4 層の垂直統合**（lib / CLI / MCP / React reconciler）で `DocSpec` の語彙が全層一貫
- **AI governance**（`.github/AGENT_RULES.md` + `ai-governance.json` + `verify-issue.mjs`）で
  エージェントを draftsman に限定し、submit は人間の GitHub identity で行う機械可読な契約。
  **AI 主体で書かれた OSS の作法として参照に値する**

### 報告について

F-1 / F-2 は利用者が実害を被りうる欠陥。
ただし pdfnative は `AGENT_RULES.md` で**エージェントの自律的な issue 起票を明示的に禁止**しているため、
報告する場合は人間（shuji）名義で、あちらの作法に従う必要がある。**未報告。**

---

## 3. その他

| ライブラリ | 位置づけ |
|---|---|
| `pdfkit` / `jsPDF` / `pdfmake` | 生成専用。構造木・PDF/A・署名を持たない |
| `pdfjs` | 読み専用（`pdf-reader-mcp` が使用） |
| `qpdf` / `poppler` / veraPDF | **独立実装の検証器**。受け入れ基準として使う（競合ではない） |
