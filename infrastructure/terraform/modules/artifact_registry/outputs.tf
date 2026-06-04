output "repository_id" {
  description = "Artifact Registry リポジトリ ID（未作成なら null）"
  value       = try(google_artifact_registry_repository.docker[0].repository_id, null)
}

# イメージ参照の prefix。<prefix>/<image>:<tag> でタグ付けして push する。
# 例: asia-northeast1-docker.pkg.dev/signage-v2-staging/kimiterrace/migrate:<sha>
output "image_repo_url" {
  description = "イメージ参照 prefix（<region>-docker.pkg.dev/<project>/<repo>）。未作成なら null。"
  value       = var.enabled ? "${var.region}-docker.pkg.dev/${var.project_id}/${var.repository_id}" : null
}
