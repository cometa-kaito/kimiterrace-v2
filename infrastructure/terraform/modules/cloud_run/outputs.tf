output "service_name" {
  description = "Cloud Run service 名"
  value       = var.service_name
}

output "service_uri" {
  description = "Cloud Run service URI（実体生成後に有効）"
  value       = try(google_cloud_run_v2_service.web[0].uri, null)
}
