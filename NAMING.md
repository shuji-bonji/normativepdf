# 命名 — 決定と経緯

> ## ✅ 決定: `normativepdf`（2026-07-20）
>
> - **ドメイン `normativepdf.dev` 取得済み**（Value-Domain。移管は 60 日経過後に検討）
> - npm `normativepdf` は未取得（公開時に確保）
> - リポジトリ名も `normativepdf` に統一済み

以下は選定の経緯。同種の判断を再びするときの参照用に残す。

## 決定理由

**空き状況（2026-07-20 実測）**

| | npm | .dev | .com | .org |
|---|---|---|---|---|
| `normativepdf` | ✅ | ✅ | ✅ | ✅ |
| `normative` | ✅ | ✅ | ❌ 登録済み | — |
| `pdf-normative` | ✅ | ✅ | — | — |

※ DNS に NS レコードが無いことによる判定。確定はレジストラで確認すること。

**`pdf-normative` ではなく `normativepdf` を採る理由**

1. **`pdf-` 接頭辞は family 内で「MCP サーバ」を意味してしまう。**
   `pdf-spec-mcp` / `pdf-reader-mcp` / `pdf-writer-mcp` / `pdf-verify-mcp` の並びに置くと
   **`-mcp` が抜けた仲間**に見える。これはライブラリであって MCP ではないので、
   **語形が違うこと自体が役に立つ**

   ```
   pdf-spec-mcp     ┐
   pdf-reader-mcp   │ MCP サーバ群
   pdf-writer-mcp   │
   pdf-verify-mcp   ┘
   normativepdf       ← ライブラリ（別レイヤと一目で分かる）
   ```

2. **ドメインが素直。** `normativepdf.dev` は読めるが `pdf-normative.dev` は呼びにくい。
   紹介サイトを持つ前提（`pdfnative.dev` 参照）なので効く
3. `pdfkit` / `pdfmake` / `pdfnative` / `jsPDF` と同じハイフンなしの語形で、ライブラリとして自然に並ぶ

**`normative` 単体を採らない理由**

unscoped で空いており PDF 以外にも広げられる強い名前だが、
**「PDF ライブラリ」で検索する人に届かない。** 発見されやすさがクリティカルパス上にある今回は不利。

→ 将来 houki family も含めた**「一次情報駆動ツール群」の総称**として温存する案あり。

## 名前が体現すべきこと

`pdfnative` が「ゼロ依存・on-device・速い」を先に押さえた。**同じ土俵に乗らない。**

このライブラリの差別化は **条文駆動・一次情報・検証可能**。
かつ **PDF/A を名乗らない設計**なので、**名前で機能を約束しない**方が一貫する。

> 参考: shuji 自身が既にドキュメントで「**正典**」という語を使っている
>（「正典は `specs/00-overview.md`」「正典は `reviews/`」）。この感覚は名前に使える。

## 候補

| 候補 | 由来・含意 | 評価 |
|---|---|---|
| **normative** / **pdf-normative** | ISO の用語そのもの（"normative references" / "normative requirements"）。「全挙動が規範要件に紐づく」を直接表す | 🟢 **最有力**。`normative` が **npm unscoped で空き**・商標リスク低・意味が正確 |
| **pdf-strict** | 記述的。family の命名規則（`pdf-*-mcp`）に忠実 | 🔴 **不採用**（下記の意味衝突）。作業名として一時使用 |
| **strictpdf** | `pdfnative` と語形が揃う | 🔴 **降格**（下記） |
| **canonical** / **pdf-canonical** | 正典であり正規形。shuji が使う「正典」に対応 | 🟡 XML c14n 的な「正規化」と読まれる余地。ただし決定論的バイト出力も実際に目標なので誤読とも言い切れない |
| **clausepdf** / **pdf-clause** | 条項。条文駆動を直接表す | 🟡 やや平板 |
| **canonpdf** / **pdf-canon** | 概念は最適 | 🔴 **非推奨**。キヤノンは PDF・印刷・イメージングが本業で、同一分野の名称衝突は実害が出やすい |
| **genten**（原典） | 一次情報駆動。houki family とも通底し「一次情報ツール群」という個人ブランドになりうる | ⚪ 今回は英語系を選好したため見送り。将来の family 総称としては再考の余地 |
| **joubun**（条文） | より PDF・仕様寄り | ⚪ 同上 |

## 判明した衝突

### 🔴 strict 系 — `strictpdf.com` が稼働中（2026-07-20 確認）

<https://strictpdf.com/> — ブラウザ完結の消費者向け PDF ツール
（結合・分割・回転・ページ削除・JPG 変換・圧縮）。**12 言語展開**。

**問題は SEO だけではなく、意味の衝突。**

| | "strict" の意味 |
|---|---|
| strictpdf.com | **プライバシーに厳格**（ファイルが端末外に出ない） |
| このライブラリ | **条文に厳格**（規範要件に紐づく） |

**同じ語が別の意味で先に使われている**ため、名前が説明にならない。
加えて `strictpdf.com` は取得済みで、**紹介サイト用のドメインが確保できない**
（`pdfnative.dev` を見ても分かるとおり、この種のライブラリはサイトを持つのが前提）。

> **発見されやすさはこの計画のクリティカルパス上にある。**
> 「採用実績が増えたら ISO 19005 を調達する」という設計なので、
> 埋もれると条文調達の道が閉じ、T2 → T1 への昇格が永久に来ない。

### 🔴 canon 系 — キヤノン

PDF・印刷・イメージングが本業。同一分野の名称衝突は実害が出やすい。

### npm 空き状況（2026-07-20 実測）

| 候補 | npm |
|---|---|
| `normative` | ✅ **空き（unscoped）** |
| `pdf-normative` / `normativepdf` | ✅ 空き |
| `pdf-canonical` | ✅ 空き |
| `canonical` | ❌ 使用中 |
| `strictpdf` / `pdf-strict` | ✅ 空き（ただし上記の意味衝突により非推奨） |
| `clausepdf` / `pdf-clause` | ✅ 空き |

## 決める前に確認すること

- [x] npm の空き → 上表
- [ ] ドメインの空き（`.dev` / `.org`。紹介サイトを前提とする）
- [ ] GitHub org/user 配下の重複
- [ ] 既存 PDF ライブラリとの紛らわしさ（`pdf-lib` / `pdfkit` / `pdfmake` / `pdfnative` / `pdfjs`）
- [ ] 商標検索（特に印刷・イメージング分野）
- [ ] ロゴ・短縮形が成立するか
- [ ] **同じ語が別の意味で先行使用されていないか**（strict 系で踏んだ罠）

## メモ

- パッケージを分割する場合（例: コア / タグ / 署名）、スコープ付き（`@名前/core` 等）が扱いやすい
- family 内での呼び分けを考えると、`pdf-` 接頭辞があると `pdf-writer-mcp` 等と並べたときに一貫する
- 逆に、将来 PDF 以外へ広げる気があるなら `pdf-` は足枷になる
