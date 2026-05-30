# キミテラス v2

学校サイネージ・校務 DX プラットフォーム（GCP ネイティブ版）

旧 [キミテラス](../キミテラス/)（Firebase 構成）からの**全改修版**。
公立高校相手の運用を見据え、ISMAP 準拠コンポーネント・日本リージョン完結・PostgreSQL ベースの監査可能性を備える。

---

## ステータス

**現在**: W0 準備フェーズ（要件・設計・スキーマ初稿）

詳細は [docs/STATUS.md](docs/STATUS.md) と [docs/ROADMAP.md](docs/ROADMAP.md) を参照。

---

## 開発を始める

### 前提

- Node.js 22+
- pnpm 11+
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
├── apps/                  # アプリ群 (web / firmware / jobs)
├── packages/              # 共有パッケージ (db / shared-types / ui / ai)
├── infrastructure/        # Terraform + Docker
├── scripts/               # 移行・seed スクリプト
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
