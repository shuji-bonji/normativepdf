# 引き継ぎ: L2 — 文書モデル（グラフ容器 + ページツリーの意味規定）

- 対象リポジトリ: `normativepdf`（実装のみ。writer はまだ触らない）
- 決定: [`../adr/0007-document-model-scope.md`](../adr/0007-document-model-scope.md)（範囲・可変性・受入）
- 位置: [`phase3-pdflib-removal.md`](phase3-pdflib-removal.md) §3.5 の **L2**。L1 / L1.5 は完了
- この文書だけで着手できる

---

## 1. なぜこれが要るか（1 段落）

writer の pdf-lib 依存 19 ファイルで上位に来るのは `PDFName` / `PDFArray` / `PDFDict` / `PDFRef` で、
これらは normativepdf の COS 型と 1 対 1 に対応する。**難所は COS ではなく、それらが生きた
`PDFDocument.context` に register / lookup されること**で、そこを置き換えるには器が要る。
器を作らずにサービスを 1 つずつ移すと、`pdf-lib → COS` の変換層を書くことになる
（§6 で作らないと決めたもの）。

## 2. 作るもの / 作らないもの

ADR-0007 §1 の 3 分割がそのまま範囲である。

| | 中身 | ここで作るか |
|---|---|---|
| (a) | グラフ容器（可変オーバーレイ・load / save） | ✅ |
| (b) | ページツリーの意味規定（`/Count`・重複参照・`/Parent`・継承） | ✅ |
| (c) | オーサリング API（`addPage` / `drawText` / ブロック） | ❌ writer に残す（DESIGN §5） |

## 3. 形（提案・実装時に条文で詰める）

```
src/doc/
  document.ts     PdfDocumentEditor  — グラフ容器 (a)
  page-tree.ts    ページツリーの走査・検査・/Count 再計算 (b)
```

### 3.1 グラフ容器

既存の `PdfDocument`（読み取り専用・遅延・キャッシュ付き）を**包む**。置き換えない。

🔴 **オーバーレイの鍵は `objectNumber` + `generationNumber` の対にする。**
ページツリーの中だけを見ると世代 ≠ 0 は 0 件（間接参照 15,834 件すべて gen 0）だが、
**オーバーレイが鍵にするのは全オブジェクト**であり、xref 全体では
**世代 ≠ 0 の in-use エントリが 12 件・2 検体に実在する**
（`TWG test suite A029-pdfa2-pass-b.pdf` / `-d.pdf`・gen 1〜6 が各 2）。
番号だけを鍵にすると、この 2 検体で別のオブジェクトを取り違える。

```ts
class PdfDocumentEditor {
  static async open(bytes: Uint8Array): Promise<PdfDocumentEditor>;

  // 読み — 未変更なら下の PdfDocument に委ね、変更済みならオーバーレイを返す
  get(objectNumber: number, generationNumber?: number): Promise<CosObject>;
  resolve(value: CosObject): Promise<CosObject>;

  // 書き — 触れたものだけがオーバーレイに載る
  set(objectNumber: number, object: CosObject, generationNumber?: number): void;
  allocate(object: CosObject): CosRef;   // 新しい番号を採る
  delete(objectNumber: number, generationNumber?: number): void;

  // 何が変わったか（appendUpdate の入力そのもの）
  changed(): readonly WritableObject[];
  deleted(): readonly DeletedObject[];

  // 出口は 2 つだけ
  save(options?: WriteFileOptions): Promise<Uint8Array>;          // 全書き直し
  appendUpdate(options?: AppendUpdateOptions): Promise<Uint8Array>; // 増分更新
}
```

### ✅ 実装済み（2026-08-14・`src/doc/document.ts`）

`open` / `get` / `resolve` / `getCatalog` / `set` / `allocate` / `delete` /
`changed` / `deleted` / `dirty` / `save` / `appendUpdate`。

**`allocate` は参照も避ける。** 「定義済みの最大番号 + 1」は素直だが誤りで、
定義の無い番号を新しいものに与えると**宙ぶらりんの参照がそこに解決される**
（段階 1 で writer が踏み、qpdf が
`operation for dictionary attempted on object of type stream` と言った）。

コーパスで数えた（2026-08-14）: **2,890 検体中 1 件**が該当する ——
`6-2-11-4-1-t01-fail-a.pdf` は最大 20 番まで定義して 21 番を参照している。
1 件だが**失敗が静か**なので、全参照の走査を入れることにした。
走査は `open` ではなく **`allocate` の初回**に行う。読むだけ・既存を置き換えるだけの
使い方は走査の代金を払わない。

