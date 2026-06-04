# cloud_run_job_migrate モジュール入力（M3 / DB migration Job）

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP リージョン（NFR07 データ越境ゼロ: asia-northeast1）"
  type        = string
  default     = "asia-northeast1"
}

variable "env" {
  description = "環境名 (prod/staging/dev)"
  type        = string
}

variable "enabled" {
  description = "実体生成スイッチ。雛形段階は false（リソースを作らない）。"
  type        = bool
  default     = false
}

variable "job_name" {
  description = "Cloud Run Job 名"
  type        = string
  default     = "kimiterrace-migrate"
}

variable "image" {
  description = "migrate コンテナイメージ（infrastructure/docker/migrate.Dockerfile を build/push したもの）。空なら enabled=true で fail-fast。"
  type        = string
  default     = ""
}

variable "database_url_secret_id" {
  description = <<-EOT
    DATABASE_URL を保持する Secret Manager secret の ID（ルール5）。
    値は **migrator ロール（cloudsqlsuperuser・テーブル所有）** の DSN。空文字なら env / accessor を配線しない（雛形）。
  EOT
  type        = string
  default     = ""
}

variable "vpc_connector" {
  description = <<-EOT
    Cloud SQL private IP 接続用の VPC connector（network モジュール出力 network.vpc_connector_id）。
    内部 egress（PRIVATE_RANGES_ONLY）のみで Cloud NAT は不要。空文字なら VPC egress を付けない（雛形）。
  EOT
  type        = string
  default     = ""
}

variable "grant_app_role_member" {
  description = <<-EOT
    設定すると migration 後に `GRANT kimiterrace_app TO <値>` を実行する（migrate-runner の
    MIGRATE_GRANT_APP_ROLE_MEMBER env）。staging では app login user の `app` を渡す。空なら付与しない。
  EOT
  type        = string
  default     = ""
}

variable "cpu" {
  description = "コンテナ CPU リミット"
  type        = string
  default     = "1"
}

variable "memory" {
  description = "コンテナメモリリミット"
  type        = string
  default     = "512Mi"
}

variable "max_retries" {
  description = "Job タスクの最大リトライ回数。migrate-runner は _schema_migrations 追跡で冪等/resume 可ゆえ retry 安全。"
  type        = number
  default     = 1
}

variable "task_timeout" {
  description = "Job タスクのタイムアウト（例: 600s）"
  type        = string
  default     = "600s"
}

variable "deletion_protection" {
  description = "Job の削除保護。prod は true 推奨、staging/dev は recreate 容易性のため false（Issue #70 同方針）。"
  type        = bool
  default     = true
}
