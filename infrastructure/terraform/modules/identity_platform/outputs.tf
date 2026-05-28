output "tenant_name" {
  description = "IDP tenant 名（実体生成後に有効）"
  value       = try(google_identity_platform_tenant.school[0].name, null)
}
