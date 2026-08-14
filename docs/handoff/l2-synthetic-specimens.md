# 引き継ぎ: L2 の合成検体 — 文書モデルの受入を測る道具

- 対象: `normativepdf/tests/`（実装より先に作る）
- 位置: [`l2-document-model.md`](l2-document-model.md) §4 の受入で使う道具。**L2 の実装より先**
- 決定: [`../adr/0007-document-model-scope.md`](../adr/0007-document-model-scope.md)
- この文書だけで着手できる

---

## 1. なぜコーパスだけでは足りないか（実測・2026-08-14）

veraPDF-corpus 2,889 検体を歩いて数えた結果、**L2 が触る面のほとんどに素材が無い**:

| L2 が触るもの | コーパスにある素材 | 測れるか |
|---|---|---|
| 木の走査・組み直し | 中間ノード **11 個**・最大深さ **3**・ページ 12,932 | ❌ 99% が「根 → ページ」の平ら |
| 継承の解決（§7.7.3.4） | **11 ページ / 11 検体**（全部 veraPDF「6.1.13 Implementation limits」1 か所） | △ 動くことは示せる |
| `/Count` 不整合の拒否 | **0 件** | ❌ 一度も動かない |
| 重複参照の拒否 | **0 件** | ❌ 一度も動かない |
| `/Parent` 非参照の拒否 | **0 件** | ❌ 一度も動かない |
| 世代 ≠ 0 のオブジェクト | **12 件 / 2 検体**（xref 全体） | △ 鍵の設計には足りた |

**コーパスは「基準を下回らない」ことしか示さない。** それだけを受入にすると、
新しく書いた検査が一度も動かないまま緑になる。

## 2. 作り方 — 手書きのバイト列

**`writeFile` で検体を作らない。** 作ると、読みの誤りと書きの誤りが打ち消し合う（GUARDS T-2）。
文書モデルは `PdfDocument`（パーサ）の上に建つので、パーサ由来の誤りも同じように打ち消し合う。

既に先例がある。`tests/file-parser.test.ts` の `buildPdf` が
**手書きのオブジェクト列 + オフセット自動計算**でこれをやっている:

> Fixtures are assembled with computed offsets so every xref entry is exact by construction —
> hand-written offsets would rot the moment a fixture changes.

### やること: `buildPdf` を共有ヘルパへ出し、3 つ足す — ✅ 済（2026-08-14）

```
tests/helpers/build-pdf.ts     ← file-parser.test.ts から移した（そちらは import に置き換え済み）
```

足すのは 3 つ:

1. **オブジェクトごとの世代番号**（今は全部 0 固定）— 世代 ≠ 0 の検体に要る
2. **`/Root` 以外のトレーラ項目**を渡せるようにする
3. 🔴 **xref エントリをオブジェクト番号で引く**（下記）

### 🔴 現在の `buildPdf` は「配列の順 = オブジェクト番号」を仮定している

`buildPdf` は渡された配列の i 番目を xref の i 番目のエントリとして書く。
つまり**オブジェクトを番号の昇順・連番で渡さないと、xref が別のオブジェクトを指す**。

設計を書いた直後に自分で踏んだ（2026-08-14）。`inherit-shadowed` を
`2, 4, 3` の順に並べたところ、qpdf が
`object 4 0, offset 234: expected 4 0 obj` / `file is damaged` と言った。
`nested-unbalanced` はたまたま昇順だったので通っていた。

**番号で引く形に直した。** 「昇順で渡すこと」を規約にすると、木の構造を読みやすく並べたい
という当然の欲求と衝突し、同じ間違いが繰り返される。番号の穴は
**サブセクションに割る**（§7.5.4 はいくつあってもよい）。free エントリを捏造しない。

**検算（2026-08-14・サンドボックス実走）**:

| 測ったこと | 結果 |
|---|---|
| 既定の経路が旧実装とバイト同一か（既存 25 テストの回帰） | **9/9 形で同一** |
| 番号が昇順でない並び（`1, 2, 4, 3`） | qpdf **clean**・`parsePdf` 通過 |
| ↑ その中身が取り違えられていないか | obj2 = `/Pages` 612×792 / obj4 = `/Pages` 595×842 / obj3 = `/Page` ✅ |
| 番号に穴（`1, 2, 7`） | `xref\n0 3\n…\n7 1\n…` に割れる・qpdf clean |
| 世代 ≠ 0（`3 4 R`） | `getObject(3,4)` = dict / `getObject(3,0)` = **null**・qpdf clean |
| ビルダ自身が拒むもの | 番号 0（§7.3.10）・番号の重複 |

