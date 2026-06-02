# F01: 教員ファイル抽出入力

- 状態: MVP 実装済（文書形式 PDF/DOCX/XLSX）。アップロード経路・GCS 保存配線・抽出テキスト化・編集→公開 UI まで結線（#509: [#516](https://github.com/cometa-kaito/kimiterrace-v2/pull/516)/[#520](https://github.com/cometa-kaito/kimiterrace-v2/pull/520)/[#521](https://github.com/cometa-kaito/kimiterrace-v2/pull/521)/[#523](https://github.com/cometa-kaito/kimiterrace-v2/pull/523)/[#524](https://github.com/cometa-kaito/kimiterrace-v2/pull/524)）。**残（導入前/別 issue）**: 画像 OCR テキスト化（ADR-024 決定3）/ 実 Vertex 構造化フィールド自動充填（PII マスキング基盤 [#289](https://github.com/cometa-kaito/kimiterrace-v2/issues/289) は実装済、実 Vertex 呼び出し有効化は後続スライス）/ バケット実 apply + ハードニング（[#522](https://github.com/cometa-kaito/kimiterrace-v2/issues/522)）
- 関連 ADR: ADR-005 (Vertex AI), ADR-017 (Gemini 抽出, 起票予定), [ADR-024 (文書抽出/OCR 委託境界)](../../adr/024-document-extraction-and-ocr-egress.md)
- 関連 issue: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12)

## 概要

教員が PDF / Word / Excel / 画像をアップロードすると、AI が内容を構造化してコンテンツ草稿を生成する。

## ユーザーストーリー

- **教員として**、紙の進路だよりをスキャンしてアップロードし、サイネージ用コンテンツが自動生成されてほしい。**なぜなら**手入力すると時間がかかり働き方改革の趣旨に反するから。

## 受け入れ条件

- [x] PDF / DOCX / XLSX / PNG / JPEG をアップロード可 — 実装済（multipart 受信 `POST /api/teacher-inputs/upload` [#521](https://github.com/cometa-kaito/kimiterrace-v2/pull/521) + ファイル選択 UI [#524](https://github.com/cometa-kaito/kimiterrace-v2/pull/524)、MIME allowlist で 5 形式を受理。抽出レイヤは [#180](https://github.com/cometa-kaito/kimiterrace-v2/pull/180)/[#187](https://github.com/cometa-kaito/kimiterrace-v2/pull/187)/[#189](https://github.com/cometa-kaito/kimiterrace-v2/pull/189)）。注: 画像（PNG/JPEG）の**テキスト化**は OCR 配線（ADR-024 決定3）後で、現状アップロードは受理し transcript 保留（pending_ocr）
- [~] アップロードファイルは Cloud Storage の per-school prefix バケットに保存 — コード結線済（GCS 保存ポート + `uploads/{schoolId}/{uuid}.{ext}` per-school prefix + ADC、[#521](https://github.com/cometa-kaito/kimiterrace-v2/pull/521)）。残: バケット実 apply は導入フェーズ（[#516](https://github.com/cometa-kaito/kimiterrace-v2/pull/516) で `enabled=false` スキャフォールド済、未 apply 時は 502 でフェイルクローズ）
- [~] AI 抽出結果は構造化 JSON (title, body, confidence_score 等) として返る — ファイル→テキスト化（transcript）は実装済（[#521](https://github.com/cometa-kaito/kimiterrace-v2/pull/521)）。構造化抽出（kind/data/confidenceScore/evidence、`packages/ai/src/schema/extraction.ts` [#144](https://github.com/cometa-kaito/kimiterrace-v2/pull/144)）の `/extract` トリガは配線済だが、実 Vertex 呼び出しの有効化は後続（PII マスキング基盤 [#289](https://github.com/cometa-kaito/kimiterrace-v2/issues/289) は実装済、実呼び出しは別スライス）。`suggested_publish_scope`/`suggested_period` は未定義のまま、公開先は編集 UI で教員が明示選択
- [x] 教員 UI で抽出結果を編集してから公開ボタン押下できる — 実装済（[#524](https://github.com/cometa-kaito/kimiterrace-v2/pull/524)）: 抽出済み transcript →「編集して公開」→ `createContent` で下書き生成（[#523](https://github.com/cometa-kaito/kimiterrace-v2/pull/523)）→ 既存エディタ `/admin/contents/[id]`（PublishControls/ConfidenceBadge）で編集 → 公開
- [x] アップロードと AI 抽出は全件 audit_log に記録 — 実装済（アップロードは `createTeacherInput`/`addAttachment` が同一 tx で audit_log insert [#521](https://github.com/cometa-kaito/kimiterrace-v2/pull/521)、AI 抽出は `ai_extractions` + DB トリガ audit [#235](https://github.com/cometa-kaito/kimiterrace-v2/pull/235)）
- [x] アップロード上限サイズ: 50 MB / ファイル — 実装済（Content-Length 早期棄却 + 実バイト長検査の二段、[#521](https://github.com/cometa-kaito/kimiterrace-v2/pull/521)）。ストリーム硬上限の追加ハードニングは [#522](https://github.com/cometa-kaito/kimiterrace-v2/issues/522)（導入前）
- [~] PII を含む可能性が高いため、Cloud Storage 側で CMEK 暗号化 + アクセスログ有効化 — Terraform モジュールに CMEK（`kms_key_name`）+ アクセスログ + uniform access + public access 禁止を配線済（[#516](https://github.com/cometa-kaito/kimiterrace-v2/pull/516)、`enabled=false`）。残: 実 apply 時に KMS 鍵必須化の precondition（[#522](https://github.com/cometa-kaito/kimiterrace-v2/issues/522)）+ apply（導入フェーズ）

> 補足: 抽出レイヤのレガシー Office (.doc/.xls) 検出 + 変換案内（[#184](https://github.com/cometa-kaito/kimiterrace-v2/pull/184)）、pdf/docx 実バイト smoke E2E（[#218](https://github.com/cometa-kaito/kimiterrace-v2/pull/218)）、pdfjs standard_fonts 同梱 + 起動 fail-fast（[#316](https://github.com/cometa-kaito/kimiterrace-v2/pull/316)）は実装済で、いずれも条件 1（形式対応）を裏付ける。

## 関連

- 後続: [F03 (AI 構造化)](F03-ai-structuring.md), [F04 (即公開フロー)](F04-instant-publish-safety-nets.md)
- セキュリティ要件: [NFR03](../non-functional/NFR03-security.md), [NFR04](../non-functional/NFR04-audit-log.md)
- テスト: `__tests__/api/uploads/`, `__tests__/ai/extraction/`
