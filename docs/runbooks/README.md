# Runbooks

運用手順書。緊急時に**読みながら手を動かせる**粒度で書く。

## 構成

- `deployment.md` — 通常デプロイ手順
- `rollback.md` — 切り戻し手順
- `data-migration.md` — Firestore → PostgreSQL データ移行
- `cutover.md` — 本番切替（DNS切替含む）
- `incident-response.md` — 障害対応フロー
- `disaster-recovery.md` — 災害復旧（リージョン障害等）
- `secret-rotation.md` — シークレットローテーション
- `backup-restore.md` — バックアップと復元
- `oncall.md` — オンコール手順

## 書き方

1. 前提（誰が、いつ実行する）
2. 必要な権限
3. 手順（コピペで動くコマンド）
4. 検証（成功確認方法）
5. 失敗時の対処
6. 関連
