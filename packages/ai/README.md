# @kimiterrace/ai

Vertex AI Gemini + RAG ロジック。本パッケージの第一責務は **LLM 送信前の PII マスキング**
（[CLAUDE.md ルール4](../../CLAUDE.md)）。LLM への送信は「事実上の外部委託」とみなし、
生徒・保護者・職員の PII をモデルログ/キャッシュ/将来の学習データに残さないため、
送信前に必ずトークン化する。

## PII マスキング (`src/pii/`)

```ts
import { maskPII, unmaskPII, findUnmaskedPii } from "@kimiterrace/ai";

// 1. school_id でスコープした名簿から PII エントリを組む（呼び出し側 = ハンドラの責務）
const entries = [
  { value: "田中太郎", category: "STUDENT", aliases: ["田中 太郎"] },
];

// 2. 送信前にマスク
const { masked, dictionary } = maskPII("田中太郎さんは欠席 090-1234-5678", entries);
// masked = "{{STUDENT_001}}さんは欠席 {{PHONE_001}}"

// 3. fail-closed 検証（残存があれば中断する — ルール4）
if (findUnmaskedPii(masked, entries).length > 0) throw new Error("PII masking failed");

// 4. Gemini へ `masked` を送信 → 応答を逆変換
const restored = unmaskPII(geminiResponseText, dictionary);
```

### 設計方針

- **名簿駆動**: 氏名・住所など曖昧な PII は確率的 NER に頼らず、`school_id` でスコープした
  DB 名簿を呼び出し側が `PiiEntry[]` として渡す。決定論的でテスト可能。
- **パターン検出**: 名簿外の電話・メールは正規表現で補完（既定 ON、`MaskOptions` で無効化可）。
- **長い表層形を先に置換**: "田中太郎" を "田中" より先に処理し取りこぼしを防ぐ。
- **fail-closed**: `findUnmaskedPii` が残存を返したらハンドラはリクエストを中断する。

トークン書式は `{{CATEGORY_NNN}}`（例 `{{STUDENT_001}}`）。逆変換は別名も正規表記
（`value`）に正規化する。

## AI 構造化抽出 (`src/structure.ts` ほか, F03 / ADR-017)

自由入力を Gemini で構造化 JSON 化するオーケストレータ。パイプライン:
PII マスキング → SHA-256 ハッシュ → インジェクション境界付きプロンプト → 生成 →
JSON parse + Zod validate（失敗時 **最大 2 回リトライ**）→ トークン逆変換。

```ts
import { structureContent, createVertexModelClient, toAiExtractionInsert } from "@kimiterrace/ai";

const model = createVertexModelClient({ project, location: "asia-northeast1" }); // ADR-005/006
const result = await structureContent({
  kind: "announcement",
  input: "田中太郎さんは欠席",
  piiEntries,                       // 名簿（PII マスキングに使用）
  model,
  rateLimiter, schoolId,            // NFR06: 60 req / 60s / school
});
// 呼び出し側が withTenantContext 内で ai_extractions へ INSERT（RLS 強制・ルール2）
const row = toAiExtractionInsert({ schoolId, actorUserId, result });
```

- **モデル**: Gemini Pro 固定・バージョンピン（ADR-017、認証は ADC / Workload Identity・ルール5）。
- **confidence_score**: 構造化 JSON の必須フィールド（ADR-017、F04.3 確信度フラグが依存）。
- **インジェクション対策**: ユーザー入力を `<teacher_input>` で分離し山括弧を無害化（system 上書き不可）。
- **監査**: 生プロンプト/応答は保存せず、マスク後入力の SHA-256・トークン数・確信度・モデル版を記録。

### 本パッケージで今後追加予定

- DB 配線（apps/web Server Action / Cloud Run Job からの `ai_extractions` INSERT）と Vertex 実呼び出しの結合テスト
- 分散レート制限（複数インスタンス用の共有ストア）
- RAG（pgvector）ロジック（F06）
