# ADR-038: 画像 OCR を Vertex Gemini マルチモーダル直送に切替（データレジデンシー優先）

- 状態: Accepted（2026-06-13、学校体験リニューアル AI レーンで実装着地）
- 日付: 2026-06-13
- 関連: [ADR-024 文書抽出と OCR egress](024-document-extraction-and-ocr-egress.md)（**決定2 を本 ADR が supersede**）, [ADR-005 Vertex AI](005-vertex-ai.md), [ADR-030 authoring 時 PII ゲート](030-authoring-time-pii-gate.md), [CLAUDE.md ルール4], NFR06（コスト）/ NFR07（データ越境ゼロ）, 学校関係者UX通し体験 指摘ログ 2026-06-13（finding 2b ファイル入力＝画像対応）

## 文脈

[ADR-024 決定2](024-document-extraction-and-ocr-egress.md) は画像 OCR バックエンドに **Google Cloud Vision API**（Document Text Detection）を選び、**Gemini Vision（マルチモーダル LLM）を代替B として却下**した。却下理由は「生 PII 画像を**生成モデル**の文脈に渡すと、モデルログ・将来学習データへの混入リスクが OCR 専用 API より高い」。

実装着地（finding 2b: 教員のファイル入力で画像も扱う）に向けて再評価したところ、ADR-024 自身が **M1（データレジデンシー）** として残した懸念が決定的になった:

- **Cloud Vision は asia-northeast1 のデータレジデンシー保証の前提が Vertex と異なる**。リージョナルエンドポイント（`eu-` / `us-`）はあるが、本プロジェクトの処理を **asia-northeast1 に閉じる**（NFR07 データ越境ゼロ）保証を Vision で満たせるかは未実証で、満たせない場合 **NFR07 違反**になる。
- 一方 **Vertex Gemini は本プロジェクトの全 AI 経路（F03 構造化 / F06 対話 / 連絡ドラフト等）と同一の asia-northeast1 に閉じられる**。OCR も Vertex に寄せれば、リージョン保証は他経路と同一の既知の土俵に乗る。

つまり「**生成モデルへの PII 露出（ADR-024 代替B の懸念）**」と「**データ越境ゼロ（NFR07・ハード要件）**」のトレードオフであり、ADR-024 はリージョン未確定のまま前者を優先していた。NFR07 はコンプライアンスのハード要件（越えると越境）で、代替B の懸念は「リスク（運用ガードで縮小可能）」である。**ハード要件を満たす側（asia-northeast1 に閉じる = Gemini）を採る**。

## 決定

**画像 OCR バックエンドを Vertex Gemini マルチモーダル直送に切替**（`createGeminiOcrClient`、`packages/ai/src/extract/ocr/gemini.ts`）。ADR-024 **決定2（Cloud Vision 採用・代替B 却下）を本 ADR が supersede** する。ADR-024 の他の決定（決定1=文書ローカル抽出 / 決定3=OcrClient 依存逆転 / 決定4=フェイルクローズ）は**不変**。

