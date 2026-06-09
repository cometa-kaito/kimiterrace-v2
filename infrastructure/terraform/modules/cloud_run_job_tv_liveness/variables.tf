# cloud_run_job_tv_liveness モジュール入力（F16 TV 死活監視 / #94, ADR-023）
# ADR-002 Cloud Run / ADR-001 PostgreSQL / ADR-009 Terraform / ADR-013 Sentry / ADR-014 観測
#
# cloud_run_job_weather モジュールと構造を揃えつつ（runtime SA + cloudsql.client + DATABASE_URL accessor +
# google_cloud_run_v2_job + scheduler SA + run.invoker + google_cloud_scheduler_job + VPC egress + Cloud NAT
# precondition）、TV 死活チェック Job 固有の差分を持つ:
#   - 起動コマンドは tv-liveness エントリ（dist/tv-liveness/tv-liveness-job.js）。jobs イメージは weather と共有。
#   - 外部 egress は **Slack（incoming webhook）への POST**（PR7 / F16 §9）。weather の JMA POST と同様に
#     ALL_TRAFFIC egress + Cloud NAT 経由で出す（閉域原則・出口 1 経路、ADR-021）。Slack が外部依存先。
#   - SLACK_WEBHOOK_URL は Secret Manager 経由で注入（任意、ルール5）。未設定なら Slack 送信は no-op
#     （PR7 のコードが空をハンドルし、構造化ログのみ）。SENTRY_DSN と同じ optional パターン。
#   - 閾値（TV_DOWN_THRESHOLD_SEC / TV_OFF_HOURS_THRESHOLD_SEC）は任意 override。未設定なら Job コードの
#     既定が効く（Job entrypoint tv-liveness-job.ts は TIGHT_THRESHOLD_SEC=120 を両閾値に渡す＝**実効
#     120/120 秒** = F16 §9 の 24/7 tight。packages/db DEFAULT_TV_LIVENESS_THRESHOLDS 180/1800 は本 Job 経路では不到達）。
#   - Scheduler は **毎分**（"* * * * *"）24/7 起動（ADR-023 / F16 §2 の 1 分間隔ポーリング前提）。

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
  description = <<-EOT
    Cloud Run Job 名。派生 SA account_id（`<job_name>-sa` / `<job_name>-sch`）が GCP 上限 30 文字に
    収まる必要がある。既定 "kimiterrace-tv-liveness"(23) → "-sa"(26) / "-sch"(27) でいずれも制限内。
  EOT
  type        = string
  default     = "kimiterrace-tv-liveness"
}

variable "image" {
  description = "コンテナイメージ（例: asia-northeast1-docker.pkg.dev/.../jobs:tag）。weather と同じ jobs イメージを共有（command だけ差し替え）。Phase 開発で確定。"
  type        = string
  default     = "asia-northeast1-docker.pkg.dev/PLACEHOLDER/jobs:latest"
}

variable "container_command" {
  description = "コンテナ起動コマンド。tv-liveness-job.ts のエントリは `node` 起動。"
  type        = list(string)
  default     = ["node"]
}

variable "container_args" {
  description = "起動引数。`src/tv-liveness/tv-liveness-job.ts` のビルド済み JS を起動する（jobs.Dockerfile・WORKDIR=/app/apps/jobs）。"
  type        = list(string)
  default     = ["dist/tv-liveness/tv-liveness-job.js"]
}

variable "database_url_secret_id" {
  description = <<-EOT
    DATABASE_URL を保持する Secret Manager secret の ID（ルール5）。
    値は **kimiterrace_app ロール（非 BYPASSRLS）** の DSN（ルール2）。空文字なら env / accessor を配線しない（雛形）。
    tv_devices の down/recover 反映は run.ts が system_admin context（system_admin_full_access policy）で行う。
  EOT
  type        = string
  default     = ""
}

variable "sentry_dsn_secret_id" {
  description = <<-EOT
    Sentry DSN を保持する Secret Manager secret の ID（ADR-013、ルール5）。
    空文字なら SENTRY_DSN env / accessor を配線しない（Sentry 送信は無効、構造化ログ + 非ゼロ終了のみ）。
  EOT
  type        = string
  default     = ""
}

variable "slack_webhook_url_secret_id" {
  description = <<-EOT
    Slack incoming webhook URL を保持する Secret Manager secret の ID（PR7 / F16 §9、ルール5）。
    device_down / device_recovered を Slack に配信するための URL。**外部 egress 先**（Slack）ゆえ
    ALL_TRAFFIC egress + Cloud NAT が前提（下の external_egress_ready precondition）。
    空文字なら SLACK_WEBHOOK_URL env / accessor を配線しない（Slack 送信は no-op、PR7 のコードが空をハンドル）。
    SENTRY_DSN と同じ optional secret パターン。
  EOT
  type        = string
  default     = ""
}

