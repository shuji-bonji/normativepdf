---
spec_id: NORMATIVEPDF
approved: 2026-11-02
pr: 2
---
# text

## Purpose

`src/text/` の層（テキスト文字列・PDFDocEncoding・日付）が、文字列オブジェクトのバイト列と JavaScript の文字列をどう相互に変換するかを定めます。
ISO 32000-2 §7.9.2（テキスト文字列）・§7.9.4（日付）・Annex D.3（PDFDocEncoding）を写した層です。どの文字列オブジェクトがテキスト文字列かは、それが現れる辞書のキーで決まるので、この層では決めません（呼び出し側が決める）。

この初版は、2026-11-02 時点の既存テストが固定している振る舞いを起こしたもので、期待値は変えていません。
起こした範囲は `tests/text-string.test.ts` の全件（46 件）です。
§7.9.2.2.1 と §7.9.4 は pdf-spec-mcp（`iso32000-2`）で原文を確かめました。Annex D.3 の Table D.3 の食い違い 3 件は `TABLE_D3_DEFECTS` が持ち、ここには写しません。

## できないこと

- 文字列オブジェクトがテキスト文字列かどうかを判断すること（キーで決まる。R-7.9.2.1-1）
- 日付の暦の正しさ（2 月 31 日など）を判断すること（§7.9.4 は日を月によらず 01〜31 で区切る）

## Requirements

### Requirement: SPEC-NORMATIVEPDF-TEXT-001 テキスト文字列は 3 つの符号化のどれかとして読む

`decodeTextString` は、バイト順マークが無ければ PDFDocEncoding、`FE FF` で始まれば UTF-16BE、`EF BB BF` で始まれば UTF-8（PDF 2.0）として読む（SHALL）。根拠は ISO 32000-2 §7.9.2.2.1。

#### Scenario: マークが無ければ PDFDocEncoding、マークに応じて UTF-16BE と UTF-8

- **WHEN** マークの無いバイト列、`FE FF` で始まるバイト列、`EF BB BF` で始まるバイト列を読む
- **THEN** それぞれ PDFDocEncoding・UTF-16BE・UTF-8 として読んだ文字列になる

### Requirement: SPEC-NORMATIVEPDF-TEXT-002 UTF-16BE のマークは 2 バイトそろったときだけマークとして扱う

先頭の `FE FF` はマークとして扱い、文字列に含めない（SHALL）。`FE` だけではマークにせず、PDFDocEncoding の文字（thorn）として読む（SHALL）。マークだけの文字列は空文字列にする（SHALL）。根拠は §7.9.2.2.1（UTF-16BE の最初の 2 バイトは 254・255）。

#### Scenario: FE FF をマークとして扱う

- **WHEN** `FE FF` に続けて `A` の UTF-16BE を読む
- **THEN** `A` になる

#### Scenario: FE だけはマークにしない

- **WHEN** `FE 41` を読む
- **THEN** `þA` になる

#### Scenario: マークだけの文字列は空

- **WHEN** `FE FF` だけを読む
- **THEN** 空文字列になる

### Requirement: SPEC-NORMATIVEPDF-TEXT-003 UTF-8 のマークは 3 バイトそろったときだけマークとして扱う

先頭の `EF BB BF` はマークとして扱い、文字列に含めない（SHALL）。`EF BB` だけではマークにせず、PDFDocEncoding として読む（SHALL）。根拠は §7.9.2.2.1（UTF-8 の最初の 3 バイトは 239・187・191）。

#### Scenario: EF BB BF をマークとして扱う

- **WHEN** `EF BB BF` に続けて `café` の UTF-8 を読む
- **THEN** `café` になる

#### Scenario: EF BB だけはマークにしない

- **WHEN** `EF BB` を読む
- **THEN** `ï»` になる

### Requirement: SPEC-NORMATIVEPDF-TEXT-004 補助文字を 1 文字として読み書きする

UTF-16BE のサロゲートペアと UTF-8 の 4 バイト列は、それぞれ 1 文字として読む（SHALL）。補助文字を書くときは、UTF-16BE のサロゲートペアにする（SHALL）。根拠は §7.9.2.2.1（Unicode のテキスト文字列を処理する reader は、補助文字を扱えなければならない）。

#### Scenario: 補助文字を読み書きする

- **WHEN** U+1F600 を UTF-16BE と UTF-8 で読み、`encodeTextString` で書く
- **THEN** 読んだ結果はどちらも 1 文字で、書いたバイト列は `FE FF D8 3D DE 00` になる

### Requirement: SPEC-NORMATIVEPDF-TEXT-005 言語のエスケープ列は Unicode の文字列からだけ取り除く

`stripLanguageEscape` は、ESCAPE（U+001B）・2 文字の言語コード・任意の 2 文字の国コード・ESCAPE の並びを、文字列のどこにあっても、いくつあっても取り除く（SHALL）。閉じていない並びと、並びを含まない文字列はそのまま返す（SHALL）。`decodeTextString` は UTF-16BE と UTF-8 の文字列にだけこれを当て、PDFDocEncoding の文字列には当てない（SHALL）。PDFDocEncoding には ESCAPE が無く、バイト `1B` は U+02D9 なので、並びを書けないため。根拠は §7.9.2.2.2。

#### Scenario: 言語のエスケープ列を取り除く

- **WHEN** 先頭・途中・複数の並び、国コード付きの並びを含む文字列から取り除く
- **THEN** 並びだけが消え、閉じていない並びと普通の文字列は変わらない

#### Scenario: PDFDocEncoding の文字列には当てない