1. **バックエンド = Vertex Gemini（asia-northeast1 固定）**。`OcrClient` インターフェース（ADR-024 決定3）はそのまま流用し、`ImageExtractor` への注入を Vision → Gemini に差し替えるだけ（依存逆転のおかげで配線変更は局所）。`createVisionOcrClient` はコードに残すが既定経路からは外す（将来 Vision の asia 保証が整えば再評価可能）。
2. **OCR 専用プロンプトに限定**: 「画像の文字を忠実に書き起こす（要約・推論・補完をしない）」system で生成能力を**転写に絞る**。画像に無い事実の創作を防ぐ（下流の構造化/マスクはこの素テキストに働く）。
3. **代替B のリスク（生成モデルへの生 PII 露出）の緩和策**（ADR-024 決定2 の三段ガードを継承・強化）:
   - **オプトイン**: 教員が画像を**明示アップロード**したときのみ OCR を起動する（既定で画像を勝手にテキスト化しない）。
   - **越境ゼロ**: project/location はハードコードせず注入し、Vertex と同じ asia-northeast1 に閉じる（NFR07）。Vertex の no-retention / 既定で学習に使わない契約前提に依拠（ADR-005）。
   - **監査**: OCR egress を `audit_log` に記録（who / school_id / 対象 / **画像 SHA-256** / 抽出文字数 / `ocrEgress:true`）。**画像本体・抽出本文は残さない**（ルール4）。egress は extract 時点で発生済ゆえ、後続 draft 失敗時も監査を残す（fail-safe）。
   - **下流マスキング**: 抽出テキストは必ず `runSectionDraft`（mask + soft-gate + fail-closed）/ structure 経路を通してから Vertex の生成・embedding に渡す（ADR-024 決定2.3 / ルール4）。
   - **レート前置**: 画像経路は OCR egress の**前**に per-school rate を取る（NFR06 コスト / egress 増幅防止）。
4. **CSV も「表」として受理**（ユーザー決定 2026-06-13）: `text/csv` を upload allowlist に追加。CSV は egress なしの `TextExtractor`（UTF-8 デコード）で素通り（OCR 経路ではない・本 ADR とは独立だが同 PR で着地）。

## 検討した代替案

- **A. Cloud Vision のまま + asia リージョナル設定を実証**: NFR07 を満たせるか未確定で、満たせなければ越境。実証コスト + 不確実性に対し、Gemini 移行は他経路と同一土俵で確実。却下（実証できれば将来再評価）。
- **B. オンデバイス OCR（tesseract.js）**: ADR-024 代替A と同じく日本語（手書き/縦書き）精度が校務文書に不足。却下。
- **C. 画像はテキスト貼り付けのみ・OCR を作らない**: finding 2b の「画像も対応」要望を満たさない。却下。

## 残存リスク（正直に明記）

- **生成モデルへの生 PII 画像露出**: ADR-024 代替B が嫌った点。Vertex の no-retention 前提 + オプトイン + 監査 + 下流マスクで縮小するが、ゼロではない（画像→生成モデルである以上、Vision 専用 API よりログ/将来学習面は理論上不利）。**NFR07（越境ゼロ）を満たすためのトレードオフとして受容**（ユーザー方針 finding 2b）。
- **OCR 精度**: 手書きは誤読しうる。抽出テキストは教員が採用前にカードで確認・編集する安全網（ADR-033）に載る。
- **acknowledge 再送で OCR 二重実行**: OCR テキストに氏名が含まれ soft-gate（ADR-030）が発火 → 教員 acknowledge → 再アップロードで OCR が再度走る（egress 二重・監査二行）。本 Server Action 経路の既知の非効率。会話型バックエンド（別 PR）は抽出を一度だけ行う設計で解消予定。

## 再検討トリガ

- Cloud Vision が asia-northeast1 のデータレジデンシーを明確に保証する設定を提供 → コスト/精度を見て Vision 回帰を再評価。
- Vertex の OCR 精度/コストが校務文書で不足と判明 → Document AI 等を補足 ADR で検討。
- 生成モデルへの PII 露出に関する規制/契約条件が変化。

## 影響

- `packages/ai`: `createGeminiOcrClient` 追加（`ocr/gemini.ts`）。`OcrClient.recognize` に任意 `mediaType` 引数を追加（Gemini が画像パートに付与・Vision は無視＝後方互換）。barrel から export。
- `apps/web/lib/editor/assistant-actions.ts`: 画像 OCR 配線（rate 前置 + OCR egress 監査 + skipRateLimit）。`EDITOR_FILE_EXTS` に csv/png/jpg 追加。
- `apps/web/lib/teacher-input/upload-validation.ts`: allowlist に `text/csv` 追加・415 文言更新。
- ルール3（型単一ソース）非接触。ルール4 は不変（マスクは下流・本 ADR で egress 経路の監査が増える）。
