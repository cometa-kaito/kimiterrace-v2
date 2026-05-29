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
}

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
  enabled             = false
  tier                = "db-custom-1-3840"
  deletion_protection = false # staging も recreate 容易性優先（Issue #70）
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
