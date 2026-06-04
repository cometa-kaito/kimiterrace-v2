# network モジュール入力

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

variable "network_name" {
  description = "VPC 名"
  type        = string
  default     = "kimiterrace-vpc"
}

variable "psa_range_address" {
  description = "PSA 予約レンジ（Cloud SQL Private IP 用）の開始 IP。null = GCP 自動割当。connector_cidr と重複しない固定値を推奨（PR #493 Low の enable-time 対応）。"
  type        = string
  default     = null
}

# ── Serverless VPC Access connector ──────────────────────────────────

variable "connector_name" {
  description = "Serverless VPC Access connector 名（GCP 制約: 小文字・25 文字以下）。job モジュールの vpc_connector に渡す。"
  type        = string
  default     = "kimiterrace-conn"

  validation {
    condition     = can(regex("^[a-z][-a-z0-9]{0,23}[a-z0-9]$", var.connector_name))
    error_message = "connector_name は小文字英数とハイフン、2〜25 文字（先頭は英字）。"
  }
}

variable "connector_cidr" {
  description = <<-EOT
    connector 専用の /28 レンジ。VPC 内で他レンジ（PSA 予約 / 将来の subnet）と重複しないこと。
    Cloud NAT は ALL_SUBNETWORKS_ALL_IP_RANGES で本レンジも外部 egress 対象に含める。
  EOT
  type        = string
  default     = "10.8.0.0/28"

  validation {
    condition     = can(cidrhost(var.connector_cidr, 0)) && tonumber(split("/", var.connector_cidr)[1]) == 28
    error_message = "connector_cidr は /28 の CIDR（Serverless VPC Access connector の要件）。"
  }
}

variable "connector_machine_type" {
  description = "connector インスタンスのマシンタイプ（軽量バッチ egress なので最小で十分）。"
  type        = string
  default     = "e2-micro"
}

variable "connector_min_instances" {
  description = "connector の最小インスタンス数（GCP 下限 = 2）。"
  type        = number
  default     = 2
}

variable "connector_max_instances" {
  description = "connector の最大インスタンス数（min より大きいこと。低頻度バッチなので小さく）。"
  type        = number
  default     = 3

  validation {
    condition     = var.connector_max_instances > var.connector_min_instances
    error_message = "connector_max_instances は connector_min_instances より大きいこと。"
  }
}

# ── Cloud NAT（外部 egress 単一出口）ロギング ─────────────────────────

variable "nat_logging_enabled" {
  description = "Cloud NAT のロギング有効化（外部 egress 証跡、ADR-021 / NFR07）。既定 true。"
  type        = bool
  default     = true
}

variable "nat_logging_filter" {
  description = "Cloud NAT ログのフィルタ（ERRORS_ONLY / TRANSLATIONS_ONLY / ALL）。既定はエラーのみで低コスト。"
  type        = string
  default     = "ERRORS_ONLY"

  validation {
    condition     = contains(["ERRORS_ONLY", "TRANSLATIONS_ONLY", "ALL"], var.nat_logging_filter)
    error_message = "nat_logging_filter は ERRORS_ONLY / TRANSLATIONS_ONLY / ALL のいずれか。"
  }
}
