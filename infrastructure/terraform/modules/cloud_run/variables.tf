# cloud_run モジュール入力
# ADR-002: Cloud Run (asia-northeast1) を採用
# ADR-008: Next.js Route Handlers 統合のため単一サービス

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
  description = "環境名 (prod/staging/dev)"
  type        = string
}

variable "enabled" {
  description = "実体生成スイッチ。雛形段階は false。"
  type        = bool
  default     = false
}

variable "service_name" {
  description = "Cloud Run service name"
  type        = string
  default     = "kimiterrace-web"
}

variable "image" {
  description = "Container image (例: asia-northeast1-docker.pkg.dev/.../web:tag)"
  type        = string
  default     = "asia-northeast1-docker.pkg.dev/PLACEHOLDER/web:latest"
}
