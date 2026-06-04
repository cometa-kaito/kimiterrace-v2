# staging 環境ルート
# prod と同構成、tier だけ縮小。雛形段階は実体生成なし。

terraform {
  required_version = ">= 1.9.0, < 2.0.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
  }

  backend "gcs" {
    bucket = "signage-v2-tf-state"
    prefix = "envs/staging"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

variable "project_id" {
  description = "GCP project ID"
  type        = string
  default     = "signage-v2-staging"
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "asia-northeast1"
}

variable "repository" {
  description = "GitHub repository in owner/name form. Only OIDC tokens from this repo can impersonate the WIF SAs."
  type        = string
  default     = "cometa-kaito/kimiterrace-v2"
}

locals {
  env = "staging"
  # アプリ DB ユーザー（app）のパスワードを保持する Secret Manager secret ID（ルール5）。
  # 値（パスワード）は人間が `gcloud secrets versions add staging-db-app-password --data-file=-` で投入する。
  # 同じ ID を secret_manager（コンテナ作成）と cloud_sql（data source で参照）の両方に渡す。
  db_app_password_secret_id = "staging-db-app-password"
}

module "network" {
  source            = "../../modules/network"
  project_id        = var.project_id
  region            = var.region
  env               = local.env
  enabled           = true
  psa_range_address = "10.60.0.0" # connector_cidr 10.8.0.0/28 と非重複（PR #493 enable-time 対応）
}

# Cloud SQL for PostgreSQL 16 + pgvector（ADR-001 / ADR-007）。
# staging は private IP only + SSL 強制 + pgvector + 自動バックアップ/PITR + ZONAL（HA は prod のみ）。
# private IP は network の PSA peering 上に割り当てられるため、network_id と private_services_ready を配線し
# peering -> instance の順序を強制する（private_services_ready が false なら plan 時 fail-fast）。
# DB ユーザー（google_sql_user.app）は Secret Manager 配備後に別ステップで有効化（現状 module 側 count=0）。
module "cloud_sql" {
  source                 = "../../modules/cloud_sql"
  project_id             = var.project_id
  region                 = var.region
  env                    = local.env
  enabled                = true
  tier                   = "db-custom-1-3840"
  availability_type      = "ZONAL"                               # staging は HA 不要（prod のみ REGIONAL）
  deletion_protection    = false                                 # staging も recreate 容易性優先（Issue #70）
  vpc_network_id         = module.network.network_id             # private IP を割り当てる VPC
  private_services_ready = module.network.private_services_ready # PSA peering 実在 signal（順序強制）

  # アプリ DB ユーザー（app）のパスワード secret（secret_manager が作成・人間が値を投入）。
  # 2-phase apply: ① -target=module.secret_manager で secret コンテナ作成 → ② 人間が値投入 → ③ full apply で user 作成。
  # secret 値未投入の状態で full apply すると data source が読めず失敗するため、必ず ②→③ の順で進める。
  app_db_password_secret_id = local.db_app_password_secret_id
}

# Secret Manager（ルール5）。staging はまずアプリ DB ユーザーのパスワード secret コンテナを作る。
# Terraform はコンテナのみ作成し、値（パスワード）は人間が投入する:
#   gcloud secrets versions add staging-db-app-password --data-file=- --project=signage-v2-staging
# accessor SA は Cloud Run runtime SA 生成後（cloud_run enabled 化時）に配線する。現状の DB user 作成・
# migration は人間 ADC / Cloud SQL proxy 経由で読むため accessor 不要。DATABASE_URL 等の secret は導入時に追加。
module "secret_manager" {
  source     = "../../modules/secret_manager"
  project_id = var.project_id
  env        = local.env
  enabled    = true
  secrets = {
    (local.db_app_password_secret_id) = {
      description = "Cloud SQL アプリ DB ユーザー（app）のパスワード。値は人間が投入（ルール5・Terraform は値を扱わない）。"
    }
  }
}

module "identity_platform" {
  source     = "../../modules/identity_platform"
  project_id = var.project_id
  env        = local.env
  enabled    = false
}

module "cloud_run" {
  source     = "../../modules/cloud_run"
  project_id = var.project_id
  region     = var.region
  env        = local.env
  enabled    = false
}

# F06 embedding バッチの Cloud Run Job + Scheduler（#416）。雛形段階は enabled = false。
module "cloud_run_job" {
  source              = "../../modules/cloud_run_job"
  project_id          = var.project_id
  region              = var.region
  env                 = local.env
  enabled             = false
  deletion_protection = false # staging は recreate 容易性優先（Issue #70）
}

# F14 天気取得 Cloud Run Job + Scheduler + egress（#128, ADR-021）。雛形段階は enabled = false。
# enabled 化時: image / vpc_connector(network) / database_url_secret_id(secret_manager) を設定。
# 外部 egress(JMA) は本 Job 経路のみ（閉域原則）。external_egress_ready で network の Cloud NAT 実在を強制
# （NAT 無しで enabled=true にすると plan が fail-fast）。Sentry を使うなら sentry_dsn_secret_id を設定（ADR-013）。
module "cloud_run_job_weather" {
  source                = "../../modules/cloud_run_job_weather"
  project_id            = var.project_id
  region                = var.region
  env                   = local.env
  enabled               = false
  deletion_protection   = false                       # staging は recreate 容易性優先（Issue #70）
  external_egress_ready = module.network.egress_ready # network の Cloud NAT 実在 signal（ADR-021）
}

# Cloud Logging 閲覧の最小権限 IAM（ADR-029 / #439）。
# 公開ルート（magic-link / webhook）の秘匿値が載る request log の閲覧を運用者へ限定する。
# enabled 化時に var.log_viewer_members（運用者グループ + breakglass）を設定すること。
module "logging_iam" {
  source     = "../../modules/logging_iam"
  project_id = var.project_id
  env        = local.env
  enabled    = false # TODO(Phase 開発): true + log_viewer_members を設定
}

# 月次レポート PDF の Cloud Storage バケット（F09 / #430）。90 日後コールド移送。
# staging は recreate 容易性優先で force_destroy=true（Issue #70 同規律）。
# writer_service_account に reports Job runtime SA を渡し、当該バケット限定で objectAdmin を付与（ルール5 最小権限）。
# 雛形段階は両モジュール enabled=false ＝ SA 未生成（output null）→ "" にフォールバックして付与なし。
module "report_storage" {
  source                 = "../../modules/report_storage"
  project_id             = var.project_id
  env                    = local.env
  enabled                = false # TODO(Phase 開発)
  force_destroy          = true
  writer_service_account = module.cloud_run_job_reports.runtime_service_account_email != null ? module.cloud_run_job_reports.runtime_service_account_email : ""
}

# F09 月次レポート生成 Cloud Run Job + Scheduler（#430, #45）。雛形段階は enabled = false。
# enabled 化時: image / vpc_connector(network) / database_url_secret_id(secret_manager) /
#   report_bucket(report_storage.bucket_name) を設定。外部 egress は不要（Cloud SQL + GCS のみ、embedding と同設計）。
# Scheduler は月初 04:00 JST（前月分を生成）。runtime SA の email は report_storage.writer_service_account に配線済。
module "cloud_run_job_reports" {
  source              = "../../modules/cloud_run_job_reports"
  project_id          = var.project_id
  region              = var.region
  env                 = local.env
  enabled             = false
  deletion_protection = false # staging は recreate 容易性優先（Issue #70）
  report_bucket       = module.report_storage.bucket_name
}

# 教員アップロード素材の Cloud Storage バケット（F01 / #509 / #37, ADR-024）。90 日後コールド移送。
# staging は recreate 容易性優先で force_destroy=true（Issue #70 同規律）。
# enabled 化時に upload 受口 runtime SA を writer_service_account に設定し、Cloud Run の env に
# 出力 bucket_name を渡す。生徒 PII 素材のため CMEK 推奨（kms_key_name に KMS key を設定）。
module "upload_storage" {
  source        = "../../modules/upload_storage"
  project_id    = var.project_id
  env           = local.env
  enabled       = false # TODO(Phase 開発)
  force_destroy = true
}

module "workload_identity_federation" {
  source = "../../modules/workload_identity_federation"

  project_id = var.project_id
  repository = var.repository
  env_name   = local.env
}

output "wif_provider_name" {
  description = "Pass to GitHub Actions vars as WIF_PROVIDER."
  value       = module.workload_identity_federation.provider_name
}

output "wif_deploy_sa_email" {
  description = "Pass to GitHub Actions vars as WIF_SA_DEPLOY."
  value       = module.workload_identity_federation.deploy_sa_email
}

output "wif_plan_sa_email" {
  description = "Pass to GitHub Actions vars as WIF_SA_PLAN."
  value       = module.workload_identity_federation.plan_sa_email
}
