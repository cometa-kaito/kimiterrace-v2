# Artifact Registry（Docker フォーマット）— コンテナイメージ置き場（ADR-002 Cloud Run / ルール8）。
# migration 用 Cloud Run Job と Cloud Run app（B5）の image を push する単一リポジトリ。
# enabled = false（雛形）では count = 0（plan 空・validate 緑・後方互換）。
# イメージ参照: ${var.region}-docker.pkg.dev/${var.project_id}/${var.repository_id}/<image>:<tag>

resource "google_artifact_registry_repository" "docker" {
  count = var.enabled ? 1 : 0

  project       = var.project_id
  location      = var.region
  repository_id = var.repository_id
  format        = "DOCKER"
  description   = "キミテラス v2 コンテナイメージ（${var.env}）: migration Job / Cloud Run app"

  labels = {
    env = var.env
  }

  # ストレージ肥大化防止（コスト意識）。タグ無し（再 push で孤児化した version）を 30 日で削除する。
  # tagged image は削除しない（ロールバック用に履歴を残す）。dry_run = false で実際に削除を適用。
  cleanup_policy_dry_run = false
  cleanup_policies {
    id     = "delete-untagged-30d"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "2592000s" # 30 日
    }
  }
}
