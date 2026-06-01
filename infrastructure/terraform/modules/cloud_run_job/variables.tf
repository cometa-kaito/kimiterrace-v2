# cloud_run_job モジュール入力（F06 embedding バッチ / #416）
# ADR-002 Cloud Run / ADR-005 Vertex AI / ADR-007 pgvector・embedding モデル

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
  default     = "kimiterrace-embedding"
}

variable "image" {
  description = "コンテナイメージ（例: asia-northeast1-docker.pkg.dev/.../jobs:tag）。Phase 開発で確定。"
  type        = string
  default     = "asia-northeast1-docker.pkg.dev/PLACEHOLDER/jobs:latest"
}

variable "container_command" {
  description = "コンテナ起動コマンド。embed-job.ts のエントリは `node` 起動。"
  type        = list(string)
  default     = ["node"]
}

variable "container_args" {
  description = "起動引数。`src/embedding/embed-job.ts` のビルド済み JS を起動する（Dockerfile は別 PR）。"
  type        = list(string)
  default     = ["src/embedding/embed-job.js"]
}

variable "database_url_secret_id" {
  description = <<-EOT
    DATABASE_URL を保持する Secret Manager secret の ID（ルール5）。
    値は **kimiterrace_app ロール（非 BYPASSRLS）** の DSN（ルール2）。空文字なら env / accessor を配線しない（雛形）。
  EOT
  type        = string
  default     = ""
}

variable "vpc_connector" {
  description = "Cloud SQL private IP 接続用の VPC connector（network モジュール出力）。空文字なら VPC egress を付けない（雛形）。"
  type        = string
  default     = ""
}

variable "vertex_location" {
  description = "Vertex AI location（embed-job.ts の VERTEX_LOCATION）"
  type        = string
  default     = "asia-northeast1"
}

variable "embedding_model_id" {
  description = "embedding モデル ID（ADR-007 確定: gemini-embedding-001@768）"
  type        = string
  default     = "gemini-embedding-001@768"
}

variable "embed_batch_size" {
  description = "1 回の embed 呼び出し件数（embed-job.ts の EMBED_BATCH_SIZE）"
  type        = number
  default     = 32
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
  description = "Job タスクの最大リトライ回数（バッチは冪等: embedding IS NULL の残りだけ拾う）"
  type        = number
  default     = 1
}

variable "task_timeout" {
  description = "Job タスクのタイムアウト（例: 600s）"
  type        = string
  default     = "600s"
}

variable "schedule" {
  description = "Cloud Scheduler の cron（公開コンテンツ更新の反映頻度。即時性が要れば publish 時トリガは別途検討）"
  type        = string
  default     = "0 * * * *" # 毎時 0 分（Phase 開発で頻度確定）
}

variable "schedule_time_zone" {
  description = "Scheduler のタイムゾーン"
  type        = string
  default     = "Asia/Tokyo"
}

variable "scheduler_retry_count" {
  description = "Scheduler の起動リトライ回数（Job 自体も冪等なので軽め）"
  type        = number
  default     = 1
}
