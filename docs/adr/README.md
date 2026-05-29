# Architecture Decision Records (ADR)

技術判断の記録。**「なぜこれを選んだか」を後から読めるようにする**ためのもの。

## フォーマット

各 ADR は 1 ファイル、命名は `NNN-short-title.md`。

```markdown
# ADR-NNN: 短いタイトル

- 状態: Proposed / Accepted / Superseded by ADR-MMM / Deprecated
- 日付: YYYY-MM-DD
- 関連: #issue, ADR-XXX

## 文脈
何が課題で、どんな選択肢があったか。

## 決定
何を選んだか。1〜2文で明確に。

## 検討した代替案
- 代替A: なぜ却下したか
- 代替B: なぜ却下したか

## 結果（Consequences）
良い影響、悪い影響、トレードオフ。
```

## 索引

| ID | タイトル | 状態 |
|---|---|---|
| 001 | PostgreSQL を採用、Firestore を捨てる | Proposed |
| 002 | Cloud Run を採用、Functions を捨てる | Proposed |
| 003 | Identity Platform を採用、Firebase Auth は移行 | Proposed |
| 004 | Drizzle ORM を採用、Prisma を却下 | Proposed |
| 005 | Vertex AI Gemini を採用、データ越境回避 | Proposed |
| 006 | Vercel AI SDK でストリーミング UI | Proposed |
| 007 | pgvector を採用、外部ベクトル DB 不採用 | Proposed |
| 008 | API は Next.js Route Handlers に統合、Hono 非採用 | Proposed |
| 009 | Terraform を採用、Pulumi 不採用 | Proposed |
| 010 | pnpm + Turborepo モノレポ | Proposed |
| 011 | Biome を採用、ESLint + Prettier 不採用 | Proposed |
| 012 | テストは Vitest + Playwright + Testcontainers | Proposed |
| 013 | エラー追跡は Sentry | Proposed |
| 014 | 観測は Cloud Logging + Cloud Trace + OTel | Proposed |
| 015 | [即公開 + 安全網 4 種](015-instant-publish-with-safety-nets.md)（承認フロー非採用） | Proposed |
| 016 | [クラス magic link 匿名アクセス](016-class-magic-link-anonymous-access.md)（個別アカウント非採用） | Proposed |
| 017 | [Gemini で AI 構造化 + confidence_score 必須化](017-gemini-ai-structuring-with-confidence.md) | Proposed |
| 018 | [CRM 機能の独自設計](018-custom-crm-design.md)（既存 SaaS 連携非採用） | Proposed |
| 019 | [RLS 二層分離](019-rls-two-layer-tenant-isolation.md)（school_id テナント + system_admin cross-tenant） | Proposed |
| 020 | [来場検知は SwitchBot Webhook + Cloud SQL](020-presence-sensor-switchbot-webhook.md)（自作 LiDAR 案を deprecate） | Proposed |

## ルール

- 既存 ADR は**書き換えない**。方針変更時は新 ADR を書き、旧 ADR を Superseded にする
- ドラフト段階は Proposed、レビュー後に Accepted
- 退役する技術は Deprecated
- 必ずトレードオフを書く。「良いこと」だけの ADR は信用されない
