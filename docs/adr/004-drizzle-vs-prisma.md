# ADR-004: Drizzle ORM を採用、Prisma を却下

- 状態: Proposed
- 日付: 2026-05-30
- 関連: [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94), [ADR-001 (PostgreSQL)](001-postgres-vs-firestore.md), [ADR-007 (pgvector)](007-pgvector.md), [ADR-019 (RLS 二層)](019-rls-two-layer-tenant-isolation.md), [CLAUDE.md ルール3 (型は Drizzle 単一ソース)](../../CLAUDE.md)

## 文脈

[ADR-001](001-postgres-vs-firestore.md) で Cloud SQL for PostgreSQL を採用した。スキーマがあるからこそ「**型をスキーマから機械生成して二重管理を排除する**」（[CLAUDE.md ルール3](../../CLAUDE.md)）を強制したい。ORM / クエリビルダを選定する。

要求:

- **スキーマ → 型の単一ソース**: `InferSelectModel` 等でドメイン型・API 型を自動派生し、手書き interface を作らない（[ルール3](../../CLAUDE.md)）。
- **RLS と相性が良いこと**: トランザクション内で `SET LOCAL` / `set_config`（[ADR-019](019-rls-two-layer-tenant-isolation.md)）を素直に発行でき、生 SQL のエスケープハッチが軽いこと。
- **pgvector 等の拡張型を扱えること**（[ADR-007](007-pgvector.md)、`vector(768)` カラム）。
- **drizzle-zod 等で Zod スキーマも DB から派生**できること。
- **migration がスキーマと一体**で、生成物が読めること（手書き SQL とのズレを避ける）。
- Cloud Run（サーバレス）でのコールドスタート・バンドルサイズが軽いこと。

選択肢:

- **Drizzle ORM**
- Prisma
- Kysely（クエリビルダ）
- 生 `postgres` / `pg` + 手書き型

## 決定

**Drizzle ORM を採用**し、Prisma を却下する。

決め手:

- **TypeScript 定義がそのままスキーマ**: `pgTable(...)` 定義から `InferSelectModel` / `InferInsertModel` で型が機械生成され、[ルール3](../../CLAUDE.md) を構造的に満たす。別言語スキーマ（Prisma schema）→ codegen の往復が不要。
- **生 SQL のエスケープハッチが軽い**: `sql\`...\`` / `tx.execute(sql\`select set_config(...)\`)` で RLS コンテキスト（[ADR-019](019-rls-two-layer-tenant-isolation.md)）や VIEW（`effective_ads_per_class`、[#48-F](https://github.com/cometa-kaito/kimiterrace-v2/issues/116)）を素直に扱える。`security_invoker` VIEW や `set_config(..., true)` のような PostgreSQL 固有機能と摩擦が小さい。
- **drizzle-zod で Zod も DB 由来**にでき、入力検証スキーマまで単一ソース化。
- **カスタム型 (pgvector)**: `customType` で `vector(768)` を表現でき（[ADR-007](007-pgvector.md)）、外部拡張に追従しやすい。
- **軽量 / コールドスタート**: ランタイムが薄く、別エンジンバイナリ（Prisma の query engine）を持たないため、Cloud Run（[ADR-002](002-cloud-run-vs-functions.md)）でのバンドル・起動が軽い。

## 検討した代替案

### 代替 A: Prisma
- 却下理由: 独自の Prisma schema 言語 → codegen の往復が挟まり、「TS 型がスキーマ」という単一ソース性が一段薄れる。
- 副次理由: 別途 query engine（ネイティブバイナリ）に依存し、Cloud Run のコンテナ・コールドスタートで footprint が増える。
- 副次理由: RLS / `SET LOCAL` / `security_invoker` VIEW のような PostgreSQL 固有機能に対して、生 SQL エスケープハッチが Drizzle より重い（middleware 層で `set_config` を毎トランザクション発行する本設計と摩擦）。
- 補足: Prisma の DX（Studio 等）は魅力だが、本プロジェクトの「DB レベル強制 + 生 SQL を厭わない」方針には Drizzle が噛み合う。

### 代替 B: Kysely（クエリビルダ）
- 却下理由: 型安全なクエリビルダとして優秀だが、スキーマ定義・migration・Zod 連携が Drizzle ほど一体化しておらず、別途組み合わせる手間が増える。
- 補足: Drizzle はクエリビルダ的にも使えるため、Kysely の利点を概ね包含。

### 代替 C: 生 `postgres` / `pg` + 手書き型
- 却下理由: 型を手書きすると [ルール3](../../CLAUDE.md)（DB と型の二重管理禁止）に正面から反する。
- 補足: 生 `postgres`（postgres-js）はテスト/低レベル接続で併用するが、ドメイン型は Drizzle 由来に統一。

## 結果（Consequences）

### 良い影響
- スキーマ → 型の機械生成で [ルール3](../../CLAUDE.md) を構造的に満たし、人力レビュー依存を排除。
- RLS / VIEW / pgvector など PostgreSQL 固有機能と摩擦が小さく、[ADR-019](019-rls-two-layer-tenant-isolation.md) の `set_config` 一元化（`withTenantContext`）が素直。
- 軽量ランタイムで Cloud Run のコールドスタート・バンドルに優しい。
- drizzle-zod で入力検証まで単一ソース化。

### 悪い影響 / リスク
- **enum re-export の落とし穴**: `schema/index.ts` で pgEnum を re-export しないと `drizzle-kit generate` が既存 enum の `DROP TYPE` を吐く（[[drizzle-enum-export]]、Issue #101 / PR #104・#127 で対処済）。新 enum 追加時は generate 出力に `DROP TYPE` が無いか確認する規律が要る。
- **エコシステムの成熟度**: Prisma に比べ周辺ツール（Studio 等）が薄い → 必要なら別ツールで補完。
- **生 SQL を多用する箇所の型保証**: `sql\`...\`` のエスケープハッチは型が緩くなるため、VIEW 等は `pgView(...).existing()` で型のみ単一ソース化する（[#48-F](https://github.com/cometa-kaito/kimiterrace-v2/issues/116) で実践）。

### トレードオフ
- 「Prisma の DX・成熟度 vs Drizzle の軽量さ・生 SQL 親和性」のうち、RLS を DB レベルで強制し生 SQL を厭わない本方針に合わせ **Drizzle の軽量さ・生 SQL 親和性**に振った。
- 「codegen 言語スキーマ vs TS ネイティブスキーマ」のうち、[ルール3](../../CLAUDE.md) を構造的に満たす **TS ネイティブスキーマ**に振った。
