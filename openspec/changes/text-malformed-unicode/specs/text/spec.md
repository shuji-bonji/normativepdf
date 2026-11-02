## ADDED Requirements

### Requirement: SPEC-NORMATIVEPDF-TEXT-012 形の壊れた UTF-16BE と UTF-8 は、壊れた箇所を U+FFFD にして読む

`decodeTextString` は、形の壊れた UTF-16BE・UTF-8 を捨てずに、壊れた箇所を U+FFFD にして返す（SHALL）。UTF-16BE の最後に余った 1 バイトは U+FFFD 1 つに、対になっていないサロゲート（`D800`〜`DFFF`）は 1 単位ずつ U+FFFD にする（SHALL）。UTF-8 として読めないバイトは、WHATWG の UTF-8 デコーダー（`TextDecoder` の `fatal: false`）と同じ規則で U+FFFD にする（SHALL）。ISO 32000-2 §7.9.2.2.1 は形の壊れたバイト列の読み方を定めず、UTF-16BE と UTF-8 の定義を Unicode Standard に委ねている。

#### Scenario: UTF-16BE の最後に 1 バイト余る

- **WHEN** `FE FF 00 41 00` を読む
- **THEN** `A` に U+FFFD が続く文字列になる

#### Scenario: UTF-16BE の対になっていない上位サロゲート

- **WHEN** `FE FF D8 3D 00 41` を読む
- **THEN** U+FFFD に `A` が続く文字列になり、孤立したサロゲートを含まない

#### Scenario: UTF-16BE の対になっていない下位サロゲート

- **WHEN** `FE FF 00 41 DE 00` を読む
- **THEN** `A` に U+FFFD が続く文字列になる

#### Scenario: UTF-8 として読めないバイト

- **WHEN** `EF BB BF 41 FF 42` を読む
- **THEN** `A`・U+FFFD・`B` の文字列になる
