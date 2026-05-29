# identity_platform モジュール入力（ADR-003）

variable "project_id" {
  description = "GCP project ID"
  type        = string
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

variable "tenant_display_name" {
  description = "IDP tenant 表示名（学校マルチテナント単位）"
  type        = string
  default     = "kimiterrace-default"
}
