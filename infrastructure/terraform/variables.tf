# 入力変数（共通）
# 各 env からは同名・同型で渡される前提。

variable "project_id" {
  description = "GCP project ID（例: signage-v2-prod）"
  type        = string
}

variable "region" {
  description = "GCP リージョン。原則 asia-northeast1 固定（ADR-002）。"
  type        = string
  default     = "asia-northeast1"
}

variable "env" {
  description = "環境名: prod / staging / dev"
  type        = string
  validation {
    condition     = contains(["prod", "staging", "dev"], var.env)
    error_message = "env must be one of: prod, staging, dev."
  }
}

# Workload Identity Federation 用（雛形）
# 本 PR では宣言のみ。実体は手動でプール / プロバイダ作成（README 参照）。
variable "wif_pool_id" {
  description = "Workload Identity Pool ID（CI 認証用）"
  type        = string
  default     = ""
}

variable "wif_provider_id" {
  description = "Workload Identity Provider ID（GitHub Actions 連携）"
  type        = string
  default     = ""
}
