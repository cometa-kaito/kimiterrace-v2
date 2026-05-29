# cloud_sql モジュール入力
# ADR-001: PostgreSQL 16 + pgvector を採用

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP リージョン"
  type        = string
  default     = "asia-northeast1"
}

variable "env" {
  description = "環境名"
  type        = string
}

variable "enabled" {
  description = "実体生成スイッチ。雛形段階は false。"
  type        = bool
  default     = false
}

variable "instance_name" {
  description = "Cloud SQL instance 名"
  type        = string
  default     = "kimiterrace-pg"
}

variable "tier" {
  description = "machine tier（prod は db-custom 推奨、dev は db-f1-micro 可）"
  type        = string
  default     = "db-f1-micro"
}

variable "vpc_network_id" {
  description = "Private IP を割り当てる VPC network self_link"
  type        = string
  default     = ""
}

# Cloud SQL の deletion_protection は env ごとに切替たい:
#   - prod: true（誤削除防止、後方互換のため default=true）
#   - dev / staging: false（recreate のたびに手動切替を不要化）
# Issue #70 / PR #66 Reviewer H-2 対応
variable "deletion_protection" {
  description = "Cloud SQL instance の deletion_protection。prod は true、dev/staging は false 推奨。"
  type        = bool
  default     = true
}
