# ADR-012: テストスタック（Vitest + Playwright + 実 PostgreSQL）

- 状態: Accepted
- 日付: 2026-05-30
- 関連: [#15](https://github.com/cometa-kaito/kimiterrace-v2/issues/15), [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94), [#96](https://github.com/cometa-kaito/kimiterrace-v2/issues/96), [#98](https://github.com/cometa-kaito/kimiterrace-v2/issues/98), [NFR03 (セキュリティ)](../requirements/non-functional/NFR03-security.md), [NFR04 (監査ログ)](../requirements/non-functional/NFR04-audit-log.md), [ADR-001 (PostgreSQL)](001-postgres-vs-firestore.md), [ADR-004 (Drizzle)](004-drizzle-vs-prisma.md), [ADR-019 (RLS)](019-rls-two-layer-tenant-isolation.md), [CLAUDE.md ルール 7](../../CLAUDE.md)

## 文脈

公立校データ（生徒の個人情報を含む）を扱う SaaS であるため、テストの規律はサービス継続性に直結する。本 ADR を起草する時点で確立されている要件は:

- **CLAUDE.md ルール 7**: 「テストが落ちている状態で次に進まない」「`it.skip` で隠さない」
- **CLAUDE.md ルール 2**: RLS は **DB レベルで強制**、`__tests__/rls/` で許可ケース + 拒否ケース両方を検証
- **CLAUDE.md ルール 3**: 型は Drizzle スキーマ単一ソース、ロジックも DB に強く結合
- **PR #93 / #96 / #97 / #99 / #103 の実装経緯**: 当初 Testcontainers 採用想定だったが、ローカル Docker 不在環境 (Worker spawn / GitHub Actions ランナーの一部) で起動できず、最終的に **`DATABASE_URL` env で実 PG 接続、未設定なら skip** に切替。CI 側は `postgres:16` service container で実走 (PR #99 で確立)

選択肢:

- **A. Vitest + Testcontainers**: 当初想定。テストランナーが Docker コンテナを起動して実 PG を立てる
- **B. Vitest + 既存 PG への DATABASE_URL 接続**: ローカル `docker-compose up postgres` or CI service container で立てた PG にテストランナーが繋ぐ
- **C. Vitest + pg-mem (in-memory PostgreSQL JS 実装)**: コンテナ不要、最速だが PostgreSQL の RLS / 拡張 (pgvector) 未対応
- **D. Jest + ts-jest**: より大きなエコシステムだが ESM 対応が後手、Vite との二重 build
- **E2E**: Playwright vs Cypress (Playwright を採用、Cypress は別途検討)

## 決定

**B (Vitest + Vite 統合 + DATABASE_URL env)** を採用する。E2E は Playwright。

### 単体・統合テスト: Vitest

- ランナー: `vitest@^2`
- 設定: 各パッケージの `vitest.config.ts` で `environment: "node"`、`include: ["src/**/__tests__/**/*.test.ts"]`
- vi.mock + vi.hoisted で external SDK を stub (例: `@opentelemetry/sdk-node`、`firebase-admin`)
- カバレッジ: `@vitest/coverage-v8`（CI で計測、しきい値は package 別に設定）
- 並列: `pool: 'forks'` + `singleFork: true` を **DB 接続テストで必須** (PR #97 で確立、cross-test state 漏洩防止)

### DB / RLS テスト: 実 PostgreSQL + DATABASE_URL

- **ローカル**: `docker-compose -f infrastructure/docker/docker-compose.yml up -d postgres` で `postgres:16` (+ pgvector 拡張) を起動、`DATABASE_URL=postgres://kimiterrace:dev@localhost:5432/kimiterrace_test` を `.env.local` 経由 or shell 環境で設定
- **CI**: GitHub Actions の `services.postgres: image: postgres:16` を `.github/workflows/ci.yml` で立て、`DATABASE_URL` を `turbo.json` の `passThroughEnv` で test job に渡す (PR #99 で確立)
- **未設定時**: 各テストファイル先頭で `const describeOrSkip = getConnectionUrl() ? describe : describe.skip` パターンを使い、ローカル DB なし環境では skip して落ちない設計
- **migrations**: テスト DB は `global-setup.ts` で `migrations/*.sql` を順次適用、各 test の `beforeAll` で `seedBaseFixture` がテナント・ユーザー・schools を投入

### E2E: Playwright

- ランナー: `@playwright/test`
- ブラウザ: Chromium (Phase 1)、必要に応じ Firefox / WebKit 追加
- 対象: ログイン → エディタ更新 → サイネージ反映の golden path、F0 移植完了 (#48-O) で導入予定
- 並列: 単一テストプロセスで複数 worker、各 worker は別 DB スキーマ (or トランザクション rollback) で独立
- スクリーンショット / トレース: CI 失敗時のみ Artifact upload

### 採用するパッケージ群

| 用途 | パッケージ | 補足 |
|---|---|---|
| 単体テスト | `vitest` | `vi.mock` / `vi.hoisted` / `expect` (Jest 互換 API) |
| カバレッジ | `@vitest/coverage-v8` | 標準的、別途 c8 不要 |
| 実 PG 接続 | `postgres` (postgres-js) | Drizzle 標準 driver、生 SQL も使える |
| マッチャー拡張 | (なし、`expect` 標準で十分) | `jest-extended` は追加しない |
| E2E | `@playwright/test` | テストランナー兼用 |

### CLAUDE.md ルール 7 とのリンク

- 全 PR は CI で `pnpm test` + `pnpm typecheck` + `pnpm lint` 緑が必須
- `it.skip` / `it.todo` は **テスト本体の隠蔽用途では禁止**。ただし `describeOrSkip` の DB 未接続時 skip パターンは設計上の skip として例外許容 (PR #93 / #99 で運用確認済)
- 既知 flaky test は `__tests__/known-flaky/` 等の別ディレクトリに隔離 + Issue 化、リトライ設定は CI 側

## 検討した代替案

### 代替 A: Vitest + Testcontainers

- 却下理由: ローカル Docker 不在環境 (Worker spawn / GitHub Actions 一部ランナー) で起動できず、PR #93 着手時に Worker が ~23 分 hang する事故が発生 (STATUS.md 2026-05-29 記録)
- 副次理由: テスト 1 ケース起動ごとにコンテナ生成 → teardown のオーバーヘッドが大きく、特に Windows 開発者の体験を悪化させる
- 副次理由: CI 上では `services.postgres` で既に同等のことが達成できる
- 保留: Phase 2 (本格的なマルチテナント負荷試験) で再評価余地あり、本 ADR は Phase 1 (F0 移植 + F01-F13) のスコープ

### 代替 B-2: Vitest + pg-mem

- 却下理由: pg-mem は PostgreSQL の subset 実装で、**RLS が未サポート** ([CLAUDE.md ルール 2](../../CLAUDE.md) の検証ができない)
- 副次理由: pgvector ([ADR-007](007-pgvector.md)) も未サポート、AI/RAG テストで使えない
- 副次理由: 一部 SQL 構文 (`LISTEN/NOTIFY`、`SECURITY DEFINER`、`CREATE TYPE` enum 拡張) の挙動が実 PG と微妙に違い、本番再現性が崩れる

### 代替 D: Jest + ts-jest

- 却下理由: Vite + Next.js 16 のビルドパイプラインを既に採用 ([ADR-008](008-nextjs-route-handlers.md))、Jest を別途入れると ESM/CJS 二重 build + tsconfig 二重管理になる
- 副次理由: `vi.hoisted` のような ES module を本気で扱う API が Vitest の方が成熟
- 副次理由: Vitest はマッチャー API が Jest 互換のため、Jest 経験者の学習コスト最小

### 代替 E: E2E に Cypress

- 却下理由: Playwright の方がブラウザ並列 (Chromium / Firefox / WebKit 同時) が容易、Trace Viewer が成熟
- 副次理由: Cypress は内部 iframe 構造でファイルアップロード等の API が制約多い (F01 ファイル抽出テストで詰む可能性)
- 副次理由: Microsoft / Playwright チームの長期メンテ体制が安心

## 結果（Consequences）

### 良い影響

- ローカル / CI どちらでも同じ test 経路 (`DATABASE_URL` env) で走る、再現性高い
- Docker 不在環境でもテストは skip で「落ちない」、CI で実走で本物の検証が走る (PR #99 確立)
- RLS / pgvector / enum 等の **PostgreSQL 固有挙動** を本番と同じバージョンで検証できる
- Drizzle migration を実 PG に流して検証することで「migration が落ちる」事故を CI で早期検知 (PR #93 / #96 の dormant bug 経路)
- E2E (Playwright) を将来 #48-O で追加する形にすることで、Phase 1 のテスト構成を肥大化させない

### 悪い影響 / リスク

- **DB 接続未設定でローカル skip**: 開発者が手元で RLS テストを走らせず PR 投稿 → CI で初めて落ちる体験が発生 (PR #99 で実証済)。緩和策: `pnpm db:up` (docker-compose + migrate + DATABASE_URL export) のスクリプト整備 (#48-A の前段で追加予定)
- **Testcontainers 採用しない判断の再評価**: Phase 2 で並列負荷試験 (例: 100 校テナント同時アクセス) を本格化する際、Testcontainers の per-test isolation が必要になる可能性。本 ADR を Superseded にして再決定
- **E2E 未導入**: Phase 1 では unit + integration のみ。教員 → サイネージのフローを e2e で検証するのは #48-O まで待つ → リグレッション検知が遅れるリスク。緩和策: 重要 path (ログイン / 公開) は手動テスト runbook を `docs/runbooks/manual-smoke-tests.md` (未作成、別 Issue) に整備

### トレードオフ

- 「コンテナで完全隔離 vs 開発者体験」のうち **開発者体験 + CI 実走の二段構え** に振った設計
- 「pg-mem の高速 vs 本物の網羅性」のうち **本物の網羅性** に振った設計
- 「Jest の安定 vs Vitest の最新エコシステム」のうち **Vitest の Vite 統合 + ESM 対応** に振った設計
- 「Cypress の使いやすさ vs Playwright の制約少なさ」のうち **Playwright** に振った設計

## 実装状況（2026-05-30 時点）

- `packages/db/__tests__/_setup/` に共通 fixture (`createSql` / `getConnectionUrl` / `seedBaseFixture`)、RLS テスト 5 ファイル (tenant-isolation / audit-columns / audit-log-append-only / audit-log-hash-chain / audit-log-actor-spoofing / crm-system-admin)、計 33 ケース
- `packages/observability/__tests__/` に logger.test.ts + tracer.test.ts (PR #109 で追加)、計 15 ケース
- CI 上で `postgres:16` service container 起動 + migrations 適用 + RLS テスト実走 (PR #99 で確立、12/12 green 達成)
- E2E (Playwright) は **未導入**、#48-O で着手予定

## 関連

- [ADR-001 (PostgreSQL)](001-postgres-vs-firestore.md): DB 基盤
- [ADR-004 (Drizzle)](004-drizzle-vs-prisma.md): ORM
- [ADR-007 (pgvector)](007-pgvector.md): ベクトル検索
- [ADR-019 (RLS)](019-rls-two-layer-tenant-isolation.md): policy 規約、テストはここを検証
- [CLAUDE.md ルール 2 / 7](../../CLAUDE.md)
- 親 Issue: [#94 ADR-001〜014 ファイル不在](https://github.com/cometa-kaito/kimiterrace-v2/issues/94) (本 ADR で 1 件解消、ADR-001/002/003/004/005/006/007/008/009/010/011/013/014 は別 PR で順次起草)
