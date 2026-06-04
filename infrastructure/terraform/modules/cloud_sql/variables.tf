# cloud_sql モジュール入力
# ADR-001: PostgreSQL 16 + pgvector を採用

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

variable "instance_name" {
  description = "Cloud SQL instance 名"
  type        = string
  default     = "kimiterrace-pg"
}

variable "tier" {
  description = "machine tier（prod は db-custom 推奨、dev は db-f1-micro 可）"
  type        = string
  default     = "db-f1-micro"
}

variable "vpc_network_id" {
  description = "Private IP を割り当てる VPC network の id（network モジュールの network_id 出力を渡す）。"
  type        = string
  default     = ""
}

# Cloud SQL の private IP は VPC <-> Google サービス VPC の PSA peering の上に割り当てられる。
# network モジュールの private_services_ready 出力（PSA peering 実在 signal）を渡し、
# enable-time precondition で peering 不在のまま instance を作る事故を plan 時に fail-fast させる
# （private IP only の instance は peering が無いと作成不能。count 静的依存 = plan 時既知）。
variable "private_services_ready" {
  description = <<-EOT
    Cloud SQL private IP の土台となる PSA peering が provision 済みかを示す signal。
    **network モジュールの private_services_ready 出力を渡す**。enabled = true（private IP only）の
    とき true が必須（peering -> instance の順序を強制、ADR-001 / ADR-021 / ルール8）。
  EOT
  type        = bool
  default     = false
}

# 可用性タイプ:
#   - prod: REGIONAL（HA = 同期スタンバイで自動 failover、10 年保管要件 ADR-001）
#   - staging / dev: ZONAL（HA 不要・コスト優先。モジュール comment どおり HA は prod のみ）
# 後方互換のため default = ZONAL（staging が明示せず ZONAL になる）。prod だけ REGIONAL を明示。
variable "availability_type" {
  description = "Cloud SQL の可用性タイプ。prod のみ REGIONAL（HA）、staging/dev は ZONAL（既定）。"
  type        = string
  default     = "ZONAL"

  validation {
    condition     = contains(["ZONAL", "REGIONAL"], var.availability_type)
    error_message = "availability_type は ZONAL か REGIONAL のいずれか。"
  }
}

# ── バックアップ / PITR / メンテナンス ────────────────────────────────
# 10 年保管・漏洩時の復旧要件（ADR-001）。staging でも本番同等にバックアップ + PITR を有効化する
# （検証環境でリストア手順も含めて確認するため）。

variable "backup_start_time" {
  description = "自動バックアップ開始時刻（HH:MM、UTC）。既定 19:00 UTC = 04:00 JST（低負荷帯）。"
  type        = string
  default     = "19:00"

  validation {
    condition     = can(regex("^([01][0-9]|2[0-3]):[0-5][0-9]$", var.backup_start_time))
    error_message = "backup_start_time は HH:MM（24h, UTC）。"
  }
}

variable "backup_retained_count" {
  description = "保持する自動バックアップ世代数（PITR の WAL 保持はこれに紐づく）。"
  type        = number
  default     = 7

  validation {
    condition     = var.backup_retained_count >= 1
    error_message = "backup_retained_count は 1 以上。"
  }
}

variable "transaction_log_retention_days" {
  description = "PITR 用トランザクションログ（WAL）の保持日数（1〜7）。"
  type        = number
  default     = 7

  validation {
    condition     = var.transaction_log_retention_days >= 1 && var.transaction_log_retention_days <= 7
    error_message = "transaction_log_retention_days は 1〜7。"
  }
}

variable "maintenance_window_day" {
  description = "メンテナンスウィンドウの曜日（1=月 〜 7=日）。既定 7 = 日曜。"
  type        = number
  default     = 7

  validation {
    condition     = var.maintenance_window_day >= 1 && var.maintenance_window_day <= 7
    error_message = "maintenance_window_day は 1〜7（1=月, 7=日）。"
  }
}

variable "maintenance_window_hour" {
  description = "メンテナンスウィンドウの開始時（0〜23、UTC）。既定 18 UTC = 03:00 JST。"
  type        = number
  default     = 18

  validation {
    condition     = var.maintenance_window_hour >= 0 && var.maintenance_window_hour <= 23
    error_message = "maintenance_window_hour は 0〜23（UTC）。"
  }
}

# Cloud SQL の deletion_protection は env ごとに切替たい:
#   - prod: true（誤削除防止、後方互換のため default=true）
#   - dev / staging: false（recreate のたびに手動切替を不要化）
# Issue #70 / PR #66 Reviewer H-2 対応
variable "deletion_protection" {
  description = "Cloud SQL instance の deletion_protection。prod は true、dev/staging は false 推奨。"
  type        = bool
  default     = true
}

# ── アプリ DB ユーザー（google_sql_user.app）─────────────────────────────
# パスワードは Secret Manager に「人間が」投入した値を data source で参照する（ルール5）。
# Terraform はパスワードを生成・ハードコードしない。本変数には secret の ID（例 "staging-db-app-password"）を渡す。
# 空文字（既定）なら DB ユーザーを作らない＝雛形・dev（docker-compose 代替）・prod 後方互換（count = 0・plan 空）。
#
# 2-phase apply（chicken-and-egg を回避）:
#   ① secret コンテナだけ先に作る   : terraform apply -target=module.secret_manager
#   ② 人間がパスワード値を投入       : gcloud secrets versions add <id> --data-file=- --project=...
#   ③ full apply で本ユーザーを作成  : terraform apply（data source が ② の最新版を読む）
# CI は fmt + validate(-backend=false) のみで data source を読まないため、② 未投入でも CI は緑。
variable "app_db_password_secret_id" {
  description = "アプリ DB ユーザー（app）のパスワードを保持する Secret Manager secret ID。空なら user を作らない。値は人間が投入（ルール5）。"
  type        = string
  default     = ""
}

# ── migrator DB ユーザー（google_sql_user.migrator）─────────────────────────
# migration 実行用。Cloud SQL の API 作成 user は cloudsqlsuperuser ゆえ CREATE EXTENSION / CREATE ROLE 可。
# **migrator がテーブルを所有** することで app（非所有者）に RLS が効く（app をテーブル所有にすると
# owner-bypass で RLS 無効化＝ルール2 違反）。app と同じ data source 方式（値は人間投入・ルール5）。
# 空文字（既定）なら作らない＝dev/prod 後方互換（count = 0・plan 空）。
variable "migrator_db_password_secret_id" {
  description = "migrator DB ユーザーのパスワードを保持する Secret Manager secret ID。空なら user を作らない。値は人間が投入（ルール5）。"
  type        = string
  default     = ""
}
