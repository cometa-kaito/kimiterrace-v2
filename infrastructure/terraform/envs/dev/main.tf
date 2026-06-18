# dev 環境ルート
# ローカル開発に近い設定。Cloud SQL は基本使わず docker-compose で代替（README 参照）。
# 雛形段階は実体生成なし。

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
    prefix = "envs/dev"
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
  default     = "signage-v2-dev"
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
  env = "dev"
}

# dev では VPC は最小限。Cloud SQL は docker-compose で代替するので enabled = false 継続。
module "network" {
  source     = "../../modules/network"
  project_id = var.project_id
  region     = var.region
  env        = local.env
  enabled    = false
}

module "cloud_sql" {
  source              = "../../modules/cloud_sql"
  project_id          = var.project_id
  region              = var.region
  env                 = local.env
  enabled             = false # dev は docker-compose で代替（infrastructure/docker/ 参照）
  tier                = "db-f1-micro"
  deletion_protection = false # dev は recreate 容易性優先（Issue #70）
}

module "secret_manager" {
  source     = "../../modules/secret_manager"
  project_id = var.project_id
  env        = local.env
  enabled    = false
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

# F06 embedding バッチの Cloud Run Job + Scheduler（#416）。dev は通常起動しない。
module "cloud_run_job" {
  source              = "../../modules/cloud_run_job"
  project_id          = var.project_id
  region              = var.region
  env                 = local.env
  enabled             = false
  deletion_protection = false # dev は recreate 容易性優先（Issue #70）
}

# F14 天気取得 Cloud Run Job + Scheduler + egress（#128, ADR-021）。dev は通常起動しない。
# enabled 化時: image / vpc_connector(network) / database_url_secret_id(secret_manager) を設定。
# 外部 egress(JMA) は本 Job 経路のみ（閉域原則）。external_egress_ready で network の Cloud NAT 実在を強制
# （NAT 無しで enabled=true にすると plan が fail-fast）。Sentry を使うなら sentry_dsn_secret_id を設定（ADR-013）。
module "cloud_run_job_weather" {
  source                = "../../modules/cloud_run_job_weather"
  project_id            = var.project_id
  region                = var.region
  env                   = local.env
  enabled               = false
  deletion_protection   = false                       # dev は recreate 容易性優先（Issue #70）
  external_egress_ready = module.network.egress_ready # network の Cloud NAT 実在 signal（ADR-021）
}

# パターン2 鉄道運行情報取得 Job（名鉄スクレイピング、ADR-035）。dev は scaffold。
module "cloud_run_job_railway_status" {
  source                = "../../modules/cloud_run_job_railway_status"
  project_id            = var.project_id
  region                = var.region
  env                   = local.env
  enabled               = false
  deletion_protection   = false
  external_egress_ready = module.network.egress_ready # network の Cloud NAT 実在 signal（ADR-035）
}

# pattern2/3 サイネージ工学ニュース取得 Job（政府系 / JST の公開 RSS、ADR-043）。dev は scaffold。
module "cloud_run_job_news" {
  source                = "../../modules/cloud_run_job_news"
  project_id            = var.project_id
  region                = var.region
  env                   = local.env
  enabled               = false
  deletion_protection   = false
  external_egress_ready = module.network.egress_ready # network の Cloud NAT 実在 signal（ADR-043）
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
# dev は recreate 容易性優先で force_destroy=true（Issue #70 同規律）。
# writer_service_account に reports Job runtime SA を渡し、当該バケット限定で objectAdmin を付与（ルール5 最小権限）。
# 雛形段階は両モジュール enabled=false ＝ SA 未生成（output null）→ "" にフォールバックして付与なし。
module "report_storage" {
  source                 = "../../modules/report_storage"
  project_id             = var.project_id
  env                    = local.env
  enabled                = false # TODO(Phase 開発)
  force_destroy          = true
  writer_service_account = coalesce(module.cloud_run_job_reports.runtime_service_account_email, "")
}

# F09 月次レポート生成 Cloud Run Job + Scheduler（#430, #45）。dev は通常起動しない。
# enabled 化時: image / vpc_connector(network) / database_url_secret_id(secret_manager) /
#   report_bucket(report_storage.bucket_name) を設定。外部 egress は不要（Cloud SQL + GCS のみ、embedding と同設計）。
# Scheduler は月初 04:00 JST（前月分を生成）。runtime SA の email は report_storage.writer_service_account に配線済。
module "cloud_run_job_reports" {
  source              = "../../modules/cloud_run_job_reports"
  project_id          = var.project_id
  region              = var.region
  env                 = local.env
  enabled             = false
  deletion_protection = false # dev は recreate 容易性優先（Issue #70）
  report_bucket       = module.report_storage.bucket_name
}

# 教員アップロード素材の Cloud Storage バケット（F01 / #509 / #37, ADR-024）。90 日後コールド移送。
# dev は recreate 容易性優先で force_destroy=true（Issue #70 同規律）。
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