variable "tv_down_threshold_sec" {
  description = <<-EOT
    通常の down 閾値（秒）の override。空文字なら env を設定せず、Job entrypoint(tv-liveness-job.ts) の
    既定 **120 秒**が効く（F16 §9 24/7 tight。packages/db の 180 は本 Job 経路では不到達）。number ではなく string で受け、
    空文字 = 未設定と区別する（"" のとき env を生成しない）。
  EOT
  type        = string
  default     = ""
}

variable "tv_off_hours_threshold_sec" {
  description = <<-EOT
    OFF 時間帯の down 閾値（秒）の override。空文字なら env を設定せず、Job entrypoint の既定 **120 秒**が
    効く（F16 §9 で OFF 緩和は撤廃済＝24/7 同一 tight。packages/db の 1800 は本 Job 経路では不到達）。string、空文字 = 未設定。
  EOT
  type        = string
  default     = ""
}

variable "tv_liveness_heartbeat" {
  description = <<-EOT
    チェッカ自身の死活（dead man's switch、ADR-014）用の任意 heartbeat 値（TV_LIVENESS_HEARTBEAT）。
    空文字なら env を設定しない。PR7 のコードがハートビート送信先を解決する（未設定 = 無効、no-op）。
  EOT
  type        = string
  default     = ""
}

variable "vpc_connector" {
  description = <<-EOT
    egress 用の VPC connector（network モジュール出力）。空文字なら VPC egress を付けない（雛形）。
    本 Job は Cloud SQL private IP（内部）と Slack incoming webhook（外部）の両方へ出るため、
    egress は VPC 経由に集約し外向きは Cloud NAT で出す（egress_setting 既定 = ALL_TRAFFIC）。
    閉域原則（ADR-021 / [[closed-system-security]]）: 外部 egress は本 Job 経路（Slack 通知）のみ。
  EOT
  type        = string
  default     = ""
}

variable "egress_setting" {
  description = <<-EOT
    Cloud Run Job の VPC egress 設定。死活 Job は Slack（外部）へ POST するため既定 ALL_TRAFFIC で
    全 egress を VPC に通し Cloud NAT 経由で外向きにする（出口を 1 経路に集約し監査・FW 制御可能に）。
    Slack 通知を使わない（slack_webhook_url_secret_id 空）場合は PRIVATE_RANGES_ONLY でも可だが、既定は
    weather と揃えて ALL_TRAFFIC（PR7 の Slack 配信を即使えるように）。
  EOT
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
    ALL_TRAFFIC egress（= Slack 等の外部 API へ出る）には Cloud NAT が必須で、NAT 無しでは Job は runtime で
    外部に到達できない（vpc_connector があっても NAT が無ければ出口が無い）。
    enable-time precondition で fail-fast させ「Slack に通知できない死活 Job」を本番に作らない（ADR-021 / ADR-009）。
    vpc_connector の有無だけでは NAT の存在を保証できないため、本 signal を別途受け取る。
  EOT
  type        = bool
  default     = false
}

variable "cpu" {
  description = "コンテナ CPU リミット（軽量な全校横断 down/recover 走査 + Slack POST）"
  type        = string
  default     = "1"
}

variable "memory" {
  description = "コンテナメモリリミット"
  type        = string
  default     = "512Mi"
}

variable "max_retries" {
  description = "Job タスクの最大リトライ回数（down/recover 反映は冪等な UPDATE。毎分起動ゆえリトライは軽め）"
  type        = number
  default     = 1
}

variable "task_timeout" {
  description = "Job タスクのタイムアウト（全校横断の軽量走査 + 少数 Slack POST、短め）"
  type        = string
  default     = "120s"
}

variable "deletion_protection" {
  description = "Job の削除保護。prod は true 推奨、staging/dev は recreate 容易性のため false（Issue #70 と同方針）。"
  type        = bool
  default     = true
}

variable "schedule" {
  description = <<-EOT
    Cloud Scheduler の cron。TV 死活は **毎分**（"* * * * *"）24/7 で走査する（ADR-023 / F16 §2 の 1 分間隔
    ポーリング前提。down/recover の検知遅延を最小化し、tight monitoring を実現する）。
  EOT
  type        = string
  default     = "* * * * *" # 毎分（24/7）
}

variable "schedule_time_zone" {
  description = "Scheduler のタイムゾーン（OFF 時間帯判定が JST の schedule_json に依存、JST に揃える）"
  type        = string
  default     = "Asia/Tokyo"
}

variable "scheduler_retry_count" {
  description = "Scheduler の起動リトライ回数（Job 自体も冪等・毎分起動ゆえ軽め）"
  type        = number
  default     = 1
}
