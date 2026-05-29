# Cloud SQL for PostgreSQL 16 + pgvector 雛形（ADR-001 / ADR-007）
# TODO(Phase 開発):
#   - private IP only, backup_configuration, point_in_time_recovery
#   - database_flags = [{ name = "cloudsql.enable_pgvector", value = "on" }]
#   - HA (REGIONAL) は prod のみ
# 雛形段階は count = 0。

resource "google_sql_database_instance" "main" {
  count = var.enabled ? 1 : 0

  project          = var.project_id
  region           = var.region
  name             = var.instance_name
  database_version = "POSTGRES_16"

  settings {
    tier = var.tier
    # TODO: ip_configuration { ipv4_enabled = false, private_network = var.vpc_network_id }
    # TODO: backup_configuration, maintenance_window
    # TODO: database_flags - pgvector 有効化
  }

  deletion_protection = var.deletion_protection
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
