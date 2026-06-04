# artifact_registry モジュール入力（ルール8 / ADR-002）

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP リージョン（Artifact Registry の location）"
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

variable "repository_id" {
  description = "Artifact Registry リポジトリ ID（イメージ参照 prefix の一部）。"
  type        = string
  default     = "kimiterrace"
}
