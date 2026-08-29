# ADR-0010: 読み側の回復方針を `@normativepdf/recover` として別パッケージにする

- 状態: **Accepted**
- 日付: 2026-08-29
- 決定者: shuji

## 背景

コアは §7.5 を条文どおり読み、条文に反する文書を受け取らない。これは
[DESIGN §4.2](../DESIGN.md)（自前で検証器を持たない）と、Phase 1 で
`readXrefSectionAt` を置いたときの記録が言っているとおりである。

> `readXrefSectionAt`（**回復方針は消費者側に残す** = 単一セクション読み）
> —— [ROADMAP](../ROADMAP.md) Phase 1

その「消費者側に残した回復方針」を、消費者が**それぞれ独立に書いた**。

| 消費者 | 状態（2026-08-29 実測） |
|---|---|
| pdf-verify-mcp | 3 ファイル 1,189 行を持つ（`xref-walk.ts` 476 / `document.ts` 483 / `cos.ts` 230）。src の 14 ファイルが import |
| `@shuji-bonji/pdf-constraints` | 回復を持たない（`parsePdf` を直接呼ぶ）。COS の読み口 `src/facts/cos.ts` 141 行を**別に**持ち、verify の `cos.ts` と 14 関数が名前ごと重複 |
| pdf-reader-mcp | まだ pdf-lib の上にある（第 3 弾で撤去予定） |

**同じ変換が 2 通りあって、そのうち 1 つだけ条文の読み方が違う**、という形で壊れる。
reader の撤去でこれが 3 通りになる前に 1 つに寄せる。

## 決定

### 1. 器 = 別 npm パッケージ `@normativepdf/recover`（npm 名は 2026-08-29 時点で空き）

**コアには入れない。** 回復方針は推測である —— 古い `startxref` への後退、
巡回検出、`N G obj` を数え上げた表の組み直し。`DocumentScope.reconstructed` は
「ファイルが持っていない表をこちらが作った」の申告であり、
2,907 件の門番で「条文どおりに読む」を証明しているコアの立場と両立しない。

**`@normativepdf/document` にも入れない。** あれは
[ADR-0009](0009-highlevel-document-package.md) が決めたオーサリング層
（Document/Page・drawText・M1〜M4）で、受入基準も刻みの速さも別である。

同じ scope に置く理由: コアが「受け取らない」と言い、隣が「受け取らなかった
ときにどうするか」を持つ形にすると、**いま各消費者の中に隠れている境界が
npm のページで見える。**

### 2. 中身（verify から移す 3 ファイル・1,189 行）

| ファイル | 役割 |
|---|---|
| `cos.ts` | COS の読み口。**ここに判定は書かない** |
| `xref-walk.ts` | チェーンの歩きと回復方針（3 段・全部申告） |
| `document.ts` | `openDocument` / `DocumentScope` / `toReadingScope` |

依存は `normativepdf` **1 つだけ**。切り出しで解くのは 3 つ ——
`logger`（36 行・stderr へ出すだけ。パッケージ側は差し替え可能な形にするか落とす）、
`XrefKind`（1 行の型別名）、`ReadingScope`（この 3 つと一緒に移る）。

**判定は入れない。** `scope` は「どこまで読んだか」であって、
「条文に適合しているか」ではない。適合の判定は pdf-verify-mcp と
pdf-constraints の仕事である（DESIGN §4.2 の線をここでも引く）。

### 3. リポジトリ構成 = multi-repo（ADR-0009 §2 と同じ）

独立リポジトリ。ローカルの作業場所は傘フォルダ `pdf-agent-stack/lib/recover`。
コーパス基盤（136MB の fetch・survey）は持たない —— 受入の道具が違う（下記）。

### 4. `@shuji-bonji/pdf-constraints` は scope を移さない

pdf-constraints は**判定する側**である（26 制約の pass/fail）。
DESIGN §4.2 は「このライブラリは自己検証機能を持たない」と言っており、
同じ scope に判定するライブラリを並べるとその 1 文が読めなくなる。
名前は `@shuji-bonji/pdf-constraints` のままにする。

**ただし利用側になる。** pdf-constraints で行うのは 3 つ:

1. `dependencies` に `@normativepdf/recover` を足す
2. `src/check.ts` 53 行目の `parsePdf(bytes)` を `openDocument(bytes)` に替え、
   `observation` に `scope` を足す
3. `src/facts/cos.ts`（141 行）を消し、3 ファイル
   （`facts/annotation.ts` / `facts/document.ts` / `facts/embedded-font.ts`）の
   import 元を替える

## 受入

| 面 | 何を見るか |
|---|---|
| **1 切り出し** | verify の A/B が **差 0 件**。同じコードの置き場所が変わるだけなので、差が出たら移し方を間違えている |
| **2 重複の解消** | `pdf-constraints/src/facts/cos.ts` が消え、COS の読み口が family に 1 つになる |
| **3 実測できる差** | pdf-constraints が `openDocument` を使うと、**いま `parsePdf` の throw で検査していない 20 件**（検体 2,950 中）が検査できるようになるはず。ならなければ理由を測る |

## 順序

1. `@normativepdf/recover` を切り出す（verify から。A/B 差 0 件を確認）
2. verify 0.22.0 —— import 元を替えるだけ
3. reader の pdf-lib 撤去を、**最初からこのパッケージの上で**書く
4. pdf-constraints で上の 3 つを行い、20 件の行方を実測する

## 影響

- コアは変わらない。`dependencies: 0` も 2,907 件の門番もそのまま
- npm org `normativepdf` に入る 1 つ目の scoped パッケージになる
  （`@normativepdf/document` はまだ未公開）
