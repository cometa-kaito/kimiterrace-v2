# Secret Manager 雛形（CLAUDE.md ルール5）
# TODO(Phase 開発): secrets map に DB password / Sentry DSN / 外部 API キー等を入れる。
# 雛形段階は default = {} なので for_each も空。

resource "google_secret_manager_secret" "items" {
  for_each = var.enabled ? var.secrets : {}

  project   = var.project_id
  secret_id = each.key

  replication {
    auto {}
  }

  labels = {
    env = var.env
  }
}

# accessor IAM 雛形
resource "google_secret_manager_secret_iam_member" "accessor" {
  for_each = var.enabled && var.accessor_service_account != "" ? var.secrets : {}

  project   = var.project_id
  secret_id = google_secret_manager_secret.items[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.accessor_service_account}"
}
