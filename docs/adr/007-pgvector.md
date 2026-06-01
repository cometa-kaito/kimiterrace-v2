# ADR-007: pgvector を採用、外部ベクトル DB を不採用

- 状態: Accepted（2026-06-01 ユーザーレビューで Proposed → Accepted）
- 日付: 2026-05-30
- 関連: [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94), [ADR-001 (PostgreSQL)](001-postgres-vs-firestore.md), [ADR-004 (Drizzle)](004-drizzle-vs-prisma.md), [ADR-005 (Vertex AI)](005-vertex-ai.md), [ADR-019 (RLS 二層)](019-rls-two-layer-tenant-isolation.md), [F06 生徒 Q&A](../requirements/functional/F06-student-qa.md), [CLAUDE.md ルール2 (RLS) / ルール4 (PII)](../../CLAUDE.md)

## 文脈

生徒 Q&A（[F06](../requirements/functional/F06-student-qa.md)）の RAG は、掲示物コンテンツの embedding を semantic search する。embedding の格納・検索基盤を選定する。

最重要の制約:

- **テナント分離が embedding 検索にも効くこと**: ベクトル検索の結果が `school_id` スコープ（[ADR-019](019-rls-two-layer-tenant-isolation.md) / [ルール2](../../CLAUDE.md)）を超えないこと。別テナントの掲示物が検索でヒットしたら漏洩。
- **PII を外部に出さないこと**: embedding は**マスキング後テキスト**から生成（[ADR-005](005-vertex-ai.md) / [ルール4](../../CLAUDE.md)）するが、ベクトル自体の格納先も外部委託を避けたい。
- 運用の単純さ（バックアップ・移行を DB 1 つに集約）。

選択肢:

- **pgvector（PostgreSQL 拡張、Cloud SQL 内）**
- 外部ベクトル DB（Pinecone / Weaviate / Qdrant 等）
- 全文検索のみ（ベクトル検索なし）

## 決定

**pgvector を採用**し、外部ベクトル DB を不採用とする。

- embedding を Cloud SQL（[ADR-001](001-postgres-vs-firestore.md)）内の `vector(768)` カラムに格納し、同一 DB で semantic search。
- **RLS が embedding 検索にも自然に効く**: ベクトル検索クエリも `school_id` スコープの RLS（[ADR-019](019-rls-two-layer-tenant-isolation.md)）下で実行され、別テナントのベクトルは見えない。別途のアクセス制御を二重実装しない。
- 型は Drizzle の `customType` で `vector(768)` を表現（[ADR-004](004-drizzle-vs-prisma.md)、`_shared/pgvector.ts` に hoist 済 = PR #76）。
- embedding は[マスキング後テキスト](005-vertex-ai.md)から生成（[ルール4](../../CLAUDE.md)）。

## 検討した代替案

### 代替 A: 外部ベクトル DB（Pinecone / Weaviate / Qdrant 等）
- 却下理由: ベクトルを別サービスに置くと、**テナント分離を pgvector の RLS とは別系統で再実装**する必要があり、漏洩面が増える（[ルール2](../../CLAUDE.md) の「DB レベル強制」から外れる）。
- 副次理由: ベクトル（マスキング後でも）の外部送信・所在が増え、運用（バックアップ・整合）が DB と二系統に分裂。コストも従量で増える。

### 代替 B: 全文検索のみ（ベクトル検索なし）
- 却下理由: 掲示物 Q&A の意味的な質問（言い換え・要約）に対して、キーワード一致だけでは回答精度が不足。semantic search が中核要件。
- 補足: pgvector とキーワード検索のハイブリッドは将来検討余地。

## 結果（Consequences）

### 良い影響
- ベクトル検索が `school_id` の RLS（[ADR-019](019-rls-two-layer-tenant-isolation.md)）に自然に乗り、テナント越境をアクセス制御の二重化なしに防止。
- embedding が Cloud SQL に同居し、バックアップ・移行・運用が DB 1 つに集約。
- 外部ベクトル DB への PII / ベクトル egress を回避（[ルール4](../../CLAUDE.md)）。

### 悪い影響 / リスク
- **スケール上限**: 超大規模・超高 QPS のベクトル検索では専用ベクトル DB に性能で劣りうる → 本システムの規模（学校テナント・掲示物量）では pgvector で十分。索引（HNSW / IVFFlat）設計でチューニング。
- **索引運用**: ベクトル索引の構築・再構築コスト、`school_id` を含む複合索引設計が要る（[ADR-019](019-rls-two-layer-tenant-isolation.md) の RLS パフォーマンス注意と共通）。
- **次元固定**: `vector(768)`（埋め込みモデル依存）。モデル変更で次元が変わると再埋め込みが要る。

### トレードオフ
- 「専用ベクトル DB の性能・機能 vs pgvector の RLS 同居・運用単純さ」のうち、テナント分離の一元化とデータ所在を優先して **pgvector の RLS 同居**に振った。
- 「スケール上限の受容 vs 二系統運用の複雑さ」のうち、本規模では **単一 DB の単純さ**に振った（将来スケールで再評価余地）。
