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

# 認証は claims-based が既定（tenant 非使用）。tenant マルチテナント分離が要る場合だけ true。
variable "create_tenant" {
  description = "Identity Platform tenant を作るか。claims-based（既定）は false。"
  type        = bool
  default     = false
}

variable "tenant_display_name" {
  description = "IDP tenant 表示名（学校マルチテナント単位、create_tenant=true 時のみ）"
  type        = string
  default     = "kimiterrace-default"
}

# F11 / ADR-031: MFA capability の有効化状態。
#   DISABLED … 無効（雛形既定）
#   ENABLED  … 任意登録可（岐南工業 PoC。未登録でもログイン可、アプリ層は enrollment へ誘導）
# 本番導入ゲートで ENABLED にし、アプリ層で teacher 以上に強制する（ADR-031）。
variable "mfa_state" {
  description = "MFA 有効化状態（ADR-031）。DISABLED または ENABLED。"
  type        = string
  default     = "DISABLED"

  validation {
    condition     = contains(["DISABLED", "ENABLED"], var.mfa_state)
    error_message = "mfa_state は DISABLED または ENABLED のいずれか。"
  }
}

# 許可する MFA factor。factor 種別（PHONE_SMS / TOTP）は導入時に確定（ADR-031 未確定事項）。
variable "mfa_enabled_providers" {
  description = "MFA で許可する factor のリスト（ADR-031）。"
  type        = list(string)
  default     = ["PHONE_SMS"]
}
