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
