# cloud_run_job_reports モジュール入力（F09 月次レポート生成 / #430, #45）
# ADR-002 Cloud Run / ADR-001 PostgreSQL / ADR-009 Terraform / ADR-018 Cloud Storage 保管
#
# embedding バッチ用 cloud_run_job モジュールと構造を揃えつつ、月次レポート Job 固有の差分を持つ:
#   - Vertex AI 権限・env は不要（PDF 生成 = pdfkit、集計 = SQL のみ）。
#   - 外部 egress 不要（Cloud SQL private IP + Cloud Storage の Google API のみ。embedding と同じく PRIVATE_RANGES_ONLY）。
#   - REPORT_BUCKET（保存先バケット名）と REPORT_YEAR / REPORT_MONTH（対象年月）を env で受ける。

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
  default     = "kimiterrace-monthly-reports"
}

variable "image" {
  description = "コンテナイメージ（例: asia-northeast1-docker.pkg.dev/.../jobs:tag）。Phase 開発で確定。"
  type        = string
  default     = "asia-northeast1-docker.pkg.dev/PLACEHOLDER/jobs:latest"
}

variable "container_command" {
  description = "コンテナ起動コマンド。report-job.ts のエントリは `node` 起動。"
  type        = list(string)
  default     = ["node"]
}

variable "container_args" {
  description = "起動引数。`src/reports/report-job.ts` のビルド済み JS を起動する（Dockerfile は別 PR）。"
  type        = list(string)
  default     = ["src/reports/report-job.js"]
}

variable "database_url_secret_id" {
  description = <<-EOT
    DATABASE_URL を保持する Secret Manager secret の ID（ルール5）。
    値は **kimiterrace_app ロール（非 BYPASSRLS）** の DSN（ルール2）。空文字なら env / accessor を配線しない（雛形）。
    run.ts が校列挙を system_admin context、各校の集計読取・履歴書込を school_admin 降格 context で行う。
  EOT
  type        = string
  default     = ""
}

variable "report_bucket" {
  description = <<-EOT
    PDF 保存先 Cloud Storage バケット名（report-job.ts の REPORT_BUCKET env、ハードコード禁止・ルール5）。
    env root で report_storage モジュールの bucket_name 出力を渡す。空文字なら env を配線しない（雛形）。
    enabled = true のときは必須（lifecycle.precondition で fail-fast）。
  EOT
  type        = string
  default     = ""
}

variable "report_year" {
  description = <<-EOT
    対象年（report-job.ts の REPORT_YEAR env、整数文字列）。月初に前月分を生成する運用では実行時刻依存のため、
    固定値を焼かず enable-time に Scheduler の http_target body 等で動的注入する想定（既定は空 = 配線しない、雛形）。
  EOT
  type        = string
  default     = ""
}

variable "report_month" {
  description = <<-EOT
    対象月（report-job.ts の REPORT_MONTH env、1-12 の整数文字列）。report_year と同様、月初に前月を動的注入する
    想定で既定は空（配線しない、雛形）。Phase 開発で Scheduler の注入方式と合わせて確定する。
  EOT
  type        = string
  default     = ""
}

variable "vpc_connector" {
  description = <<-EOT
    Cloud SQL private IP 接続用の VPC connector（network モジュール出力 network.vpc_connector_id）。
    本 Job は内部 egress（PRIVATE_RANGES_ONLY）のみで Cloud NAT は不要（外部 API へ出ない、GCS は Private Google Access）。
    空文字なら VPC egress を付けない（雛形）。enabled = true のときは必須（lifecycle.precondition で fail-fast）。
  EOT
  type        = string
  default     = ""
}

variable "cpu" {
  description = "コンテナ CPU リミット（集計クエリ + pdfkit レンダリング）"
  type        = string
  default     = "1"
}

variable "memory" {
  description = "コンテナメモリリミット（全校分の PDF を順次生成、フォント同梱）"
  type        = string
  default     = "1Gi"
}

variable "max_retries" {
  description = "Job タスクの最大リトライ回数（保存 + 履歴 upsert は冪等: 同 path 上書き + (school,year,month) upsert）"
  type        = number
  default     = 1
}

variable "task_timeout" {
  description = "Job タスクのタイムアウト（全校を順次 集計 → PDF → GCS 保存 → 履歴 upsert）"
  type        = string
  default     = "900s"
}

variable "deletion_protection" {
  description = "Job の削除保護。prod は true 推奨、staging/dev は recreate 容易性のため false（Issue #70 と同方針）。"
  type        = bool
  default     = true
}

variable "schedule" {
  description = <<-EOT
    Cloud Scheduler の cron。月次レポートは月初に前月分を生成する（F09 / #430 「月次・手動配布」）。
    既定は毎月 1 日 04:00 JST（早朝、前日までの月内集計が確定している時刻帯）。Phase 開発で調整可。
  EOT
  type        = string
  default     = "0 4 1 * *" # 毎月 1 日 04:00（JST）
}

variable "schedule_time_zone" {
  description = "Scheduler のタイムゾーン（集計は JST 暦月境界、ルール: JST 暦月窓）"
  type        = string
  default     = "Asia/Tokyo"
}

variable "scheduler_retry_count" {
  description = "Scheduler の起動リトライ回数（Job 自体も冪等なので軽め）"
  type        = number
  default     = 1
}
