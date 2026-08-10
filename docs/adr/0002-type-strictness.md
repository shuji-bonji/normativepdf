# ADR-0002: 型の厳格性ポリシー

- 状態: **Accepted**
- 日付: 2026-08-08
- 決定者: shuji

## 背景

TypeScript ライブラリとして、どこまで厳格な型設定を課すか。
「ライブラリは any が増えがちではないか」という懸念に対し、実測と構造の両面から判断した。

**any 圧はライブラリ一般の宿命ではなく、入力の開き方で決まる。**
any が増えるのは、ユーザーの任意データを受ける層（ORM・バリデータ汎用層）、
型なし依存との interop、DX のためのジェネリクス曲芸、コールバック機構である。
本ライブラリはそのいずれにも該当しない:

- **入力域が閉じている** — バイト列 → COS オブジェクト 8 種の判別可能ユニオン。
  型システムの閉域性が ISO 32000-1 §7.3（オブジェクト型の列挙）とそのまま対応する
- **ゼロ依存**の構造層・**低レベル API 一本**（ジェネリクス最小）・決定論的な純関数群

**実測**: 同族の `@shuji-bonji/pdf-constraints`（strict: true・純 TS・PDF ドメイン）の
src に any は 0 件（2026-08-08 確認）。

## 決定

### 1. tsconfig — family 標準 + ライブラリ級フラグ

family 標準（`strict: true` / NodeNext / declaration 等 = pdf-constraints と同形）に以下を追加する:

```jsonc
{
  "compilerOptions": {
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "verbatimModuleSyntax": true,
    "isolatedDeclarations": true
  }
}
```

`isolatedDeclarations` により公開 API の型は常に明示される — **d.ts が仕様書になる**。

### 2. リンタ — biome（family 標準を維持）

型検査の重量は tsconfig 側に持たせる。biome では `noExplicitAny` を error にする。
typescript-eslint の `strictTypeChecked` は採らない（型情報リントの実質は tsc のフラグでカバーし、
ツールチェーンを family の tsc + biome + vitest から増やさない）。

### 3. 逃げ道の規律

**any 禁止・境界は `unknown` + narrowing・suppress には理由コメント必須。**

- `as any` / `: any` は書かない。外部境界（テストフィクスチャ読み込み等）は `unknown` で受けて型ガードで絞る
- `// biome-ignore` / `@ts-expect-error` には**理由を必ず書く**（`@ts-ignore` は使わない）
- COS ユニオンの分岐は `switch` + `never` 網羅性検査で閉じる

これは本プロジェクトの中核原則「紐づけられない挙動は主張しない」の型版である —
**説明できない any は書かない。**

## 予見される摩擦と対処

| 摩擦 | 対処 |
|---|---|
| `noUncheckedIndexedAccess` で `bytes[i]` が `number \| undefined` になり、パーサのホットループで毎回 undefined 検査 | **境界検査を 1 箇所に閉じた `ByteCursor`**（`peek()` / `next()` / `expect()`）を作り、生の添字アクセスをレキサ内部だけに隔離する。壊れた PDF の回復パース（[`../DESIGN.md`](../DESIGN.md) §5.2）で必要になる設計でもあり、二重に元が取れる |
| `exactOptionalPropertyTypes` で `{ key?: T }` に明示的 `undefined` を代入できない | PDF の意味論では「エントリが無い」と「Null オブジェクト」は別物（ISO 32000-1 §7.3.9）。この制約はむしろ意味論に合っているので、区別をそのまま型に写す |

## 見直し条件

- `isolatedDeclarations` がビルド系（tsc 単体）で維持コストに見合わなくなったら外してよい（他は外さない）
- 段階 2（生成パス移行）で pdf-lib 差分オラクルとの interop に any 圧が生じた場合、
  **オラクル比較コードはライブラリ本体の外**（テスト側）に置くことで本体の規律を守る

## 関連

- [`0001-language-choice.md`](0001-language-choice.md) — 言語 = TypeScript（査読可能性）。本 ADR はその厳格化
- [`../DESIGN.md`](../DESIGN.md) §5 — 低レベル API 一本・ESM
- [`../GUARDS.md`](../GUARDS.md) — 主張と実体を乖離させない（型でも同じ）