⚠️ **「parsePdf を通った」だけでは足りない。** 直す前も `parsePdf` は（回復パースを経て）
何かを返しうる。**辞書の中身まで見る** — obj 4 が `/Page` として読めたら、
それは xref がまだ配列順で組まれている。

⚠️ この件は §2 の「検算」が働いた実例でもある。**qpdf と normativepdf のパーサが
両方とも捕まえた** — normativepdf は
`cross-reference table points object 4 0 at a definition of 3 0 (§7.5.4)` と条項つきで拒否した。
検体ビルダを検算せずに使っていたら、**壊れた検体で L2 を採点していた**。

⚠️ **xref ストリーム版は作らない。** 作ると `buildXrefStream` の 2 つ目の実装をテストコードに持つことになる。
xref 3 形式（`table` / `stream` / `objstm`）の被覆は**コーパスの往復が既に持っている**。
合成検体で測るのは**ページツリーの意味**であって、xref の形ではない。**合成検体は古典テーブルのみ。**

### 検算 — 検体ビルダ自身が正しいことをどう示すか

ヘルパも実装なので間違いうる。**肯定系の検体は qpdf に通す**（GUARDS T-2 = 独立実装で読み戻す）。
qpdf が苦情を出したら、それは検体の欠陥であって実装の欠陥ではない。

否定系（条文に反する検体）は qpdf も苦情を出しうる。**qpdf が何と言ったかを記録する**だけにして、
合否には使わない。

✅ **実測済み（2026-08-14）**: `flat-1page` と `nested-unbalanced` は qpdf が
`No syntax or stream encoding errors found`。`inherit-shadowed` は苦情が出たが、
原因は検体ではなくビルダだった（上記）。

## 3. 肯定系の検体 — 軸で並べる

「ツールごと」ではなく軸で並べる（ADR-0006 §5 と同じ規律）。

| id | 軸 | 木の形 | 何を測るか |
|---|---|---|---|
| `flat-1page` | depth 1 / 中間 0 | 根 → p1 | 最小。ここが通らなければ他は読まない |
| `flat-3pages` | depth 1 / 中間 0 | 根 → p1 p2 p3 | 平らな木。コーパスの 99% と同じ形 |
| `nested-balanced` | depth 2 / 中間 2 | 根 → [A → p1 p2] [B → p3 p4] | 走査の再帰 |
| **`nested-unbalanced`** | depth 2 / 中間 1 | 根 → [A → p1 p2] [p3] | **`/Count` の本命**（下記 §5） |
| `nested-deep` | depth 4 / 中間 3 | 根 → A → B → C → p1 | コーパスの最大深さ 3 を超える |
| `gen-nonzero` | 世代 ≠ 0 | 平ら・ページが `2 3 R` | オーバーレイの鍵（番号だけでは取り違える） |
| `inherit-from-parent` | 継承 / 1 段上 | 根 → A → p1（A が属性を持つ） | 継承の基本 |
| **`inherit-shadowed`** | 継承 / 2 段・値が違う | 根と A が**別の値**を持つ | **停止規則の本命**（下記 §5） |
| **`inherit-not-merged`** | 継承 / 合成されうる形 | 根 `/Resources` に `/XObject`、A に `/Font` | **as-is の本命**（下記 §5） |
| `inherit-all-four` | 継承 / 属性 4 種 | `/Resources` `/MediaBox` `/CropBox` `/Rotate` | 属性ごとに経路が分かれていないか |
| `resources-empty-dict` | R-7.7.3.3-8 | ページが `/Resources << >>` | 空辞書は合法（省略とは違う） |
| `contents-array` | R-7.7.3.3-22/-23 | `/Contents [4 0 R 5 0 R]` | 配列形式を落とさない |

**継承の対象は 4 属性**（Table 31 で inheritable と書かれているもの）:
`/Resources` `/MediaBox` `/CropBox` `/Rotate`。**これ以外は継承しない**（R-7.7.3.3-2）ので、
`inherit-all-four` には「継承されない属性を祖先に置いて、ページに降りてこないこと」も入れる。

## 4. 否定系の検体 — 読めるが書けない

ADR-0007 §6 の「load は寛容・save は厳格」を測る。**1 検体につき 2 つ測る**:

