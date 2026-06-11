# Runbooks

運用手順書。緊急時に**読みながら手を動かせる**粒度で書く。

## 構成

- **`web-deploy.md` — web の日常コードデプロイ手順（routine code deploy）。新セッションでデプロイを頼まれたらまずこれ。実体は `scripts/deploy/deploy-web.sh`**
- `rollback.md` — 切り戻し手順（web の戻しは web-deploy.md「ロールバック」に集約）
- `data-migration.md` — Firestore → PostgreSQL データ移行
- `db-migrations.md` — DB スキーマ/RLS マイグレーション適用（SECURITY DEFINER オーナー固定）
- `dependency-upgrades.md` — dependabot bump の安全な取り込み（minimumReleaseAge / チョークポイント / 統合）
- `staging-bringup.md` — staging 環境のゼロからの構築（Terraform enabled 化 / 2 段 apply）
- `cutover.md` — 本番切替（DNS切替含む）
- `prod-bringup-cutover.md` — 本番(prod)構築 + 岐南工業 実機TV の LP→v2 cutover（端末操作ゼロ）の機械的チェックリスト
- `incident-response.md` — 障害対応フロー
- `disaster-recovery.md` — 災害復旧（リージョン障害等）
- `secret-rotation.md` — シークレットローテーション
- `backup-restore.md` — バックアップと復元
- `oncall.md` — オンコール手順
- `orchestrator-pipeline-pattern.md` — Desktop Claude を idle にしない並列 spawn パターン

## 書き方

1. 前提（誰が、いつ実行する）
2. 必要な権限
3. 手順（コピペで動くコマンド）
4. 検証（成功確認方法）
5. 失敗時の対処
6. 関連
