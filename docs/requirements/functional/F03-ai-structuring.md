# F03: AI 構造化

- 状態: 実装済（抽出エンジン `packages/ai` + DB 永続化 + Vertex 配線 + 抽出トリガ `POST /api/teacher-inputs/:id/extract` 完了。分散レート制限はストア実装済・本番ランタイム差し替えのみ未配線）
- 関連 ADR: [ADR-005 (Vertex AI)](../../adr/005-vertex-ai.md), [ADR-017 (confidence_score 必須化)](../../adr/017-gemini-ai-structuring-with-confidence.md), [ADR-006 (Vercel AI SDK)](../../adr/006-vercel-ai-sdk.md), [ADR-027 (分散レート制限)](../../adr/027-distributed-f03-rate-limit.md)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [#154](https://github.com/cometa-kaito/kimiterrace-v2/issues/154)
- 実装: `packages/ai/`（`maskPII` / `structureContent` / `createVertexModelClient` / `toAiExtractionInsert`）

## 概要

[F01](F01-teacher-file-extraction.md) / [F02](F02-teacher-voice-chat-input.md) の入力を Vertex AI Gemini に渡し、構造化 JSON を返す。

## ユーザーストーリー

- **システムとして**、自由形式の入力を機械可読な構造に変換し、後続フローを単純化したい。
- **教員として**、AI 抽出結果がどれくらい信頼できるかを数値で見たい（後続の確信度フラグへ）。

## 受け入れ条件

- [x] Vertex AI Gemini (asia-northeast1) を使用 — `createVertexModelClient`（Gemini Pro 固定・ADC 認証）
- [x] PII マスキング後にプロンプトを送信、応答後に逆変換（[CLAUDE.md ルール 4](../../../CLAUDE.md)）— `maskPII`/`unmaskPII`、`findUnmaskedPii` で fail-closed 検証（全角 CJK 電話/メール・国際電話 E.164 対応：[#378](https://github.com/cometa-kaito/kimiterrace-v2/pull/378)/[#384](https://github.com/cometa-kaito/kimiterrace-v2/pull/384)）
- [x] 出力スキーマは Zod で validate。失敗時はリトライ最大 2 回 — `structureContent`（修復ヒント付き）
- [x] confidence_score (0.0〜1.0) を必ず返す — `extractionSchema` 必須フィールド
- [x] プロンプト・応答・トークン数・確信度を `ai_extractions` テーブルに記録 — `toAiExtractionInsert` マッパー + 実 INSERT 配線済（`insertAiExtraction` を RLS context 内で実行）。実装済（[#228](https://github.com/cometa-kaito/kimiterrace-v2/pull/228)、[#267](https://github.com/cometa-kaito/kimiterrace-v2/pull/267)、[#346](https://github.com/cometa-kaito/kimiterrace-v2/pull/346)、`packages/db/src/queries/ai-extractions.ts`、`apps/web/lib/ai/run-extraction.ts`）
- [x] レート制限: school_id あたり 1 分 60 リクエスト — `createPerSchoolRateLimiter`（本番ランタイムで配線）。分散版 `CloudSqlRateLimiter`（共有ストア + 実 PG 並行テスト）も実装済だが本番ランタイム差し替えは未配線。実装済（[#144](https://github.com/cometa-kaito/kimiterrace-v2/pull/144)、[#345](https://github.com/cometa-kaito/kimiterrace-v2/pull/345)、[#351](https://github.com/cometa-kaito/kimiterrace-v2/pull/351)、[#360](https://github.com/cometa-kaito/kimiterrace-v2/pull/360)、`packages/ai/src/rate-limit.ts`、`packages/db/src/queries/ai-rate-limit.ts`）
- [x] プロンプトインジェクション対策: ユーザー入力は system プロンプトを上書きできない構造（XML タグでセパレート）— `buildUserPrompt`/`neutralizeInput`

> **follow-up（解決済）**: ① 実 INSERT（RLS context 内）= [#228](https://github.com/cometa-kaito/kimiterrace-v2/pull/228)/[#267](https://github.com/cometa-kaito/kimiterrace-v2/pull/267)、抽出トリガ `POST /api/teacher-inputs/:id/extract` = [#287](https://github.com/cometa-kaito/kimiterrace-v2/pull/287)、職員氏名 roster マスキング供給 = [#317](https://github.com/cometa-kaito/kimiterrace-v2/pull/317)、Vertex 実呼び出し結合テスト（skip-gated）= [#334](https://github.com/cometa-kaito/kimiterrace-v2/pull/334)。② 分散レート制限（共有ストア）= [#345](https://github.com/cometa-kaito/kimiterrace-v2/pull/345)/[#351](https://github.com/cometa-kaito/kimiterrace-v2/pull/351)/[#360](https://github.com/cometa-kaito/kimiterrace-v2/pull/360)。**残課題**: 本番ランタイム（`apps/web/lib/ai/extract-teacher-input.ts`）を in-memory limiter から分散版へ切替、生徒/保護者氏名のマスキング方針確定と実 Vertex 呼び出し有効化ゲート。

## 関連

- 前段: [F01](F01-teacher-file-extraction.md), [F02](F02-teacher-voice-chat-input.md)
- 後段: [F04 (確信度フラグ)](F04-instant-publish-safety-nets.md)
- セキュリティ: [NFR03 (PII マスキング)](../non-functional/NFR03-security.md), [NFR06 (rate limit)](../non-functional/NFR06-cost-policy.md)
- テスト: `__tests__/ai/extraction/`, `__tests__/ai/prompt-injection/`