1. `parsePdf` が**通ること**
2. `save()` が**投げること**（そのとき条項番号を名指ししていること）

| id | 反する条文 | 仕込み |
|---|---|---|
| `bad-count-high` | R-7.7.3.2-8 | 根 `/Count 5`・実際は 3 ページ |
| `bad-count-low` | R-7.7.3.2-8 | 根 `/Count 1`・実際は 3 ページ |
| `bad-count-missing` | R-7.7.3.2-8 | 根に `/Count` が無い |
| `bad-count-nonint` | R-7.7.3.2-8 | `/Count 3.0`（実数） |
| `dup-page-ref` | R-7.7.3.3-3 | `Kids [4 0 R 4 0 R]`（同じページを 2 回） |
| `dup-node-ref` | R-7.7.3.2-4 | 2 つの中間ノードが同じ子ノードを指す |
| `parent-direct` | R-7.7.3.3-5 | `/Parent << /Type /Pages … >>`（直接辞書） |
| `parent-wrong` | R-7.7.3.3-5 | `/Parent` が実際の親でないノードを指す |
| `parent-missing` | R-7.7.3.3-5 | 根以外に `/Parent` が無い |
| `rotate-45` | R-7.7.3.3-28 | `/Rotate 45` |
| `contents-empty-array` | R-7.7.3.3-26 | `/Contents []` |
| `resources-nowhere` | R-7.7.3.4-2 | ページにも祖先にも `/Resources` が無い |

🔴 **各検体が `parsePdf` を通ることを先に確かめる。**
反例は手前の層を通り抜けないと反例にならない。パーサが先に拒否する検体は
**save の規則を一度も測っていない**のに緑になる。

✅ **実測済み（2026-08-14）: 上の 10 形すべてが `parsePdf` を通り、ページ辞書まで到達する。**
`/Count 1.0`（実数）も `/Parent << … >>`（直接辞書）も `/Contents []` も
`/Parent` 欠落も、パーサは拒否しない。**この 12 検体はすべて save 側の規則を実際に測れる。**
（測ったのは `bad-count-high` / `bad-count-missing` / `bad-count-nonint` / `dup-page-ref` /
`parent-direct` / `parent-missing` / `rotate-45` / `contents-empty-array` /
`resources-nowhere` / `gen-nonzero` の 10 形。残り 2 形 = `bad-count-low` / `dup-node-ref` /
`parent-wrong` は同じ構文の別値なので同じ結果になる。）

## 5. 差を運べる形にする — この設計の中心

検体は「条文に沿っている」だけでは足りない。**正しい実装と、ありそうな間違った実装が、
違う答えを出す形**でなければ、その検体は何も測らない。

### `/Count` — 木が平らだと差が出ない

平らな木では `Kids.length` と「子孫ページ数」が**同じ値になる**。
だから素朴な `Kids.length` 実装でも緑になる。

`nested-unbalanced` はこう仕込む:

```
根 Pages   Kids [A, p3]     → Kids.length = 2 / 正しい Count = 3
  A Pages  Kids [p1, p2]    → Kids.length = 2 / 正しい Count = 2
```

**根で 2 と 3 が割れる。** ここでしか `Kids.length` 実装は落ちない。
`nested-balanced`（4 ページ）も根で 2 対 4 に割れるので、両方が要るわけではないが、
不均衡のほうは「Page と Pages が同じ Kids に混ざる」形も同時に測れる。

### 継承の停止規則 — 祖先が 1 つしか値を持たないと差が出ない

R-7.7.3.4-5/-6 は「Page から Parent を辿り、**最初に見つかった時点で停止**」と言う。
祖先が 1 つだけ値を持つ木では、**「最初のヒット」も「最後のヒット」も「根の値」も同じ答え**になる。

`inherit-shadowed` はこう仕込む:

```
根 Pages   /MediaBox [0 0 612 792]
  A Pages  /MediaBox [0 0 595 842]      ← ページに近いほう
    p1 Page （/MediaBox を持たない）
```

正しい実装は **595 842**。根から探す実装は **612 792**。**ここで割れる。**

### 継承の as-is — 別々のキーを別の祖先に置く

R-7.7.3.4-4 は「マージしない」と言う。同じキーの辞書が祖先に 2 つあるだけでは、
マージする実装としない実装が**同じキー集合**を返すことがある。

`inherit-not-merged` はこう仕込む:

