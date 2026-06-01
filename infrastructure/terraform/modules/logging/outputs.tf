output "magic_link_exclusion_name" {
  description = "magic-link トークンパスを除外する Cloud Logging exclusion 名（実体生成後に値が入る）"
  value       = var.enabled ? google_logging_project_exclusion.magic_link_token_paths[0].name : null
}
