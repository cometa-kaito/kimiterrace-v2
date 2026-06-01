# ADR-024: 文書テキスト抽出と画像 OCR の外部委託境界

- 状態: Accepted（2026-06-01 ユーザーレビューで Proposed → Accepted）
- 日付: 2026-05-31
- 関連: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [#180 (抽出レイヤ scaffold)](https://github.com/cometa-kaito/kimiterrace-v2/pull/180), [ADR-005 (Vertex AI)](005-vertex-ai.md), [ADR-017 (Gemini 構造化 + confidence)](017-gemini-ai-structuring-with-confidence.md), [CLAUDE.md ルール4 (PII マスキング)](../../CLAUDE.md)

## 文脈

[#180](https://github.com/cometa-kaito/kimiterrace-v2/pull/180) で、アップロード素材（PDF / Word / Excel / 画像）から素テキストを取り出し、既存 `structureContent`（[ADR-017](017-gemini-ai-structuring-with-confidence.md)）へ渡す前段レイヤ（`packages/ai/src/extract/`）を scaffold した。形式推定とインターフェースは確定したが、**具象抽出器のパーサ選定と「どこまでが自プロセス内処理で、どこからが外部委託か」の境界**は未決のまま、各 `Extractor` をフェイルクローズスタブとして残した。

本 ADR はこの境界を確定する。論点は 2 つ:

1. **文書パーサ（PDF / docx / xlsx）**: ローカルライブラリで自プロセス内処理するか、外部 API（Document AI 等）に投げるか。
2. **画像 OCR**: 画像そのものが生徒の顔・氏名・手書き答案などの PII を含む。これを OCR するには事実上どこかへ画像を送る必要があり、[CLAUDE.md ルール4](../../CLAUDE.md)（LLM/外部への送信は事実上の外部委託）の正面の論点になる。

### 前提となる脅威モデル

- 抽出対象は教員がアップロードする校務文書・配布物・写真。生徒氏名・成績・顔写真を含みうる。
- 抽出後テキストは下流で必ず PII マスキング → `structureContent` を経由する（[#180](https://github.com/cometa-kaito/kimiterrace-v2/pull/180) の設計）。**ただしマスキングはテキスト化後にしか効かない**。画像の段階では顔・レイアウトを匿名化できない。
- データ越境は [NFR07 コンプライアンス] の禁止事項。処理は asia-northeast1 内に閉じる。

## 決定

### 1. 文書パーサ（PDF / docx / xlsx）は **ローカルライブラリで自プロセス内処理**

| 形式 | ライブラリ | 理由 |
|---|---|---|
| PDF | `pdfjs-dist`（legacy build, Node) | テキストレイヤ抽出が egress なしで完結。スキャン PDF（テキストレイヤ無し）は OCR 経路（決定2）にフォールバック |
| docx | `mammoth` | 段落テキスト抽出に特化、軽量、egress なし |
| xlsx | `exceljs` | シート/セルを行テキスト化、egress なし |

- **外部委託しない**: バイト列は Cloud Run コンテナ内で処理し、抽出テキストはプロセス外に出ない。ルール4 の「外部送信」に該当しないため、画像 OCR より規律が軽い。
- Document AI / 外部パース API は **却下**（後述 代替C）。

### 2. 画像 OCR は **Google Cloud Vision API (Document Text Detection)**、ただし送信ガードを必須化

- バックエンド: **Cloud Vision API**（`@google-cloud/vision`）を asia-northeast1 で使用。Workload Identity 認証（[CLAUDE.md ルール5](../../CLAUDE.md)、JSON キー禁止）。
- **Gemini Vision（マルチモーダル LLM）は却下**（後述 代替B）。OCR はテキスト座標抽出で足り、画像を生成モデルのコンテキスト/ログに残す必要がない。
- **送信ガード（fail-safe）**:
  1. 画像 OCR は **明示的なオプトイン**（教員が「画像から読み取る」を選んだ場合のみ）。既定では画像はテキスト化されない。
  2. OCR 呼び出しを **必ず `audit_log` に記録**（who / school_id / 画像ハッシュ / Vision API 呼び出し / 結果文字数）。[CLAUDE.md ルール1・ルール4]。
  3. OCR 結果テキストは **下流の PII マスキングを必ず通す**（`ExtractedText` は PII 未マスクの契約、[#180](https://github.com/cometa-kaito/kimiterrace-v2/pull/180)）。
  4. `ExtractMeta.ocrUsed = true` を立て、外部委託が発生したことを監査側が判別可能にする。
- **オンデバイス OCR（tesseract.js）は却下**（後述 代替A）。

### 3. OCR クライアントは依存逆転（DI）でテスタブルにする

- `ImageExtractor` は Vision SDK を直接 import せず、`OcrClient` インターフェース（`recognize(bytes) => Promise<{text, confidence}>`）を受け取る。`ModelClient`（[ADR-006](006-vercel-ai-sdk.md)）と同じ思想。
- 単体テストはフェイク `OcrClient` で全分岐を検証し、credential を要する実 Vision 呼び出しを CI に持ち込まない。実 Vision アダプタは薄いラッパとして別管理。

### 4. 未配線の抽出器はフェイルクローズを維持

- 依存追加・配線が済むまで各 `Extractor` は `ExtractorNotConfiguredError` を投げる（[#180](https://github.com/cometa-kaito/kimiterrace-v2/pull/180) の方針継続）。「黙って空文字を返す」は禁止（誤って空抽出が下流に流れる事故を防ぐ）。

## 検討した代替案

### 代替 A: 画像 OCR をオンデバイス（tesseract.js）で行い egress ゼロ
- 却下理由: 日本語（特に手書き・縦書き）の精度が Cloud Vision に大きく劣り、校務文書の実用に耐えない。
- 副次理由: WASM OCR は Cloud Run の CPU/メモリを重く消費し、リクエストレイテンシとコストが悪化。
- 留保: 精度要件が低い限定用途が出れば再評価。egress ゼロの利点は大きい。

### 代替 B: 画像 OCR を Gemini Vision（マルチモーダル LLM）で行う
- 却下理由: 画像（顔・氏名を含む生 PII）を**生成モデル**のコンテキストに渡すことになり、モデルログ・将来学習データへの混入リスクが OCR 専用 API より高い（[ADR-017](017-gemini-ai-structuring-with-confidence.md) がテキストの PII マスキングを必須化した思想と整合させる）。
- 副次理由: OCR は座標付きテキスト抽出で十分で、LLM の生成能力は不要。タスクに対し過剰な権限委譲。

### 代替 C: 文書パースも外部 API（Document AI 等）に委託
- 却下理由: ローカルライブラリで egress なしに完結できる処理を、わざわざ外部委託に格上げする必然性がない（安全側＝送らない、[CLAUDE.md セキュリティ心構え]）。
- 副次理由: 追加の API コスト・レイテンシ・監査対象が増える。

### 代替 D: 抽出を全面的に後回しにし、当面テキスト貼り付けのみ対応
- 却下理由: 教員の実運用（配布プリント・Excel 時間割の取り込み）で文書アップロードの需要が明確。
- 留保: 画像 OCR だけは需要・リスクを見て段階導入も可（決定2のオプトインで実質段階導入になっている）。

## 結果（Consequences）

### 良い影響
- 文書パース（PDF/docx/xlsx）は egress ゼロで、ルール4 の外部委託規律の対象外。実装・監査が軽い。
- 画像 OCR は外部委託と明確に位置づけ、オプトイン + 監査 + 下流マスキングの三段ガードで漏洩面を最小化。
- OCR クライアント DI により、credential なしで全分岐を CI 検証できる（ルール7 のテスト緑を担保しやすい）。
- フェイルクローズ維持で「空抽出が黙って下流へ流れる」事故を構造的に排除。

### 悪い影響 / リスク
- **スキャン PDF**: テキストレイヤのない PDF は pdfjs では空になり、OCR フォールバック（決定2）が必要 → 配線時に分岐を明示実装し、フォールバック時は `ocrUsed=true`。
- **pdfjs-dist の重量**: legacy build は依存が重い。Cloud Run のコールドスタートに影響する場合は `unpdf` 等への差し替えを補足 ADR で検討。
- **Vision API コスト**: 画像ページ単価が発生。オプトインで件数を抑制、[NFR06] のコスト方針に従う。
- **OCR 精度**: Vision でも手書きは誤読しうる。抽出結果は `confidence` を持ち、下流 `structureContent` の confidence_score（[ADR-017](017-gemini-ai-structuring-with-confidence.md)）と合わせて教員レビューの安全網に載せる。

### トレードオフ
- 「精度 vs egress ゼロ」: 文書は egress ゼロを取り、画像 OCR は精度を取って（外部委託を許容しつつガードで縛る）バランス。
- 「実装の手軽さ vs テスタビリティ」: OCR の DI で後者に振った（credential 依存を CI に持ち込まない）。
- 本 ADR は画像 OCR バックエンドを Cloud Vision に固定するが、将来 Document AI / オンデバイスの精度・コストが変われば補足 ADR で再評価可能。
