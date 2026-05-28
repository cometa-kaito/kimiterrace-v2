# GCP プロジェクト signage-v2-prod セットアップ完了

セットアップ日: 2026-05-28

## プロジェクト情報

| 項目 | 値 |
|---|---|
| プロジェクト ID | `signage-v2-prod` |
| プロジェクト番号 | `1003674206308` |
| 課金アカウント | `0135CE-295E34-85F22E` |
| オーナー | `20051215kaito@gmail.com` |
| デフォルトリージョン | `asia-northeast1` |

## 有効化済み API

### 必須（W1 以降で使う）

- `run.googleapis.com` — Cloud Run
- `sqladmin.googleapis.com` — Cloud SQL
- `identitytoolkit.googleapis.com` — Identity Platform
- `aiplatform.googleapis.com` — Vertex AI Gemini
- `secretmanager.googleapis.com` — シークレット管理
- `cloudbuild.googleapis.com` — Cloud Build
- `artifactregistry.googleapis.com` — Docker イメージ管理
- `iam.googleapis.com` — IAM
- `cloudresourcemanager.googleapis.com` — プロジェクト管理
- `vpcaccess.googleapis.com` — VPC アクセス
- `servicenetworking.googleapis.com` — Private Service Connect
- `compute.googleapis.com` — Compute Engine / VPC

### 監視・分析

- `logging.googleapis.com`
- `monitoring.googleapis.com`
- `cloudtrace.googleapis.com`
- `bigquery.googleapis.com` （後続: 分析・MEXT報告）
- `pubsub.googleapis.com` （後続: イベント駆動）

### ストレージ

- `storage.googleapis.com`
- `storage-api.googleapis.com`
- `storage-component.googleapis.com`

## ローカル CLI 設定

```bash
# 既に実行済み
gcloud config set project signage-v2-prod
gcloud auth login    # 20051215kaito@gmail.com

# Application Default Credentials（Terraform / SDK 用）
gcloud auth application-default login
```

## TODO（次フェーズ）

- [ ] **予算アラート設定**: 月5,000円で警告、月20,000円で緊急通知
  - Console: https://console.cloud.google.com/billing/0135CE-295E34-85F22E/budgets
- [ ] **PATH 環境変数**: gcloud / terraform を新規シェルで使えるように
  - gcloud: `C:\Users\20051\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin`
  - terraform: `C:\tools\terraform`
- [ ] **Workload Identity Federation 設定**: GitHub Actions から GCP デプロイ用（W1）
- [ ] **VPC 構築**: Cloud Run と Cloud SQL のプライベート接続（W1）
- [ ] **Cloud SQL インスタンス作成**: PostgreSQL 16 + pgvector（W1）

## 関連

- Issue: [#20](https://github.com/cometa-kaito/kimiterrace-v2/issues/20)
- Terraform 雛形は W1 で作成
