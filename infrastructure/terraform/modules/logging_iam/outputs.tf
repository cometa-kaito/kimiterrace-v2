output "restricted_roles" {
  description = "authoritative に member を限定した Cloud Logging ロール一覧（enabled 時のみ）。"
  value       = var.enabled ? var.restricted_roles : []
}

output "log_viewer_members" {
  description = "ログ閲覧を許可した運用者プリンシパル。"
  value       = var.log_viewer_members
}
