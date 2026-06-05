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

output "custom_domain" {
  description = "マッピング済みカスタムドメイン FQDN（未設定なら null）"
  value       = var.custom_domain != "" ? var.custom_domain : null
}

output "custom_domain_dns_records" {
  description = <<-EOT
    カスタムドメインマッピングが要求する DNS レコード（name/type/rrdata）。
    apply 後にこの値を Vercel DNS（school-signage.net）へ登録する。サブドメインは通常
    CNAME → ghs.googlehosted.com。未設定/未作成なら空リスト。
  EOT
  value       = try(google_cloud_run_domain_mapping.web[0].status[0].resource_records, [])
}
