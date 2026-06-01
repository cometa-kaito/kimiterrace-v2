# prod 環境ルート
# 雛形のみ。実体生成は各モジュールの enabled = true に切替後、Phase 開発で実行する。

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
    prefix = "envs/prod"
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
  default     = "signage-v2-prod"
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
  env = "prod"
}

module "network" {
  source     = "../../modules/network"
  project_id = var.project_id
  region     = var.region
  env        = local.env
  enabled    = false # TODO(Phase 開発): true に切替
}

module "cloud_sql" {
  source     = "../../modules/cloud_sql"
  project_id = var.project_id
  region     = var.region
  env        = local.env
  enabled    = false # TODO(Phase 開発): true に切替
  tier       = "db-custom-2-7680"
}

module "secret_manager" {
  source     = "../../modules/secret_manager"
  project_id = var.project_id
  env        = local.env
  enabled    = false # TODO(Phase 開発)
}

module "identity_platform" {
  source     = "../../modules/identity_platform"
  project_id = var.project_id
  env        = local.env
  enabled    = false # TODO(Phase 開発)
}

module "cloud_run" {
  source     = "../../modules/cloud_run"
  project_id = var.project_id
  region     = var.region
  env        = local.env
  enabled    = false # TODO(Phase 開発)
}

# F06 embedding バッチの Cloud Run Job + Scheduler（#416）。
module "cloud_run_job" {
  source     = "../../modules/cloud_run_job"
  project_id = var.project_id
  region     = var.region
  env        = local.env
  enabled    = false # TODO(Phase 開発)
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
