# ADR-010: pnpm + Turborepo モノレポを採用

- 状態: Accepted（2026-05-31 実装稼働により Proposed → Accepted）
- 日付: 2026-05-30
- 関連: [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94), [ADR-004 (Drizzle)](004-drizzle-vs-prisma.md), [ADR-011 (Biome)](011-biome.md), [CLAUDE.md ディレクトリ構成](../../CLAUDE.md)

## 文脈

本リポジトリは `apps/`（web / firmware / jobs）と `packages/`（db / shared-types / ui / ai）を 1 リポジトリで持つ構成（[CLAUDE.md ディレクトリ構成](../../CLAUDE.md)）。型の単一ソース（[ADR-004](004-drizzle-vs-prisma.md)、`@kimiterrace/db` を web から消費）を成立させるには、ワークスペース内パッケージ参照とビルドパイプラインが要る。パッケージマネージャ + モノレポビルドツールを選定する。

要求:

- **ワークスペース内パッケージ参照**（`@kimiterrace/db` 等を `workspace:*` で消費）。
- **厳格な依存解決**（phantom dependency を防ぎ、CI とローカルの再現性を担保）。
- **タスクキャッシュ / 並列実行**（lint / typecheck / test / build を差分実行）。
- **ディスク効率**（CI のインストール時間短縮）。

選択肢:

- **pnpm（workspaces）+ Turborepo**
- npm workspaces / yarn workspaces（+ 自前スクリプト）
- Nx
- Lerna

## 決定

**pnpm（workspaces）+ Turborepo を採用**する。

- **pnpm**: content-addressable store + 厳格な `node_modules`（symlink）で phantom dependency を防ぎ、ディスク・インストールを効率化。`workspace:*` でパッケージ間参照。
- **Turborepo**: `turbo.json` のタスクパイプライン + リモート/ローカルキャッシュで lint/typecheck/test/build を差分・並列実行。`passThroughEnv` で `DATABASE_URL` 等を必要なタスクに渡す（PR #99 で実践）。

## 検討した代替案

### 代替 A: npm / yarn workspaces（+ 自前スクリプト）
- 却下理由: 依存解決が pnpm ほど厳格でなく phantom dependency を許しやすい。タスクキャッシュ・並列実行を自前スクリプトで作り込むと Turborepo の再発明になる。

### 代替 B: Nx
- 却下理由: 高機能だが、プラグイン・ジェネレータ・グラフ管理など抽象が厚く、本リポジトリ規模に対して学習・運用コストが過大。Turborepo の薄いキャッシュ層で十分。

### 代替 C: Lerna
- 却下理由: 歴史的にパブリッシュ管理寄りで、近年は Nx 傘下。本用途（内部モノレポのビルドキャッシュ）には Turborepo が素直。

## 結果（Consequences）

### 良い影響
- `workspace:*` で型の単一ソース（[ADR-004](004-drizzle-vs-prisma.md)）を成立させつつ、phantom dependency を防止。
- Turborepo キャッシュで CI（lint/typecheck/test/build）が高速化・差分実行。
- ディスク効率・インストール高速化で CI コスト低減。

### 悪い影響 / リスク
- **pnpm の symlink 構造**: 一部ツールが symlink `node_modules` を想定しない場合に設定が要る（例: Next.js の `transpilePackages`、PR #137 で実踏）。
- **キャッシュの落とし穴**: `turbo.json` の入力・環境変数（`passThroughEnv`）設定漏れで誤キャッシュ → 環境変数は明示的に宣言する規律が要る（PR #99）。
- **lockfile の肥大**: 依存追加で `pnpm-lock.yaml` の diff が大きくなる（レビュー時は lockfile を別扱い）。

### トレードオフ
- 「Nx の高機能 vs Turborepo の薄さ」のうち、本規模では **Turborepo の薄さ・学習容易性**に振った。
- 「npm/yarn の普及 vs pnpm の厳格さ」のうち、再現性・phantom dependency 防止のため **pnpm の厳格さ**に振った。
