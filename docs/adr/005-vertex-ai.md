# ADR-005: Vertex AI Gemini を採用、データ越境を回避する

- 状態: Proposed
- 日付: 2026-05-30
- 関連: [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94), [ADR-006 (Vercel AI SDK)](006-vercel-ai-sdk.md), [ADR-007 (pgvector)](007-pgvector.md), [ADR-017 (Gemini 構造化 + confidence)](017-gemini-ai-structuring-with-confidence.md), [F01 教員ファイル抽出](../requirements/functional/F01-teacher-file-extraction.md), [F03 AI 構造化](../requirements/functional/F03-ai-structuring.md), [F06 生徒 Q&A](../requirements/functional/F06-student-qa.md), [NFR03 セキュリティ](../requirements/non-functional/NFR03-security.md), [CLAUDE.md ルール4 (PII マスキング)](../../CLAUDE.md)

## 文脈

本システムの中核は AI による掲示物の構造化（[F01](../requirements/functional/F01-teacher-file-extraction.md) / [F03](../requirements/functional/F03-ai-structuring.md)）と生徒 Q&A の RAG（[F06](../requirements/functional/F06-student-qa.md)）。LLM プロバイダ / 実行基盤を選定する。

公立校データを扱う制約上の最重要点:

- **データ越境の最小化**: LLM への送信は事実上の外部委託（[CLAUDE.md ルール4](../../CLAUDE.md)）。プロバイダのログ・将来の学習データに生徒 PII が残るリスクを排除したい。送信前に PII をマスキングする（ルール4）前提でも、**データ所在は asia-northeast1 / GCP 内に閉じたい**（ISMAP・データ所在要件）。
- **GCP ネイティブ統合**: IAM / Workload Identity / 監査ログ（[NFR03](../requirements/non-functional/NFR03-security.md)）と一体化したい。
- **構造化出力 + confidence**: JSON モード等で構造化し、確信度を必須化（[ADR-017](017-gemini-ai-structuring-with-confidence.md)）。
- **embedding**: RAG の embedding を同一プロバイダで生成し、pgvector（[ADR-007](007-pgvector.md)）に格納。
- **コスト**: 学校無料モデルのため、従量コストが読めること。

選択肢:

- **Vertex AI（Gemini、asia-northeast1）**
- OpenAI API（GPT 系）
- Anthropic API（Claude 系）
- セルフホスト OSS LLM（Llama 等を GKE/GPU で運用）

## 決定

**Vertex AI の Gemini（asia-northeast1）を採用**する。

- **モデル**: 構造化（[F03](../requirements/functional/F03-ai-structuring.md)）と Q&A（[F06](../requirements/functional/F06-student-qa.md)）に Gemini ファミリ（Pro / Flash）を用いる。**具体的なモデル選定（MVP は Pro 固定、用途別の Flash/Pro 使い分けは Phase 2 送り）と出力の `confidence_score` 必須化は [ADR-017](017-gemini-ai-structuring-with-confidence.md) に委ねる**（本 ADR はプロバイダ = Vertex AI の採用とデータ所在の決定に責務を限定）。
- **PII マスキング**: Vertex AI でも生 PII は投げない。送信前にトークン化、応答後に逆変換、embedding はマスキング後テキストで生成（[CLAUDE.md ルール4](../../CLAUDE.md)）。
- **データ所在**: asia-northeast1 リージョンで処理を完結。Google 内であってもモデルログ・将来学習に PII が混入しない設計（マスキング + リージョン固定）。
- **認証**: Workload Identity（JSON キー禁止 = [ルール5](../../CLAUDE.md)）。
- **監査**: すべての LLM 呼び出しを `audit_log` に記録（ルール4）。
- **embedding**: Vertex AI の embedding を pgvector（[ADR-007](007-pgvector.md)）に格納し RAG。

## 検討した代替案

### 代替 A: OpenAI API（GPT 系）
- 却下理由: データが GCP / asia-northeast1 の外（主に米国）に出る。マスキングしても**データ所在要件・[ルール4](../../CLAUDE.md) の「外部委託最小化」思想**と整合しにくい。
- 副次理由: IAM / Workload Identity / 監査の GCP 統合が得られず、認証・監査が別系統になる。

### 代替 B: Anthropic API（Claude 系）
- 却下理由: 代替 A と同じくデータ所在・GCP 統合の観点。モデル品質は高いが、本要件では「GCP 内完結」を優先。
- 補足: 将来 Vertex AI 経由で Claude が asia-northeast1 提供される等の条件が整えば、本 ADR を再評価する余地。

### 代替 C: セルフホスト OSS LLM（Llama 等を GKE + GPU）
- 却下理由: データ所在は完全に自管理できる反面、GPU インフラの運用コスト・モデル更新・品質維持の負担が、学校無料モデルの規模・チーム体制に対して過大。
- 副次理由: 構造化品質・多言語・ツール連携で Gemini に対し検証コストが大きい。

## 結果（Consequences）

### 良い影響
- データが asia-northeast1 / GCP 内で完結し、マスキング（[ルール4](../../CLAUDE.md)）と合わせて PII 越境リスクを最小化。
- IAM / Workload Identity / 監査ログと統合（[NFR03](../requirements/non-functional/NFR03-security.md) / [ルール5](../../CLAUDE.md)）。
- embedding を pgvector（[ADR-007](007-pgvector.md)）に同居させ、RAG が RLS の `school_id` スコープに自然に乗る。
- 構造化 + `confidence_score`（[ADR-017](017-gemini-ai-structuring-with-confidence.md)）で AI 出力の安全網を張れる。

### 悪い影響 / リスク
- **プロバイダロックイン**: Gemini 固有の構造化 API / プロンプト設計に依存 → プロンプト・パーサを `packages/ai/` に分離し、抽象化で差し替え余地を残す。
- **マスキングの完全性**: マスキング漏れが越境に直結 → マスキング処理のテスト必須、embedding は必ずマスキング後テキストで生成（[ルール4](../../CLAUDE.md)）。
- **コスト変動**: 利用増で従量コストが膨らむ → レート制限（[NFR06](../requirements/non-functional/NFR06-cost-policy.md)）・モデル使い分け（Flash/Pro）で制御。
- **プロンプトインジェクション**: スコープ外データ引き出しの設計リスク → コンテキストは `school_id` スコープの行に限定（ルール4）。

### トレードオフ
- 「最高品質の外部 LLM vs データ所在を満たす GCP 内 LLM」のうち、公立校データのセキュリティ最優先で **GCP 内 Gemini**に振った。
- 「セルフホストの完全自管理 vs マネージドの運用容易性」のうち **マネージドの運用容易性**に振った。
