# F06: 生徒対話（音声 / チャット）

- 状態: 確定（チャットボット仕様 2026-06-01 確定 → [ADR-028](../../adr/028-f06-chatbot-answer-policy.md)）／実装は部品 DONE・束ねる SSE チャット route と UI が唯一の残（[#42](https://github.com/cometa-kaito/kimiterrace-v2/issues/42)）
- 関連 ADR: ADR-005 (Vertex AI), ADR-006 (Vercel AI SDK), ADR-007 (pgvector), ADR-016 (magic link 匿名), ADR-017 (confidence), ADR-019 (RLS 二層), ADR-028 (回答ポリシー)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [#42](https://github.com/cometa-kaito/kimiterrace-v2/issues/42)

## 概要

生徒が magic link 経由でアクセスし、サイネージに表示されている掲示物に関して音声 or チャットで質問できる。

## ユーザーストーリー

- **生徒として**、「あの説明会、自分のクラスも対象？」とその場で聞きたい。**なぜなら**掲示板を見て分からない時、教員を探すコストが高いから。

## 対象ユーザー（2026-06-01 確定 / ADR-028）

- MVP は **生徒 + 教員**。**保護者は Phase 2 送り**（クラス magic link は生徒・匿名アクセス専用で、保護者の認証/導線が未設計のため。[ADR-016](../../adr/016-class-magic-link-anonymous-access.md)）。
- 生徒: クラス magic link 経由・匿名（client_id cookie）。教員: Identity Platform 認証済みセッション（rate limit キーは user_id）。

> **実装状況サマリ（2026-06-02）**: ガード層・スコープ分類器・RAG 検索・拒否文ビルダー・プロンプト builder・PII マスキング・embedding パイプライン・`ai_chat_*` スキーマ + RLS は**すべて実装済**だが、いずれも import 元がテストのみ。**生徒向けチャット endpoint（SSE/streaming route）・LLM 応答生成の実配線・チャット UI が未実装**で、これらが揃えば各部品が稼働する（`apps/web/app/student/page.tsx` は「準備中」プレースホルダ）。

## 受け入れ条件

- [~] 質問範囲は **掲示物に関する Q&A のみ**。学習・進路アドバイスは Phase 2 送り — 部分実装（[#389](https://github.com/cometa-kaito/kimiterrace-v2/pull/389)、`packages/ai/src/scope/classify.ts`）残: 決定論スコープ分類器は完成だが、これを呼ぶチャット route が未配線
- [x] RAG: 自校 (school_id スコープ) の公開中コンテンツのみを embedding 検索対象とする — 実装済（[#375](https://github.com/cometa-kaito/kimiterrace-v2/pull/375)、`packages/db/src/queries/rag-search.ts`：RLS で school スコープ + active publish のみ inner join + pgvector cosine top-k）
- [ ] Vercel AI SDK + SSE ストリーミングで応答 — 未実装（`app/api` にチャット endpoint なし、`streamText`/`useChat`/`@ai-sdk` の使用が apps/web に皆無）
- [~] トーンは **中立・丁寧**（敬語ベース、キャラ付けなし）— 部分実装（[#388](https://github.com/cometa-kaito/kimiterrace-v2/pull/388)、`packages/ai/src/prompt/chat.ts`：system プロンプトでトーン契約を固定）残: builder を呼ぶ route / LLM 実呼出し未配線
- [x] PII マスキング（生徒名等が掲示物・質問に含まれる場合）。生 PII は Gemini にも DB にも送らない — 実装済（[#378](https://github.com/cometa-kaito/kimiterrace-v2/pull/378)、[#384](https://github.com/cometa-kaito/kimiterrace-v2/pull/384)、`packages/ai/src/pii/mask.ts`：E.164 国際電話 + 全角 CJK 電話/メール。embedding バッチも roster 氏名マスク + fail-closed 配線済 [#424](https://github.com/cometa-kaito/kimiterrace-v2/pull/424)）
- [~] 全質問・応答は ai_chat_sessions / ai_chat_messages に保管（10 年）— 部分実装（[#278](https://github.com/cometa-kaito/kimiterrace-v2/pull/278)、`packages/db/src/schema/ai-chat-messages.ts`：embedding 列・composite FK・監査カラム・RLS）残: 保管書込みを行う route 未実装
- [~] rate limit: magic_link あたり 1 分 10 質問、1 端末 cookie あたり 1 分 10 質問（教員は user_id で別カウント）— 部分実装（[#269](https://github.com/cometa-kaito/kimiterrace-v2/pull/269)、`apps/web/lib/student-qa/rate-limit.ts`：二重キー原子評価）残: route 未配線・per-instance のみ（分散は #155 系）
- [~] プロンプトインジェクション対策: system プロンプトを user 入力で上書きさせない構造 — 部分実装（[#388](https://github.com/cometa-kaito/kimiterrace-v2/pull/388)、`packages/ai/src/prompt/chat.ts`：`<contents>`/`<student_question>` 役割分離 + `neutralizeInput`）残: builder を使う route / LLM 実呼出し未配線
- [~] **スコープ外**（学習・進路など掲示物と無関係）は「ごめんなさい、それは掲示物の話題から外れます」で誘導なし拒否（Gemini 呼出前に分類）— 部分実装（[#389](https://github.com/cometa-kaito/kimiterrace-v2/pull/389)、[#403](https://github.com/cometa-kaito/kimiterrace-v2/pull/403)、`packages/ai/src/scope/classify.ts`／`packages/ai/src/scope/refusal.ts`：分類器 + 多言語・決定論拒否文）残: 分類器 + 拒否文を呼ぶ route 未配線
- [~] **掲示物の話題だが掲示に根拠が無い場合**（RAG 非ヒット / 掲示に詳細なし）は、関連掲示を案内しつつ一般範囲で補足。ガードレール必須 = ①「掲示には無い一般的な情報です」と明示ラベル ②日時・持ち物・場所など **学校固有の事実は推測で生成せず**「先生に確認してください」と誘導 ③出典 (evidence_chunk_ids)・confidence を保管（[ADR-028](../../adr/028-f06-chatbot-answer-policy.md) / ADR-017）— 部分実装（[#388](https://github.com/cometa-kaito/kimiterrace-v2/pull/388)、`packages/ai/src/prompt/chat.ts`）残: ①②は system 契約のみで LLM 実行 route 未実装、③ evidence/confidence 保管書込み未配線（スキーマ列は存在）
- [~] **多言語対応**: 主要外国語（やさしい日本語可）でも上記すべてを満たす。PII マスキング・スコープ分類・拒否/ラベル文言を多言語で機能させる（ADR-028）— 部分実装（[#403](https://github.com/cometa-kaito/kimiterrace-v2/pull/403)、[#407](https://github.com/cometa-kaito/kimiterrace-v2/pull/407)、`packages/ai/src/scope/refusal.ts`：分類器 ja/やさしい日本語/en/pt、拒否文言多言語化、PII マスクは言語非依存）残: 各部品を束ねる route 未実装（多言語パイプライン未結線）

## 関連

- 前段: [F03 (AI 構造化と同じ Gemini)](F03-ai-structuring.md), [F05 (magic link)](F05-class-magic-link.md)
- セキュリティ: [NFR03](../non-functional/NFR03-security.md), [NFR06 (rate limit)](../non-functional/NFR06-cost-policy.md)
- テスト: `__tests__/ai/rag/`, `__tests__/ai/prompt-injection/`, `__tests__/e2e/student-qa/`
