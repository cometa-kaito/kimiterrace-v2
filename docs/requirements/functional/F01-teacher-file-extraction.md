# F01: 教員ファイル抽出入力

- 状態: 一部実装（抽出エンジン `packages/ai/src/extract/` は全形式対応済。アップロード経路・保存・編集 UI・CMEK は未実装）
- 関連 ADR: ADR-005 (Vertex AI), ADR-017 (Gemini 抽出, 起票予定), [ADR-024 (文書抽出/OCR 委託境界)](../../adr/024-document-extraction-and-ocr-egress.md)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12)

## 概要

教員が PDF / Word / Excel / 画像をアップロードすると、AI が内容を構造化してコンテンツ草稿を生成する。

## ユーザーストーリー

- **教員として**、紙の進路だよりをスキャンしてアップロードし、サイネージ用コンテンツが自動生成されてほしい。**なぜなら**手入力すると時間がかかり働き方改革の趣旨に反するから。

## 受け入れ条件

- [~] PDF / DOCX / XLSX / PNG / JPEG をアップロード可 — 部分実装（[#180](https://github.com/cometa-kaito/kimiterrace-v2/pull/180)、[#187](https://github.com/cometa-kaito/kimiterrace-v2/pull/187)、[#189](https://github.com/cometa-kaito/kimiterrace-v2/pull/189)、`packages/ai/src/extract/`）残: 抽出レイヤ（形式推定 + 各形式の抽出器 + Cloud Vision OCR）は全形式対応済だが、ブラウザからの実アップロード経路（multipart 受信 API ルート）は未実装
- [ ] アップロードファイルは Cloud Storage の `school-{school_id}-uploads/` バケットに保存 — 未実装（`teacher_input_attachments` はメタ行のみ、実アップロード経路なし）
- [~] AI 抽出結果は構造化 JSON (title, body, suggested_publish_scope, suggested_period, confidence_score) として返る — 部分実装（[#144](https://github.com/cometa-kaito/kimiterrace-v2/pull/144)、`packages/ai/src/schema/extraction.ts`）残: 構造化スキーマは kind/data/confidenceScore/evidence 形（announcement は title/body/dueDate）で、`suggested_publish_scope` / `suggested_period` フィールドは未定義
- [ ] 教員 UI で抽出結果を編集してから公開ボタン押下できる — 未実装（抽出結果を描画する編集 UI が無い。`TeacherInputComposer` は入力のみ）
- [~] アップロードと AI 抽出は全件 audit_log に記録 — 部分実装（[#235](https://github.com/cometa-kaito/kimiterrace-v2/pull/235)、`packages/ai/src/audit.ts`、`apps/web/lib/ai/run-extraction.ts`）残: AI 抽出は `ai_extractions` 記録 + DB トリガ audit 済だが、ファイルアップロード自体が未実装のため「アップロードの監査」は不在
- [ ] アップロード上限サイズ: 50 MB / ファイル — 未実装（アップロード endpoint が無く上限強制も無い）
- [ ] PII を含む可能性が高いため、Cloud Storage 側で CMEK 暗号化 + アクセスログ有効化 — 未実装（アップロード用バケット未定義、CMEK は Terraform README で将来項目）

> 補足: 抽出レイヤのレガシー Office (.doc/.xls) 検出 + 変換案内（[#184](https://github.com/cometa-kaito/kimiterrace-v2/pull/184)）、pdf/docx 実バイト smoke E2E（[#218](https://github.com/cometa-kaito/kimiterrace-v2/pull/218)）、pdfjs standard_fonts 同梱 + 起動 fail-fast（[#316](https://github.com/cometa-kaito/kimiterrace-v2/pull/316)）は実装済で、いずれも条件 1（形式対応）を裏付ける。

## 関連

- 後続: [F03 (AI 構造化)](F03-ai-structuring.md), [F04 (即公開フロー)](F04-instant-publish-safety-nets.md)
- セキュリティ要件: [NFR03](../non-functional/NFR03-security.md), [NFR04](../non-functional/NFR04-audit-log.md)
- テスト: `__tests__/api/uploads/`, `__tests__/ai/extraction/`
