output "service_name" {
  description = "Cloud Run service 名"
  value       = var.service_name
}

output "service_uri" {
  description = "Cloud Run service URI（実体生成後に有効）。smoke: <uri>/login を curl。"
  value       = try(google_cloud_run_v2_service.web[0].uri, null)
}

output "runtime_service_account_email" {
  description = "Cloud Run web service の実行 SA email（未生成なら null）"
  value       = try(google_service_account.web_runtime[0].email, null)
}
