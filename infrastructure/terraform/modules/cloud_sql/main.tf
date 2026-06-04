# Cloud SQL for PostgreSQL 16 + pgvector（ADR-001 / ADR-007）
# セキュリティ要件（公立校 生徒データ・10 年保管）:
#   - private IP only（public IP 無効）。VPC 経由でのみ到達可能。
#   - 転送時 SSL/TLS を強制（ssl_mode = ENCRYPTED_ONLY）。
#   - 自動バックアップ + PITR（point-in-time recovery）で漏洩時・誤操作時の復旧を担保。
#   - pgvector 拡張を有効化（ADR-007 RAG）。
#   - HA(REGIONAL) は prod のみ。staging/dev は ZONAL（availability_type 既定 ZONAL）。
# enabled = false（雛形）では count = 0 で実体を作らない（plan 空・validate 緑・後方互換）。

resource "google_sql_database_instance" "main" {
  count = var.enabled ? 1 : 0

  project          = var.project_id
  region           = var.region
  name             = var.instance_name
  database_version = "POSTGRES_16"

  settings {
    tier = var.tier

    # 可用性: prod のみ REGIONAL(HA)、staging/dev は ZONAL（既定）。
    availability_type = var.availability_type

    # private IP only — public IP を割り当てない。private_network 経由でのみ到達可能。
    # private IP は network モジュールの PSA peering 上に割り当てられる（var.private_services_ready で順序強制）。
    ip_configuration {
      ipv4_enabled    = false
      private_network = var.vpc_network_id
      # 転送時暗号化を強制（provider v6: 非 SSL 接続を拒否）。生徒 PII の転送経路を保護（ルール5 / NFR03）。
      ssl_mode = "ENCRYPTED_ONLY"
    }

    # pgvector 拡張の有効化（ADR-007 RAG。掲示物 embedding を同一 DB で semantic search）。
    database_flags {
      name  = "cloudsql.enable_pgvector"
      value = "on"
    }

    # 自動バックアップ + PITR。10 年保管・漏洩時/誤操作時の復旧要件（ADR-001）。
    # staging でも有効化し、リストア手順まで含めて検証する。
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true # PostgreSQL の PITR（WAL アーカイブ）
      start_time                     = var.backup_start_time
      transaction_log_retention_days = var.transaction_log_retention_days

      backup_retention_settings {
        retained_backups = var.backup_retained_count
        retention_unit   = "COUNT"
      }
    }

    # メンテナンスウィンドウ（低負荷帯に固定し、突発的な再起動を避ける）。
    maintenance_window {
      day          = var.maintenance_window_day
      hour         = var.maintenance_window_hour
      update_track = "stable"
    }
  }

  deletion_protection = var.deletion_protection

  # PSA peering（network モジュール）が無いと private IP only の instance は作成できない。
  # network の private_services_ready 出力を受け取り、peering 不在のまま enable する事故を
  # plan 時に fail-fast させる（peering -> instance の順序を強制。count 静的依存 = plan 時既知）。
  lifecycle {
    precondition {
      condition     = !var.enabled || var.private_services_ready
      error_message = "enabled = true（private IP only）のとき private_services_ready = true が必須です。network モジュールの PSA peering（google_service_networking_connection）を先に enable し、その private_services_ready 出力を渡してください（peering 無しでは private IP を割り当てられず instance を作成不可、ADR-001 / ADR-021 / ルール8）。"
    }
    precondition {
      condition     = !var.enabled || var.vpc_network_id != ""
      error_message = "enabled = true（private IP only）のとき vpc_network_id は必須です。network モジュールの network_id 出力を渡してください（ルール8）。"
    }
  }
}

resource "google_sql_database" "app" {
  count = var.enabled ? 1 : 0

  project  = var.project_id
  name     = "kimiterrace"
  instance = google_sql_database_instance.main[0].name
}

# DB ユーザーは Secret Manager 経由でパスワード参照する想定。
# TODO(Phase 開発): IAM 認証 (CLOUD_IAM_USER) に切替検討。
resource "google_sql_user" "app" {
  count = 0 # TODO: enabled かつ secret 配備後に切替

  project  = var.project_id
  instance = var.instance_name
  name     = "app"
  # password は Secret Manager から data source で参照
}
