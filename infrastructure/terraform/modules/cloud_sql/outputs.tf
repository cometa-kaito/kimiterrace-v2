output "instance_name" {
  description = "Cloud SQL instance 名"
  value       = var.instance_name
}

output "connection_name" {
  description = "Cloud SQL connection name（実体生成後に有効）"
  value       = try(google_sql_database_instance.main[0].connection_name, null)
}

output "private_ip_address" {
  description = "Private IP（VPC 経由接続用）"
  value       = try(google_sql_database_instance.main[0].private_ip_address, null)
}
