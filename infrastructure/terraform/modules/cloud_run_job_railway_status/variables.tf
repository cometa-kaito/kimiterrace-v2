# cloud_run_job_railway_status モジュール入力（パターン2 鉄道運行情報 / ADR-035）
# cloud_run_job_weather（ADR-021）と構造を揃える。差分: 取得元が名鉄公式ページ（スクレイピング）・取得頻度。

variable "project_id" {
  description = "GCP project ID"
  type        = string
}

variable "region" {
  description = "GCP リージョン（NFR07: asia-northeast1）"
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
  default     = "kimiterrace-railway-fetch"
}

variable "image" {
  description = "コンテナイメージ（jobs イメージ。weather Job と同一イメージで args で entry を切替）。"
  type        = string
  default     = "asia-northeast1-docker.pkg.dev/PLACEHOLDER/jobs:latest"
}

variable "container_command" {
  description = "コンテナ起動コマンド。railway-status-job のエントリは `node` 起動。"
  type        = list(string)
  default     = ["node"]
}

variable "container_args" {
  description = "起動引数。ビルド済み `dist/railway-status/railway-status-job.js` を起動する。"
  type        = list(string)
  default     = ["dist/railway-status/railway-status-job.js"]
}

variable "database_url_secret_id" {
  description = <<-EOT
    DATABASE_URL を保持する Secret Manager secret の ID（ルール5）。値は **kimiterrace_app ロール（非
    BYPASSRLS）** の DSN（ルール2）。空文字なら env / accessor を配線しない（雛形）。railway_status への
    書込みは run.ts が system_admin context（railway_status_write_system policy）で行う。
  EOT
  type        = string
  default     = ""
}

variable "sentry_dsn_secret_id" {
  description = "Sentry DSN を保持する Secret Manager secret の ID（ADR-013、ルール5）。空文字なら無効。"
  type        = string
  default     = ""
}

variable "vpc_connector" {
  description = <<-EOT
    egress 用の VPC connector（network モジュール出力）。空文字なら VPC egress を付けない（雛形）。
    本 Job は Cloud SQL private IP（内部）と名鉄ページ（外部）の両方へ出るため、egress を VPC 経由に集約し
    外向きは Cloud NAT で出す（egress_setting 既定 = ALL_TRAFFIC）。閉域原則（ADR-035）: 外部 egress は本 Job のみ。
  EOT
  type        = string
  default     = ""
}

variable "egress_setting" {
  description = "Cloud Run Job の VPC egress 設定。名鉄（外部）へ出るため既定 ALL_TRAFFIC（Cloud NAT 経由）。"
  type        = string
  default     = "ALL_TRAFFIC"

  validation {
    condition     = contains(["ALL_TRAFFIC", "PRIVATE_RANGES_ONLY"], var.egress_setting)
    error_message = "egress_setting は ALL_TRAFFIC か PRIVATE_RANGES_ONLY のいずれか。"
  }
}

variable "external_egress_ready" {
  description = <<-EOT
    外部 egress（Cloud NAT）が provision 済みかを示す signal。**network モジュールの egress_ready 出力を渡す**。
    ALL_TRAFFIC egress（名鉄への外部 fetch）には Cloud NAT が必須で、無いと runtime で外部到達できない。
    enable-time precondition で fail-fast させ「外部に出られない Job」を作らない（ADR-035 / ADR-009）。
  EOT
  type        = bool
  default     = false
}

variable "railway_fetch_user_agent" {
  description = "名鉄への明示 User-Agent（連絡先を含める、ADR-035 §礼儀）。railway-status-job の RAILWAY_FETCH_USER_AGENT。"
  type        = string
  default     = "kimiterrace-railway-fetch/1.0 (+https://rebounder.jp; contact: ops@rebounder.jp)"
}

variable "railway_fetch_timeout_ms" {
  description = "名鉄への HTTP タイムアウト（ms）。railway-status-job の RAILWAY_FETCH_TIMEOUT_MS。"
  type        = number
  default     = 10000
}

variable "cpu" {
  description = "コンテナ CPU リミット（軽量 HTTP + upsert）"
  type        = string
  default     = "1"
}

variable "memory" {
  description = "コンテナメモリリミット"
  type        = string
  default     = "512Mi"
}

variable "max_retries" {
  description = "Job タスクの最大リトライ回数（取得は冪等な upsert）"
  type        = number
  default     = 1
}

variable "task_timeout" {
  description = "Job タスクのタイムアウト（単一ページ取得、短め）"
  type        = string
  default     = "120s"
}

variable "deletion_protection" {
  description = "Job の削除保護。prod は true 推奨、staging/dev は false。"
  type        = bool
  default     = true
}

variable "schedule" {
  description = <<-EOT
    Cloud Scheduler の cron。運行情報は準リアルタイムだが名鉄サイトへの礼儀で過剰取得しない（ADR-035）。
    既定は 5 分間隔（鮮度と負荷のバランス。サイネージ側 isStale は 30 分閾値）。実測に合わせ調整可。
  EOT
  type        = string
  default     = "*/5 * * * *" # 5 分間隔
}

variable "schedule_time_zone" {
  description = "Scheduler のタイムゾーン（JST）"
  type        = string
  default     = "Asia/Tokyo"
}

variable "scheduler_retry_count" {
  description = "Scheduler の起動リトライ回数（Job 自体も冪等なので軽め）"
  type        = number
  default     = 1
}