⚠️ **トレーラの編集はこの段では持たない**（`/Root` の差し替えなど）。
`save` も `appendUpdate` も元のトレーラを引き継ぐ。受入（無編集の往復）には要らず、
中途半端に入れると `appendUpdate` 側だけ効かない形になるため。

> 🔴 **0.5.0 で入れた**（2026-08-14）。見送りの理由は正しかったが、
> **生成パス（L3'）が要求した** —— 何も無いところから作る文書は `/Info` と `/ID` を
> 自分で書くしかなく、両方トレーラに載る（§7.5.5 Table 15）。`/ID` は PDF 2.0 では
> Required なので、これ無しには `create-text-cff-20` も PDF/A-4 の検体も成立しない。
> `setTrailerEntry(key, value)` は**両方の出口で効く** —— `save` は読んだトレーラに
> 重ね、`appendUpdate` は重ねた結果を追記する節へ運ぶ（§7.5.6 が
> 「`/Root` / `/Info` / `/ID` はこうして変わる」と言っている経路）。
> `/Size` と `/Prev` は**断る**（どちらも writer が導出する値で、
> 受け取って黙って捨てると「書いたつもり」が残る）。
> トレーラだけを触った場合も `dirty` は真にする（`appendUpdate` が
> 「何も変わっていない」と断らないため）。

### 3.2 なぜオーバーレイなのか（3 つとも既存の受入から来ている）

1. **`appendUpdate` は「このリビジョンが書くオブジェクト」を入力に要求する。**
   オーバーレイならその集合がそのまま `changed()` になる。全件 materialize すると
   差集合を別途計算することになり、間違えれば無関係なオブジェクトが増分更新に混ざる
2. **ADR-0005 の第 1 段は「元バイト列の完全一致」。** オーバーレイは元バイト列に触れない
3. **遅延は性能ではなく到達性の問題。** 4MB 級の検体があり、`/Info` が存在しない先を指す
   検体も実在する。全件 materialize は、触ってもいないオブジェクトの解析失敗で `open` を落とす

⚠️ **非同期を隠さない**（ADR-0007 §4）。同期に見せるには全件先読みが要り、上と衝突する。

### 3.3 ページツリーの意味規定 — ✅ 実装済み（2026-08-14・`src/doc/page-tree.ts`）

`readPageTree` / `inheritedAttribute` / `checkPageTree` / `countCorrections` / `withCount`。
編集側からは `pageTree()` / `pages()` / `pageAttribute(index, key)`。
`save()` と `appendUpdate()` は書く前に **`/Count` を再計算し、それ以外の違反は投げる**。

**厳格にするコストは実測でゼロだった。** 入れる前に 7 種すべてを数えた
（2,896 検体・12,940 ページ・2026-08-14）:

| 検査 | 発火 |
|---|---|
| `/Count` 不整合 | 0 |
| 重複参照 | 0 |
| `/Parent` が非参照 | 0 |
| `/Parent` が実際の親でない | 0 |
| `/Rotate` が 90 の倍数でない | **0**（`/Rotate` を持つ 598 ページ中） |
| 空の `/Contents` 配列 | **0**（配列 17 件中） |
| `/Resources` / `/MediaBox` がどこにも無い | 0 |

検出器はすべて条件を反転させて発火を確認した（575/598・16/17・2,896）。
規定を入れた後も **`open → 無編集 save` は `rewrite` とバイト同一**（2,890 件）。

🔴 **検体が実装の欠陥を 1 件捕まえた。** `inheritedAttribute` を
「渡されたキーで祖先を辿る」と書いたところ、**継承可能でない属性まで降りてきた**
（R-7.7.3.3-2 は「継承可能と明記されていない属性は継承してはならない」）。
`inherit-all-four` が祖先に `/Tabs` を置いてあるのは、まさにこれを取り違えさせるためだった。
コーパスには 1 件も素材が無い面である。

### 条文と実装の対応

**これがこの段の本体である。** 「木を歩ける」ことではなく「**shall を表現不能にする**」ことが目的。
`buildType0Font` が W-2 を表現不能にしたのと同じ形を狙う。

