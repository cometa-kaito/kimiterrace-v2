# F03: AI 構造化

- 状態: 実装中（抽出エンジン実装済 `packages/ai`、DB/Vertex 配線は follow-up）
- 関連 ADR: [ADR-005 (Vertex AI)](../../adr/005-vertex-ai.md), [ADR-017 (confidence_score 必須化)](../../adr/017-gemini-ai-structuring-with-confidence.md), [ADR-006 (Vercel AI SDK)](../../adr/006-vercel-ai-sdk.md)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12)
- 実装: `packages/ai/`（`maskPII` / `structureContent` / `createVertexModelClient` / `toAiExtractionInsert`）

## 概要

[F01](F01-teacher-file-extraction.md) / [F02](F02-teacher-voice-chat-input.md) の入力を Vertex AI Gemini に渡し、構造化 JSON を返す。

## ユーザーストーリー

- **システムとして**、自由形式の入力を機械可読な構造に変換し、後続フローを単純化したい。
- **教員として**、AI 抽出結果がどれくらい信頼できるかを数値で見たい（後続の確信度フラグへ）。

## 受け入れ条件

- [x] Vertex AI Gemini (asia-northeast1) を使用 — `createVertexModelClient`（Gemini Pro 固定・ADC 認証）
- [x] PII マスキング後にプロンプトを送信、応答後に逆変換（[CLAUDE.md ルール 4](../../../CLAUDE.md)）— `maskPII`/`unmaskPII`、`findUnmaskedPii` で fail-closed 検証
- [x] 出力スキーマは Zod で validate。失敗時はリトライ最大 2 回 — `structureContent`（修復ヒント付き）
- [x] confidence_score (0.0〜1.0) を必ず返す — `extractionSchema` 必須フィールド
- [x] プロンプト・応答・トークン数・確信度を `ai_extractions` テーブルに記録 — `toAiExtractionInsert` マッパー（実 INSERT は呼び出し側が `withTenantContext` 内で実行＝follow-up 配線）
- [x] レート制限: school_id あたり 1 分 60 リクエスト — `createPerSchoolRateLimiter`（単一プロセス内、分散は follow-up）
- [x] プロンプトインジェクション対策: ユーザー入力は system プロンプトを上書きできない構造（XML タグでセパレート）— `buildUserPrompt`/`neutralizeInput`

> **follow-up（別 Issue/PR）**: ① apps/web Server Action / Cloud Run Job から `ai_extractions` への実 INSERT（RLS context 内）と Vertex 実呼び出しの結合テスト、② 複数インスタンス用の分散レート制限（共有ストア）。本 PR は GCP 資格情報なしでオフライン検証可能な抽出エンジン（PII / Zod / リトライ / インジェクション / マッパー）を実装。

## 関連

- 前段: [F01](F01-teacher-file-extraction.md), [F02](F02-teacher-voice-chat-input.md)
- 後段: [F04 (確信度フラグ)](F04-instant-publish-safety-nets.md)
- セキュリティ: [NFR03 (PII マスキング)](../non-functional/NFR03-security.md), [NFR06 (rate limit)](../non-functional/NFR06-cost-policy.md)
- テスト: `__tests__/ai/extraction/`, `__tests__/ai/prompt-injection/`
