# F01: 教員ファイル抽出入力

- 状態: Draft（[v2-mvp.md](../v2-mvp.md) §4 から分割）
- 関連 ADR: ADR-005 (Vertex AI), ADR-017 (Gemini 抽出, 起票予定)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12)

## 概要

教員が PDF / Word / Excel / 画像をアップロードすると、AI が内容を構造化してコンテンツ草稿を生成する。

## ユーザーストーリー

- **教員として**、紙の進路だよりをスキャンしてアップロードし、サイネージ用コンテンツが自動生成されてほしい。**なぜなら**手入力すると時間がかかり働き方改革の趣旨に反するから。

## 受け入れ条件

- [ ] PDF / DOCX / XLSX / PNG / JPEG をアップロード可
- [ ] アップロードファイルは Cloud Storage の `school-{school_id}-uploads/` バケットに保存
- [ ] AI 抽出結果は構造化 JSON (title, body, suggested_publish_scope, suggested_period, confidence_score) として返る
- [ ] 教員 UI で抽出結果を編集してから公開ボタン押下できる
- [ ] アップロードと AI 抽出は全件 audit_log に記録
- [ ] アップロード上限サイズ: 50 MB / ファイル
- [ ] PII を含む可能性が高いため、Cloud Storage 側で CMEK 暗号化 + アクセスログ有効化

## 関連

- 後続: [F03 (AI 構造化)](F03-ai-structuring.md), [F04 (即公開フロー)](F04-instant-publish-safety-nets.md)
- セキュリティ要件: [NFR03](../non-functional/NFR03-security.md), [NFR04](../non-functional/NFR04-audit-log.md)
- テスト: `__tests__/api/uploads/`, `__tests__/ai/extraction/`