| 条文 | 要求 | 実装での扱い |
|---|---|---|
| **R-7.7.3.2-8** | 「**A PDF writer shall ensure** that Count is consistent with Kids and its descendants」 | **導出値として再計算する。** 呼び出し側に数えさせない。入力と違ったら報告する |
| R-7.7.3.2-4 / R-7.7.3.3-3 | 同じノード / ページへの複数の間接参照は **shall not** | save 前に検査して**投げる** |
| R-7.7.3.3-5 | `/Parent` は Required かつ**間接参照** | 木を組む API が参照しか受け取らない形にする |
| R-7.7.3.4-4 | 継承は**マージせず as-is**（配列・辞書でも） | 解決はコピーを返さない。見つけた値をそのまま返す |
| R-7.7.3.4-5/-6 | `/Resources` は Parent を辿り、**最初に見つかった時点で停止**し、**まるごと**使う | 探索を 1 関数に閉じる。「見つかったものを足し合わせる」実装を書けなくする |
| R-7.7.3.4-7/-8 | **Linearized なら継承してはならない** | 継承の解決は提供するが、線形化ファイルは作らない（§5） |
| R-7.7.3.3-8 | リソース不要なら `/Resources` は**空辞書**（省略ではない） | 木を組むとき既定で空辞書を置く |
| R-7.7.3.3-26 | **空の `/Contents` 配列を作ってはならない** | 配列が空になるなら `/Contents` ごと落とす |
| R-7.7.3.3-28 | `/Rotate` は 90 の倍数 | 検査。writer の `rotation.ts` が同じ検査を持っている（移す先はここ） |

⚠️ **R-7.7.3.2-2「shall not be required to preserve the existing structure of the page tree」は
「元の木を捨てて別物にしてよい」ではない。** 木を組み直してよいと言っているだけ。
増分更新は元の構造を保つ必要があるので、**モデルの既定は保持**。

### 3.4 load は寛容・save は厳格（ADR-0007 §6）

- **load** — 条文に反する木でも読める。読めなくなったら回復パースの後退
- **save** — 上の shall に反する木は**書く前に投げる**。黙って直すと、利用者は自分が
  条文に反する木を作ったことを知らないままになる
- **例外は `/Count`** — 導出値なので再計算する

**この厳格さのコストは実測済みで、ゼロである**（ADR-0007「測ってあること」）:
コーパス 2,907 件で `/Count` 不整合 **0** / 重複参照 **0** / `/Parent` 非参照 **0**（読めた 2,889 件）。
計器は T-3 に通してある（比較を 1 ずらすと 393/393 が挙がる・重複判定も 393/393 で発火）。

⚠️ **3 件とも 0 = この検査はコーパスでは一度も発火しない。** T-3 は合成した検体で取ること。

## 4. 受入（ADR-0007 §5）

**L2 は writer がまだ使わないので `uc-oracle` は緑のまま動かない。** 受入は normativepdf 側で完結させる。

現在の往復の合格基準は `rewrite()` = `collectObjects` → `writeFile` の経路で測っている。これを
**`PdfDocumentEditor.open()` → 無編集 → `save()`** に置き換えて、同じ基準を適用する。

| 面 | 基準 |
|---|---|
| 自己一貫性 | `npm run roundtrip:survey` が **2,881/2,881** を下回らない |
| 他者可読性 | qpdf が元ファイルに無い苦情を出さない（同 2,881 件） |

✅ **自己一貫性と他者可読性は取れた（2026-08-14）。** 測り方は「もう一度 gate を回す」ではなく
**等価であることを示した**: `PdfDocumentEditor.open() → 無編集 → save()` の出力が
`rewrite()` の出力と**バイト同一**であることを、**両方が読めた 2,890 件すべて**で確認した
（母集団は veraPDF-corpus 2,907 + pdf20examples 7 = 2,914。差 24 は `rewrite` 側も読めない）。
出力が 1 バイトも違わないので、gate の結果は構成上そのまま成り立つ。

ホスト実走でも確認済み: `roundtrip:survey` が **2,881/2,881**・
qpdf も **2,881/2,881 で新しい苦情なし**（gate の分母 2,881 は上の 2,890 の部分集合）。
| 増分更新 | `selfmade-pades-lta.pdf` / `dss-pades-5sigs-doctimestamp.pdf` で**署名が VALID を維持** |

✅ **増分更新の面も取れた（2026-08-14）。** 両検体とも**入力にも同じ読み手を通して**帰属を記録した:

| 検体 | 入力 | 追記後 |
|---|---|---|
| `selfmade-pades-lta`（署名 2 本） | 2 本とも VALID | **2 本とも VALID**・署名範囲の後ろ +835 = 追記分ちょうど |
| `dss-pades-5sigs`（署名 6 本） | Sig1 INVALID（**証明書が失効**）・他 5 本 VALID | **判定は 1 つも変わらない**・DocTimeStamp が全体を覆わなくなるのみ |

Sig1 の INVALID は入力の時点でそうであり、追記のせいではない。
**入力を測っていなければ「壊した」と読み違えていた。**

🔴 **この過程で 2 件見つかった。**

