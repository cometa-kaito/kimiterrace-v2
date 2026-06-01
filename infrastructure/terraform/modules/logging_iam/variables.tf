# logging_iam モジュール入力（ADR-029 / #439 / CLAUDE.md ルール5）

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

variable "restricted_roles" {
  description = <<-EOT
    member を authoritative に限定する Cloud Logging ロール。
    既定はリクエストログ（`_Default` バケット。Cloud Run の `httpRequest.requestUrl` に
    公開ルートの token/secret が載りうる）とデータアクセスログの閲覧ロール + 管理ロール。
  EOT
  type        = list(string)
  default = [
    "roles/logging.viewer",           # `_Default` バケット（Cloud Run request log を含む）の閲覧
    "roles/logging.privateLogViewer", # データアクセス/`_Required` 等の private log 閲覧
    "roles/logging.admin",            # ログ設定・sink・exclusion の管理
  ]
}

variable "log_viewer_members" {
  description = <<-EOT
    上記ロールを付与する運用者プリンシパル。`group:ops@example.com` 形を推奨
    （`user:`/`serviceAccount:` も可）。雛形段階は空 = enabled 化時に列挙外の閲覧付与を
    authoritative に排除する。breakglass 用の管理者を必ず含めること。
  EOT
  type        = list(string)
  default     = []
}
