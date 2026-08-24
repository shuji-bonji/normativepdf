# ADR-0008: Phase 4 を「暗号化」に再定義する

- 状態: **Accepted**
- 日付: 2026-08-24
- 決定者: shuji（[`../handoff/phase4-scoping.md`](../handoff/phase4-scoping.md) の決裁事項に対し案 A を選択）

## 背景

Phase 4「PDF 2.0 の実体（TS 32003/32004/32005）」の着手前調査（2026-08-22・
`handoff/phase4-scoping.md`）で 3 つが実測で確定した:

1. TS 3 冊は pdf-spec-mcp に sponsored 版で入っており、条文のブロッカーは無い
2. Scope 実測 — 32003（AES-GCM）/ 32004（MAC）は**暗号化**の条文・32005 は**構造ツリー**
   = Phase 5 の前提
3. 受入「veraPDF flavour `4` COMPLIANT」は writer 0.20.x（生成 = normativepdf）の
   **109/109 で既に充足している**。暗号化もタグも無しで到達した数字であり、TS 3 冊は
   どれもこの受入の前提ではない

受入は充足済み・中身は受入と噛み合っていない、という状態に対する選択肢 A/B/C のうち
**A（暗号化 Phase として再定義）を採用した**。B（受入充足で閉じて暗号化を別 Phase に
起票）との差は Phase の番号付けだけで、作業の中身は同じ暗号化実装である。A を選んだので、
Phase 4 の名前と受入を条文と実測に合わせて書き直す。ROADMAP 更新規則 3
（スコープ変更は ADR に起こす）に従い本 ADR がその記録である。

## 実測（2026-08-24）

コーパス 2907 検体中、バイト列に `/Encrypt` を含むのは **4 件**（grep 全件・live trailer に
`/Encrypt` があることを `parsePdf` で確認済み）:

| 検体 | 方式 | 現状の挙動 |
|---|---|---|
| Isartor `PDFA-1b/…/isartor-6-1-3-t02-fail-a` | `/Filter /Standard`・V 2 / R 3（RC4・128 bit） | 全オブジェクト取得まで成功 — ただし**ストリームは暗号文のまま返る** |
| `PDF_A-2b/…/6-1-3-t02-fail-a` | V 4 / R 4・AESV2（AES-128-CBC）・StmF/StrF = StdCF | 同上（暗号文を黙って返す） |
| `PDF_A-4/…/6-1-3-t02-fail-a` | V 5 / R 6・AESV3（AES-256-CBC） | parse で名指しエラー（§7.6 を引用） |
| `PDF_UA-1/7.16 Security/7.16-t01-fail-a` | V 4 / R 4・AESV2（AES-128-CBC） | parse で名指しエラー（§7.6 を引用） |

挙動が割れる理由は暗号方式ではなく**ファイル構造**である。名指しエラーになる 2 件は
xref ストリーム / オブジェクトストリーム構造で、parse がオブジェクトストリームの
FlateDecode を踏み、復号していない暗号文の inflate に失敗して trailer の `/Encrypt` を
名指しする。古典 xref テーブルの 2 件は parse が復号を要する処理を一度も踏まないため、
`getObject` が**暗号文を平文の顔で返す**。pdf-lib の `ignoreEncryption` と同じ形であり
（family では #18 で本文が化けた実例がある）、名指しエラーより悪い。

`roundtrip:survey` は trailer の `/Encrypt` を見てこの 4 件を not-measurable にしている。
handoff が「roundtrip not-measurable 5 件」と書いたのは **not-measurable の総数**で、
5 件目は `/Prev` チェーン打ち切りの `6-1-4-t01-fail-a`（暗号化ではない）。暗号化は 4 件 —
本 ADR で訂正する。

## 決定

### 1. Phase 4 の名前と受入を変える

- 名前: 「段階 3 — PDF 2.0 の実体」→ **「段階 3 — 暗号化」**
- 旧受入「veraPDF flavour `4` COMPLIANT」は **writer 0.20.x の 109/109 で充足済みの実測**
  として ROADMAP に記録し、Phase 4 の受入からは外す
- DESIGN §5.1 の段階 3 の行を先に直し、ROADMAP は追従する（更新規則 2）

### 2. スコープ: 読み側（復号）が先行する

要求が立っているのは読み側だけである（上の 4 検体 + family の encrypted 実ファイル）。

- **§7.6.4 標準セキュリティハンドラ**の復号。コーパスが要求する 3 方式:
  - RC4（V 2 / R 3・§7.6.3.2 Algorithm 1）
  - AES-128-CBC（V 4 / R 4・crypt filter AESV2・§7.6.3.2）
  - AES-256-CBC（V 5 / R 6・AESV3・§7.6.3.3 Algorithm 1.A + §7.6.4.4 パスワードアルゴリズム）
- 復号対象は §7.6.2 のとおり**文字列とストリーム**。例外も §7.6.2 =
  trailer `/ID`・Encrypt 辞書内の文字列・署名辞書 `/Contents` の 16 進文字列。
  **xref ストリームは復号対象外**（Table 20 StmF の shall）
- 公開鍵ハンドラ（§7.6.5）は**作らない** — 要求が 1 件も立っていない
- パスワードはまず空文字列（コーパス検体の形）。パスワード付きの API 形は実装時に決める

### 3. 併せて閉じる穴: 暗号文を黙って返す経路を無くす

trailer に `/Encrypt` がある文書で復号できない（未対応方式・パスワード不明）とき、
`getObject` は**常に名指しエラー**にする。黙って暗号文を返す現状の 2 検体が、
この検査の T-3（外すと落ちる）の実測根拠になる。

### 4. 書き側（TS 32003 AES-GCM / 32004 MAC）は後続

条文は入手済みだが、書きの要求はまだ 1 件も立っていない。着手条件 =
**読み側完了 + 実需要**（暗号化 PDF を書く消費者が family に現れること）。
Phase 4 の中の後続項目として置くが、読み側だけで Phase の受入は判定できる形にする。

### 5. 決めないこと

- **TS 32005 は Phase 5 に送る**（もともと構造ツリーの条文。handoff の実測どおり）
- **verify の `decryptor.ts` との共有は決めない**（handoff どおり別判断）。
  読み側実装時に A/B の材料として使う

## 受入（Phase 4 = 読み側）

- 暗号化 4 検体すべてで `parsePdf` + 全 in-use/compressed の `getObject` + `getCatalog` が
  成功し、**Flate を含むストリームが復号後に decode まで通る**（平文が取れたことの機械判定。
  暗号文のままなら inflate が落ちるので、成功自体が判定になる）
- 暗号文を黙って返す経路が無いこと（決定 3。T-3 = 検査を外すと該当テストが落ちる）
- 門番 2 種の baseline 更新は既存の規則（改善も赤・lock は pin-guard の規則で単独更新）に従う
- roundtrip は**書き側暗号化が入るまで not-measurable のまま**が正しい —
  復号して非暗号で書き直したものは「同じファイルの往復」ではない（ADR-0004 の意味論を
  変えない）

## 測っていないこと

- 4 検体のパスワードが空であること（実装の最初に測る。空でなければ受入の分母から
  理由つきで外す）
- TS 32003 / 32004 の書き側要件の詳細（着手時に条文を引く）
- verify `decryptor.ts` の対応範囲との差分

## 関連

- [`../handoff/phase4-scoping.md`](../handoff/phase4-scoping.md) — 着手前調査と決裁事項
- [ADR-0004](0004-roundtrip-acceptance.md) — 往復の意味論（not-measurable の扱い)
- [`../DESIGN.md`](../DESIGN.md) §5.1 — 移行段階の正典
