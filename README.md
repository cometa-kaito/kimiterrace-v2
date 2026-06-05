# キミテラス v2

学校サイネージ・校務 DX プラットフォーム（GCP ネイティブ版）

旧 [キミテラス](../キミテラス/)（Firebase 構成）からの**全改修版**。
公立高校相手の運用を見据え、ISMAP 準拠コンポーネント・日本リージョン完結・PostgreSQL ベースの監査可能性を備える。

---

## ステータス

**現在**: Phase 検証（Verification）進行中 — 全 16 機能（F01–F16）の実装が完了し、staging 環境で稼働中。

- **開発**: 全 16 機能（F01–F16）の実装完了。
- **インフラ**: staging フル稼働（VPC + Cloud SQL〔PostgreSQL 16 + pgvector〕+ Identity Platform + Cloud Run web）。すべて Terraform 管理（Cloud Run は scale-to-zero）。
- **AI**: Vertex AI Gemini を staging で有効化済み（PII マスキング・`AI_ENABLED` kill-switch・全 LLM 呼び出し監査・asia-northeast1 完結）。実 Vertex で認証 E2E まで裏取り済み。
- **検証**: セキュリティ敵対テスト・DAST（ZAP baseline）・移行 dry-run を実施済み。残りは staging ゲートの検証トラックと受入テスト。
- **次**: 検証フェーズの残トラック → go/no-go → 導入（人間担当）。

ロードマップは **5 Phase 構成（調査 → 設計 → 開発 → 検証 → 導入）**。Claude は調査〜検証を全力で進め、導入は人間が担当する。

詳細は [docs/STATUS.md](docs/STATUS.md) と [docs/ROADMAP.md](docs/ROADMAP.md) を参照。

---

## 主な機能（F01–F16）

掲示物の入稿から AI 構造化・公開・効果測定・端末運用までを一気通貫で扱う。

| 領域 | 機能 |
|---|---|
| 入稿・構造化 | F01 教員ファイル抽出 / F02 教員音声チャット入力 / F03 AI 構造化 / F04 即時公開セーフティネット |
| 配信・対話 | F05 クラス別マジックリンク / F06 生徒向け Q&A チャットボット / F12 v1 機能移植 |
| 計測・運用 | F07 イベントログ / F08 効果ダッシュボード / F09 月次レポート / F10 CRM / F11 ロール管理 |
| サイネージ端末 | F13 在室センサ Webhook / F14 天気予報サイネージ / F15 TV デバイス管理 / F16 TV 死活監視 |

各機能の要件は [docs/requirements/functional/](docs/requirements/functional/) を参照。

---

## 開発を始める

### 前提

- Node.js 22+
- pnpm 10+（`packageManager` は 11.4.0 を固定）
- Docker Desktop（ローカル PostgreSQL 用）
- gcloud SDK（GCP デプロイ時）
- Terraform（インフラ管理）

### セットアップ

```bash
pnpm install
```

### ローカル開発を始める

ローカル DB（PostgreSQL 16 + pgvector）はコンテナで提供する。Cloud SQL と同等の image を使う。

```bash
# 1. PostgreSQL 起動 + pgvector 拡張有効化 + .env 生成（初回のみ）
./scripts/dev-setup.sh

# 2. 接続確認
psql "$DATABASE_URL" -c "SELECT extversion FROM pg_extension WHERE extname = 'vector';"
```

手動で起動・停止する場合:

```bash
docker compose -f infrastructure/docker/docker-compose.dev.yml up -d   # 起動
docker compose -f infrastructure/docker/docker-compose.dev.yml down    # 停止
docker compose -f infrastructure/docker/docker-compose.dev.yml down -v # データ破棄
```

接続情報は [.env.example](.env.example) を参照。`.env` はコミットしない（[CLAUDE.md ルール5](CLAUDE.md)）。

### よく使うコマンド

```bash
pnpm dev          # 開発サーバー起動
pnpm test         # テスト実行
pnpm typecheck    # TypeScript 型チェック
pnpm lint         # Biome lint
pnpm format       # Biome format
pnpm build        # ビルド
```

---

## 開発規律

このプロジェクトは **公立校の生徒データ** を扱う。
動けばいい開発は許容しない。詳細は [CLAUDE.md](CLAUDE.md) を必ず読むこと。

主要ルール:

1. 全テーブルに監査カラム
2. PostgreSQL RLS を必ず有効化
3. Drizzle スキーマを真実の単一ソースに
4. PII の Vertex AI 送信前マスキング
5. シークレットは Secret Manager のみ
6. 1 PR = 1 機能、500 行目安
7. テストが落ちている状態で次に進まない
8. Terraform 外のインフラ変更禁止

---

## ディレクトリ構成

```
.
├── apps/                  # アプリ群 (web: Next.js / jobs: Cloud Run Jobs バッチ)
├── packages/              # 共有パッケージ (db: Drizzle / ai: Vertex+RAG / observability)
├── infrastructure/        # Terraform + Docker
├── scripts/               # 移行・seed・orchestrator スクリプト
├── docs/                  # 要件・設計・ADR・runbook
└── .github/               # CI/CD・テンプレ
```

---

## Claude Code で開発する

このリポジトリは Claude Code による長期協働を前提に設計されている。

- 新セッション開始時は必ず [CLAUDE.md](CLAUDE.md) と [docs/STATUS.md](docs/STATUS.md) を読む
- タスクは GitHub Issues で管理
- 大きな技術判断は [docs/adr/](docs/adr/) に記録
- セッション終了時に STATUS.md を更新

---

## ライセンス

Proprietary. All rights reserved.
