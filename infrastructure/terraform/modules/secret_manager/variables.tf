# secret_manager モジュール入力（CLAUDE.md ルール5）

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

variable "secrets" {
  description = "作成する secret 一覧。実体は Phase 開発で埋める。"
  type = map(object({
    description = string
  }))
  default = {}
}

variable "accessor_service_account" {
  description = "secret accessor を付与する SA email（Cloud Run runtime SA など）"
  type        = string
  default     = ""
}
