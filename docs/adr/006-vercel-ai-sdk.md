# ADR-006: Vercel AI SDK でストリーミング UI を実装

- 状態: Accepted（2026-06-01 ユーザーレビューで Proposed → Accepted）
- 日付: 2026-05-30
- 関連: [#94](https://github.com/cometa-kaito/kimiterrace-v2/issues/94), [ADR-005 (Vertex AI)](005-vertex-ai.md), [ADR-008 (Route Handlers)](008-nextjs-route-handlers.md), [ADR-017 (Gemini 構造化 + confidence)](017-gemini-ai-structuring-with-confidence.md), [F02 教員音声/チャット入力](../requirements/functional/F02-teacher-voice-chat-input.md), [F06 生徒 Q&A](../requirements/functional/F06-student-qa.md), [NFR06 コストポリシー](../requirements/non-functional/NFR06-cost-policy.md)

## 文脈

生徒 Q&A（[F06](../requirements/functional/F06-student-qa.md)）と教員の音声/チャット入力（[F02](../requirements/functional/F02-teacher-voice-chat-input.md)）は、LLM の応答を**ストリーミングで逐次表示**したい（体感速度・途中での読みやすさ）。[ADR-002](002-cloud-run-vs-functions.md) の Cloud Run + [ADR-008](008-nextjs-route-handlers.md) の Next.js Route Handlers 上で、[ADR-005](005-vertex-ai.md) の Vertex AI Gemini をストリーミングする実装手段を選定する。

要求:

- **SSE ストリーミング**: トークン逐次配信を Route Handler から返し、React 側で逐次描画。
- **Vertex AI Gemini に対応**: [ADR-005](005-vertex-ai.md) のプロバイダでストリームできること。
- **React 統合**: Next.js App Router の Server / Client 境界で扱いやすい hooks。
- **薄さ**: 余計な抽象（チェーン/エージェント基盤）を持ち込まない。本要件は「RAG 1 段 + ストリーム表示」程度。

選択肢:

- **Vercel AI SDK**
- 生の SSE / `ReadableStream` を手書き
- LangChain.js
- LlamaIndex.ts

## 決定

**Vercel AI SDK を採用**し、ストリーミング UI の標準基盤とする。

- **役割**: Route Handler（[ADR-008](008-nextjs-route-handlers.md)）で Gemini（[ADR-005](005-vertex-ai.md)）のストリームを SSE として返し、Client 側の hooks（`useChat` / `useCompletion` 相当）で逐次描画。
- **プロバイダ**: Vertex AI（Gemini）プロバイダ経由で接続。マスキング（[ルール4](../../CLAUDE.md)）・`confidence_score`（[ADR-017](017-gemini-ai-structuring-with-confidence.md)）等のドメインロジックは `packages/ai/` 側に置き、SDK は「ストリーム配線」に徹する。
- **共通化**: [F02](../requirements/functional/F02-teacher-voice-chat-input.md)（教員）と [F06](../requirements/functional/F06-student-qa.md)（生徒）でストリーミング基盤を共通化。

## 検討した代替案

### 代替 A: 生の SSE / ReadableStream 手書き
- 却下理由: トークン配信・中断・エラー・React 側の逐次状態管理を毎回手書きすると、バグの温床かつ重複実装になる。Vercel AI SDK がこの定型を吸収。
- 補足: SDK が薄いラッパであるため、必要なら下層の `ReadableStream` に降りる余地は残る。

### 代替 B: LangChain.js
- 却下理由: チェーン/エージェント/多数のインテグレーションを持つフル基盤で、本要件（RAG 1 段 + ストリーム表示）に対して過剰。依存と抽象が重く、デバッグ面が増える。
- 副次理由: RAG は pgvector（[ADR-007](007-pgvector.md)）+ 自前プロンプトで十分に薄く組める。

### 代替 C: LlamaIndex.ts
- 却下理由: 代替 B と同様、データフレームワークとしての抽象が本要件に対して重い。pgvector 直叩きで足りる。

## 結果（Consequences）

### 良い影響
- SSE ストリーミングの定型（配信・中断・React 状態）を SDK が吸収し、[F02](../requirements/functional/F02-teacher-voice-chat-input.md) / [F06](../requirements/functional/F06-student-qa.md) で共通化。
- Route Handler（[ADR-008](008-nextjs-route-handlers.md)）+ Cloud Run（[ADR-002](002-cloud-run-vs-functions.md)）の構成に素直に乗る。
- 薄いラッパのため、ドメインロジック（マスキング・confidence・RAG）を `packages/ai/` に分離しやすい。

### 悪い影響 / リスク
- **SDK のバージョン追従**: Vercel AI SDK の API 変更に追従が要る → ストリーム配線層を薄く保ち、ドメインロジックを `packages/ai/` に隔離して影響範囲を限定。
- **プロバイダ抽象の限界**: Gemini 固有機能（構造化出力の細部）は SDK 抽象を超える場合がある → 必要なら Vertex AI を直接呼ぶ経路を併用。
- **レート制御の所在**: ストリーミングはコネクションを保持するため、レート制限（[NFR06](../requirements/non-functional/NFR06-cost-policy.md)）を Route Handler 側で確実に適用する。

### トレードオフ
- 「フル基盤（LangChain）の機能網羅 vs 薄い SDK のシンプルさ」のうち、本要件の軽さに合わせ **薄い SDK のシンプルさ**に振った。
- 「手書き SSE の自由度 vs SDK の定型吸収」のうち、重複実装とバグを避け **SDK の定型吸収**に振った。