- **WHEN** `1B 65 6E 1B 41` を `decodeTextString` で読む
- **THEN** `˙en˙A` になる

### Requirement: SPEC-NORMATIVEPDF-TEXT-006 PDFDocEncoding は 1 バイト 1 文字で読み、表に無い文字は書かない

`pdfDocDecode` は 1 バイトを 1 文字として、Annex D.3 の Table D.3 どおりに読む（SHALL）。Latin-1 と違うバイト（`18`・`80`・`8A`・`A0` など）は表の文字にし、ASCII と Latin-1 の上半分はそのままにする。`pdfDocEncode` は、表に無い文字（表で `U` の 24 個のコードと、表の外の文字）を含む文字列には `null` を返す（SHALL）。根拠は §7.9.2.3 と Annex D.3。

#### Scenario: Latin-1 と違うバイトを表どおりに読む

- **WHEN** `18 80 8A A0` を読む
- **THEN** U+02D8・U+2022・U+2212・U+20AC になる

#### Scenario: 表に無い文字は書かない

- **WHEN** U+0000 と U+65E5 を書こうとする
- **THEN** どちらも `null` になる

### Requirement: SPEC-NORMATIVEPDF-TEXT-007 マークと読み違えられる PDFDocEncoding の文字列は UTF-16BE で書く

`encodeTextString` は、PDFDocEncoding で書けても、そのバイト列が `FE FF` か `EF BB BF` で始まる文字列は、UTF-16BE で書く（SHALL）。PDFDocEncoding のまま書くと、読み手が UTF-16BE か UTF-8 として読むため。根拠は §7.9.2.2.1 の NOTE 3・NOTE 4。

#### Scenario: thorn ydieresis で始まる文字列は UTF-16BE で書く

- **WHEN** `þÿ` と U+00EF U+00BB U+00BF を書く
- **THEN** どちらも `form: "hex"`（UTF-16BE）になり、読み戻すと元の文字列になる

### Requirement: SPEC-NORMATIVEPDF-TEXT-008 書いて読み戻すと元の文字列になる

`encodeTextString` は、PDFDocEncoding で書ける文字列は PDFDocEncoding（`form: "literal"`）で、書けない文字列は UTF-16BE（`form: "hex"`）で書く（SHALL）。どちらも `decodeTextString` で読み戻すと元の文字列になる（SHALL）。言語のエスケープ列だけは、読み戻すときに取り除かれる（005）。PDFDocEncoding で定義された 256 − 24 個のバイトは、読んで書くと同じバイトに戻る（SHALL）。

#### Scenario: 書いて読み戻す

- **WHEN** PDFDocEncoding で書ける文字列・書けない文字列・補助文字を含む文字列を書いて読み戻す
- **THEN** 元の文字列になる

### Requirement: SPEC-NORMATIVEPDF-TEXT-009 日付の文字列を条文の形のときだけ読む

`parsePdfDate` は `D:YYYYMMDDHHmmSSOHH'mm` の形の文字列を各欄に分けて読む（SHALL）。`D:` と年は必須で、各欄はそれより前の欄がすべてあるときだけ置ける（R-7.9.4-12）。省いた月・日は 1、ほかは 0 にする（R-7.9.4-16）。値域（月 01〜12・日 01〜31・時 00〜23・分と秒 00〜59）の外の欄がある文字列は `null` にする（SHALL）。根拠は ISO 32000-2 §7.9.4。

#### Scenario: 条文の例を読む

- **WHEN** `D:199812231952-08'00` を読む
- **THEN** 年 1998・月 12・日 23・時 19・分 52・`-`・8 時間で、時点は 1998-12-24T03:52:00Z になる

#### Scenario: 条文の形でない文字列は null

- **WHEN** `D:` の無い文字列・年の無い文字列・前の欄が欠けた文字列・値域の外の欄を持つ文字列を読む
- **THEN** どれも `null` になる

### Requirement: SPEC-NORMATIVEPDF-TEXT-010 UT との関係を条文どおりに読む

アポストロフィは時のオフセットがあるときだけ、分のオフセットはアポストロフィがあるときだけ置ける（R-7.9.4-14・-15）。UT の情報が無ければ GMT とみなす（R-7.9.4-17）。`Z` は UT と同じで、0 のオフセットは続けてよいが、0 でないオフセットが続く文字列は `null` にする（SHALL）。PDF 1.7 までの末尾のアポストロフィは受け付ける（§7.9.4 NOTE 2）（SHALL）。

#### Scenario: UT との関係を読む

- **WHEN** オフセットの欠けた文字列・UT の情報の無い文字列・`Z` に続くオフセット・末尾のアポストロフィを読む
- **THEN** 形の合わないものは `null`、UT の情報が無ければ GMT、`Z00'00` は UT、`Z05'00` は `null`、末尾のアポストロフィ付きは読める

### Requirement: SPEC-NORMATIVEPDF-TEXT-011 日付は UT で、末尾のアポストロフィを付けずに書く

`formatPdfDate` は時点を UT の `D:YYYYMMDDHHmmSS+00'00` の形で書き、末尾のアポストロフィを付けない（SHALL）。ISO 32000-2 の形には末尾のアポストロフィが無いため。書いた文字列を `parsePdfDate` で読むと同じ時点になる（SHALL）。年が 4 桁に収まらない時点は `RangeError` にする（SHALL）。

#### Scenario: ISO 32000-2 の形で書く

- **WHEN** 2026-08-27T12:34:56Z を書いて読み戻し、10000 年以降の時点を書く
- **THEN** `D:20260827123456+00'00` になって同じ時点に戻り、10000 年以降は `RangeError` になる
