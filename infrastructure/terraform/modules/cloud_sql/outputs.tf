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

# アプリ DB ユーザー名（パスワードは出力しない＝state にのみ存在・ルール5）。
output "app_user_name" {
  description = "作成したアプリ DB ユーザー名（未作成なら null）"
  value       = try(google_sql_user.app[0].name, null)
}
