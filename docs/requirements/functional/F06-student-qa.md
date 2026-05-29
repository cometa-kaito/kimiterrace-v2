# F06: 生徒対話（音声 / チャット）

- 状態: Draft（[v2-mvp.md](../v2-mvp.md) §4 から分割）
- 関連 ADR: ADR-005 (Vertex AI), ADR-006 (Vercel AI SDK), ADR-007 (pgvector)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12)

## 概要

生徒が magic link 経由でアクセスし、サイネージに表示されている掲示物に関して音声 or チャットで質問できる。

## ユーザーストーリー

- **生徒として**、「あの説明会、自分のクラスも対象？」とその場で聞きたい。**なぜなら**掲示板を見て分からない時、教員を探すコストが高いから。

## 受け入れ条件

- [ ] 質問範囲は **掲示物に関する Q&A のみ**。学習・進路アドバイスは Phase 2 送り
- [ ] RAG: 自校 (school_id スコープ) の公開中コンテンツのみを embedding 検索対象とする
- [ ] Vercel AI SDK + SSE ストリーミングで応答
- [ ] PII マスキング（生徒名等が掲示物に含まれている場合）
- [ ] 全質問・応答は ai_chat_sessions / ai_chat_messages に保管（10 年）
- [ ] rate limit: magic_link あたり 1 分 10 質問、1 端末 cookie あたり 1 分 10 質問
- [ ] プロンプトインジェクション対策: system プロンプトを user 入力で上書きさせない構造
- [ ] スコープ外の質問（学習・進路）は「ごめんなさい、それは掲示物の話題から外れます」で誘導なし拒否

## 関連

- 前段: [F03 (AI 構造化と同じ Gemini)](F03-ai-structuring.md), [F05 (magic link)](F05-class-magic-link.md)
- セキュリティ: [NFR03](../non-functional/NFR03-security.md), [NFR06 (rate limit)](../non-functional/NFR06-cost-policy.md)
- テスト: `__tests__/ai/rag/`, `__tests__/ai/prompt-injection/`, `__tests__/e2e/student-qa/`
