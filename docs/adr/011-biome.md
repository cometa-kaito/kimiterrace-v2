# ADR-011: Biome を採用、ESLint + Prettier を却下

- 状態: Accepted（2026-05-31 実装稼働により Proposed → Accepted）
- 日付: 2026-05-30
- 関連: [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94), [ADR-010 (pnpm + Turborepo)](010-pnpm-turborepo.md), [ADR-012 (テスト)](012-testing-stack.md), [CLAUDE.md ルール7 (lint 緑)](../../CLAUDE.md)

## 文脈

コード品質ゲート（lint + format）を [CLAUDE.md ルール7](../../CLAUDE.md)（lint 緑でないとマージしない）で機械強制する。pre-commit hook（lint-staged）と CI の双方で走らせるため、**速さ・設定の単純さ・CI 安定性**が重要。lint / format ツールを選定する。

選択肢:

- **Biome**（lint + format 統合、Rust 実装）
- ESLint + Prettier
- ESLint + Prettier + 各種プラグイン群

## 決定

**Biome を採用**し、ESLint + Prettier を却下する。

- **lint + format を 1 ツール・1 設定**（`biome.json`）に統合。Rust 実装で高速。
- pre-commit（lint-staged: `biome format --write`）+ CI（`biome check`）で二段強制。
- `biome check --write` で安全な自動修正（import 整列・`import type` 等）を適用、残りは CI で fail させる（PR #133 等で実践）。

## 検討した代替案

### 代替 A: ESLint + Prettier
- 却下理由: lint（ESLint）と format（Prettier）で**2 ツール・2 設定**になり、ルール衝突（`eslint-config-prettier` 等の調停）・プラグイン依存の保守が増える。
- 副次理由: JS 実装で大規模リポの CI 実行が相対的に遅い。pre-commit の体感も重い。

### 代替 B: ESLint + Prettier + プラグイン群
- 却下理由: 表現力は最大だが、プラグインのバージョン整合・設定肥大・CI 時間の面で本プロジェクトの「速くて単純なゲート」要求から外れる。

## 結果（Consequences）

### 良い影響
- 1 ツール・1 設定で lint + format が完結し、設定肥大・ルール衝突を排除。
- Rust 実装の高速性で pre-commit / CI（[ルール7](../../CLAUDE.md)）が軽快。
- 自動修正（import 整列等）が安全に効き、レビュー時の機械的指摘が減る。

### 悪い影響 / リスク
- **ルールの網羅性**: ESLint エコシステムに比べ一部の細かいルール / プラグイン（特定フレームワーク固有 lint）が未対応の場合がある → 必要なら個別に補完、または Biome のルール拡充に追従。
- **メジャーバージョン追従**: Biome の破壊的更新（例: 1.x → 2.x）でルール挙動・設定スキーマが変わりうる → バージョン更新時は差分を検証（Dependabot の major bump は個別レビュー）。

### トレードオフ
- 「ESLint の網羅性・エコシステム vs Biome の速さ・単純さ」のうち、CI ゲートの速さと設定単純性を優先して **Biome の速さ・単純さ**に振った。
- 不足ルールは「速くて単純なゲートを保ちつつ個別補完」で許容する判断。
