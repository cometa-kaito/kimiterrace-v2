# ADR-017: AI 構造化への Gemini 採用（confidence_score 必須化）

- 状態: Accepted（2026-06-01 ユーザーレビューで Proposed → Accepted）
- 日付: 2026-05-28
- 関連: [#12](https://github.com/cometa-kaito/kimiterrace-v2/issues/12), [F03](../requirements/functional/F03-ai-structuring.md), [F06](../requirements/functional/F06-student-qa.md), [ADR-005 (Vertex AI 採用)](005-vertex-ai.md), [ADR-006 (Vercel AI SDK)](006-vercel-ai-sdk.md)

## 文脈

[ADR-005](005-vertex-ai.md) で Vertex AI を採用済だが、本 ADR では:

1. 具体的なモデル選定（Gemini Pro / Flash / Ultra 等）
2. 構造化出力の品質保証メカニズム
3. F04.3 安全網（[ADR-015](015-instant-publish-with-safety-nets.md)）が依存する `confidence_score` の生成方針

を確定する。

### 候補モデル

| モデル | 強み | 弱み |
|---|---|---|
| Gemini Pro | バランス、JSON モード対応、asia-northeast1 |   |
| Gemini Flash | 高速・低コスト | 複雑な構造化タスクで精度不足 |
| Gemini Ultra | 最高精度 | コスト高、生徒対話の頻度に合わない |

### 構造化出力品質

LLM の JSON 出力は破綻するケースが避けられない。受け側の対応として:
- スキーマ validate + リトライ
- function calling / tool use
- structured output mode (Gemini の native JSON mode)

### confidence_score の入手

LLM 自身に confidence を出力させる方式と、間接指標（logprobs 等）から推定する方式がある。

## 決定

1. **モデル: Gemini Pro 固定 (MVP)**。Flash/Pro 自動切替は Phase 2 送り
2. **構造化出力**: Gemini の native JSON mode + Zod validate + 最大 2 回リトライ
3. **confidence_score**: LLM 自身に **0.0〜1.0 の自己評価値**を構造化 JSON の必須フィールドとして出力させる
4. **根拠引用**: 抽出結果に対応するソース文字列を `evidence` フィールドで返させる（[F04.3 AI 確信度フラグ](../requirements/functional/F04-instant-publish-safety-nets.md) の UI 表示で利用）
5. **PII マスキング**: 送信前/応答後でトークン変換（[CLAUDE.md ルール 4](../../CLAUDE.md), [v2-mvp.md §9](../requirements/v2-mvp.md)）
6. **rate limit**: school_id あたり 1 分 60 リクエスト（[F03](../requirements/functional/F03-ai-structuring.md), [NFR06](../requirements/non-functional/NFR06-cost-policy.md)）

## 検討した代替案

### 代替 A: Claude on Vertex AI / Bedrock
- 却下理由: GCP プロジェクト統合が Gemini ほどシームレスでない（Workload Identity・監査ログ・モデル管理の統合度）
- 副次理由: データ越境（Bedrock は US リージョン）回避の手間が増える
- 留保: 将来 Vertex AI で Claude が日本リージョン提供された段階で再評価

### 代替 B: GPT-4 on Azure OpenAI
- 却下理由: スタックを GCP に統一する方針（[memory: project_kimiterrace_stack](../../.claude/projects/.../memory/project_kimiterrace_stack.md)）と矛盾
- 副次理由: マルチクラウド運用の監査コストが増える

### 代替 C: OpenAI 直接 API
- 却下理由: PII を US 法域に送信することになり、[NFR07 コンプライアンス](../requirements/non-functional/NFR07-compliance.md) のデータ越境回避と矛盾
- 副次理由: 学習データへの混入リスク（opt-out 設定が必要）

### 代替 D: Flash 主体 + Pro へエスカレーション
- 却下理由: 教員の入力品質バラつきで Flash 失敗ケースが頻発し、エスカレーション判定のロジックが複雑化
- 副次理由: MVP では精度優先、コスト天井は意図的に設けない方針（[STATUS.md](../STATUS.md)）と整合

### 代替 E: confidence_score を logprobs から推定
- 却下理由: Gemini API では token-level logprobs が安定的に取得できない
- 副次理由: 「LLM 自己評価値」の方が説明可能性が高い（教員に「AI がこう判定した」と提示できる）

### 代替 F: 構造化出力に function calling
- 却下理由: Gemini の function calling は JSON mode より制約が多く、追加の複雑性に対する利得が薄い
- 副次理由: 構造化が Zod スキーマで完結する方が、フロントエンド型生成（[CLAUDE.md ルール 3](../../CLAUDE.md)）と整合する

## 結果（Consequences）

### 良い影響

- GCP 内完結でデータ越境ゼロ、監査ログ統合
- Gemini Pro の精度で F03 / F06 双方の品質を担保
- confidence_score を必須化したことで F04.3 (確信度フラグ) の安全網が機能可能
- evidence 引用により AI 出力の説明可能性が向上、教員レビューの負荷低減
- Zod スキーマ → Drizzle → API 型の自動生成チェーンが [ADR-004](004-drizzle-vs-prisma.md) と整合

### 悪い影響 / リスク

- **モデルバージョンアップ時の互換性**: Gemini Pro のバージョン変更で出力形式が揺れる可能性 → モデル名にバージョン固定 (`gemini-pro-002` 等) し、アップグレードは ADR 補足で記録
- **confidence_score の信頼性**: LLM 自己評価は過信/過小評価の系統的バイアスを持つ可能性 → ベータ運用で実測し、しきい値 0.7 を調整
- **コスト膨張**: Pro 固定はトークン単価が Flash より高い。ただし [NFR06](../requirements/non-functional/NFR06-cost-policy.md) で天井なし方針のため当面は許容
- **JSON mode のリトライ最大 2 回**: 3 回目で失敗する稀ケースで教員が再入力する必要 → UI でエラーメッセージを丁寧に

### トレードオフ

- 「精度 vs コスト」のうち **精度** に振った設計（MVP）
- 「自己評価 vs 客観評価」のうち **自己評価** に振った設計（説明可能性優先）
- 「マルチプロバイダ柔軟性 vs スタック単一化」のうち **単一化** に振った設計（運用負荷優先）
- 将来 Claude/GPT が日本リージョンで GCP 統合された場合、本 ADR を Superseded として再評価可能

## 更新 (2026-06-05): モデルピン更新 `gemini-1.5-pro-002` → `gemini-2.5-flash`（リスク欄「アップグレードは ADR 補足で記録」の実行）

#289（実 Vertex 有効化）の staging 実呼び出し検証で、**決定1 の旧ピン `gemini-1.5-pro-002` が Vertex から
retired**（asia-northeast1 で `generateContent` が 404 "model was not found"）であることを確認した。ユニット
テストはモデルを mock するため露見せず、実 Vertex 結合（`vertex-live.test.ts`）で初めて検知。

- **新ピン: `gemini-2.5-flash`**（chat/生成/効果コメント。`packages/ai` の 3 クライアント DEFAULT_MODEL_ID）。
  embedding は `gemini-embedding-001` のまま現行（retired でない）。可用性は 2026-06-05 に実呼び出しで確認
  （`gemini-2.5-flash`/`gemini-2.5-pro` = 200、`gemini-1.5-pro-002`/`gemini-2.0-flash-001` = 404）。
- **tier 変更 Pro → Flash（決定1 の更新・ユーザー判断 2026-06-05）**: 用途は掲示物 Q&A（F06）/ 構造化抽出
  （F03）/ 効果コメント（F08）で複雑推論を要さず、Flash の精度で十分。学校無料サービスのコスト適性を優先し、
  本 ADR の「精度に振った（Pro 固定）」tradeoff を **コスト寄りに調整**（代替 D「Flash 主体」の趣旨を一部採用。
  ただし自動エスカレーションは依然不採用）。`confidence_score` 必須・native JSON mode・Zod validate・最大2
  リトライ（決定2/3）は不変。
- **2.5 系の thinking トークン**: gemini-2.5 系は既定で thinking を行い出力トークン予算を消費する。3 クライアント
  はいずれも `maxOutputTokens` を設定しない（生成は必要分だけ）ため **truncation は起きない**。thinking budget
  の最適化（レイテンシ/コスト・特に F06 SSE の time-to-first-token、`thinkingConfig` 調整）は follow-up とする。
- **モデル名のハードコード**: 現状 DEFAULT_MODEL_ID は定数。将来の retired 再発時に image 再ビルドを避けるため、
  モデル ID の env 化（`VERTEX_MODEL_ID`）は follow-up 候補。
