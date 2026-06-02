# cloud_run_job_weather モジュール入力（F14 サイネージ天気予報 / #128, ADR-021）
# ADR-002 Cloud Run / ADR-001 PostgreSQL / ADR-009 Terraform / ADR-013 Sentry
#
# embedding バッチ用 cloud_run_job モジュールと構造を揃えつつ、天気取得 Job 固有の差分を持つ:
#   - Vertex AI 権限は不要（JMA 取得のみ、外部 API キーも不要 = ADR-021）。
#   - 外部 egress が必要（JMA は public internet。embedding は Cloud SQL private IP のみ）。
#   - 失敗追跡は Sentry DSN を Secret Manager 経由で注入（任意、ADR-013）。

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
  default     = "kimiterrace-weather-fetch"
}

variable "image" {
  description = "コンテナイメージ（例: asia-northeast1-docker.pkg.dev/.../jobs:tag）。Phase 開発で確定。"
  type        = string
  default     = "asia-northeast1-docker.pkg.dev/PLACEHOLDER/jobs:latest"
}

variable "container_command" {
  description = "コンテナ起動コマンド。weather-job.ts のエントリは `node` 起動。"
  type        = list(string)
  default     = ["node"]
}

variable "container_args" {
  description = "起動引数。`src/weather/weather-job.ts` のビルド済み JS を起動する（Dockerfile は別 PR）。"
  type        = list(string)
  default     = ["src/weather/weather-job.js"]
}

variable "database_url_secret_id" {
  description = <<-EOT
    DATABASE_URL を保持する Secret Manager secret の ID（ルール5）。
    値は **kimiterrace_app ロール（非 BYPASSRLS）** の DSN（ルール2）。空文字なら env / accessor を配線しない（雛形）。
    weather_forecasts への書込みは run.ts が system_admin context（weather_write_system policy）で行う。
  EOT
  type        = string
  default     = ""
}

variable "sentry_dsn_secret_id" {
  description = <<-EOT
    Sentry DSN を保持する Secret Manager secret の ID（ADR-013、ルール5）。
    空文字なら SENTRY_DSN env / accessor を配線しない（Sentry 失敗送信は無効、構造化ログ + 非ゼロ終了のみ）。
  EOT
  type        = string
  default     = ""
}

variable "vpc_connector" {
  description = <<-EOT
    egress 用の VPC connector（network モジュール出力）。空文字なら VPC egress を付けない（雛形）。
    本 Job は Cloud SQL private IP（内部）と JMA public API（外部）の両方へ出るため、
    egress は VPC 経由に集約し外向きは Cloud NAT で出す（egress_setting 既定 = ALL_TRAFFIC）。
    閉域原則（ADR-021 / [[closed-system-security]]）: 外部 egress は **本 Job 経路のみ**、端末は外部に出ない。
  EOT
  type        = string
  default     = ""
}

variable "egress_setting" {
  description = <<-EOT
    Cloud Run Job の VPC egress 設定。天気 Job は JMA（外部）へ出るため既定 ALL_TRAFFIC で
    全 egress を VPC に通し Cloud NAT 経由で外向きにする（出口を 1 経路に集約し監査・FW 制御可能に）。
    内部のみで足りる場合は PRIVATE_RANGES_ONLY。
  EOT
  type        = string
  default     = "ALL_TRAFFIC"

  validation {
    condition     = contains(["ALL_TRAFFIC", "PRIVATE_RANGES_ONLY"], var.egress_setting)
    error_message = "egress_setting は ALL_TRAFFIC か PRIVATE_RANGES_ONLY のいずれか。"
  }
}

variable "weather_fetch_user_agent" {
  description = "JMA への明示 User-Agent（連絡先を含める、ADR-021 §HTTP マナー）。weather-job.ts の WEATHER_FETCH_USER_AGENT。"
  type        = string
  default     = "kimiterrace-weather-fetch/1.0 (+https://rebounder.jp; contact: ops@rebounder.jp)"
}

variable "weather_fetch_timeout_ms" {
  description = "JMA への HTTP タイムアウト（ms）。weather-job.ts の WEATHER_FETCH_TIMEOUT_MS。"
  type        = number
  default     = 10000
}

variable "cpu" {
  description = "コンテナ CPU リミット（軽量 HTTP + upsert バッチ）"
  type        = string
  default     = "1"
}

variable "memory" {
  description = "コンテナメモリリミット"
  type        = string
  default     = "512Mi"
}

variable "max_retries" {
  description = "Job タスクの最大リトライ回数（取得は冪等な upsert、部分失敗は last-known-good で許容）"
  type        = number
  default     = 1
}

variable "task_timeout" {
  description = "Job タスクのタイムアウト（地域 dedup 後の少数 HTTP 取得、短め）"
  type        = string
  default     = "300s"
}

variable "deletion_protection" {
  description = "Job の削除保護。prod は true 推奨、staging/dev は recreate 容易性のため false（Issue #70 と同方針）。"
  type        = bool
  default     = true
}

variable "schedule" {
  description = <<-EOT
    Cloud Scheduler の cron。JMA の予報更新頻度（1 日数回）に合わせ過剰取得しない（F14 §2 / ADR-021）。
    既定は毎時（30〜60 分間隔の上限）。JMA は概ね 05/11/17 時 JST 更新だが、last-known-good 維持と
    冪等 upsert のため毎時取得で鮮度と負荷のバランスを取る。Phase 開発で実測に合わせ調整可。
  EOT
  type        = string
  default     = "0 * * * *" # 毎時 0 分
}

variable "schedule_time_zone" {
  description = "Scheduler のタイムゾーン（JMA は日本の予報、JST）"
  type        = string
  default     = "Asia/Tokyo"
}

variable "scheduler_retry_count" {
  description = "Scheduler の起動リトライ回数（Job 自体も冪等なので軽め）"
  type        = number
  default     = 1
}