1. **5 署名検体は `parsePdf` で開けなかった** — trailer の `/Prev 0` でチェーン全体を拒否していた。
   `readXrefChain` が**打ち切りを値で返す**形に変えた（`complete` / `prev-zero` /
   `unreadable` / `cyclic` / `malformed`）。最新セクションが読めない場合だけは今までどおり投げる。
   **打ち切った文書は `save` と `rewrite` を拒み（読めなかった節のオブジェクトを黙って落とすため）、
   `appendUpdate` は許す**（元バイト列がそのまま残るため）= `TruncatedHistoryError`
2. **`allocate` が 3 番を返した** — 古いリビジョンが定義している番号である。
   Table 15 の `/Size` は**ファイル全体**（読めなかったリビジョンを含む）について
   「最大のオブジェクト番号 + 1」なので、採番の下限を `/Size` にした。
   5 署名検体では読めた最大が 153・`/Size` が 154 で、直すと 154 を返す
| 意味規定 | §3.3 の各検査について **T-3**（検査を外したら通らなくなるテストがあること） |
| 木の形 | **合成した検体**（深さ 3 超・中間ノード複数・継承 4 属性）で走査と再計算が正しいこと |
| 世代 | `TWG test suite A029-pdfa2-pass-b.pdf` / `-d.pdf` が往復で同じ結果になること |

**3 モード（`table` / `stream` / `objstm`）すべてで測る。** 段階 1 がそうしたから。

⚠️ **合成した検体は避けられない。** §5 のとおり、木の形と §3.3 の 3 検査はコーパスに素材が無い。
コーパスは「基準を下回らない」ことしか示さないので、それだけを受入にすると
**新しく書いた検査が一度も動かないまま緑になる**。
設計は [`l2-synthetic-specimens.md`](l2-synthetic-specimens.md)。**実装より先に作る。**

⚠️ **往復が緑だけでは受入としない**（ADR-0004 §1）。両側が同じパーサを共有するので、
読みの誤りと書きの誤りが打ち消し合う。qpdf の面が要る。

## 5. 着手前の計測 — 済（2026-08-14）

3 件とも数えた。詳細と T-3 は ADR-0007「測ってあること」。結論だけ:

| 測ったこと | 結果 | 実装への含意 |
|---|---|---|
| 祖先から継承しているページ | **11 ページ / 11 検体**（`/Resources` 5・`/MediaBox` 5・`/CropBox` 5・`/Rotate` 0） | **継承の解決は実装する。** 実際に使われている |
| `/Count` を持たない中間ノード | **0** | 再計算だけでよい |
| ページツリー内の世代 ≠ 0 | **0**（間接参照 15,834 件） | — |
| **xref 全体**の in-use で世代 ≠ 0 | **12 件 / 2 検体** | 🔴 **鍵は番号 + 世代の対**（§3.1） |

### この計測が示した、コーパスで測れない面

- ⚠️ **木の形。** 中間ノードは全体で **11 個**、木の最大深さは **3**、ページ総数 12,932。
  つまり **2,889 検体の 99% は「根 → ページ」の平らな木**である。
  木を組み直す実装や、深い木の走査を入れても、**コーパスは後退を検出できない**
  （[[saturated-faces-cannot-carry-a-difference]]）。合成した検体が要る
- ⚠️ **継承の標本の狭さ。** 11 件は全部 veraPDF の「6.1.13 Implementation limits」1 か所から来ている。
  「継承が動く」ことは示せるが、「いろいろな継承が動く」ことは示せない
- ⚠️ **§3.3 の 3 検査（`/Count` 不整合・重複参照・`/Parent` 非参照）はコーパスで一度も発火しない**（全部 0 件）

## 6. 触ってはいけないもの

- **オーサリング API を作らない**（ADR-0007 §1 の (c)・DESIGN §5）
- **`PdfDocument` を可変にしない。** 包む。reader / verify が読み取り専用として使っている
- **決定論的出力（DESIGN §4.1）を成り立たなくしない**
- **コーパスの pin（`corpus.lock.json`）と実装変更を同じ commit に入れない**
- **writer 側の方針を持ち込まない** — `/ID` の更新（§14.4）・DocMDP 判定・dirty 参照追跡は
  writer に残るもの（`incremental.ts` 587 行）

## 7. 参照

- [`../adr/0007-document-model-scope.md`](../adr/0007-document-model-scope.md) — 範囲・可変性・受入の正典
- [`../adr/0004-roundtrip-acceptance.md`](../adr/0004-roundtrip-acceptance.md) — 往復は単独では受入にしない
- [`../adr/0005-incremental-update-acceptance.md`](../adr/0005-incremental-update-acceptance.md) — 元バイト列の不変
- [`../DESIGN.md`](../DESIGN.md) §5（低レベル一本）/ §6.1-5（高レベルは別パッケージ）
- ISO 32000-2 §7.7.2 Table 29 / §7.7.3 Table 30・31 / §7.7.3.4（継承）