```
根 Pages   /Resources << /XObject << /X1 9 0 R >> >>
  A Pages  /Resources << /Font << /F1 8 0 R >> >>
    p1 Page （/Resources を持たない）
```

正しい実装は **`/Font` だけ**を持つ辞書。マージする実装は `/Font` と `/XObject` の両方。
**キーの数で割れる。**

### 世代番号 — 番号だけの鍵と対の鍵で差が出る形

`gen-nonzero` は、**同じ番号で世代の違うエントリ**を作るのではなく
（xref は番号ごとに 1 エントリしか持てない）、
**世代 ≠ 0 のオブジェクトを含む木**にする。オーバーレイに `set()` したあと
`get()` が同じものを返すかで測る。番号だけを鍵にすると、
`4 2 R` に書いたものが `4 0 R` として読めてしまう。

## 6. 置き場所 — ✅ 済（2026-08-14）

```
tests/helpers/build-pdf.ts          検体ビルダ（file-parser.test.ts から移した）
tests/helpers/page-trees.ts         肯定 13 形 + 否定 12 形 + axisCoverage
tests/page-tree-fixtures.test.ts    検体自身を測る（L2 の実装より先に立つ）
tests/page-tree.test.ts             ← L2 の実装と一緒に書く（肯定系を model 経由で）
tests/page-tree-invalid.test.ts     ← 同上（save が投げること）
```

**`page-tree-fixtures.test.ts` は L2 が無くても動く。** 測るのは 3 つ:

1. 肯定 13 形が parse を通り、宣言したページ数と一致する
2. 否定 12 形が **parse を通る**（通らない検体は save の規則を一度も測らない）
3. 差を運ぶ 7 形について、**間違った答えと正しい答えが実際に違う**こと

実走（サンドボックス・2026-08-14）: 肯定 13 形すべて qpdf **clean**・
否定 12 形すべて parse 通過・差を運ぶ 7 形すべて成立。

⚠️ **軸の被覆をテストの中で検査する。** 1 形しかない軸を列挙し、
想定と違えば落とす。uc-oracle の `revisions` 軸は
「検体はあるのにラベルが無い」状態で被覆が閉じているように見えていた。
今の 1 形は `mixedKids` だけ（真偽値なので不在がもう一方の形）。

**検体は .pdf として凍結しない。** `uc-oracle` が `form-basic.pdf` を凍結したのは
「作る手段（pdf-lib）が消えるから」で、ここは手書きなので消えない。
むしろ**バイナリにすると仕込みが読めなくなる** —
レビューする人は「この検体は `/Count 5` で実際は 3 ページ」を目で見られる必要がある。

## 7. 受入

| 面 | 基準 |
|---|---|
| 肯定系 | 全検体が `parsePdf` を通り、**qpdf が苦情を出さない** |
| 否定系 | 全検体が `parsePdf` を**通り**、`save()` が**条項番号を名指しして**投げる |
| 差を運ぶこと | §5 の 4 つについて、**間違った実装を書くと落ちる**ことを実測する（T-3） |
| コーパス | 合成検体を足しても `roundtrip:survey` が **2,881/2,881** を下回らない |

⚠️ **T-3 を「検査を外す」でやらない。** §5 の 4 つは「**ありそうな間違った実装に差し替える**」で測る
（`Kids.length` を返す / 根から探す / 祖先をマージする / 番号だけを鍵にする）。
検査を外すだけだと、検体が差を運べているかは分からない。

## 8. 触ってはいけないもの

- **`writeFile` / `appendUpdate` で検体を作らない**（T-2）
- **xref ストリーム版のビルダを作らない**（§2）
- **検体を .pdf として凍結しない**（§6）
- **コーパスの pin（`corpus.lock.json`）と検体の追加を同じ commit に入れない**

## 9. 参照

- [`l2-document-model.md`](l2-document-model.md) — この検体を使う側
- [`../adr/0007-document-model-scope.md`](../adr/0007-document-model-scope.md) §5 §6 — 受入と「load は寛容・save は厳格」
- [`../adr/0006-phase3-differential-acceptance.md`](../adr/0006-phase3-differential-acceptance.md) §5 — 検体は軸で並べる
- [`../GUARDS.md`](../GUARDS.md) T-2（独立実装で読み戻す）/ 第三部（テストが空振りしないための規律）
- ISO 32000-2 §7.7.3 Table 30・31 / §7.7.3.4（継承）
