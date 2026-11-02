# Tasks

## 1. 受入テスト（直す前に落ちることを確かめる）

- [x] 1.1 `tests/text-string.test.ts` に 012 の describe を足し、it の名前に仕様 ID と Scenario 名を書く（4 件）
- [x] 1.2 変更前の `src/` で、孤立したサロゲートの 2 件が落ち、余った 1 バイトと UTF-8 の 2 件が通ることを確かめる

## 2. 実装

- [x] 2.1 `decodeUtf16Be` で、孤立したサロゲートを U+FFFD に置き換える
- [x] 2.2 `decodeTextString` の TSDoc に、形の壊れたバイト列の読み方を書く

## 3. 確かめる

- [x] 3.1 CI の check ジョブの一覧（`check:engines`・`typecheck`・`test`・`check`）が終了コード 0
- [x] 3.2 公開 API（`dist/index.d.ts`）が変わっていないことを確かめる
- [x] 3.3 コーパスのテキスト文字列で、変更前後の `decodeTextString` の差が孤立したサロゲートを含む文字列だけであることを確かめる
- [x] 3.4 `CHANGELOG.md` に `[Unreleased]` を足す
- [x] 3.5 `npx openspec validate --all && npx spec-ids check` が通る

## 5. archive（承認の後）

- [x] 5.1 proposal.md の `approved`・`pr` が埋まっていることを確かめる
- [x] 5.2 `openspec archive text-malformed-unicode --yes`（text は既存の capability なので、front matter の書き足しは要らない）
- [x] 5.3 `npx openspec validate --all`・`npx spec-ids check`・`npx spec-ids pr-scope` を通して commit
