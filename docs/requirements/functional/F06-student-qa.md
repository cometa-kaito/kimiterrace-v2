# F06: 生徒対話（音声 / チャット）

- 状態: 確定（チャットボット仕様 2026-06-01 確定 → [ADR-028](../../adr/028-f06-chatbot-answer-policy.md)）
- 関連 ADR: ADR-005 (Vertex AI), ADR-006 (Vercel AI SDK), ADR-007 (pgvector), ADR-016 (magic link 匿名), ADR-017 (confidence), ADR-019 (RLS 二層), ADR-028 (回答ポリシー)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12)

## 概要

生徒が magic link 経由でアクセスし、サイネージに表示されている掲示物に関して音声 or チャットで質問できる。

## ユーザーストーリー

- **生徒として**、「あの説明会、自分のクラスも対象？」とその場で聞きたい。**なぜなら**掲示板を見て分からない時、教員を探すコストが高いから。

## 対象ユーザー（2026-06-01 確定 / ADR-028）

- MVP は **生徒 + 教員**。**保護者は Phase 2 送り**（クラス magic link は生徒・匿名アクセス専用で、保護者の認証/導線が未設計のため。[ADR-016](../../adr/016-class-magic-link-anonymous-access.md)）。
- 生徒: クラス magic link 経由・匿名（client_id cookie）。教員: Identity Platform 認証済みセッション（rate limit キーは user_id）。

## 受け入れ条件

- [ ] 質問範囲は **掲示物に関する Q&A のみ**。学習・進路アドバイスは Phase 2 送り
- [ ] RAG: 自校 (school_id スコープ) の公開中コンテンツのみを embedding 検索対象とする
- [ ] Vercel AI SDK + SSE ストリーミングで応答
- [ ] トーンは **中立・丁寧**（敬語ベース、キャラ付けなし）
- [ ] PII マスキング（生徒名等が掲示物・質問に含まれる場合）。生 PII は Gemini にも DB にも送らない
- [ ] 全質問・応答は ai_chat_sessions / ai_chat_messages に保管（10 年）
- [ ] rate limit: magic_link あたり 1 分 10 質問、1 端末 cookie あたり 1 分 10 質問（教員は user_id で別カウント）
- [ ] プロンプトインジェクション対策: system プロンプトを user 入力で上書きさせない構造
- [ ] **スコープ外**（学習・進路など掲示物と無関係）は「ごめんなさい、それは掲示物の話題から外れます」で誘導なし拒否（Gemini 呼出前に分類）
- [ ] **掲示物の話題だが掲示に根拠が無い場合**（RAG 非ヒット / 掲示に詳細なし）は、関連掲示を案内しつつ一般範囲で補足。ガードレール必須 = ①「掲示には無い一般的な情報です」と明示ラベル ②日時・持ち物・場所など **学校固有の事実は推測で生成せず**「先生に確認してください」と誘導 ③出典 (evidence_chunk_ids)・confidence を保管（[ADR-028](../../adr/028-f06-chatbot-answer-policy.md) / ADR-017）
- [ ] **多言語対応**: 主要外国語（やさしい日本語可）でも上記すべてを満たす。PII マスキング・スコープ分類・拒否/ラベル文言を多言語で機能させる（ADR-028）

## 関連

- 前段: [F03 (AI 構造化と同じ Gemini)](F03-ai-structuring.md), [F05 (magic link)](F05-class-magic-link.md)
- セキュリティ: [NFR03](../non-functional/NFR03-security.md), [NFR06 (rate limit)](../non-functional/NFR06-cost-policy.md)
- テスト: `__tests__/ai/rag/`, `__tests__/ai/prompt-injection/`, `__tests__/e2e/student-qa/`
