# ADR-007: pgvector を採用、外部ベクトル DB を不採用

- 状態: Accepted（2026-06-01 ユーザーレビューで Proposed → Accepted）
- 日付: 2026-05-30
- 関連: [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94), [#396 (埋め込みモデル選定 M-2)](https://github.com/cometa-kaito/kimiterrace-v2/issues/396), [ADR-001 (PostgreSQL)](001-postgres-vs-firestore.md), [ADR-004 (Drizzle)](004-drizzle-vs-prisma.md), [ADR-005 (Vertex AI)](005-vertex-ai.md), [ADR-019 (RLS 二層)](019-rls-two-layer-tenant-isolation.md), [F06 生徒 Q&A](../requirements/functional/F06-student-qa.md), [CLAUDE.md ルール2 (RLS) / ルール4 (PII)](../../CLAUDE.md)
- 追補: 2026-06-01 に「F06 埋め込みモデルの選定確定」（#396 M-2）を末尾に追記（本決定 pgvector 採用は不変、`vector(768)` の **768 を生成するモデル**を確定）

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
- **次元固定**: `vector(768)`（埋め込みモデル依存）。モデル変更で次元が変わると再埋め込みが要る。採用モデルと 768 の確定根拠は末尾「追補（2026-06-01）」を参照。

### トレードオフ
- 「専用ベクトル DB の性能・機能 vs pgvector の RLS 同居・運用単純さ」のうち、テナント分離の一元化とデータ所在を優先して **pgvector の RLS 同居**に振った。
- 「スケール上限の受容 vs 二系統運用の複雑さ」のうち、本規模では **単一 DB の単純さ**に振った（将来スケールで再評価余地）。

---

## 追補（2026-06-01）: F06 埋め込みモデルの選定確定（#396 M-2）

本体の決定（pgvector 採用・`vector(768)`）は不変。本追補は **その 768 次元ベクトルを生成する埋め込みモデルを確定**する（ADR-007 本体は次元のみ規定し、モデルを pin していなかったギャップを埋める）。PR #393（F06 S2 第1スライス）の Reviewer が forward risk として挙げた #396 M-2 への回答。

### 文脈

- PR #393 の Vertex embedding client は既定モデルを **`text-embedding-004`（768 次元 = `VECTOR_DIM`）** でピンしていた。
- その後 **`text-embedding-004` は 2026-01-14 に deprecated** となり、Google は後継として **`gemini-embedding-001`** への移行を案内している（旧 `text-embedding-004` / `text-multilingual-embedding-002` を統合した GA モデル）。
- `gemini-embedding-001` の **既定出力は 3072 次元**で、そのまま採用すると `vector(768)` → `vector(3072)` のスキーマ変更 + 全件再埋め込みという cross-cutting 移行になる。
- **F06 は多言語必須**（[F06 仕様](../requirements/functional/F06-student-qa.md): 主要外国語対応）。`text-embedding-004` は英語中心だったが、`gemini-embedding-001` は英語・多言語・コードで SOTA をうたい日本語を含む多言語をサポートする。

### 決定

1. **採用モデル: `gemini-embedding-001`**（deprecated な `text-embedding-004` を置換）。多言語（日本語含む）対応が F06 要件に直接合致し、旧 specialized モデルを統合した現行 GA であるため。
2. **出力次元: `output_dimensionality = 768`（MRL 切り詰め）。`VECTOR_DIM = EMBEDDING_DIM = 768` は据え置き。** Google は 768 からの開始を推奨し、本システム規模（学校テナント・掲示物量）には 768 で十分（本体 ADR の「本規模で十分」と整合）。768 据え置きにより **pgvector スキーマ・`_shared/pgvector.ts` の `VECTOR_DIM`・#396 M-1 の単一ソース定数を一切変えない**。
3. **【必須実装指示】L2 正規化**: `gemini-embedding-001` は **3072 未満に切り詰めた出力を自動正規化しない**（自動正規化は後継 `gemini-embedding-2` のみ）。したがって 768 次元の出力は **生成直後に L2 正規化（unit length）してから pgvector へ格納し、クエリベクトルも同様に正規化**する。これを怠ると magnitude のばらつきで cosine / 内積 / L2 の順位が歪む。
4. **移行コストは現時点ゼロ**: F06 の RAG / 埋め込み生成バッチ（#365）は**未実装**で本番 embedding データが存在しないため、**PoC 公開前の今モデルを確定すれば再埋め込み migration は不要**。これが「10 年運用する次元・モデル」を固定する最適タイミング（#396 の趣旨）。

### 実装フォローアップ（#365 / 埋め込みバッチ・クエリ層で適用）

- `packages/ai/src/model/embed.ts` の `DEFAULT_EMBEDDING_MODEL_ID` を `text-embedding-004` → **`gemini-embedding-001`** に更新し、リクエストに **`outputDimensionality: 768`** を付与。
- 生成直後の次元検証（既存 `EMBEDDING_DIM` チェック）に加え、**L2 正規化**を施す（上記指示3）。`embed.test.ts` の既定モデル assertion と正規化（‖v‖₂ ≈ 1）を pin。
- **リージョン/エンドポイント確認**: 起動時に `gemini-embedding-001` を提供するエンドポイント（[ADR-005](005-vertex-ai.md) の `asia-northeast1` 優先、提供が global endpoint のみなら明示）を確定する。**PII マスキング（[ADR-005](005-vertex-ai.md) / [ルール4](../../CLAUDE.md)）は送信前処理で不変**（リージョンに依らずマスク後テキストのみ送る）。
- **将来モデル/次元を変える場合の再埋め込み手順**: `VECTOR_DIM` 更新 → `content_versions.embedding` / `ai_chat_messages.embedding` を全件再生成（migration + バッチ再実行）→ ベクトル索引（HNSW/IVFFlat 採用時）再構築。本体 ADR「悪い影響/リスク > 次元固定」のとおり。

### 出典

- text-embedding-004 の deprecation（2026-01-14）と `gemini-embedding-001` への移行案内: [Gemini Embedding now generally available — Google Developers Blog](https://developers.googleblog.com/gemini-embedding-available-gemini-api/), [Embeddings — Gemini API docs](https://ai.google.dev/gemini-api/docs/embeddings)
- 既定 3072 次元・MRL 切り詰め（推奨 768/1536/3072）・多言語/日本語サポート: [Get text embeddings — Vertex AI docs](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/embeddings/get-text-embeddings)
- 768 等 3072 未満では **手動 L2 正規化が必要**（自動正規化は gemini-embedding-2 のみ）: 上記 Vertex AI / Gemini API ドキュメントおよび Google 推奨ベストプラクティス
