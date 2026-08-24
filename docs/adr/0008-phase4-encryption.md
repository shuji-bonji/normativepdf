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

### 4. 書き側 — TS 32003（AES-GCM）は landed（2026-08-24）、TS 32004（MAC）は defer

**当初「実需要待ち」としたが、受入が独立に測れる形が立ったので着手した**（shuji の
「書き側とリリースまで進める」判断）。書き側の受入は本リポジトリの二面測定（GUARDS T-2）で:

- 標準ハンドラの **AES-256-CBC（AESV3・V5/R6）**書き込みを骨格にする。これは
  **qpdf が独立にファイル全体を復号できる**（qpdf 11.9.0 実測 = `--decrypt` で平文回収・
  `--check` clean）。Encrypt 辞書生成（Algorithm 8/9/10）・鍵導出・オブジェクト枠・
  xref の書き込み機械が独立オラクルで測れる。
- その上に **AES-GCM（AESV4・V6/R7・TS 32003 §5.1/§5.2）**を載せる。暗号器は純 TS
  （CTR + GHASH・エンジン非依存を維持）で、**node:crypto の aes-256-gcm を独立オラクル**に
  各オブジェクトの復号とタグ検証を突き合わせる（qpdf は R7/V6 非対応 = 実測で確認）。
- 併せて読み側に AESV4 復号を足した（同じ R6 鍵導出 + GCM）。書いたものが自分の読み手で
  開くのが最強の自己整合。

**TS 32004（MAC / 完全性保護）は defer する。** CMS/ASN.1 の AuthenticatedData + HKDF +
digest 範囲という別レイヤで、**独立検証器がコンテナにも実在の PDF ツールにも無く**
（qpdf/veraPDF は未対応）、実需要も 0 件。測れない暗号は建てない（本リポジトリの規律）。
実需要か独立検証器が現れたら要求駆動で起こす。

### 5. 決めないこと

- **TS 32005 は Phase 5 に送る**（もともと構造ツリーの条文。handoff の実測どおり）
- **verify の `decryptor.ts` との共有は決めない**（handoff どおり別判断）。
  読み側実装時に A/B の材料として使う

## 受入（Phase 4）

### 読み側

- 暗号化 4 検体すべてで `parsePdf` + 全 in-use/compressed の `getObject` + `getCatalog` が
  成功し、**Flate を含むストリームが復号後に decode まで通る**（平文が取れたことの機械判定。
  暗号文のままなら inflate が落ちるので、成功自体が判定になる）
- 暗号文を黙って返す経路が無いこと（決定 3。T-3 = 検査を外すと該当テストが落ちる）
- 門番 2 種の baseline 更新は既存の規則（改善も赤・lock は pin-guard の規則で単独更新）に従う
- roundtrip の暗号化検体は **not-measurable のまま**が正しい — 復号して非暗号で書き直した
  ものは「同じファイルの往復」ではない（ADR-0004 の意味論を変えない）

### 書き側（TS 32003・landed 2026-08-24）

- **二面測定**（GUARDS T-2）: ①AESV3（AES-256-CBC）は **qpdf が全体復号**（`--decrypt` で
  平文回収・`--check` clean）②AESV4（AES-GCM）は **node:crypto が各オブジェクトを独立復号**
  （qpdf は R7/V6 非対応を実測）③両方とも自前読み戻しで元平文に一致・暗号化ファイルに
  平文漏れ無し
- **T-3**: AESV4 オブジェクト本文を 1 バイト変えると読みが tag 不一致で名指し失敗
  （暗号文を返さない）
- **測っていないこと（書き側）**: 客体ストリーム / xref ストリームの暗号化書き込み
  （枠の外・要求が立ったら追加）・実物の Adobe/Acrobat での相互運用（独立読み手が
  コンテナに qpdf しか無い）

## 測っていないこと

- TS 32004（MAC）の一切 — defer（決定 4）。独立検証器が無く実需要も 0
- verify `decryptor.ts` の対応範囲との差分（共有判断は未着手）

## 関連

- [`../handoff/phase4-scoping.md`](../handoff/phase4-scoping.md) — 着手前調査と決裁事項
- [ADR-0004](0004-roundtrip-acceptance.md) — 往復の意味論（not-measurable の扱い)
- [`../DESIGN.md`](../DESIGN.md) §5.1 — 移行段階の正典
